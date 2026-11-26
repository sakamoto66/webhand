#!/bin/sh
# Runs every prepared, unstarted task of BENCH_ROUND (or BENCH_ROUNDS="a b", alternating) with N sessions at a time
# (default 3; 1 runs in this terminal, as before), and scores each. Parallel is the default: each session has its own
# WEBHAND_HOME, so the conditions do not change. N > 1 opens a herdr workspace "bench-<round>" with N panes, each
# running worker.sh. Answer each pane by the README's rules. Stop after the running tasks: touch ~/webhand-bench/STOP (in the data root).
# Usage: BENCH_ROUND=ev research/bench/run_all.sh [N]
set -eu
# CODE: this folder (the scripts). ROOT: the data, outside the repository.
CODE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${WEBHAND_BENCH:-$HOME/webhand-bench}" && pwd -P)" || exit 1
export WEBHAND_BENCH="$ROOT"
N=${1:-${BENCH_PARALLEL:-3}}
[ -e "$ROOT/STOP" ] && { echo "Removed a stale STOP file."; rm -f "$ROOT/STOP"; }
if [ "$N" -le 1 ]; then exec "$CODE/worker.sh"; fi
LABEL="${BENCH_ROUNDS:-${BENCH_ROUND:-main}}"
# The rounds are quoted: BENCH_ROUNDS="sa sb" has a space, which the pane's shell would split into a command.
WORKER="env WEBHAND_BENCH='$ROOT' BENCH_ROUND='${BENCH_ROUND:-}' BENCH_ROUNDS='${BENCH_ROUNDS:-}' '$CODE/worker.sh'"
id() { python3 -c "import json,sys; d=json.load(sys.stdin)['result']; print($1)"; }
root=$(herdr workspace create --label "bench-$(printf %s "$LABEL" | tr ' ' '-')" --cwd "$ROOT" --no-focus | id "d['root_pane']['pane_id']")
panes="$root"; last="$root"; i=1
while [ "$i" -lt "$N" ]; do
  dir=right; [ $((i % 2)) -eq 0 ] && dir=down
  last=$(herdr pane split "$last" --direction "$dir" --no-focus | id "d['pane']['pane_id']")
  panes="$panes $last"; i=$((i + 1))
done
for p in $panes; do herdr pane run "$p" "$WORKER" >/dev/null; done
echo "Started $N workers for $LABEL in herdr: $panes"
