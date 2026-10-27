#!/bin/sh
# usage: sh wt-test.sh <rolldown-package-dir> <tag>
# Checks that the harness loads the given rolldown build, then runs the large preset (2% and 10% non-ASCII)
# with the modes that read chunk data. Results: results-large500-{na02,na10}-<tag>.json; log: wt-test-<tag>.log.
R=$(cd "$(dirname "$0")" && pwd)
PKG=$(cd "$1" && pwd); TAG=$2
cd "$R" || exit 1
export NODE_OPTIONS=--max-old-space-size=16384
echo "## loaded native modules"
node --input-type=module -e "
import('$PKG/dist/index.mjs').then(() => {
  const so = process.report.getReport().sharedObjects.filter((s) => s.endsWith('.node'));
  console.log(so.join('\n'));
  if (!so.some((s) => s.startsWith('$PKG'))) { console.error('binding not loaded from $PKG'); process.exit(1); }
});
" || exit 1
echo "## smoke"
SRC_DIR=/tmp/repro-smoke ROLLDOWN_PKG="$PKG" node "$R/build.mjs" renderedLength | command grep -o '"rolldown_pkg":"[^"]*"' || exit 1
for c in na02 na10; do
  echo "## large preset, $c, $TAG"
  SRC_DIR="$R/src-large-$c" ROLLDOWN_PKG="$PKG" RESULTS="results-large500-$c-$TAG.json" node "$R/run-all.mjs" code code2 modules renderedLength all
done
echo done
