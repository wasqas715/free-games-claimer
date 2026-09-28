"""Patch v5 for FGC's prime-gaming.js: visibility-gated sign-in, with the email value logged.

Evidence driving v5 (from the v4 run at 2026-09-28 04:11Z):
  * The page v4 got stuck on was Amazon's EMAIL step: submits = INPUT#continue[type=submit] only, and
    the only visible input was INPUT#ap_email[name=email][type=email]. The probe's pwExists=true was a
    HIDDEN pre-rendered password field, so v4 typed into nothing and pressed Continue with a
    keystroke-typed email that Amazon rejected: "Wrong or Invalid email address or mobile phone number".
  * v2 (page.fill('[name=email]') then click input[type=submit]) DID reach the password page on
    earlier runs, and the earlier dump there read "Your password is incorrect". So fill() works for
    the email and the flow shape was right; keystroke-typing the email is what regressed it.
  * The configured email IS the account: the configured email must match the EMAIL hash in config.env.

v5 therefore:
  * email  -> fill() (v2-proven), with a read-back of the value length
  * submit -> #continue first, then the visible-submit cascade
  * password -> waits (up to 30s) for a VISIBLE password field before touching it, then types with
    real keystrokes (Amazon's JS discards programmatically-set values), read-back verified, refilled if lost
  * submits the password with Enter inside the field, then falls back to the button cascade
  * logs the email field's actual value at submit time and an uncapped inventory of inputs/submits,
    so "wrong email" can never be a guess again

usage: patch_prime_v5.py <v2.js> <v5.js>
"""
import sys

src_path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/prime-patched.js"
out_path = sys.argv[2] if len(sys.argv) > 2 else "/tmp/prime-patched5.js"

src = open(src_path, encoding="utf-8", errors="replace").read()

A = """      await page.fill('[name=email]', email);
      await page.click('input[type="submit"]');
      await page.fill('[name=password]', password);
      // await page.check('[name=rememberMe]'); // no longer exists
      await page.click('input[type="submit"]');"""

B = """      // PATCHED v5: visibility-gated sign-in (email via fill(), password via keystrokes), email logged.
      const VIS_EMAIL = ['#ap_email:visible', 'input[name=email]:visible', 'input[type=email]:visible'];
      const VIS_PW = ['#ap_password:visible', 'input[name=password]:visible', 'input[type=password]:visible'];
      const probe = async (tag) => {
        const d = await page.evaluate(() => {
          const describe = (sel) => [...document.querySelectorAll(sel)].slice(0, 20)
            .map(e => `${e.tagName}${e.id ? '#' + e.id : ''}[name=${e.name || '-'}][type=${e.type || '-'}]${e.offsetParent ? '' : '(hidden)'}`).join(', ');
          const pw = document.querySelector('#ap_password:not([hidden]), input[name=password], input[type=password]');
          const em = document.querySelector('#ap_email, input[name=email], input[type=email]');
          const pwVis = [...document.querySelectorAll('input[type=password]')].some(e => !!e.offsetParent);
          return {
            url: location.href.slice(0, 110),
            forms: document.forms.length,
            inputs: describe('input'),
            submits: describe('input[type=submit], button, [role=button]'),
            emailValue: em ? em.value : null,
            pwExists: !!pw, pwVisible: pwVis, pwFilled: pw ? (pw.value.length > 0) : null,
            captcha: !!document.querySelector('iframe[src*=captcha], .g-recaptcha, [id*=captcha], img[src*=captcha]'),
          };
        }).catch(_ => 'probe failed');
        console.error(`PRIME PROBE ${tag}: ${JSON.stringify(d)}`);
        return d;
      };
      const setField = async (selectors, value, label, useKeys) => {
        for (const s of selectors) {
          const loc = page.locator(s).first();
          if (!(await loc.count().catch(_ => 0))) continue;
          if (!(await loc.isVisible().catch(_ => false))) continue;
          await loc.click({ timeout: 15000 }).catch(_ => { });
          if (useKeys) {
            await loc.fill('', { timeout: 5000 }).catch(_ => { });
            await loc.type(value, { delay: 40, timeout: 120000 }).catch(async () => { await loc.fill(value, { timeout: 15000 }).catch(_ => { }); });
          } else {
            await loc.fill(value, { timeout: 15000 }).catch(async () => { await loc.type(value, { delay: 40, timeout: 120000 }).catch(_ => { }); });
          }
          const got = await loc.inputValue().catch(_ => null);
          console.log(`  ${label}: set via ${s}; field length now ${got === null ? '?' : got.length}`);
          if (got !== null) return s;
        }
        console.error(`  ${label}: no VISIBLE field accepted the value`);
        return null;
      };
      const submitAny = async (label) => {
        const cascade = ['#continue', '#signInSubmit', 'input[type="submit"]:visible', 'button:has-text("Sign in")', 'button:has-text("Continue")', 'input[type="submit"]'];
        for (const s of cascade) {
          const loc = page.locator(s).first();
          if (!(await loc.count().catch(_ => 0))) continue;
          const ok = await loc.click({ timeout: 15000 }).then(() => true).catch(_ => false);
          if (ok) { console.log(`  ${label}: clicked ${s}`); return s; }
        }
        console.error(`  ${label}: no submit control clicked`);
        return null;
      };
      const waitVisiblePw = async (ms) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          for (const s of VIS_PW) {
            const loc = page.locator(s).first();
            if (await loc.count().catch(_ => 0) && await loc.isVisible().catch(_ => false)) return loc;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        return null;
      };
      await probe('start');
      await setField(VIS_EMAIL, email, 'email', false);
      const preEmail = await probe('before-continue');
      await submitAny('continue');
      const pwLoc = await waitVisiblePw(30000);
      if (!pwLoc) {
        console.error('  no VISIBLE password field appeared within 30s of submitting the email');
        await probe('no-password-page');
      } else {
        console.log('  password page reached (visible password field found)');
        await setField(VIS_PW, password, 'password', true);
        const pre = await probe('before-password-submit');
        if (pre && pre.pwFilled === false) await setField(VIS_PW, password, 'password(refill)', true);
        await pwLoc.press('Enter', { timeout: 15000 }).catch(_ => { });
        console.log('  submit: pressed Enter inside the visible password field');
        await new Promise((r) => setTimeout(r, 10000));
        const after = await probe('after-password-submit');
        if (after && after.pwVisible) {
          console.log('still on a visible password field 10s after Enter — trying the button cascade');
          await submitAny('password-fallback');
          await probe('after-password-fallback');
        }
      }"""

n = src.count(A)
assert n == 1, "anchor appears %d times, refusing" % n
src = src.replace(A, B)

open(out_path, "w", encoding="utf-8").write(src)
print("  applied v5 sign-in patch; wrote %s (%d bytes)" % (out_path, len(src)))
