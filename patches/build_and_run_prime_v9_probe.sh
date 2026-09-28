#!/bin/bash
set -u
S=/Users/br00klyn/.hermes/profiles/kramer/scripts
IN=/tmp/prime-v9-in.js
OUT=/tmp/prime-patched9-probe.js
DUMP=/Users/br00klyn/.hermes/profiles/kramer/state/fgc-v9-probe.log

echo "=== stage 1: build v9-PROBE from the verified v8 payload ==="
scp -q tower:/tmp/prime-patched8.js "$IN"
echo "  v8 in : $(md5 -q "$IN")  $(wc -c < "$IN" | tr -d ' ') bytes"
python3 "$S/patch_prime_v9_probe.py" "$IN" "$OUT" || { echo "  ABORT: patch failed"; exit 3; }
echo "  probe : $(md5 -q "$OUT")  $(wc -c < "$OUT" | tr -d ' ') bytes"
node --check "$OUT" && echo "  node --check: OK"

echo
echo "=== stage 2: install + start ==="
scp -q "$OUT" tower:/tmp/prime-patched9-probe.js
ssh tower "docker cp /tmp/prime-patched9-probe.js Free-Games-Claimer:/fgc/prime-gaming.js"
BACK=$(ssh tower "docker cp Free-Games-Claimer:/fgc/prime-gaming.js /tmp/v9probe-back.js >/dev/null && md5sum /tmp/v9probe-back.js | cut -d' ' -f1")
echo "  in-container hash: $BACK"
echo "  local hash       : $(md5 -q "$OUT")"
ssh tower "docker start Free-Games-Claimer" >/dev/null && echo "  container started (probe build)"

echo
echo "=== stage 3: collecting probes (240s) ==="
sleep 240
mkdir -p "$(dirname "$DUMP")"
ssh tower "docker logs --since 8m Free-Games-Claimer 2>&1 | grep 'FGC PROBE' | head -8" > "$DUMP"
echo "  probes captured: $(grep -c 'FGC PROBE' "$DUMP" || true)"
echo "  saved to: $DUMP"
echo
echo "=== claim sweep context ==="
ssh tower "docker logs --since 8m Free-Games-Claimer 2>&1 | grep -v 'still waiting on' | grep -E 'Current free game|External store|claim:|Code to redeem|Number of' | tail -24"
