#!/bin/sh
# Fetch the benchmark into the data root and install it: research/bench/setup.sh
# The benchmark is not part of this repository. It is pinned to a tag and its commit; an existing clone that differs is
# left as it is and this stops.
set -eu
TAG=v2.1.1
COMMIT=af6c7f7f6772b6985b7644f660cac87fd4b03583
URL=https://github.com/browser-use/benchmark.git
ROOT="${WEBHAND_BENCH:-$HOME/webhand-bench}"
BENCH="$ROOT/benchmark"
mkdir -p "$ROOT"
[ -e "$BENCH" ] || git clone --branch "$TAG" --single-branch "$URL" "$BENCH"
head=$(git -C "$BENCH" rev-parse HEAD)
[ "$head" = "$COMMIT" ] || { echo "$BENCH is at $head, expected $TAG ($COMMIT)." >&2; exit 1; }
[ -z "$(git -C "$BENCH" status --porcelain --untracked-files=no)" ] || { echo "$BENCH has local changes." >&2; exit 1; }
cd "$BENCH"
uv sync --frozen --python 3.12
echo "Benchmark ready: $BENCH ($TAG)"
