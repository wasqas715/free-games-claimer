#!/bin/bash
set -u
S=/Users/br00klyn/.hermes/profiles/kramer/scripts
IN=/tmp/prime-v6-in.js
OUT=/tmp/prime-patched6.js

echo "=== stage 1: build v6 from the verified v5 payload ==="
scp -q tower:/tmp/prime-patched5.js "$IN"
echo "  v5 in : $(md5 -q "$IN")  $(wc -c < "$IN" | tr -d ' ') bytes"
python3 "$S/patch_prime_v6.py" "$IN" "$OUT" || { echo "  ABORT: patch failed"; exit 3; }
echo "  v6 out: $(md5 -q "$OUT")  $(wc -c < "$OUT" | tr -d ' ') bytes"
if command -v node >/dev/null 2>&1; then
  node --check "$OUT" && echo "  node --check (local): OK"
fi

echo
echo "=== stage 2: install + start ==="
scp -q "$OUT" tower:/tmp/prime-patched6.js
ssh tower "docker cp /tmp/prime-patched6.js Free-Games-Claimer:/fgc/prime-gaming.js"
ssh tower "docker cp Free-Games-Claimer:/fgc/prime-gaming.js /tmp/v6-back.js && md5sum /tmp/v6-back.js | cut -d' ' -f1"
echo "  (in-container hash above must equal the v6 hash)"
ssh tower "docker start Free-Games-Claimer" >/dev/null && echo "  container started"

echo
echo "=== stage 3: v6 run, first 100s ==="
sleep 100
ssh tower "docker logs --since 4m Free-Games-Claimer 2>&1 | grep -v 'still waiting on' | tail -34"
