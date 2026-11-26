#!/bin/sh
# One analysis session (a separate Claude Code session, as ANALYSIS.md requires): run_analysis.sh KIND A B
# KIND is a template in analysis/templates (completion, not-visible). It writes analysis/auto/A-B/KIND.md and closes
# itself once that file has stayed unchanged for 45 seconds. The session may read results/work of the two rounds and
# write that one file; benchmark/ and the task dumps are denied, and anything else not allowed is refused (dontAsk).
# The improving session never reads this output until a person has: see ANALYSIS.md.
set -u
# CODE: this folder (the scripts). ROOT: the data, outside the repository.
CODE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${WEBHAND_BENCH:-$HOME/webhand-bench}" && pwd -P)" || exit 1
export WEBHAND_BENCH="$ROOT"
KIND=$1; A=$2; B=$3
DIR="$ROOT/analysis/auto/$A-$B"
OUT="$DIR/$KIND.md"
mkdir -p "$DIR"
python3 - "$ROOT" "$KIND" "$A" "$B" "$OUT" "$DIR" "$CODE" <<'PY'
import json, os, sys
root, kind, a, b, out, d, code = sys.argv[1:]
text = open(f"{code}/analysis/templates/{kind}.txt").read()
home = os.path.realpath(os.path.expanduser("~"))
shown = "~" + root[len(home):] if root.startswith(home + os.sep) else root
for k, v in {"@ROOT@": shown, "@A@": a, "@B@": b, "@OUT@": out}.items():
    text = text.replace(k, v)
open(f"{d}/{kind}.prompt.txt", "w").write(text)
allow = [f"Read(/{root}/work-{r}/**)" for r in (a, b)] + [f"Read(/{root}/results-{r}/**)" for r in (a, b)]
allow += [f"Read(/{root}/analysis/auto/{a}-{b}/**)", f"Edit(/{out})", "Glob", "Grep", *[f"Bash({p}{c} *)" for p in ("", "rtk ") for c in ("ls", "wc", "grep", "jq", "head", "tail", "cat")]]
deny = [f"Read(/{root}/benchmark/**)", f"Read(/{root}/analysis/tasks-*)", "Read(**/*.enc)", "Bash(*benchmark*)", "Bash(*.enc*)", "Bash(*tasks-*)"]
json.dump({"permissions": {"allow": allow, "deny": deny, "defaultMode": "dontAsk"}}, open(f"{d}/{kind}.settings.json", "w"), indent=2)
PY
[ -n "${DIAG_DRY:-}" ] && { echo "dry: $DIR/$KIND.prompt.txt"; exit 0; }
rm -f "$OUT" "$DIR/$KIND.ready"
id=$(uuidgen)
# The session id is kept so analysis_status.sh can close the session, and see the output ready, after a reboot: herdr
# then resumes the session with "claude --resume ID", without this script (found with fa-fb, 2026-11-16).
echo "$id" > "$DIR/$KIND.session"
# Closes the session when the output exists and has not changed for 45 seconds, or after 40 minutes.
( i=0; while [ $i -lt 2400 ]; do
    sleep 5; i=$((i + 5))
    if [ -s "$OUT" ]; then
      m1=$(stat -c %Y "$OUT"); sleep 45
      [ "$(stat -c %Y "$OUT")" = "$m1" ] && break
    fi
  done
  pkill -TERM -f "$id" 2>/dev/null ) &
watcher=$!
cd "$DIR"
claude --strict-mcp-config --model "${BENCH_MODEL:-claude-sonnet-5-5}" --session-id "$id" --settings "$DIR/$KIND.settings.json" "$(cat "$DIR/$KIND.prompt.txt")" || true
kill "$watcher" 2>/dev/null
if [ -s "$OUT" ]; then echo "READY $OUT"; date -u +%FT%TZ > "$DIR/$KIND.ready"; sh "$CODE/scripts/beep.sh" 2>/dev/null; else echo "NO OUTPUT: $KIND (analysis_status.sh $A $B shows it later)"; fi
