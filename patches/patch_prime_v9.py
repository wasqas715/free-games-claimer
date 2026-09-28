'''v9 final for FGC's prime-gaming.js: capture codes reliably and resolve store identity from either source.

Evidence:
  * v9 probe run (2026-09-28 01:0xZ): with a 4s settle after the claim click, the ORIGINAL code
    selectors worked and GOG keys were captured:
        Code to redeem game: RSKW863A6B539E2899   (Zoria: Age of Shattering)
        Code to redeem game: XQ5E04639C901458DA   (Weakless)
    Without the settle (v8) the same offers logged "none on the page" - the claim response renders
    a moment after the click.
  * Amazon's own counters moved 8 -> 13 claimed and 7 -> 2 unclaimed, so claims are landing.
  * Store identity is ambiguous in BOTH directions on real offers:
        Just Die Already: URL slug -epic,     page text "microsoft store" (gave a Microsoft code)
        DOOM Eternal:     URL slug -microsoft, page text "epic games store" (key was lost under v5/v6)
    So the redeem map is now tested against BOTH the slug store and the page-text store.
  * The probe build is temporary instrumentation; this build is the clean production one.

usage: patch_prime_v9.py <in.js> <out.js>
'''
import sys

src_path = sys.argv[1] if len(sys.argv) > 1 else '/tmp/prime-patched8.js'
out_path = sys.argv[2] if len(sys.argv) > 2 else '/tmp/prime-patched9.js'

src = open(src_path, encoding='utf-8', errors='replace').read()
counts = {'store_both': 0, 'redeem_either': 0, 'settle': 0}

V7_STORE = '''    let store = SLUG_STORE[slugKey] || '';
    if (store) {
      console.log(`  External store: ${store} (from offer URL slug: -${slugKey})`);
    } else {
      const textStore = /available on ([a-z0-9 ._'-]+?)[.\\s]*$/.exec((item_text || '').trim().toLowerCase());
      store = (textStore && textStore[1].trim()) || 'unknown';
      console.log(`  External store: ${store} (no store slug in the URL; read from page text)`);
    }
'''
V9_STORE = '''    // PATCHED v9: keep BOTH store signals. They disagreed in each direction on live offers, and
    // whichever one is a key store is the one that carries a code.
    const pageTextStore = (((item_text || '').trim().toLowerCase().replace(/\\s+/g, ' ').match(/on ([a-z0-9 ._'-]+)$/) || [])[1] || '').replace(/[\\s.]+$/, '');
    let store = SLUG_STORE[slugKey] || '';
    if (store) {
      console.log(`  External store: ${store} (from offer URL slug: -${slugKey})`);
      if (pageTextStore && pageTextStore !== store) {
        console.log(`  store disagreement: page text says "${pageTextStore}" - both are tested against the redeem map`);
      }
    } else {
      store = pageTextStore || 'unknown';
      console.log(`  External store: ${store} (no store slug in the URL; read from page text)`);
    }
'''
if V7_STORE in src:
    src = src.replace(V7_STORE, V9_STORE, 1)
    counts['store_both'] += 1

V6_REDEEM = '''      if (store in redeem) { // did not work for linked origin: && !await page.locator('div:has-text("Successfully Claimed")').count()
'''
V9_REDEEM = '''      // PATCHED v9: accept either store signal, so a misleading slug cannot cost a code.
      if (!(store in redeem) && pageTextStore && pageTextStore in redeem) {
        console.log(`  using page-text store "${pageTextStore}" instead of slug store "${store}" for the redeem map`);
        store = pageTextStore;
      }
      if (store in redeem) { // did not work for linked origin: && !await page.locator('div:has-text("Successfully Claimed")').count()
'''
if V6_REDEEM in src:
    src = src.replace(V6_REDEEM, V9_REDEEM, 1)
    counts['redeem_either'] += 1

V8_CODE = '''        // PATCHED v8: a missing code element must not abort the sweep. Already-claimed offers and
        // offers with no key have no code on the page; the unguarded Promise.any here threw an
        // AggregateError and ended the whole external sweep at offer #1 (v7 run).
        let code = '';
        try {
          code = await Promise.any([
            page.inputValue('input[type="text"]', { timeout: 15000 }),
            page.textContent('[data-a-target="ClaimStateClaimCodeContent"]', { timeout: 15000 }).then((s) => s.replace('Your code: ', '')),
          ]);
        } catch (codeErr) {
          console.error('  Code to redeem game: none on the page - already claimed, or this offer carries no key. Continuing.');
          continue;
        }
'''
V9_CODE = '''        // PATCHED v9: the claim response renders a moment after the click. Without this settle the
        // code capture read an empty page (v8: "none on the page"); with it the GOG keys came through.
        await new Promise((r) => setTimeout(r, 4000));
        let code = '';
        try {
          code = await Promise.any([
            page.inputValue('input[type="text"]', { timeout: 15000 }),
            page.textContent('[data-a-target="ClaimStateClaimCodeContent"]', { timeout: 15000 }).then((s) => s.replace('Your code: ', '')),
          ]);
        } catch (codeErr) {
          // v9 fallback: the Twitch-era code element is gone, so scan the page text for a code shape.
          const found = await page.evaluate(() => {
            const body = document.body ? document.body.innerText : '';
            return (body.match(/\\b[A-Z0-9]{4,6}(?:-[A-Z0-9]{4,6}){2,5}\\b|\\b[A-Z0-9]{16}\\b/g) || []).slice(0, 3);
          }).catch(() => []);
          if (found && found.length) {
            code = found[0];
            console.log('  Code to redeem game: ' + code + ' (recovered by scanning the page text)');
          } else {
            console.error('  Code to redeem game: none on the page - already claimed, or this offer carries no key. Continuing.');
            continue;
          }
        }
'''
if V8_CODE in src:
    src = src.replace(V8_CODE, V9_CODE, 1)
    counts['settle'] += 1

open(out_path, 'w', encoding='utf-8').write(src)
print('  replacements:', counts)
missing = [k for k, v in counts.items() if v == 0]
if missing:
    print('  ABORT: no match for', ', '.join(missing))
    sys.exit(2)
print('  output:', out_path, len(src), 'bytes')
