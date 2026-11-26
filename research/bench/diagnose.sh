#!/bin/sh
# After a pair of rounds is scored: a numbers-only report, then the analysis sessions (completion type, NOT_VISIBLE type)
# in a herdr workspace, each a separate Claude Code session. Usage: diagnose.sh A B   (A = base round, B = changed round)
# The report holds scores and counts from webhand's logs only, so the improving session may read it. The analysis files
# quote judge output: a person reads them first (ANALYSIS.md). DIAG_DRY=1 writes prompts and settings only.
set -eu
# CODE: this folder (the scripts). ROOT: the data, outside the repository.
CODE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${WEBHAND_BENCH:-$HOME/webhand-bench}" && pwd -P)" || exit 1
export WEBHAND_BENCH="$ROOT"
A=$1; B=$2
PY="uv run --project $ROOT/benchmark python"
DIR="$ROOT/analysis/auto/$A-$B"
mkdir -p "$DIR"
{
  echo "# $A vs $B ($(date -u +%FT%TZ))"
  echo; echo "## summary $A"; BENCH_ROUND=$A $PY "$CODE/scripts/summary.py"
  echo; echo "## summary $B"; BENCH_ROUND=$B $PY "$CODE/scripts/summary.py"
  echo; echo "## compare $B --base $A"; BENCH_ROUND=$B $PY "$CODE/scripts/compare.py" "$B" --base "$A" || true
  echo; $PY "$CODE/scripts/nv_counts.py" "$A" "$B"
} > "$DIR/report.txt" 2>&1
echo "Report: $DIR/report.txt"
if [ -n "${DIAG_DRY:-}" ]; then
  for k in completion not-visible; do DIAG_DRY=1 "$CODE/run_analysis.sh" $k "$A" "$B"; done; exit 0
fi
id() { python3 -c "import json,sys; d=json.load(sys.stdin)['result']; print($1)"; }
root=$(herdr workspace create --label "diag-$A-$B" --cwd "$DIR" --no-focus | id "d['root_pane']['pane_id']")
second=$(herdr pane split "$root" --direction right --no-focus | id "d['pane']['pane_id']")
herdr pane run "$root" "env WEBHAND_BENCH='$ROOT' '$CODE/run_analysis.sh' completion $A $B" >/dev/null
herdr pane run "$second" "env WEBHAND_BENCH='$ROOT' '$CODE/run_analysis.sh' not-visible $A $B" >/dev/null
echo "Analysis sessions started in herdr workspace diag-$A-$B: $root $second"
