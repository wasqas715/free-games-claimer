"""v7 for FGC's prime-gaming.js: slug-first store identity + stop the linking gate eating codes.

Evidence (clean v6 run, 2026-09-27 23:37-23:56Z, from prime-gaming.json):
  * 9 offers recorded claimed; 6 recorded "failed: need account linking" and were SKIPPED entirely.
  * The gate at (orig) line 196 aborts on ANY div whose text contains "Link game account"/"Link account",
    and the code/redeem block lives in the else branch -> a key-bearing offer that trips the gate
    silently loses its code. DOOM Eternal (offer URL ...-doom-eternal-microsoft) was labelled
    "life for pc on epic games store" from page boilerplate and lost its Microsoft key that way.
  * Store identity came from page text, which is boilerplate. The offer URL slug is authoritative:
    weakless-gog, doom-doom-ii-gog, doom-eternal-microsoft, the-da-vinci-cryptex-legacy.
  * The app's own redeem map (orig 209-215) keys on EXACT strings: 'gog.com', 'microsoft store',
    'legacy games'. v6's fallback emitted bare 'gog', which does not match -> GOG keys would have
    been missed (Zoria: Age of Shattering recorded claimed with no code field).

v7:
  1. Store from the URL slug first, mapped to the exact strings the redeem map expects.
  2. The linking gate becomes evidence, not an abort: the old else-body runs unconditionally, so key
     stores always reach the code capture. Status still records when a linking control was present.
  3. Alias keys added to the redeem map as insurance.

usage: patch_prime_v7.py <in.js> <out.js>
"""
import sys

src_path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/prime-patched6.js"
out_path = sys.argv[2] if len(sys.argv) > 2 else "/tmp/prime-patched7.js"

src = open(src_path, encoding="utf-8", errors="replace").read()
counts = {"store": 0, "gate": 0, "status": 0, "redeemmap": 0}

# --- 1. store identity: slug first, mapped to the exact strings the redeem map uses -------------
V6_STORE = """    let store = '';
    const storeFromText = /on ([a-z0-9 ._'-]+?)\\.?$/.exec(item_text.trim().toLowerCase());
    if (storeFromText) store = storeFromText[1].trim();
    if (!store) {
      const storeFromSlug = /-(gog|epic|legacy-games|xbox|microsoft|ea|origin|ubisoft|rockstar)(?:$|[/-])/.exec(url.toLowerCase());
      store = storeFromSlug ? storeFromSlug[1] : 'unknown';
    }
"""

V7_STORE = """    // PATCHED v7: the offer URL slug is authoritative; page text is boilerplate. The mapped values
    // MUST match the app's redeem map keys exactly ('gog.com', 'microsoft store', 'legacy games'),
    // otherwise the code capture below never runs for that store.
    const SLUG_STORE = {
      gog: 'gog.com',
      epic: 'epic games store',
      'legacy-games': 'legacy games',
      legacy: 'legacy games',
      microsoft: 'microsoft store',
      xbox: 'microsoft store',
      ea: 'ea',
      origin: 'origin',
      ubisoft: 'ubisoft',
      rockstar: 'rockstar',
      blizzard: 'blizzard',
    };
    const slugKey = (url.toLowerCase().match(/-(gog|epic|legacy-games|legacy|microsoft|xbox|ea|origin|ubisoft|rockstar|blizzard)(?:$|[/?])/) || [])[1] || '';
    let store = SLUG_STORE[slugKey] || '';
    if (store) {
      console.log(`  External store: ${store} (from offer URL slug: -${slugKey})`);
    } else {
      const textStore = /available on ([a-z0-9 ._'-]+?)[.\\s]*$/.exec((item_text || '').trim().toLowerCase());
      store = (textStore && textStore[1].trim()) || 'unknown';
      console.log(`  External store: ${store} (no store slug in the URL; read from page text)`);
    }
"""
if V6_STORE in src:
    src = src.replace(V6_STORE, V7_STORE, 1)
    counts["store"] += 1

# --- 2. the linking gate: warn, do not abort ----------------------------------------------------
lines = src.splitlines(keepends=True)
out, i, gate_seen = [], 0, False
while i < len(lines):
    line = lines[i]
    if (not gate_seen
            and 'if (await page.locator(\'div:has-text("Link game account")\').count()' in line):
        gate_seen = True
        # consume through the matching "} else {"
        j = i
        while j < len(lines) and lines[j].strip() != "} else {":
            j += 1
        i = j + 1  # skip the "} else {" line too
        out.append("""    // PATCHED v7: the original gate aborted the whole claim on ANY div containing the words
    // "Link account" and skipped the code/redeem block below - key-bearing offers (microsoft, gog,
    // legacy games) silently lost their codes that way. The old else-body now runs unconditionally.
    const linkingControl = await page.locator(
      'button:has-text("Link account"), a:has-text("Link account"), [data-a-target*="LinkAccount"]'
    ).count();
    if (linkingControl) {
      console.error('  NOTE: an account-linking control is present on this offer page -');
      console.error('  v7 continues anyway so a key store still yields its code.');
      notify_game.status = `needs account linking? for ${store}`;
    }
    {
""")
        counts["gate"] += 1
        continue
    out.append(line)
    i += 1
src = "".join(out)

# --- 3. status line: record when a linking control was present ----------------------------------
V6_STATUS = "      db.data[user][title].status = 'claimed';\n"
V7_STATUS = "      db.data[user][title].status = linkingControl ? 'claimed? (linking control present)' : 'claimed';\n"
if V6_STATUS in src:
    src = src.replace(V6_STATUS, V7_STATUS, 1)
    counts["status"] += 1

# --- 4. insurance: alias keys in the redeem map -------------------------------------------------
V6_MAP = """        'gog.com': 'https://www.gog.com/redeem',"""
V7_MAP = """        'gog.com': 'https://www.gog.com/redeem',
        gog: 'https://www.gog.com/redeem',"""
if V6_MAP in src:
    src = src.replace(V6_MAP, V7_MAP, 1)
    counts["redeemmap"] += 1

open(out_path, "w", encoding="utf-8").write(src)
print("  replacements:", counts)
missing = [k for k, v in counts.items() if v == 0]
if missing:
    print("  WARNING: no match for:", ", ".join(missing))
    sys.exit(2)
print("  output:", out_path, len(src), "bytes")
