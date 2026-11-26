#!/bin/sh
# One worker of run_all.sh. Claims the next prepared, unstarted task (mkdir .claim is atomic, so two workers never
# take the same one), runs it with its watcher and the checks, and goes on. With BENCH_ROUNDS="a b" the rounds
# alternate task by task (a's task 1, b's task 1, a's task 2, ...), so a run cut short still leaves complete pairs.
# Scoring is serialized with flock. A failed check creates STOP, which stops every worker after its current task.
set -u
# CODE: this folder (the scripts). ROOT: the data, outside the repository.
CODE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${WEBHAND_BENCH:-$HOME/webhand-bench}" && pwd -P)" || exit 1
export WEBHAND_BENCH="$ROOT"
PY="uv run --project $ROOT/benchmark python"
ROUNDS="${BENCH_ROUNDS:-${BENCH_ROUND:--}}"
FIRST="${ROUNDS%% *}"
[ "$FIRST" = - ] && FIRST=""
INT=0
trap 'echo "Stopping after this task."; INT=1' INT

stop() { touch "$ROOT/STOP"; echo "$1 Stopping every worker after its task."; }

# Runs one task of one round; returns 1 when the workers must stop.
run_one() {
  dir="$1"
  id="$(basename "$dir")"
  echo "=== ${BENCH_ROUND:-main} $id ($(date '+%H:%M')) ==="
  $PY "$CODE/scripts/watch.py" "$id" &
  watcher=$!
  "$dir/launch.sh" || true
  wait "$watcher" 2>/dev/null || true
  stty sane 2>/dev/null || true
  echo "$id ended: $(cat "$dir/ended_by" 2>/dev/null || echo unknown)"
  # Sessions prepared with skill_repo must have loaded the skill from that repository.
  repo="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("skill_repo", ""))' "$dir/meta.json")"
  if [ -n "$repo" ] && ! $PY "$CODE/scripts/check_skill.py" "$id" "$repo/skills/webhand"; then
    stop "Wrong skill loaded ($id stays as it is, not scored)."; return 1
  fi
  # Sessions must have run on the model in meta.json (fixed from 2026-11-09).
  if ! $PY "$CODE/scripts/check_model.py" "$id"; then
    stop "Wrong model ($id stays as it is, not scored)."; return 1
  fi
  # Jev must have been callable (from 2026-11-12: its credit ran out during rounds fv1 and fv2).
  if ! $PY "$CODE/scripts/check_jev.py" "$id"; then
    stop "Jev refused for the account ($id is kept, marked invalid, not scored)."; return 1
  fi
  # Sessions must have run webhand in the flow in meta.json (from 2026-11-12).
  if ! $PY "$CODE/scripts/check_cli.py" "$id"; then
    stop "Wrong webhand CLI ($id stays as it is, not scored)."; return 1
  fi
  if ! $PY "$CODE/scripts/check_flow.py" "$id"; then
    stop "Wrong webhand flow ($id stays as it is, not scored)."; return 1
  fi
  # Scoring (collect and judge, about 2 minutes) is not waited for: it runs in the background, one at a time, and a
  # worker that finds it busy goes on; every worker scores what is left before it ends (below).
  ( flock -n "$ROOT/.score.lock" $PY "$CODE/scripts/score_pending.py" ) &
}

for first in "$ROOT"/work${FIRST:+-$FIRST}/*/; do
  id="$(basename "$first")"
  for round in $ROUNDS; do
    [ "$round" = - ] && round=""
    dir="$ROOT/work${round:+-$round}/$id"
    [ -d "$dir" ] || continue
    [ -e "$dir/started_at" ] && continue
    [ "$INT" = 1 ] && break 2
    [ -e "$ROOT/STOP" ] && { echo "STOP file found; this worker stops."; break 2; }
    mkdir "$dir/.claim" 2>/dev/null || continue
    if [ -n "$round" ]; then export BENCH_ROUND="$round"; else unset BENCH_ROUND; fi
    run_one "${dir%/}" || break 2
  done
done
wait
# Whatever the background scoring skipped (it was busy) or was started before the session closed: score it now, one at a time.
for round in $ROUNDS; do
  [ "$round" = - ] && round=""
  if [ -n "$round" ]; then export BENCH_ROUND="$round"; else unset BENCH_ROUND; fi
  flock "$ROOT/.score.lock" $PY "$CODE/scripts/score_pending.py"
done
for round in $ROUNDS; do
  [ "$round" = - ] && round=""
  if [ -n "$round" ]; then export BENCH_ROUND="$round"; else unset BENCH_ROUND; fi
  echo "=== summary ${round:-main} ==="
  $PY "$CODE/scripts/summary.py"
done
# The last worker to finish a pair of rounds starts the diagnosis: a numbers-only report and the analysis sessions
# (diagnose.sh). BENCH_DIAGNOSE=0 turns it off. A round that was stopped half way is not diagnosed.
set -- $ROUNDS
if [ "${BENCH_DIAGNOSE:-1}" != 0 ] && [ $# -eq 2 ] && [ ! -e "$ROOT/STOP" ]; then
  complete=1
  for round in "$1" "$2"; do
    for dir in "$ROOT/work-$round"/*/; do
      [ -e "$dir/invalid" ] && continue
      { [ -e "$dir/ended_by" ] && [ -e "$ROOT/results-$round/$(basename "$dir")/result.json" ]; } || complete=0
    done
  done
  if [ "$complete" = 1 ]; then
    mkdir -p "$ROOT/analysis/auto"
    if mkdir "$ROOT/analysis/auto/$1-$2.started" 2>/dev/null; then
      echo "=== diagnose $1 $2 ==="
      "$CODE/diagnose.sh" "$1" "$2" || echo "diagnose failed"
    fi
  fi
fi
echo "worker done"
