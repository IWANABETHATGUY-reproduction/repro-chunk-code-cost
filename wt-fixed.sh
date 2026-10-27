#!/bin/sh
# usage: sh wt-fixed.sh <rolldown-worktree-dir>
# Applies the prototype fixes, rebuilds the binding and the JS glue, saves the diff, checks correctness,
# then measures the large preset. Log: wt-fixed.log.
R=$(cd "$(dirname "$0")" && pwd)
W=$(cd "$1" && pwd)
python3 "$R/patches/apply-fix.py" "$W" || exit 1
cd "$W/packages/rolldown" || exit 1
pnpm build-binding:release || exit 1
pnpm build-node || exit 1
git -C "$W" diff > "$R/patches/rolldown-chunk-code-cost.patch"
git -C "$W" diff --stat
cd "$R" || exit 1
export NODE_OPTIONS=--max-old-space-size=16384
echo "## correctness, ASCII smoke graph"
SRC_DIR=/tmp/repro-smoke ROLLDOWN_PKG="$W/packages/rolldown" node "$R/check-fix.mjs" || exit 1
echo "## correctness, non-ASCII 30% graph"
SRC_DIR="$R/src-share30" ROLLDOWN_PKG="$W/packages/rolldown" node "$R/check-fix.mjs" || exit 1
sh "$R/wt-test.sh" "$W/packages/rolldown" wt-fixed
