#!/bin/sh
# Generates the large preset (about 84,000 modules, about 500 MB of output) with ASCII, 2% and 10% non-ASCII
# content, then runs every mode on each. Results: results-large500-{ascii,na02,na10}.json; log: large-test.log.
R=$(cd "$(dirname "$0")" && pwd)
cd "$R" || exit 1
export NODE_OPTIONS=--max-old-space-size=16384
for cfg in "0 0 ascii" "1 0.02 na02" "1 0.10 na10"; do
  set -- $cfg
  PRESET=large NON_ASCII=$1 NON_ASCII_SHARE=$2 SRC_DIR="$R/src-large-$3" node "$R/gen.mjs" || exit 1
done
for c in ascii na02 na10; do
  echo "## large preset, $c"
  SRC_DIR="$R/src-large-$c" RESULTS="results-large500-$c.json" node "$R/run-all.mjs"
done
echo "done"
