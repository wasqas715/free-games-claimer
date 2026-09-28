#!/bin/bash
set -u
S=/Users/br00klyn/.hermes/profiles/kramer/scripts
IN=/tmp/prime-v10-in.js
OUT=/tmp/prime-patched10.js

echo "=== stage 1: build v10 from the verified v9 payload ==="
scp -q tower:/tmp/prime-patched9.js "$IN"
echo "  v9 in  : $(md5 -q "$IN")  $(wc -c < "$IN" | tr -d ' ') bytes"
python3 "$S/patch_prime_v10.py" "$IN" "$OUT" || { echo "  ABORT: patch failed"; exit 3; }
echo "  v10 out: $(md5 -q "$OUT")  $(wc -c < "$OUT" | tr -d ' ') bytes"
node --check "$OUT" && echo "  node --check: OK"
if grep -q 'FGC PROBE' "$OUT"; then echo "  ABORT: probe code present"; exit 4; fi
if grep -q 'successfully claimed' "$OUT"; then echo "  ABORT: guessed marker still present"; exit 5; fi
echo "  probe absent / guessed marker gone: OK"

echo
echo "=== stage 2: install + start ==="
scp -q "$OUT" tower:/tmp/prime-patched10.js
ssh tower "docker cp /tmp/prime-patched10.js Free-Games-Claimer:/fgc/prime-gaming.js"
BACK=$(ssh tower "docker cp Free-Games-Claimer:/fgc/prime-gaming.js /tmp/v10-back.js >/dev/null && md5sum /tmp/v10-back.js | cut -d' ' -f1")
echo "  in-container hash: $BACK"
echo "  local hash       : $(md5 -q "$OUT")"
ssh tower "docker start Free-Games-Claimer" >/dev/null && echo "  container started (v10)"

echo
echo "=== stage 3: v10 run (240s) - every offer is already claimed, so this is regression proof ==="
sleep 240
ssh tower "docker logs --since 6m Free-Games-Claimer 2>&1 | grep -v 'still waiting on' | grep -E 'Number of|Current free game|External store|claim:|Code to redeem|offer failed|unhandled|Exception' | tail -14"
ssh tower "docker ps -a --filter name=Free-Games-Claimer --format '  container: {{.Status}}'"
echo
echo "=== codes reminder state intact after the rebuild ==="
python3 /Users/br00klyn/.hermes/profiles/kramer/scripts/fgc_redeem_codes.py || true
echo "  (no output above = state intact; the three codes stay reported)"
