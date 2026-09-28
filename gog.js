import { firefox } from 'playwright-firefox'; // stealth plugin needs no outdated playwright-extra
import chalk from 'chalk';
import { resolve, jsonDb, datetime, filenamify, prompt, notify, html_game_list, handleSIGINT } from './src/util.js';
import { cfg } from './src/config.js';

const screenshot = (...a) => resolve(cfg.dir.screenshots, 'gog', ...a);

const URL_CLAIM = 'https://www.gog.com/en';

console.log(datetime(), 'started checking gog');

const db = await jsonDb('gog.json', {});

if (cfg.width < 1280) { // otherwise 'Sign in' and #menuUsername are hidden (but attached to DOM), see https://github.com/vogler/free-games-claimer/issues/335
  console.error(`Window width is set to ${cfg.width} but needs to be at least 1280 for GOG!`);
  process.exit(1);
}

// https://playwright.dev/docs/auth#multi-factor-authentication
const context = await firefox.launchPersistentContext(cfg.dir.browser, {
  headless: cfg.headless,
  viewport: { width: cfg.width, height: cfg.height },
  locale: 'en-US', // ignore OS locale to be sure to have english text for locators -> done via /en in URL
  recordVideo: cfg.record ? { dir: 'data/record/', size: { width: cfg.width, height: cfg.height } } : undefined, // will record a .webm video for each page navigated; without size, video would be scaled down to fit 800x800
  recordHar: cfg.record ? { path: `data/record/gog-${filenamify(datetime())}.har` } : undefined, // will record a HAR file with network requests and responses; can be imported in Chrome devtools
  handleSIGINT: false, // have to handle ourselves and call context.close(), otherwise recordings from above won't be saved
});

handleSIGINT(context);

if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);

const page = context.pages().length ? context.pages()[0] : await context.newPage(); // should always exist
await page.setViewportSize({ width: cfg.width, height: cfg.height }); // TODO workaround for https://github.com/vogler/free-games-claimer/issues/277 until Playwright fixes it
// console.debug('userAgent:', await page.evaluate(() => navigator.userAgent));

const notify_games = [];
let user;

try {
  await context.addCookies([{ name: 'CookieConsent', value: '{stamp:%274oR8MJL+bxVlG6g+kl2we5+suMJ+Tv7I4C5d4k+YY4vrnhCD+P23RQ==%27%2Cnecessary:true%2Cpreferences:true%2Cstatistics:true%2Cmarketing:true%2Cmethod:%27explicit%27%2Cver:1%2Cutc:1672331618201%2Cregion:%27de%27}', domain: 'www.gog.com', path: '/' }]); // to not waste screen space when non-headless

  await page.goto(URL_CLAIM, { waitUntil: 'domcontentloaded' }); // default 'load' takes forever

  // page.click('#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll').catch(_ => { }); // does not work reliably, solved by setting CookieConsent above
  // The GOG header was rebuilt (menu-v3): sign-in is now a <button class="menu-v3__button">SIGN IN</button>
  // and #menuUsername no longer exists, so racing the two legacy selectors rejects and kills the run.
  const signInSels = [
    'button.menu-v3__button:has-text("SIGN IN")',
    'button.menu-v3__button:has-text("Sign in")',
    'a:has-text("Sign in")',
    'button:has-text("Sign in")',
    'a:has-text("SIGN IN")',
  ];
  const signedInSels = [
    '#menuUsername',
    '[class*="menu"] [class*="avatar"]',
    '[class*="menu__avatar"]',
    '[class*="menu"] a[href*="/account"]',
  ];
  const findVisible = async sels => {
    for (const sel of sels) {
      const c = page.locator(sel).first();
      if (await c.count() && await c.isVisible().catch(_ => false)) return { sel, loc: c };
    }
    return null;
  };
  let signIn = null;
  for (let i = 0; i < 20; i++) {
    const si = await findVisible(signInSels);
    const li = await findVisible(signedInSels);
    if (li && !si) { console.log('  gog session detected via', li.sel); break; }
    if (si) { signIn = si.loc; console.error('Not signed in anymore.'); console.log('  gog sign-in control matched:', si.sel); break; }
    await page.waitForTimeout(1000);
  }
  if (!signIn && !await findVisible(signedInSels)) {
    const seen = await page.locator('header a, header button, [class*="menu"] a, [class*="menu"] button').evaluateAll(els => els
      .filter(e => e.offsetParent !== null)
      .map(e => e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '') + ' :: ' + (e.innerText || '').trim().slice(0, 30))
      .slice(0, 25));
    console.error('  gog: could not determine sign-in state. url=' + page.url());
    console.error('  header controls:', seen);
    notify('gog: could not determine sign-in state - see log');
  }
  while (signIn && await signIn.isVisible()) {
    console.error('Not signed in anymore.');
    await signIn.click();
    // it then creates an iframe for the login
    await page.waitForSelector('#GalaxyAccountsFrameContainer iframe'); // TODO needed?
    const iframe = page.frameLocator('#GalaxyAccountsFrameContainer iframe');
    if (!cfg.debug) context.setDefaultTimeout(cfg.login_timeout); // give user some extra time to log in
    console.info(`Login timeout is ${cfg.login_timeout / 1000} seconds!`);
    if (cfg.gog_email && cfg.gog_password) console.info('Using email and password from environment.');
    else console.info('Press ESC to skip the prompts if you want to login in the browser (not possible in headless mode).');
    const email = cfg.gog_email || await prompt({ message: 'Enter email' });
    const password = email && (cfg.gog_password || await prompt({ type: 'password', message: 'Enter password' }));
    if (email && password) {
      iframe.locator('a[href="/logout"]').click().catch(_ => { }); // Click 'Change account' (email from previous login is set in some cookie)
      await iframe.locator('#login_username').fill(email);
      await iframe.locator('#login_password').fill(password);
      await iframe.locator('#login_login').click();
      // handle MFA, but don't await it
      iframe.locator('form[name=second_step_authentication]').waitFor().then(async () => {
        console.log('Two-Step Verification - Enter security code');
        console.log(await iframe.locator('.form__description').innerText());
        const otp = await prompt({ type: 'text', message: 'Enter two-factor sign in code', validate: n => n.toString().length == 4 || 'The code must be 4 digits!' }); // can't use type: 'number' since it strips away leading zeros and codes sometimes have them
        await iframe.locator('#second_step_authentication_token_letter_1').pressSequentially(otp.toString(), { delay: 10 });
        await iframe.locator('#second_step_authentication_send').click();
        await page.waitForTimeout(1000); // TODO still needed with wait for username below?
      }).catch(_ => { });
      // iframe.locator('iframe[title=reCAPTCHA]').waitFor().then(() => {
      // iframe.locator('.g-recaptcha').waitFor().then(() => {
      iframe.locator('text=Invalid captcha').waitFor().then(() => {
        console.error('Got a captcha during login (likely due to too many attempts)! You may solve it in the browser, get a new IP or try again in a few hours.');
        notify('gog: got captcha during login. Please check.');
        // TODO solve reCAPTCHA?
      }).catch(_ => { });
      try {
        await page.waitForSelector('#menuUsername', { timeout: 20000 });
      } catch (_) {
        if (!await findVisible(signedInSels)) console.log('  gog: post-login marker unclear; continuing');
      }
    } else {
      console.log('Waiting for you to login in the browser.');
      await notify('gog: no longer signed in and not enough options set for automatic login.');
      if (cfg.headless) {
        console.log('Run `SHOW=1 node gog` to login in the opened browser.');
        await context.close();
        process.exit(1);
      }
    }
    try {
      await page.waitForSelector('#menuUsername', { timeout: 20000 });
    } catch (_) {
      if (!await findVisible(signedInSels)) console.log('  gog: sign-in state unclear after manual login; continuing');
    }
    if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);
  }
  // innerText was uppercase due to styling; the marker itself is gone from the rebuilt header.
  const plausibleUser = s => !!s && /^[A-Za-z0-9_.@-]{2,40}$/.test(s.trim());
  user = await page.locator('#menuUsername').first().textContent().catch(_ => undefined);
  if (!plausibleUser(user)) {
    // Prefer an identity already in the db: never invent a key (the old marker once returned the whole
    // menu text and created a junk entry beside the real username).
    const known = Object.keys(db.data).filter(plausibleUser);
    const cand = await findVisible(signedInSels.filter(s => s !== '#menuUsername'));
    const candText = cand ? ((await cand.loc.textContent().catch(_ => '')) || '').trim() : '';
    user = known[0] || (plausibleUser(candText) ? candText.trim() : 'gog');
    console.log('  gog username marker is gone; continuing as identity:', user);
  }
  user = user.trim();
  console.log(`Signed in as ${user}`);
  db.data[user] ||= {};

  // The #giveaway banner is legacy markup: modern GOG renders none, and the banner used to gate the
  // entire claim, so a missing banner silently skipped claiming forever. The banner now only names the
  // giveaway for the db/notify/screenshot; the auto-claim URL is always visited.
  const banner = page.locator('#giveaway');
  let title;
  let giveawayUrl;
  if (await banner.count()) {
    const text = await page.locator('.giveaway__content-header').innerText().catch(_ => '');
    const match_all = text.match(/Claim (.*) and don't miss the|Success! (.*) was added to/);
    if (match_all && (match_all[1] || match_all[2])) title = match_all[1] ? match_all[1] : match_all[2];
    title ||= 'unknown giveaway';
    giveawayUrl = await banner.locator('a').first().getAttribute('href').catch(_ => undefined);
    console.log(`Current free game: ${chalk.blue(title)} - ${giveawayUrl}`);
    // await page.locator('#giveaway:not(.is-loading)').waitFor(); // otherwise screenshot is sometimes with loading indicator instead of game title; #TODO fix, skipped due to timeout, see #240
    await banner.screenshot({ path: screenshot(`${filenamify(title)}.png`) }).catch(_ => { }); // overwrites every time - only keep first?
  } else {
    console.log('No #giveaway banner on the storefront (modern markup) - claiming via the auto-claim URL anyway.');
  }
  // A dated key keeps distinct giveaways apart when the banner cannot name them.
  title ||= `GOG giveaway ${new Date().toISOString().slice(0, 10)}`;
  giveawayUrl ||= 'https://www.gog.com/giveaway';
  db.data[user][title] ||= { title, time: datetime(), url: giveawayUrl };
  if (cfg.dryrun) process.exit(1);

  // instead of clicking the button, we visit the auto-claim URL which gives a JSON response which is easier than checking the state of a button
  await page.goto('https://www.gog.com/giveaway/claim');
  const response = await page.innerText('body');
  // console.log(response);
  // {} // when successfully claimed
  // {"message":"Already claimed"}
  // {"message":"Unauthorized"}
  // {"message":"Giveaway has ended"}
  let status;
  try {
    if (response.trim() == '{}') {
      status = 'claimed';
      console.log('  Claimed successfully!');
    } else {
      const message = JSON.parse(response).message;
      if (message == 'Already claimed') {
        status = 'existed'; // same status text as for epic-games
        console.log('  Already in library! Nothing to claim.');
      } else {
        console.log(response);
        status = message;
      }
    }
  } catch (e) {
    // a redirect or an HTML error page is not JSON - report it instead of dying
    console.log('  unexpected auto-claim response:', response.trim().slice(0, 200));
    status = 'unknown';
  }
  db.data[user][title].status ||= status;
  notify_games.push({ title, url: giveawayUrl, status });

  if (status == 'claimed' && !cfg.gog_newsletter) {
    try {
      console.log("Unsubscribe from 'Promotions and hot deals' newsletter");
      await page.goto('https://www.gog.com/en/account/settings/subscriptions');
      await page.locator('li:has-text("Marketing communications through Trusted Partners") label').uncheck({ timeout: 15000 });
      await page.locator('li:has-text("Promotions and hot deals") label').uncheck({ timeout: 15000 });
    } catch (e) {
      console.log('  newsletter unsubscribe skipped:', (e.message || e).toString());
    }
  }
} catch (error) {
  process.exitCode ||= 1;
  console.error('--- Exception:');
  console.error(error); // .toString()?
  if (error.message && process.exitCode != 130) notify(`gog failed: ${error.message.split('\n')[0]}`);
} finally {
  await db.write(); // write out json db
  if (notify_games.filter(g => g.status != 'existed').length) { // don't notify if all were already claimed
    notify(`gog (${user}):<br>${html_game_list(notify_games)}`);
  }
}
if (page.video()) console.log('Recorded video:', await page.video().path());
await context.close();
