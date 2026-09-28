#!/bin/bash
set -u
S=/Users/br00klyn/.hermes/profiles/kramer/scripts
IN=/tmp/prime-v8-in.js
OUT=/tmp/prime-patched8.js

echo "=== stage 1: build v8 from the verified v7 payload ==="
scp -q tower:/tmp/prime-patched7.js "$IN"
echo "  v7 in : $(md5 -q "$IN")  $(wc -c < "$IN" | tr -d ' ') bytes"
python3 "$S/patch_prime_v8.py" "$IN" "$OUT" || { echo "  ABORT: patch failed"; exit 3; }
echo "  v8 out: $(md5 -q "$OUT")  $(wc -c < "$OUT" | tr -d ' ') bytes"
node --check "$OUT" && echo "  node --check: OK"

echo
echo "=== stage 2: install + start ==="
scp -q "$OUT" tower:/tmp/prime-patched8.js
ssh tower "docker cp /tmp/prime-patched8.js Free-Games-Claimer:/fgc/prime-gaming.js"
BACK=$(ssh tower "docker cp Free-Games-Claimer:/fgc/prime-gaming.js /tmp/v8-back.js >/dev/null && md5sum /tmp/v8-back.js | cut -d' ' -f1")
echo "  in-container hash: $BACK"
echo "  local hash       : $(md5 -q "$OUT")"
ssh tower "docker start Free-Games-Claimer" >/dev/null && echo "  container started"

echo
echo "=== stage 3: v8 run, first 215s ==="
sleep 215
ssh tower "docker logs --since 7m Free-Games-Claimer 2>&1 | grep -v 'still waiting on' | grep -E 'Current free game|External store|claim:|Code to redeem|offer failed|Number of|NOTE:' | tail -42"
