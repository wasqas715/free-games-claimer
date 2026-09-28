#!/bin/bash
set -u
S=/Users/br00klyn/.hermes/profiles/kramer/scripts
IN=/tmp/prime-v9f-in.js
OUT=/tmp/prime-patched9.js

echo "=== stage 1: build v9 (clean, no probe) from the verified v8 payload ==="
scp -q tower:/tmp/prime-patched8.js "$IN"
echo "  v8 in : $(md5 -q "$IN")  $(wc -c < "$IN" | tr -d ' ') bytes"
python3 "$S/patch_prime_v9.py" "$IN" "$OUT" || { echo "  ABORT: patch failed"; exit 3; }
echo "  v9 out: $(md5 -q "$OUT")  $(wc -c < "$OUT" | tr -d ' ') bytes"
node --check "$OUT" && echo "  node --check: OK"
if grep -q 'FGC PROBE' "$OUT"; then echo "  ABORT: probe code still present in the production build"; exit 4; fi
echo "  probe code absent: OK"

echo
echo "=== stage 2: install + start ==="
scp -q "$OUT" tower:/tmp/prime-patched9.js
ssh tower "docker cp /tmp/prime-patched9.js Free-Games-Claimer:/fgc/prime-gaming.js"
BACK=$(ssh tower "docker cp Free-Games-Claimer:/fgc/prime-gaming.js /tmp/v9-back.js >/dev/null && md5sum /tmp/v9-back.js | cut -d' ' -f1")
echo "  in-container hash: $BACK"
echo "  local hash       : $(md5 -q "$OUT")"
ssh tower "docker start Free-Games-Claimer" >/dev/null && echo "  container started (v9)"

echo
echo "=== stage 3: v9 run, first 200s (verification: no regression) ==="
sleep 200
ssh tower "docker logs --since 5m Free-Games-Claimer 2>&1 | grep -v 'still waiting on' | grep -E 'Number of|Current free game|External store|claim:|Code to redeem|store disagreement|offer failed|unhandled' | tail -20"
ssh tower "docker ps -a --filter name=Free-Games-Claimer --format '  container: {{.Status}}'"
