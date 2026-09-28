"""v8 for FGC's prime-gaming.js: stop one bad offer from killing the sweep, and tag claim outcomes.

Evidence (v7 run, 2026-09-28 00:26-00:29Z):
  * Store mapping fixed: "External store: gog.com (from offer URL slug: -gog)"; the linking gate no
    longer aborts (v7 change confirmed working).
  * Then the code capture threw and ended the external sweep at offer #1:
        [AggregateError: All promises were rejected] { errors: [
          page.inputValue: Timeout 60000ms exceeded. - waiting for locator('input[type="text"]'),
          page.textContent: Timeout 60000ms exceeded. - waiting for locator('[data-a-target="ClaimStateClaimCodeContent"]') ]}
    An already-claimed offer (or one with no key) has no code element on the page, and that unguarded
    Promise.any was fatal - the remaining 7 offers were never attempted.
  * Amazon's own list is ground truth: "free unclaimed games (external stores): 8" (was 13), so 5
    external offers genuinely claimed. App-side "claimed" is the app's assumption only.

v8:
  1. Code capture non-fatal: 15s timeouts, try/catch, continue ("no code" = already claimed / no key).
  2. Per-offer try/catch around the external loop body (indentation-matched close brace).
  3. Tagged claim diagnostics: log WHICH condition resolved instead of "a claim control responded".

usage: patch_prime_v8.py <in.js> <out.js>
"""
import sys

src_path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/prime-patched7.js"
out_path = sys.argv[2] if len(sys.argv) > 2 else "/tmp/prime-patched8.js"

src = open(src_path, encoding="utf-8", errors="replace").read()
counts = {"codeguard": 0, "tagged": 0, "loopwrap": 0}

V7_CODE = """        const code = await Promise.any([page.inputValue('input[type="text"]'), page.textContent('[data-a-target="ClaimStateClaimCodeContent"]').then(s => s.replace('Your code: ', ''))]); // input: Legacy Games; text: gog.com
"""
V8_CODE = """        // PATCHED v8: a missing code element must not abort the sweep. Already-claimed offers and
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
"""
if V7_CODE in src:
    src = src.replace(V7_CODE, V8_CODE, 1)
    counts["codeguard"] += 1

V6_TAGGED = """      await Promise.any([
        ...claimSelectors.map((s) => page.locator(s).first().click({ timeout: 20000 })),
        page.waitForSelector('div:has-text("Link game account")'),
        page.waitForSelector('.thank-you-title:has-text("Success")'),
        page.waitForSelector('text=/successfully claimed/i'),
      ]);
      console.log('  claim: a claim control responded');
"""
V8_TAGGED = """      // PATCHED v8: tag the winning condition so the log says what actually happened.
      const claimOutcome = await Promise.any([
        ...claimSelectors.map((s) => page.locator(s).first().click({ timeout: 20000 }).then(() => `clicked ${s}`)),
        page.waitForSelector('div:has-text("Link game account")').then(() => 'page shows a link-account prompt'),
        page.waitForSelector('.thank-you-title:has-text("Success")').then(() => 'page shows Success'),
        page.waitForSelector('text=/successfully claimed/i').then(() => 'page says successfully claimed'),
      ]);
      console.log('  claim:', claimOutcome);
"""
if V6_TAGGED in src:
    src = src.replace(V6_TAGGED, V8_TAGGED, 1)
    counts["tagged"] += 1

# per-offer isolation: the loop header sits at 2-space indent, so its closing brace is the next
# line that is exactly "  }" (all inner code is indented 4+).
lines = src.splitlines(keepends=True)
start = None
for idx, line in enumerate(lines):
    if line.startswith("  for (const { title, url } of external_info) {") and line.rstrip().endswith("{"):
        start = idx
        break
if start is not None:
    body_end = None
    for j in range(start + 1, len(lines)):
        if lines[j].rstrip() == "  }":
            body_end = j
            break
    if body_end:
        print("  loop wrap: header line %d, close line %d" % (start + 1, body_end + 1))
        for k in range(max(0, body_end - 2), min(len(lines), body_end + 2)):
            print("    %4d| %s" % (k + 1, lines[k].rstrip()[:96]))
        lines.insert(body_end, """    } catch (offerErr) {
      // PATCHED v8: one bad offer must never end the sweep (v7: offer #1 ended all remaining work).
      console.error('  offer failed, continuing with the next one:', String((offerErr && offerErr.message) || offerErr).split('\\n')[0]);
      continue;
    }
""")
        lines.insert(start + 1, "    try { // PATCHED v8: per-offer isolation\n")
        counts["loopwrap"] += 1
    else:
        print("  loop wrap: close brace not found - skipping (non-fatal, the code guard is the critical fix)")
src = "".join(lines)

open(out_path, "w", encoding="utf-8").write(src)
print("  replacements:", counts)
if counts["codeguard"] == 0 or counts["tagged"] == 0:
    print("  ABORT: the two critical replacements did not both apply")
    sys.exit(2)
print("  output:", out_path, len(src), "bytes")
