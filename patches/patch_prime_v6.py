"""v6 for FGC's prime-gaming.js: make the claim phase survivable and diagnosable.

Evidence (runs 2026-09-27 23:36-23:41Z, AFTER the credential fix made login work):
  * Login completes: "Login complete, landed on https://luna.amazon.com/claims/home?signedIn=true"
  * The run then dies on an UNHANDLED promise rejection:
        page.innerText: Timeout 60000ms exceeded.
        waiting for locator('[data-a-target="DescriptionItemDetails"]')
        at /fgc/prime-gaming.js:307:34
    That node is Twitch-era markup in the EXTERNAL-store loop; Prime Gaming no longer renders
    data-a-target attributes, so the throw kills the process before claims complete.
  * Both login watchers are fire-and-forget (page.waitForURL(...).then(...)) with no catch; their
    rejections are also unhandled and produce the misleading
    "Target page, context or browser has been closed" stack after the fact.

v6 changes:
  1. process.on('unhandledRejection') guard: log and continue instead of dying.
  2. External-store description: guarded read, text fallback, then store inferred from the URL slug.
  3. External claim click: modern button cascade; on total failure dump the page's visible
     controls (live DOM evidence) and skip that game instead of killing the run.
  4. Login-wait log cadence 12 -> 60 iterations.

usage: patch_prime_v6.py <in.js> <out.js>
"""
import sys

src_path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/prime-patched5.js"
out_path = sys.argv[2] if len(sys.argv) > 2 else "/tmp/prime-patched6.js"

src = open(src_path, encoding="utf-8", errors="replace").read()
lines = src.splitlines(keepends=True)
out = []
counts = {"guard": 0, "desc": 0, "claim": 0, "cadence": 0}
i = 0

GUARD = """      // PATCHED v6: never let a background watcher's rejection kill the run.
      process.on('unhandledRejection', (reason) => {
        console.error('  unhandled rejection (continuing):', reason && reason.message ? String(reason.message).split('\\n')[0] : String(reason));
      });
"""

DESC_NEW = """    // PATCHED v6: Prime Gaming no longer renders the Twitch-era DescriptionItemDetails node.
    let item_text = '';
    try {
      item_text = await page.innerText('[data-a-target="DescriptionItemDetails"]', { timeout: 8000 });
    } catch (_) {
      item_text = await page.locator('text=/[Aa]vailable on /').first().innerText({ timeout: 5000 }).catch(() => '');
      if (!item_text) console.log('  (no description node - inferring the external store from the offer URL)');
    }
    let store = '';
    const storeFromText = /on ([a-z0-9 ._'-]+?)\\.?$/.exec(item_text.trim().toLowerCase());
    if (storeFromText) store = storeFromText[1].trim();
    if (!store) {
      const storeFromSlug = /-(gog|epic|legacy-games|xbox|microsoft|ea|origin|ubisoft|rockstar)(?:$|[/-])/.exec(url.toLowerCase());
      store = storeFromSlug ? storeFromSlug[1] : 'unknown';
    }
"""

CLAIM_NEW = """    // PATCHED v6: modern claim cascade; a failure skips this game instead of killing the run.
    const claimSelectors = [
      '[data-a-target="buy-box"] .tw-button:has-text("Get game")',
      '[data-a-target="buy-box"] .tw-button:has-text("Claim")',
      '.tw-button:has-text("Complete Claim")',
      'button:has-text("Get game")',
      'button:has-text("Claim")',
      'button:has-text("Redeem")',
      'a:has-text("Claim")',
    ];
    try {
      await Promise.any([
        ...claimSelectors.map((s) => page.locator(s).first().click({ timeout: 20000 })),
        page.waitForSelector('div:has-text("Link game account")'),
        page.waitForSelector('.thank-you-title:has-text("Success")'),
        page.waitForSelector('text=/successfully claimed/i'),
      ]);
      console.log('  claim: a claim control responded');
    } catch (claimErr) {
      const seen = await page.evaluate(() => [...document.querySelectorAll('button, a, [role=button]')]
        .filter((e) => e.offsetParent)
        .slice(0, 40)
        .map((e) => `${e.tagName}${e.getAttribute('data-a-target') ? '[data-a-target=' + e.getAttribute('data-a-target') + ']' : ''}: ${(e.innerText || '').trim().slice(0, 40)}`)
        .join(' | ')).catch(() => 'dump failed');
      console.error('  claim: no control responded -', String(claimErr && claimErr.message).split('\\n')[0]);
      console.error('  claim: visible controls on', page.url(), '->', seen);
      continue;
    }
"""

while i < len(lines):
    line = lines[i]

    # 1. insert the rejection guard just before the credential watcher
    if "waitForURL('**/ap/signin**').then(async () => { // check for wrong credentials" in line and counts["guard"] == 0:
        out.append(GUARD)
        counts["guard"] += 1
        out.append(line)
        i += 1
        continue

    # 2. external-store description: replace the two-line unguarded read
    if "const item_text = await page.innerText('[data-a-target=\"DescriptionItemDetails\"]');" in line:
        nxt = lines[i + 1] if i + 1 < len(lines) else ""
        if "const store = item_text.toLowerCase()" in nxt:
            out.append(DESC_NEW)
            counts["desc"] += 1
            i += 2
            continue

    # 3. external claim click: replace the whole single-line Promise.any
    if line.lstrip().startswith("await Promise.any([page.click('[data-a-target=\"buy-box\"] .tw-button:has-text(\"Get game\")')"):
        out.append(CLAIM_NEW)
        counts["claim"] += 1
        i += 1
        continue

    out.append(line)
    i += 1

text = "".join(out)
if "++same % 12 === 0" in text:
    text = text.replace("++same % 12 === 0", "++same % 60 === 0", 1)
    counts["cadence"] = 1

open(out_path, "w", encoding="utf-8").write(text)

print("  replacements:", counts)
missing = [k for k, v in counts.items() if v == 0]
if missing:
    print("  WARNING: no match for:", ", ".join(missing))
    sys.exit(2)
print("  output:", out_path, len(text), "bytes")
