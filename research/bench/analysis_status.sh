#!/bin/sh
# State of the analysis sessions of a pair of rounds, at any time (also after a reboot, when run_analysis.sh is gone):
# analysis_status.sh A B [--close]
# An output file that has not changed for 60 seconds is ready: this writes the .ready mark and beeps once for it.
# With --close, the session recorded in <kind>.session (started or resumed as "claude ... ID") is ended too.
set -u
# CODE: this folder (the scripts). ROOT: the data, outside the repository.
CODE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${WEBHAND_BENCH:-$HOME/webhand-bench}" && pwd -P)" || exit 1
export WEBHAND_BENCH="$ROOT"
A=$1; B=$2; CLOSE=${3:-}
DIR="$ROOT/analysis/auto/$A-$B"
[ -d "$DIR" ] || { echo "No diagnosis for $A $B (run diagnose.sh $A $B)"; exit 1; }
now=$(date +%s)
[ -s "$DIR/report.txt" ] && echo "report: ready ($DIR/report.txt)" || echo "report: missing"
for kind in completion not-visible; do
  out="$DIR/$kind.md"
  if [ ! -s "$out" ]; then
    running=no; [ -s "$DIR/$kind.session" ] && pgrep -f "$(cat "$DIR/$kind.session")" >/dev/null 2>&1 && running=yes
    echo "$kind: no output yet (session running: $running)"; continue
  fi
  age=$((now - $(stat -c %Y "$out")))
  if [ "$age" -lt 60 ]; then echo "$kind: being written (changed ${age}s ago)"; continue; fi
  if [ ! -e "$DIR/$kind.ready" ]; then
    date -u +%FT%TZ > "$DIR/$kind.ready"; sh "$CODE/scripts/beep.sh" 2>/dev/null
  fi
  echo "$kind: ready ($out, $(wc -c < "$out") bytes)"
  if [ "$CLOSE" = --close ] && [ -s "$DIR/$kind.session" ]; then pkill -TERM -f "$(cat "$DIR/$kind.session")" 2>/dev/null && echo "  session closed"; fi
done
