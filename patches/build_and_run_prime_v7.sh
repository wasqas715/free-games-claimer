#!/bin/bash
set -u
S=/Users/br00klyn/.hermes/profiles/kramer/scripts
IN=/tmp/prime-v7-in.js
OUT=/tmp/prime-patched7.js

echo "=== stage 1: build v7 from the verified v6 payload ==="
scp -q tower:/tmp/prime-patched6.js "$IN"
echo "  v6 in : $(md5 -q "$IN")  $(wc -c < "$IN" | tr -d ' ') bytes"
python3 "$S/patch_prime_v7.py" "$IN" "$OUT" || { echo "  ABORT: patch failed"; exit 3; }
echo "  v7 out: $(md5 -q "$OUT")  $(wc -c < "$OUT" | tr -d ' ') bytes"
node --check "$OUT" && echo "  node --check: OK"

echo
echo "=== stage 2: install + start ==="
scp -q "$OUT" tower:/tmp/prime-patched7.js
ssh tower "docker cp /tmp/prime-patched7.js Free-Games-Claimer:/fgc/prime-gaming.js"
BACK=$(ssh tower "docker cp Free-Games-Claimer:/fgc/prime-gaming.js /tmp/v7-back.js >/dev/null && md5sum /tmp/v7-back.js | cut -d' ' -f1")
echo "  in-container hash: $BACK"
echo "  local hash       : $(md5 -q "$OUT")"
ssh tower "docker start Free-Games-Claimer" >/dev/null && echo "  container started"

echo
echo "=== stage 3: v7 run, first 150s ==="
sleep 150
ssh tower "docker logs --since 5m Free-Games-Claimer 2>&1 | grep -v 'still waiting on' | tail -32"
