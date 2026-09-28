'''v10 for FGC's prime-gaming.js: trust the page's own success marker instead of guessing.

Evidence (v9 probe dump, 2026-09-28 01:0xZ, luna.amazon.com/claims/weakless-gog/.../details):
  the page text contains exactly "Success, you received a code to redeem Weakless." followed by
  "Claim Code", and the Keep Exploring list shows "<game>", "Collected", "Collected on Sep 28, 2026".
  The v8 diagnostic waits on guessed markers ('successfully claimed', '.thank-you-title') that never
  match this page: each burns its full timeout per offer and reports a false negative, which is also
  how the app came to record genuinely claimed offers as "failed: need account linking".

v10:
  1. Claim diagnostics wait on the REAL markers, so the log names what happened instead of timing out.
  2. The stored status is derived from that marker (evidence) rather than inferred from page text.

usage: patch_prime_v10.py <in.js> <out.js>
'''
import sys

src_path = sys.argv[1] if len(sys.argv) > 1 else '/tmp/prime-patched9.js'
out_path = sys.argv[2] if len(sys.argv) > 2 else '/tmp/prime-patched10.js'

src = open(src_path, encoding='utf-8', errors='replace').read()
counts = {'markers': 0, 'status': 0}

V8_MARKERS = '''        page.waitForSelector('div:has-text("Link game account")').then(() => 'page shows a link-account prompt'),
        page.waitForSelector('.thank-you-title:has-text("Success")').then(() => 'page shows Success'),
        page.waitForSelector('text=/successfully claimed/i').then(() => 'page says successfully claimed'),
'''

V10_MARKERS = '''        // PATCHED v10: the real Luna claim-page marker (probe-verified). The old guesses never
        // matched this page, so each burned its full timeout and reported a false negative.
        page.waitForSelector('text=/Success, you received a code to redeem/i', { timeout: 25000 }).then(() => 'page says: Success, you received a code to redeem'),
        page.waitForSelector('text=/Collected on/i', { timeout: 25000 }).then(() => 'page shows Collected on <date>'),
        page.waitForSelector('.thank-you-title:has-text("Success")').then(() => 'page shows Success'),
        page.waitForSelector('div:has-text("Link game account")').then(() => 'page shows a link-account prompt'),
'''
if V8_MARKERS in src:
    src = src.replace(V8_MARKERS, V10_MARKERS, 1)
    counts['markers'] += 1

V7_STATUS = "      db.data[user][title].status = linkingControl ? 'claimed? (linking control present)' : 'claimed';\n"
V10_STATUS = '''      // PATCHED v10: status comes from the page's own marker, not an inference. This inference is
      // what made the app record genuinely claimed offers as "failed: need account linking".
      const claimConfirmed = await page.evaluate(() => /Success, you received a code to redeem|Collected on/i.test(document.body ? document.body.innerText : '')).catch(() => false);
      db.data[user][title].status = claimConfirmed ? 'claimed' : (linkingControl ? 'claimed? (linking control present)' : 'claimed (unconfirmed)');
'''
if V7_STATUS in src:
    src = src.replace(V7_STATUS, V10_STATUS, 1)
    counts['status'] += 1

open(out_path, 'w', encoding='utf-8').write(src)
print('  replacements:', counts)
missing = [k for k, v in counts.items() if v == 0]
if missing:
    print('  ABORT: no match for', ', '.join(missing))
    sys.exit(2)
print('  output:', out_path, len(src), 'bytes')
