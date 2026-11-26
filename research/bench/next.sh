#!/bin/sh
# Launch the next prepared task that has not been started, in id order. Run in a new terminal.
set -eu
ROOT="$(cd "${WEBHAND_BENCH:-$HOME/webhand-bench}" && pwd -P)"
for dir in "$ROOT"/work${BENCH_ROUND:+-$BENCH_ROUND}/*/; do
  if [ ! -e "$dir/started_at" ]; then
    echo "Launching $(basename "$dir")"
    exec "$dir/launch.sh"
  fi
done
echo "Every prepared task has been started."
