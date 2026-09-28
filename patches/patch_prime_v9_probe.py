'''v9-PROBE for FGC's prime-gaming.js: capture the live post-claim page structure.

Context (v8 run, 2026-09-28 00:5xZ): the sweep is unbreakable and the claim click is tagged and
firing ("claim: clicked button:has-text("Claim")"), but for key-bearing stores the code is never
found because the app reads it from Twitch-era markup that no longer exists:
    [data-a-target="ClaimStateClaimCodeContent"]   (was: text for gog.com)
    input[type="text"]                             (was: input for Legacy Games)
Also proven: store identity is ambiguous between the offer URL slug and the page text
(Just Die Already: slug -epic, real store microsoft, gave a Microsoft code; DOOM Eternal: slug
-microsoft, page text said epic games store), so the store must be read from the redemption UI.

TEMPORARY instrument. For each external offer, right after the claim click it dumps:
  url, page title, first 40 visible text lines, every input (id/name/type/value, hidden flagged),
  visible controls (buttons/links with data-a-target and label), and code-shaped tokens.

usage: patch_prime_v9_probe.py <in.js> <out.js>
'''
import sys

src_path = sys.argv[1] if len(sys.argv) > 1 else '/tmp/prime-patched8.js'
out_path = sys.argv[2] if len(sys.argv) > 2 else '/tmp/prime-patched9-probe.js'

src = open(src_path, encoding='utf-8', errors='replace').read()
counts = {'helper': 0, 'call': 0}

HELPER = '''  // PATCHED v9-PROBE (temporary): dump the live post-claim page so the code element and store
  // identity can be implemented from evidence instead of the removed Twitch-era markup.
  const fgcProbe = async (tag) => {
    try {
      const d = await page.evaluate(() => {
        const body = document.body ? document.body.innerText : '';
        const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
        const vis = (e) => !!e.offsetParent;
        const codeish = Array.from(new Set(body.match(/\\b[A-Z0-9]{4,6}(?:-[A-Z0-9]{4,6}){2,5}\\b/g) || [])).slice(0, 6);
        return {
          url: location.href.slice(0, 150),
          ptitle: (document.title || '').slice(0, 90),
          text: body.split('\\n').map((s) => s.trim()).filter(Boolean).slice(0, 40),
          inputs: Array.from(document.querySelectorAll('input, textarea')).slice(0, 15).map((e) => 'INPUT#' + (e.id || '-') + '[name=' + (e.name || '-') + '][type=' + e.type + ']' + (vis(e) ? '' : '(hidden)') + 'val=' + clean(e.value).slice(0, 40)),
          controls: Array.from(document.querySelectorAll('button, a, [role=button], [data-a-target]')).filter(vis).slice(0, 22).map((e) => e.tagName + (e.id ? '#' + e.id : '') + (e.getAttribute('data-a-target') ? '[data-a-target=' + e.getAttribute('data-a-target') + ']' : '') + ': ' + clean(e.innerText).slice(0, 45)),
          codeish,
        };
      });
      console.error('FGC PROBE ' + tag + ': ' + JSON.stringify(d));
    } catch (probeErr) {
      console.error('FGC PROBE ' + tag + ': failed - ' + String((probeErr && probeErr.message) || probeErr).slice(0, 120));
    }
  };
'''

CALL = '''      await new Promise((r) => setTimeout(r, 4000)); // let the claim response settle
      await fgcProbe(store + ' :: ' + title);
'''

anchor_loop = '  for (const { title, url } of external_info) {'
if anchor_loop in src:
    src = src.replace(anchor_loop, HELPER + anchor_loop, 1)
    counts['helper'] += 1

anchor_claim = "      console.log('  claim:', claimOutcome);\n"
if anchor_claim in src:
    src = src.replace(anchor_claim, anchor_claim + CALL, 1)
    counts['call'] += 1

open(out_path, 'w', encoding='utf-8').write(src)
print('  replacements:', counts)
if counts['helper'] == 0 or counts['call'] == 0:
    print('  ABORT: probe not inserted')
    sys.exit(2)
print('  output:', out_path, len(src), 'bytes')
