import { firefox } from 'playwright-firefox'; // stealth plugin needs no outdated playwright-extra
import { authenticator } from 'otplib';
import chalk from 'chalk';
import { resolve, jsonDb, datetime, stealth, filenamify, prompt, confirm, notify, html_game_list, handleSIGINT } from './src/util.js';
import { cfg } from './src/config.js';

const screenshot = (...a) => resolve(cfg.dir.screenshots, 'prime-gaming', ...a);

// const URL_LOGIN = 'https://www.amazon.de/ap/signin'; // wrong. needs some session args to be valid?
const URL_CLAIM = 'https://gaming.amazon.com/home';

console.log(datetime(), 'started checking prime-gaming');

const db = await jsonDb('prime-gaming.json', {});

// https://playwright.dev/docs/auth#multi-factor-authentication
const context = await firefox.launchPersistentContext(cfg.dir.browser, {
  headless: cfg.headless,
  viewport: { width: cfg.width, height: cfg.height },
  locale: 'en-US', // ignore OS locale to be sure to have english text for locators
  recordVideo: cfg.record ? { dir: 'data/record/', size: { width: cfg.width, height: cfg.height } } : undefined, // will record a .webm video for each page navigated; without size, video would be scaled down to fit 800x800
  recordHar: cfg.record ? { path: `data/record/pg-${filenamify(datetime())}.har` } : undefined, // will record a HAR file with network requests and responses; can be imported in Chrome devtools
  handleSIGINT: false, // have to handle ourselves and call context.close(), otherwise recordings from above won't be saved
});

handleSIGINT(context);

// TODO test if needed
await stealth(context);

if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);

const page = context.pages().length ? context.pages()[0] : await context.newPage(); // should always exist
await page.setViewportSize({ width: cfg.width, height: cfg.height }); // TODO workaround for https://github.com/vogler/free-games-claimer/issues/277 until Playwright fixes it
// console.debug('userAgent:', await page.evaluate(() => navigator.userAgent));

const notify_games = [];
let user;

try {
  await page.goto(URL_CLAIM, { waitUntil: 'domcontentloaded' }); // default 'load' takes forever
  // need to wait for some elements to exist before checking if signed in or accepting cookies:
  await Promise.any(['button:has-text("Sign in")', '[data-a-target="user-dropdown-first-name-text"]'].map(s => page.waitForSelector(s)));
  page.click('[aria-label="Cookies usage disclaimer banner"] button:has-text("Accept Cookies")').catch(_ => { }); // to not waste screen space when non-headless, TODO does not work reliably, need to wait for something else first?
  while (await page.locator('button:has-text("Sign in")').count() > 0) {
    console.error('Not signed in anymore.');
    await page.click('button:has-text("Sign in")');
    if (!cfg.debug) context.setDefaultTimeout(cfg.login_timeout); // give user some extra time to log in
    console.info(`Login timeout is ${cfg.login_timeout / 1000} seconds!`);
    if (cfg.pg_email && cfg.pg_password) console.info('Using email and password from environment.');
    else console.info('Press ESC to skip the prompts if you want to login in the browser (not possible in headless mode).');
    const email = cfg.pg_email || await prompt({ message: 'Enter email' });
    const password = email && (cfg.pg_password || await prompt({ type: 'password', message: 'Enter password' }));
    if (email && password) {
      // PATCHED v5: visibility-gated sign-in (email via fill(), password via keystrokes), email logged.
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
      }
      // PATCHED v6: never let a background watcher's rejection kill the run.
      process.on('unhandledRejection', (reason) => {
        console.error('  unhandled rejection (continuing):', reason && reason.message ? String(reason.message).split('\n')[0] : String(reason));
      });
      page.waitForURL('**/ap/signin**').then(async () => { // check for wrong credentials
        let error = '';
        const alertCount = await page.locator('.a-alert-content').count().catch(_ => 0);
        if (alertCount) error = await page.locator('.a-alert-content').first().innerText().catch(_ => '');
        // FIXED: was `if (!error.trim.length) return;` — `.length` was read off the trim function,
        // always 0, so this always returned early and every credential error went unreported.
        if (!error.trim().length) {
          // No alert box: dump what the page actually shows so a captcha/challenge is identifiable
          // from the log instead of looking like a silent hang.
          const shown = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 400)).catch(_ => '?');
          console.error('Sign-in page has no alert box. Page shows:', shown);
          return;
        }
        console.error('Login error:', error);
        await notify(`prime-gaming: login: ${error}`);
        await context.close(); // finishes potential recording
        process.exit(1);
      });
      // handle MFA, but don't await it
      page.waitForURL('**/ap/mfa**').then(async () => {
        console.log('Two-Step Verification - enter the One Time Password (OTP), e.g. generated by your Authenticator App');
        await page.check('[name=rememberDevice]');
        const otp = cfg.pg_otpkey && authenticator.generate(cfg.pg_otpkey) || await prompt({ type: 'text', message: 'Enter two-factor sign in code', validate: n => n.toString().length == 6 || 'The code must be 6 digits!' }); // can't use type: 'number' since it strips away leading zeros and codes sometimes have them
        await page.locator('input[name=otpCode]').pressSequentially(otp.toString());
        await page.click('input[type="submit"]');
      }).catch(_ => { });
    } else {
      console.log('Waiting for you to login in the browser.');
      await notify('prime-gaming: no longer signed in and not enough options set for automatic login.');
      if (cfg.headless) {
        console.log('Run `SHOW=1 node prime-gaming` to login in the opened browser.');
        await context.close(); // finishes potential recording
        process.exit(1);
      }
    }
    // PATCHED: Amazon's return path drifts (na.account.amazon.com/ap/sso round trip) and does not
    // always come back with the exact query string the old code required. Accept the drifted shapes,
    // log each URL change, and fail fast with the stuck URL instead of 30 silent minutes.
    {
      const landedOk = (u) => !/\/ap\/|\/login|\/errors\//.test(u) &&
        (/gaming\.amazon\.com\/home/.test(u) || /luna\.amazon\.com\/(claims\/home|home)/.test(u));
      const budgetMs = Math.min(cfg.login_timeout, 300000);
      const deadline = Date.now() + budgetMs;
      let landed = null, lastUrl = '', same = 0;
      while (Date.now() < deadline) {
        const u = page.url();
        if (u !== lastUrl) { same = 0; console.log(`post-login url: ${u}`); lastUrl = u; }
        else if (++same % 60 === 0) console.log(`still waiting on: ${u}`);
        if (landedOk(u)) { landed = u; break; }
        const dropdown = await page.locator('[data-a-target="user-dropdown-first-name-text"]').count().catch(_ => 0);
        if (dropdown) { landed = u; break; }
        await new Promise((r) => setTimeout(r, 5000));
      }
      if (landed) {
        console.log(`Login complete, landed on ${landed}`);
      } else {
        const title = await page.title().catch(_ => '?');
        const shown = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 300)).catch(_ => '?');
        console.error(`Login did NOT complete within ${Math.round(budgetMs / 1000)}s. Stuck on: ${lastUrl} (title: ${title})`);
        console.error('Page shows:', shown);
        await notify(`prime-gaming: login stalled on ${lastUrl}`);
        await context.close();
        process.exit(1);
      }
    }
    if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);
  }
  user = await page.locator('[data-a-target="user-dropdown-first-name-text"]').first().innerText();
  console.log(`Signed in as ${user}`);
  // await page.click('button[aria-label="User dropdown and more options"]');
  // const twitch = await page.locator('[data-a-target="TwitchDisplayName"]').first().innerText();
  // console.log(`Twitch user name is ${twitch}`);
  db.data[user] ||= {};

  if (await page.getByRole('button', { name: 'Try Prime' }).count()) {
    console.error('User is currently not an Amazon Prime member, so no games to claim. Exit!');
    await context.close();
    process.exit(1);
  }

  const waitUntilStable = async (f, act) => {
    let v;
    while (true) {
      const v2 = await f();
      console.log('waitUntilStable', v2);
      if (v == v2) break;
      v = v2;
      await act();
    }
  };
  const scrollUntilStable = async f => await waitUntilStable(f, async () => {
    // await page.keyboard.press('End'); // scroll to bottom to show all games
  // loading all games became flaky; see https://github.com/vogler/free-games-claimer/issues/357
    await page.keyboard.press('PageDown'); // scrolling to straight to the bottom started to skip loading some games
    await page.waitForLoadState('networkidle'); // wait for all games to be loaded
    await page.waitForTimeout(3000); // TODO networkidle wasn't enough to load all already collected games
    // do it again since once wasn't enough...
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(3000);
  });

  await page.click('button[data-type="Game"]');
  const games = page.locator('div[data-a-target="offer-list-FGWP_FULL"]');
  await games.waitFor();
  // await scrollUntilStable(() => games.locator('.item-card__action').count()); // number of games
  await scrollUntilStable(() => page.evaluate(() => document.querySelector('.tw-full-width').scrollHeight)); // height may change during loading while number of games is still the same?
  console.log('Number of already claimed games (total):', await games.locator('p:has-text("Collected")').count());
  // can't use .all() since the list of elements via locator will change after click while we iterate over it
  const internal = await games.locator('.item-card__action:has(button[data-a-target="FGWPOffer"])').elementHandles();
  const external = await games.locator('.item-card__action:has(a[data-a-target="FGWPOffer"])').all();
  // bottom to top: oldest to newest games
  internal.reverse();
  external.reverse();
  const sameOrNewPage = async url => new Promise(async (resolve, _reject) => {
    const isNew = page.url() != url;
    let p = page;
    if (isNew) {
      p = await context.newPage();
      await p.goto(url, { waitUntil: 'domcontentloaded' });
    }
    resolve([p, isNew]);
  });
  const skipBasedOnTime = async url => {
    // console.log('  Checking time left for game:', url);
    const [p, isNew] = await sameOrNewPage(url);
    const dueDateOrg = await p.locator('.availability-date .tw-bold').innerText();
    const dueDate = new Date(Date.parse(dueDateOrg + ' 17:00'));
    const daysLeft = (dueDate.getTime() - Date.now())/1000/60/60/24;
    console.log(' ', await p.locator('.availability-date').innerText(), '->', daysLeft.toFixed(2));
    if (isNew) await p.close();
    return daysLeft > cfg.pg_timeLeft;
  }
  console.log('\nNumber of free unclaimed games (Prime Gaming):', internal.length);
  // claim games in internal store
  for (const card of internal) {
    await card.scrollIntoViewIfNeeded();
    const title = await (await card.$('.item-card-details__body__primary')).innerText();
    const slug = await (await card.$('a')).getAttribute('href');
    const url = 'https://gaming.amazon.com' + slug.split('?')[0];
    console.log('Current free game:', chalk.blue(title));
    if (cfg.pg_timeLeft && await skipBasedOnTime(url)) continue;
    if (cfg.dryrun) continue;
    if (cfg.interactive && !await confirm()) continue;
    await (await card.$('.tw-button:has-text("Claim")')).click();
    db.data[user][title] ||= { title, time: datetime(), url, store: 'internal' };
    notify_games.push({ title, status: 'claimed', url });
    // const img = await (await card.$('img.tw-image')).getAttribute('src');
    // console.log('Image:', img);
    await card.screenshot({ path: screenshot('internal', `${filenamify(title)}.png`) });
  }
  console.log('\nNumber of free unclaimed games (external stores):', external.length);
  // claim games in external/linked stores. Linked: origin.com, epicgames.com; Redeem-key: gog.com, legacygames.com, microsoft
  const external_info = [];
  for (const card of external) { // need to get data incl. URLs in this loop and then navigate in another, otherwise .all() would update after coming back and .elementHandles() like above would lead to error due to page navigation: elementHandle.$: Protocol error (Page.adoptNode)
    const title = await card.locator('.item-card-details__body__primary').innerText();
    const slug = await card.locator('a:has-text("Claim")').first().getAttribute('href');
    const url = 'https://gaming.amazon.com' + slug.split('?')[0];
    // await (await card.$('text=Claim')).click(); // goes to URL of game, no need to wait
    external_info.push({ title, url });
  }
  // external_info = [ { title: 'Fallout 76 (XBOX)', url: 'https://gaming.amazon.com/fallout-76-xbox-fgwp/dp/amzn1.pg.item.9fe17d7b-b6c2-4f58-b494-cc4e79528d0b?ingress=amzn&ref_=SM_Fallout76XBOX_S01_FGWP_CRWN' } ];
  for (const { title, url } of external_info) {
    try { // PATCHED v8: per-offer isolation
    console.log('Current free game:', chalk.blue(title)); // , url);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (cfg.debug) await page.pause();
    // PATCHED v6: Prime Gaming no longer renders the Twitch-era DescriptionItemDetails node.
    let item_text = '';
    try {
      item_text = await page.innerText('[data-a-target="DescriptionItemDetails"]', { timeout: 8000 });
    } catch (_) {
      item_text = await page.locator('text=/[Aa]vailable on /').first().innerText({ timeout: 5000 }).catch(() => '');
      if (!item_text) console.log('  (no description node - inferring the external store from the offer URL)');
    }
    // PATCHED v7: the offer URL slug is authoritative; page text is boilerplate. The mapped values
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
    // PATCHED v9: keep BOTH store signals. They disagreed in each direction on live offers, and
    // whichever one is a key store is the one that carries a code.
    const pageTextStore = (((item_text || '').trim().toLowerCase().replace(/\s+/g, ' ').match(/on ([a-z0-9 ._'-]+)$/) || [])[1] || '').replace(/[\s.]+$/, '');
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
    console.log('  External store:', store);
    if (cfg.pg_timeLeft && await skipBasedOnTime(url)) continue;
    if (cfg.dryrun) continue;
    if (cfg.interactive && !await confirm()) continue;
    // PATCHED v6: modern claim cascade; a failure skips this game instead of killing the run.
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
      // PATCHED v8: tag the winning condition so the log says what actually happened.
      const claimOutcome = await Promise.any([
        ...claimSelectors.map((s) => page.locator(s).first().click({ timeout: 20000 }).then(() => `clicked ${s}`)),
        // PATCHED v10: the real Luna claim-page marker (probe-verified). The old guesses never
        // matched this page, so each burned its full timeout and reported a false negative.
        page.waitForSelector('text=/Success, you received a code to redeem/i', { timeout: 25000 }).then(() => 'page says: Success, you received a code to redeem'),
        page.waitForSelector('text=/Collected on/i', { timeout: 25000 }).then(() => 'page shows Collected on <date>'),
        page.waitForSelector('.thank-you-title:has-text("Success")').then(() => 'page shows Success'),
        page.waitForSelector('div:has-text("Link game account")').then(() => 'page shows a link-account prompt'),
      ]);
      console.log('  claim:', claimOutcome);
    } catch (claimErr) {
      const seen = await page.evaluate(() => [...document.querySelectorAll('button, a, [role=button]')]
        .filter((e) => e.offsetParent)
        .slice(0, 40)
        .map((e) => `${e.tagName}${e.getAttribute('data-a-target') ? '[data-a-target=' + e.getAttribute('data-a-target') + ']' : ''}: ${(e.innerText || '').trim().slice(0, 40)}`)
        .join(' | ')).catch(() => 'dump failed');
      console.error('  claim: no control responded -', String(claimErr && claimErr.message).split('\n')[0]);
      console.error('  claim: visible controls on', page.url(), '->', seen);
      continue;
    }
    db.data[user][title] ||= { title, time: datetime(), url, store };
    const notify_game = { title, url };
    notify_games.push(notify_game); // status is updated below
    // PATCHED v7: the original gate aborted the whole claim on ANY div containing the words
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
      // PATCHED v10: status comes from the page's own marker, not an inference. This inference is
      // what made the app record genuinely claimed offers as "failed: need account linking".
      const claimConfirmed = await page.evaluate(() => /Success, you received a code to redeem|Collected on/i.test(document.body ? document.body.innerText : '')).catch(() => false);
      db.data[user][title].status = claimConfirmed ? 'claimed' : (linkingControl ? 'claimed? (linking control present)' : 'claimed (unconfirmed)');
      // print code if there is one
      const redeem = {
        // 'origin': 'https://www.origin.com/redeem', // TODO still needed or now only via account linking?
        'gog.com': 'https://www.gog.com/redeem',
        gog: 'https://www.gog.com/redeem',
        'microsoft store': 'https://account.microsoft.com/billing/redeem',
        xbox: 'https://account.microsoft.com/billing/redeem',
        'legacy games': 'https://www.legacygames.com/primedeal',
      };
      // PATCHED v9: accept either store signal, so a misleading slug cannot cost a code.
      if (!(store in redeem) && pageTextStore && pageTextStore in redeem) {
        console.log(`  using page-text store "${pageTextStore}" instead of slug store "${store}" for the redeem map`);
        store = pageTextStore;
      }
      if (store in redeem) { // did not work for linked origin: && !await page.locator('div:has-text("Successfully Claimed")').count()
        // PATCHED v9: the claim response renders a moment after the click. Without this settle the
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
            return (body.match(/\b[A-Z0-9]{4,6}(?:-[A-Z0-9]{4,6}){2,5}\b|\b[A-Z0-9]{16}\b/g) || []).slice(0, 3);
          }).catch(() => []);
          if (found && found.length) {
            code = found[0];
            console.log('  Code to redeem game: ' + code + ' (recovered by scanning the page text)');
          } else {
            console.error('  Code to redeem game: none on the page - already claimed, or this offer carries no key. Continuing.');
            continue;
          }
        }
        console.log('  Code to redeem game:', chalk.blue(code));
        if (store == 'legacy games') { // may be different URL like https://legacygames.com/primeday/puzzleoftheyear/
          redeem[store] = await (await page.$('li:has-text("Click here") a')).getAttribute('href'); // full text: Click here to enter your redemption code.
        }
        let redeem_url = redeem[store];
        if (store == 'gog.com') redeem_url += '/' + code; // to log and notify, but can't use for goto below (captcha)
        console.log('  URL to redeem game:', redeem_url);
        db.data[user][title].code = code;
        let redeem_action = 'redeem';
        if (cfg.pg_redeem) { // try to redeem keys on external stores
          console.log(`  Trying to redeem ${code} on ${store} (need to be logged in)!`);
          const page2 = await context.newPage();
          await page2.goto(redeem[store], { waitUntil: 'domcontentloaded' });
          if (store == 'gog.com') {
            // await page.goto(`https://redeem.gog.com/v1/bonusCodes/${code}`); // {"reason":"Invalid or no captcha"}
            await page2.fill('#codeInput', code);
            // wait for responses before clicking on Continue and then Redeem
            // first there are requests with OPTIONS and GET to https://redeem.gog.com/v1/bonusCodes/XYZ?language=de-DE
            const r1 = page2.waitForResponse(r => r.request().method() == 'GET' && r.url().startsWith('https://redeem.gog.com/'));
            await page2.click('[type="submit"]'); // click Continue
            // console.log(await page2.locator('.warning-message').innerText()); // does not exist if there is no warning
            const r1t = await (await r1).text();
            const reason = JSON.parse(r1t).reason;
            // {"reason":"Invalid or no captcha"}
            // {"reason":"code_used"}
            // {"reason":"code_not_found"}
            if (reason?.includes('captcha')) {
              redeem_action = 'redeem (got captcha)';
              console.error('  Got captcha; could not redeem!');
            } else if (reason == 'code_used') {
              redeem_action = 'already redeemed';
              console.log('  Code was already used!');
            } else if (reason == 'code_not_found') {
              redeem_action = 'redeem (not found)';
              console.error('  Code was not found!');
            } else { // TODO not logged in? need valid unused code to test.
              redeem_action = 'redeemed?';
              // console.log('  Redeemed successfully? Please report your Responses (if new) in https://github.com/vogler/free-games-claimer/issues/5');
              console.debug(`  Response 1: ${r1t}`);
              // then after the click on Redeem there is a POST request which should return {} if claimed successfully
              const r2 = page2.waitForResponse(r => r.request().method() == 'POST' && r.url().startsWith('https://redeem.gog.com/'));
              await page2.click('[type="submit"]'); // click Redeem
              const r2t = await (await r2).text();
              const reason2 = JSON.parse(r2t).reason;
              if (r2t == '{}') {
                redeem_action = 'redeemed';
                console.log('  Redeemed successfully.');
                db.data[user][title].status = 'claimed and redeemed';
              } else if (reason2?.includes('captcha')) {
                redeem_action = 'redeem (got captcha)';
                console.error('  Got captcha; could not redeem!');
              } else {
                console.debug(`  Response 2: ${r2t}`);
                console.log('  Unknown Response 2 - please report in https://github.com/vogler/free-games-claimer/issues/5');
              }
            }
          } else if (store == 'microsoft store' || store == 'xbox') {
            console.error(`  Redeem on ${store} is experimental!`);
            // await page2.pause();
            if (page2.url().startsWith('https://login.')) {
              console.error('  Not logged in! Please redeem the code above manually. You can now login in the browser for next time. Waiting for 60s.');
              await page2.waitForTimeout(60 * 1000);
              redeem_action = 'redeem (login)';
            } else {
              const iframe = page2.frameLocator('#redeem-iframe');
              const input = iframe.locator('[name=tokenString]');
              await input.waitFor();
              await input.fill(code);
              const r = page2.waitForResponse(r => r.url().startsWith('https://cart.production.store-web.dynamics.com/v1.0/Redeem/PrepareRedeem'));
              // console.log(await page2.locator('.redeem_code_error').innerText());
              const rt = await (await r).text();
              // {"code":"NotFound","data":[],"details":[],"innererror":{"code":"TokenNotFound",...
              const j = JSON.parse(rt);
              const reason = j?.events?.cart.length && j.events.cart[0]?.data?.reason;
              if (reason == 'TokenNotFound') {
                redeem_action = 'redeem (not found)';
                console.error('  Code was not found!');
              } else if (j?.productInfos?.length && j.productInfos[0]?.redeemable) {
                await iframe.locator('button:has-text("Next")').click();
                await iframe.locator('button:has-text("Confirm")').click();
                const r = page2.waitForResponse(r => r.url().startsWith('https://cart.production.store-web.dynamics.com/v1.0/Redeem/RedeemToken'));
                const j = JSON.parse(await (await r).text());
                if (j?.events?.cart.length && j.events.cart[0]?.data?.reason == 'UserAlreadyOwnsContent') {
                  redeem_action = 'already redeemed';
                  console.error('  error: UserAlreadyOwnsContent');
                } else if (true) { // TODO what's returned on success?
                  redeem_action = 'redeemed';
                  db.data[user][title].status = 'claimed and redeemed?';
                  console.log('  Redeemed successfully? Please report if not in https://github.com/vogler/free-games-claimer/issues/5');
                }
              } else { // TODO find out other responses
                redeem_action = 'unknown';
                console.debug(`  Response: ${rt}`);
                console.log('  Redeemed successfully? Please report your Response from above (if it is new) in https://github.com/vogler/free-games-claimer/issues/5');
              }
            }
          } else if (store == 'legacy games') {
            // await page2.pause();
            await page2.fill('[name=coupon_code]', code);
            await page2.fill('[name=email]', cfg.lg_email);
            await page2.fill('[name=email_validate]', cfg.lg_email);
            await page2.uncheck('[name=newsletter_sub]');
            await page2.click('[type="submit"]');
            try {
              // await page2.waitForResponse(r => r.url().startsWith('https://promo.legacygames.com/promotion-processing/order-management.php')); // status code 302
              await page2.waitForSelector('h2:has-text("Thanks for redeeming")');
              redeem_action = 'redeemed';
              db.data[user][title].status = 'claimed and redeemed';
            } catch (error) {
              console.error('  Got error', error);
              redeem_action = 'redeemed?';
              db.data[user][title].status = 'claimed and redeemed?';
              console.log('  Redeemed successfully? Please report problems in https://github.com/vogler/free-games-claimer/issues/5');
            }
          } else {
            console.error(`  Redeem on ${store} not yet implemented!`);
          }
          if (cfg.debug) await page2.pause();
          await page2.close();
        }
        notify_game.status = `<a href="${redeem_url}">${redeem_action}</a> ${code} on ${store}`;
      } else {
        notify_game.status = `claimed on ${store}`;
        db.data[user][title].status = 'claimed';
      }
      // save screenshot of potential code just in case
      await page.screenshot({ path: screenshot('external', `${filenamify(title)}.png`), fullPage: true });
      // console.info('  Saved a screenshot of page to', p);
    }
    // await page.pause();
    } catch (offerErr) {
      // PATCHED v8: one bad offer must never end the sweep (v7: offer #1 ended all remaining work).
      console.error('  offer failed, continuing with the next one:', String((offerErr && offerErr.message) || offerErr).split('\n')[0]);
      continue;
    }
  }
  await page.goto(URL_CLAIM, { waitUntil: 'domcontentloaded' });
  await page.click('button[data-type="Game"]');

  if (notify_games.length) { // make screenshot of all games if something was claimed
    const p = screenshot(`${filenamify(datetime())}.png`);
    // await page.screenshot({ path: p, fullPage: true }); // fullPage does not make a difference since scroll not on body but on some element
    await scrollUntilStable(() => games.locator('.item-card__action').count());
    const viewportSize = page.viewportSize(); // current viewport size
    await page.setViewportSize({ ...viewportSize, height: 3000 }); // increase height, otherwise element screenshot is cut off at the top and bottom
    await games.screenshot({ path: p }); // screenshot of all claimed games
  }

  // https://github.com/vogler/free-games-claimer/issues/55
  if (cfg.pg_claimdlc) {
    console.log('Trying to claim in-game content...');
    // The in-game-loot entry point was a Twitch-era attribute. Probe tolerant shapes and never block
    // on a blind click: a missing nav used to cost 60s and then abort the whole DLC block.
    const dlcNavSels = [
      'button[data-type="InGameLoot"]',
      'button:has-text("In-game content")',
      'button:has-text("In-game loot")',
      '[role="tab"]:has-text("In-game")',
      'a:has-text("In-game content")',
    ];
    let dlcNav = null;
    for (const sel of dlcNavSels) {
      const cand = page.locator(sel).first();
      if (await cand.count() && await cand.isVisible().catch(_ => false)) { dlcNav = cand; console.log('  in-game section matched:', sel); break; }
    }
    if (!dlcNav) {
      console.log('  no in-game content section present - skipping the DLC phase (nothing to collect, or the nav was renamed)');
      const seen = await page.locator('button, [role="tab"], a').evaluateAll(els => els
        .filter(e => e.offsetParent !== null)
        .map(e => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''} :: ${(e.innerText || '').trim().slice(0, 40)}`)
        .filter(s => /in-game|ingame|loot|content|offer/i.test(s)).slice(0, 20));
      console.log('  candidate nav controls:', seen);
    } else {
      await dlcNav.click({ timeout: 15000 });
    }
    const loot = page.locator('div[data-a-target="offer-list-IN_GAME_LOOT"], [data-a-target*="IN_GAME_LOOT"], [data-testid*="in-game-loot"]');
    if (dlcNav) {
      try { await loot.first().waitFor({ timeout: 15000 }); } catch (_) { console.log('  in-game loot list did not appear; continuing with what is on the page'); }
    }

    process.stdout.write('Loading all DLCs on page...');
    await scrollUntilStable(() => loot.locator('[data-a-target="item-card"]').count())

    console.log('\nNumber of already claimed DLC:', await loot.locator('p:has-text("Collected")').count());

    const cards = await loot.locator('[data-a-target="item-card"]:has(p:text-is("Claim"))').all();
    console.log('Number of unclaimed DLC:', cards.length);
    const dlcs = await Promise.all(cards.map(async card => ({
      game: await card.locator('.item-card-details__body p').innerText(),
      title: await card.locator('.item-card-details__body__primary').innerText(),
      url: 'https://gaming.amazon.com' + await card.locator('a').first().getAttribute('href'),
    })));
    // console.log(dlcs);

    const dlc_unlinked = {};
    for (const dlc of dlcs) {
      const title = `${dlc.game} - ${dlc.title}`;
      const url = dlc.url;
      console.log('Current DLC:', title);
      if (cfg.debug) await page.pause();
      if (cfg.dryrun) continue;
      if (cfg.interactive && !await confirm()) continue;
      db.data[user][title] ||= { title, time: datetime(), store: 'DLC', status: 'pending' };
      const notify_game = { title, url };
      notify_games.push(notify_game); // status is updated below
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        // most games have a button 'Get in-game content'
        // epic-games: Fall Guys: Claim -> Continue -> Go to Epic Games (despite account linked and logged into epic-games) -> not tied to account but via some cookie?
        let dlcClicked = false;
        for (const sel of ['button:has-text("Get in-game content")', 'button:has-text("Claim your gift")', 'button:has-text("Claim")', '.tw-button:has-text("Get in-game content")', '.tw-button:has-text("Claim your gift")', '.tw-button:has-text("Claim")']) {
          const cand = page.locator(sel).first();
          if (await cand.count() && await cand.isVisible().catch(_ => false)) { await cand.click({ timeout: 15000 }).catch(_ => { }); dlcClicked = true; console.log('  dlc claim clicked:', sel); break; }
        }
        if (!dlcClicked) {
          const seen = await page.locator('button, [role="button"], a').evaluateAll(els => els
            .filter(e => e.offsetParent !== null)
            .map(e => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''} :: ${(e.innerText || '').trim().slice(0, 40)}`)
            .slice(0, 12));
          console.log('  dlc claim: no claim control found; visible controls:', seen);
        } else {
          page.click('button:has-text("Continue")', { timeout: 8000 }).catch(_ => { });
        }
        const linkAccountButton = page.locator('[data-a-target="LinkAccountButton"]');
        let unlinked_store;
        if (await linkAccountButton.count()) {
          unlinked_store = await linkAccountButton.first().getAttribute('aria-label');
          console.debug('  LinkAccountButton label:', unlinked_store);
          const match = unlinked_store.match(/Link (.*) account/);
          if (match && match.length == 2) unlinked_store = match[1];
        } else if (await page.locator('text=Link game account').count()) { // epic-games only?
          console.error('  Missing account linking (epic-games specific button?):', await page.locator('button[data-a-target="gms-cta"]').innerText()); // TODO needed?
          unlinked_store = 'epic-games';
        }
        if (unlinked_store) {
          console.error('  Missing account linking:', unlinked_store, url);
          dlc_unlinked[unlinked_store] ??= [];
          dlc_unlinked[unlinked_store].push(title);
        } else {
          const code = await page.inputValue('input[type="text"]').catch(_ => undefined);
          console.log('  Code to redeem game:', chalk.blue(code));
          db.data[user][title].code = code;
          db.data[user][title].status = 'claimed';
          // notify_game.status = `<a href="${redeem[store]}">${redeem_action}</a> ${code} on ${store}`;
        }
        // await page.pause();
      } catch (error) {
        console.error(error);
      } finally {
        await page.goto(URL_CLAIM, { waitUntil: 'domcontentloaded' });
    for (const sel of dlcNavSels) {
      const cand = page.locator(sel).first();
      if (await cand.count() && await cand.isVisible().catch(_ => false)) { await cand.click({ timeout: 15000 }).catch(_ => { }); break; }
    }
      }
    }
    console.log('DLC: Unlinked accounts:', dlc_unlinked);
  }
} catch (error) {
  process.exitCode ||= 1;
  console.error('--- Exception:');
  console.error(error); // .toString()?
  if (error.message && process.exitCode != 130) notify(`prime-gaming failed: ${error.message.split('\n')[0]}`);
} finally {
  await db.write(); // write out json db
  if (notify_games.length) { // list should only include claimed games
    notify(`prime-gaming (${user}):<br>${html_game_list(notify_games)}`);
  }
}
if (page.video()) console.log('Recorded video:', await page.video().path());
await context.close();
