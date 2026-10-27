#!/bin/sh
# Measures renderedLength and code read cost for several non-ASCII word shares and with a large live heap.
R=$(cd "$(dirname "$0")" && pwd)
cd "$R" || exit 1
for cfg in "0 0 src-share00" "1 0.02 src-share02" "1 0.10 src-share10" "1 0.30 src-share30"; do
  set -- $cfg
  ROUTES=1000 MODULE_BYTES=5000 NON_ASCII=$1 NON_ASCII_SHARE=$2 SRC_DIR="$R/$3" node "$R/gen.mjs"
done
run() {
  node --max-old-space-size=24000 "$R/build.mjs" "$1" | python3 -I -c 'import sys,json; r=json.loads(sys.stdin.read().split("RESULT ",1)[1]); print(json.dumps({k:r.get(k) for k in ("mode","output_mb","hooks_ms","heap_mb","rss_mb","build_ms","ballast_mb","ballast_objs")}))'
}
for d in src-share00 src-share02 src-share10 src-share30; do
  echo "## $d"
  SRC_DIR="$R/$d" run renderedLength
  SRC_DIR="$R/$d" run code
done
echo "## on-heap ballast, src-share02"
for n in 0 20000000; do
  echo "### BALLAST_OBJS=$n"
  SRC_DIR="$R/src-share02" BALLAST_OBJS=$n run renderedLength
  SRC_DIR="$R/src-share02" BALLAST_OBJS=$n run code
done
