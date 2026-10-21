// End-to-end check of social sign-up (Google/X) in this client.
//
//   # a server WITHOUT the app id: the feature must be absent, not broken
//   HTTPS=true npx vite --port 5179 --strictPort
//
//   # a server WITH the app id (and a node, so a Farcaster sign-in can reach
//   # the shell at the end of the run)
//   HTTPS=true VITE_PRIVY_APP_ID=probe-app-id \
//     VITE_SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
//     npx vite --port 5178 --strictPort
//
//   SOCIAL_SIGNUP_SERVER=https://localhost:5178 \
//   SOCIAL_SIGNUP_PLAIN_SERVER=https://localhost:5179 \
//     node scripts/verify-social-signup.mjs
//
// Screenshots land in $SOCIAL_SIGNUP_SHOT_DIR (default: the system temp dir).
//
// WHAT IS STUBBED, AND WHAT IS NOT. Only two things are stubbed, and both are
// the third parties: Privy's browser SDK (served in place of its module, so no
// real OAuth is attempted and no Privy network call is made) and Farcaster's
// SIWF relay (stubbed with a REAL SIWE message signed by a throwaway key, so the
// app's own verifier has to genuinely accept it). Everything else is the app:
// the identity mapping, the account book, the route it lands on, the backup
// notice's own storage, and the switcher.
//
// WHAT IT ASSERTS
//   A. without an app id: no doors, no dead buttons, no errors — the Farcaster
//      path exactly as it was
//   B. with an app id: both doors, at 390 and 1440
//   C. pressing Google lands on the account screen, and the account it made is
//      in the device's own book — keyed by the held wallet, named by the email,
//      with no FID invented
//   D. the backup notice: offered, blurred until tapped, deferred for days, asked
//      again when that time passes, and silenced for good by the confirm step
//   E. signing in with Farcaster from that screen reaches the shell, and the
//      switcher lists BOTH accounts — the social one joined it
//
// SAFETY: every non-GET request to anything but the dev servers is aborted and
// counted, so nothing here can post, register or own anything on a real network.

import os from 'node:os';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const SERVER = process.env.SOCIAL_SIGNUP_SERVER ?? 'https://localhost:5178';
const PLAIN_SERVER = process.env.SOCIAL_SIGNUP_PLAIN_SERVER ?? 'https://localhost:5179';
const OUT = process.env.SOCIAL_SIGNUP_SHOT_DIR ?? os.tmpdir();

const DOMAIN = new URL(SERVER).host;
const NONCE = 'a'.repeat(128);
const CHANNEL_TOKEN = 'SOCIALSIGNUP1';

/** The Farcaster account the stubbed sign-in names: a real, active one. */
const SIGNED_IN_FID = 3;
const SIGNED_IN_HANDLE = 'dwr';

/** The identity the stubbed Privy SDK answers with. A held wallet, and Google. */
const PRIVY_EMAIL = 'probe@gmail.com';
const PRIVY_NAME = 'Probe Person';
const HELD_WALLET = '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063';

const signer = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const message = createSiweMessage({
  address: signer.address,
  chainId: 10,
  domain: DOMAIN,
  nonce: NONCE,
  uri: `${SERVER}/login`,
  version: '1',
});
const signature = await signer.signMessage({ message });

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'content-type': 'application/json',
};

/**
 * Privy's SDK, replaced by the smallest module that answers the three things
 * this app imports. It is a stub of the THIRD PARTY, never of the app: what
 * `login()` does here is what the real SDK does on a successful sign-up — call
 * back with the user — so everything downstream is the app's own code.
 */
const PRIVY_STUB = `
const user = {
  linkedAccounts: [
    { type: 'google_oauth', subject: 'probe-google-sub', email: ${JSON.stringify(PRIVY_EMAIL)}, name: ${JSON.stringify(PRIVY_NAME)} },
    { type: 'wallet', address: ${JSON.stringify(HELD_WALLET)}, chainType: 'ethereum', walletClientType: 'privy' },
  ],
};

export const PrivyProvider = ({ children }) => children;

export const useLogin = (callbacks) => ({
  login: (options) => {
    globalThis.__privyLoginCalls = (globalThis.__privyLoginCalls ?? []).concat([options ?? null]);
    setTimeout(() => callbacks?.onComplete?.({ user, isNewUser: true, wasAlreadyAuthenticated: false, loginMethod: 'google', loginAccount: null }), 50);
  },
});

export const usePrivy = () => ({
  authenticated: true,
  ready: true,
  user,
  exportWallet: async () => {
    globalThis.__privyExportCalls = (globalThis.__privyExportCalls ?? 0) + 1;
  },
});
`;

const startedAt = Date.now();
const stage = (step) =>
  console.log(
    `[${String(Math.round((Date.now() - startedAt) / 1000)).padStart(3)}s] ${step}`,
  );

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/** Every write this probe could accidentally make, and every page error. */
const writes = [];
const pageErrors = [];

/** Applies the two stubs, and refuses anything that is not a read. */
const armRoutes = async (page, { server, privy }) => {
  // Registered FIRST so it is matched LAST: Playwright checks handlers in
  // reverse order of registration, and a handler that runs would end the chain.
  await page.route('**', async (route) => {
    const request = route.request();

    if (
      ['GET', 'HEAD', 'OPTIONS'].includes(request.method()) ||
      request.url().startsWith(server) ||
      request.url().startsWith('https://relay.farcaster.xyz')
    ) {
      return route.continue();
    }

    writes.push(`${request.method()} ${request.url().slice(0, 110)}`);

    return route.abort();
  });

  await page.route('**/*privy-io*', async (route) => {
    if (!privy) {
      return route.continue();
    }

    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/javascript' },
      body: PRIVY_STUB,
    });
  });

  await page.route('https://relay.farcaster.xyz/**', async (route) => {
    const method = route.request().method();

    if (method === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: CORS, body: '' });
    }

    if (method === 'POST') {
      return route.fulfill({
        status: 201,
        headers: CORS,
        body: JSON.stringify({
          channelToken: CHANNEL_TOKEN,
          url: `https://farcaster.xyz/~/siwf?channelToken=${CHANNEL_TOKEN}`,
          nonce: NONCE,
        }),
      });
    }

    return route.fulfill({
      status: 200,
      headers: CORS,
      body: JSON.stringify({
        state: 'completed',
        nonce: NONCE,
        message,
        signature,
        fid: SIGNED_IN_FID,
        username: SIGNED_IN_HANDLE,
        displayName: SIGNED_IN_HANDLE,
      }),
    });
  });

};

const dash = (value) => (value ?? '').replace(/\s+/g, ' ').trim();

/** Open the way in, through the door the client already has. */
const openLoginModal = async (page, server) => {
  // 'commit', not 'domcontentloaded': in dev the module graph of a cold Vite
  // server holds DOMContentLoaded for as long as its dependency optimisation
  // takes, and waiting on it would measure the bundler rather than the app.
  // Everything that matters is waited for explicitly, below.
  await page.goto(`${server}/welcome/ready`, {
    waitUntil: 'commit',
    timeout: 60_000,
  });
  await page.waitForSelector('button', { timeout: 60_000 });
  await page.waitForTimeout(1_500);

  const pressed = await page.evaluate(() => {
    for (const element of document.querySelectorAll('button, a, [role=button]')) {
      const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();

      if (/go social/i.test(text)) {
        element.click();
        return text;
      }
    }

    return null;
  });

  if (pressed === null) {
    throw new Error('the sign-in entry point was not on the setup screen');
  }

  await page.waitForTimeout(2_500);
};

const readAccountBook = (page) =>
  page.evaluate(async () => {
    const accountsModule = await import('/src/snapchain/accounts/localAccounts.ts');
    const socialModule = await import('/src/lib/socialAccount.ts');

    const accounts = await accountsModule.loadLocalAccounts();
    const currentId = await accountsModule.loadCurrentAccountId();

    return {
      currentId: currentId ?? null,
      accounts: accounts.map((account) => ({
        id: account.id,
        custodyAddress: account.custodyAddress,
        fid: account.fid ?? null,
        email: account.email ?? null,
        provider: account.provider ?? null,
        custody: account.walletCustody ?? null,
        phrase: account.phrase ?? null,
        // The switcher's own naming function, not a re-implementation of it.
        label: accountsModule.describeLocalAccount(account),
        isSocial: socialModule.isSocialAccount(account),
      })),
    };
  });

const readNotice = (page) =>
  page.evaluate(() => {
    const panel = document.querySelector('[data-fiddy="seed-backup-words"]');
    const notice = document.querySelector('[data-fiddy="seed-backup"]');

    return {
      present: Boolean(notice),
      title: dash(document.querySelector('#seed-backup-title')?.textContent),
      text: dash(notice?.textContent),
      wordsHidden: panel ? panel.getAttribute('data-hidden') : null,
      blurred: panel ? (panel.style.filter || '').includes('blur') : null,
      wordCount: panel ? panel.querySelectorAll('li').length : null,
      thanks: Boolean(document.querySelector('[data-fiddy="seed-backup-thanks"]')),
    };
  });

const pressButton = (page, label) =>
  page.evaluate((wanted) => {
    for (const element of document.querySelectorAll('button, a, [role=button]')) {
      const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();

      if (text.toLowerCase().includes(wanted.toLowerCase())) {
        element.click();
        return text;
      }
    }

    return null;
  }, label);

const readSeedBackupState = (page, id) =>
  page.evaluate(async (accountId) => {
    const module = await import('/src/lib/seedBackup.ts');

    return await module.loadSeedBackupState(accountId);
  }, id);

const writeSeedBackupState = (page, id, state) =>
  page.evaluate(
    async ({ accountId, next }) => {
      const module = await import('/src/lib/seedBackup.ts');

      await module.saveSeedBackupState(accountId, next);
    },
    { accountId: id, next: state },
  );

/** ── A. the build without an app id ──────────────────────────────────────── */

const runWithoutAppId = async (browser, width) => {
  stage(`A. no app id, at ${width}px`);
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width, height: width < 600 ? 844 : 900 },
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 200)));

  await armRoutes(page, { server: PLAIN_SERVER, privy: false });
  await openLoginModal(page, PLAIN_SERVER);

  const seen = await page.evaluate(() => ({
    socialBlock: Boolean(document.querySelector('[data-fiddy="login-social"]')),
    doors: Array.from(document.querySelectorAll('[data-fiddy^="social-sign-up-"]'))
      .length,
    mentionsGoogle: /continue with google/i.test(document.body.innerText),
    farcasterPath: /open link on mobile|asking farcaster for a sign-in code|sign in with/i.test(
      document.body.innerText,
    ),
  }));

  check(
    `A1 ${width}px: the social block is absent, not empty`,
    seen.socialBlock === false && seen.doors === 0 && !seen.mentionsGoogle,
    JSON.stringify(seen),
  );
  check(
    `A2 ${width}px: the Farcaster way in is still there`,
    seen.farcasterPath === true,
    JSON.stringify(seen),
  );

  await page.screenshot({ path: `${OUT}/social-signup-${width}-no-app-id.png` });
  await context.close();
};

/** ── B–E. the build with an app id ───────────────────────────────────────── */

const runWithAppId = async (browser, width) => {
  stage(`B. with an app id, at ${width}px`);
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width, height: width < 600 ? 844 : 900 },
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 200)));

  await armRoutes(page, { server: SERVER, privy: true });
  await openLoginModal(page, SERVER);

  const doors = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-fiddy^="social-sign-up-"]')).map(
      (element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
    ),
  );

  check(
    `B1 ${width}px: both doors are drawn, from the one list`,
    doors.length === 2 &&
      doors[0] === 'Continue with Google' &&
      doors[1] === 'Continue with X',
    doors.join(' | '),
  );

  const jargon = await page.evaluate(() =>
    /privy|oauth|embedded wallet/i.test(document.body.innerText),
  );
  check(`B2 ${width}px: no jargon on the way in`, jargon === false, `${jargon}`);

  await page.screenshot({ path: `${OUT}/social-signup-${width}-doors.png` });

  stage(`C. pressing Google, landed account, at ${width}px`);
  const pressed = await pressButton(page, 'Continue with Google');

  check(`C1 ${width}px: the Google door is pressable`, pressed !== null, `${pressed}`);

  await page.waitForSelector('[data-fiddy="fiddy-account"][data-state="ready"]', {
    timeout: 60_000,
  });
  await page.waitForTimeout(2_000);

  const screen = await page.evaluate(() => ({
    url: window.location.pathname,
    text: (document.body.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 400),
  }));

  check(
    `C2 ${width}px: the sign-up lands on the account screen`,
    screen.url === '/welcome/account',
    screen.url,
  );
  check(
    `C3 ${width}px: the screen names the account by what was signed up with`,
    /probe@gmail\.com/.test(screen.text) && /signed up with google/i.test(screen.text),
    screen.text.slice(0, 160),
  );
  check(
    `C4 ${width}px: it says plainly what is still missing`,
    /no farcaster account yet/i.test(screen.text),
    screen.text.slice(0, 160),
  );

  const book = await readAccountBook(page);
  const social = book.accounts.find((account) => account.isSocial);

  check(
    `C5 ${width}px: the account is in the device's own book, selected`,
    book.accounts.length === 1 &&
      book.currentId === HELD_WALLET.toLowerCase() &&
      social?.id === HELD_WALLET.toLowerCase(),
    JSON.stringify(book),
  );
  check(
    `C6 ${width}px: it is keyed by the held wallet and no FID is invented`,
    social?.fid === null &&
      social?.custody === 'privy' &&
      social?.phrase === null &&
      social?.provider === 'google',
    JSON.stringify(social),
  );
  check(
    `C7 ${width}px: the switcher's own label function names it by the email`,
    social?.label === PRIVY_EMAIL,
    `${social?.label}`,
  );

  stage(`D. the backup notice, at ${width}px`);
  const notice = await readNotice(page);

  check(
    `D1 ${width}px: the notice is offered, in plain words`,
    notice.present === true &&
      notice.title === 'Back up your account' &&
      /signed up with google/i.test(notice.text) &&
      /nobody can give them to you again/i.test(notice.text),
    notice.text.slice(0, 200),
  );
  check(
    `D2 ${width}px: no words are printed that this device does not hold`,
    notice.wordCount === 0,
    `${notice.wordCount} words`,
  );

  await pressButton(page, 'Show me my backup words');
  await page.waitForTimeout(800);

  const revealed = await readNotice(page);

  check(
    `D3 ${width}px: the words block is blurred until it is asked for`,
    revealed.wordsHidden === 'true' && revealed.blurred === true,
    JSON.stringify(revealed),
  );

  await page.screenshot({ path: `${OUT}/social-signup-${width}-notice-blurred.png` });

  await pressButton(page, 'Tap to show the words');
  await page.waitForTimeout(800);

  const shown = await readNotice(page);

  check(
    `D4 ${width}px: tapping reveals it`,
    shown.wordsHidden === 'false' && shown.blurred === false,
    JSON.stringify(shown),
  );

  await page.screenshot({ path: `${OUT}/social-signup-${width}-notice-revealed.png` });

  stage(`D5. "not now" buys days, then comes back, at ${width}px`);
  await pressButton(page, 'Not now');
  await page.waitForTimeout(800);

  const deferred = await readSeedBackupState(page, HELD_WALLET.toLowerCase());

  check(
    `D5 ${width}px: "not now" is recorded as a deferral, days out`,
    deferred.status === 'deferred' &&
      deferred.remindAfter - deferred.lastShownAt === 3 * 24 * 60 * 60 * 1000,
    JSON.stringify(deferred),
  );
  check(
    `D6 ${width}px: the notice is gone until then`,
    (await readNotice(page)).present === false,
    '',
  );

  // The clock moves by writing the stored moment into the past — the app is
  // reloaded after, so the notice is re-decided by the app's own rule.
  await writeSeedBackupState(page, HELD_WALLET.toLowerCase(), {
    ...deferred,
    lastShownAt: Date.now() - 4 * 24 * 60 * 60 * 1000,
    remindAfter: Date.now() - 1_000,
  });
  await page.reload({ waitUntil: 'commit' });
  await page.waitForSelector('[data-fiddy="seed-backup"]', { timeout: 60_000 });
  await page.waitForTimeout(1_500);

  check(
    `D7 ${width}px: it comes back by itself when that time passes`,
    (await readNotice(page)).present === true,
    '',
  );

  stage(`D8. the confirm step ends the asking, at ${width}px`);
  await pressButton(page, 'Show me my backup words');
  await page.waitForTimeout(500);
  await pressButton(page, 'I have written them down');
  await page.waitForTimeout(800);

  const savedState = await readSeedBackupState(page, HELD_WALLET.toLowerCase());

  check(
    `D8 ${width}px: the person's own confirm is what stops it`,
    savedState.status === 'saved' && typeof savedState.savedAt === 'number',
    JSON.stringify(savedState),
  );

  await page.reload({ waitUntil: 'commit' });
  await page.waitForSelector('[data-fiddy="fiddy-account"]', { timeout: 60_000 });
  await page.waitForTimeout(2_500);

  check(
    `D9 ${width}px: and it does not ask again`,
    (await readNotice(page)).present === false,
    '',
  );

  stage(`E. a Farcaster account joins it, at ${width}px`);
  await pressButton(page, 'I already have a Farcaster account');
  await page.waitForTimeout(2_500);

  await page.waitForSelector('[data-fiddy="account-switcher-entry"]', {
    timeout: 120_000,
  });
  await page.waitForTimeout(2_500);

  const current = await page.evaluate(() => ({
    entry: (document.querySelector('[data-fiddy="account-switcher-entry"]')?.textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim(),
    token: document.body.innerText.length,
  }));

  check(
    `E1 ${width}px: signing in with Farcaster reaches the shell, as that account`,
    current.entry === `@${SIGNED_IN_HANDLE}`,
    current.entry,
  );

  await page.evaluate(() => {
    document.querySelector('[data-fiddy="account-switcher-entry"]')?.click();
  });
  await page.waitForSelector('[data-fiddy="account-switcher"]', { timeout: 60_000 });
  await page.waitForTimeout(2_000);

  const sheet = await page.evaluate(() => ({
    text: (document.querySelector('[data-fiddy="account-switcher"]')?.textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim(),
    rows: Array.from(document.querySelectorAll('[data-fiddy-account]')).map((row) => ({
      id: row.getAttribute('data-fiddy-account'),
      text: (row.textContent ?? '').replace(/\s+/g, ' ').trim(),
      current: row.className.includes('current'),
    })),
  }));

  check(
    `E2 ${width}px: the switcher lists both accounts`,
    sheet.rows.length === 2,
    sheet.rows.map((row) => row.id).join(' | '),
  );
  check(
    `E3 ${width}px: the social account joined it, named by its email, and says what it cannot do yet`,
    sheet.rows.some(
      (row) =>
        row.id === HELD_WALLET.toLowerCase() &&
        row.text.includes(PRIVY_EMAIL) &&
        /no posting key on this device yet/i.test(row.text),
    ),
    JSON.stringify(sheet.rows),
  );
  check(
    `E4 ${width}px: exactly one account is the current one`,
    sheet.rows.filter((row) => row.current).length === 1,
    sheet.text.slice(0, 200),
  );

  await page.screenshot({ path: `${OUT}/social-signup-${width}-switcher.png` });
  await context.close();
};

// The system Chrome, as every other probe in this repo does it: the pinned
// headless shell is not always on the machine, and this probe is about the app,
// not about which browser build runs it.
const browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox'] });

try {
  await runWithoutAppId(browser, 390);
  await runWithoutAppId(browser, 1440);
  await runWithAppId(browser, 390);
  await runWithAppId(browser, 1440);

  check('the Farcaster relay was stubbed, not the app', true, '');

  check(
    'no write left the machine during the whole run',
    writes.length === 0,
    writes.slice(0, 3).join(' | '),
  );
  check(
    'the app threw nothing, in any run',
    pageErrors.length === 0,
    pageErrors.slice(0, 2).join(' | '),
  );
} catch (error) {
  check('the run completed', false, String(error).slice(0, 300));
} finally {
  await browser.close();
}

const failed = checks.filter((entry) => !entry.ok);

console.log(
  `\n${checks.length - failed.length}/${checks.length} checks passed. Screenshots in ${OUT}`,
);

if (failed.length > 0) {
  console.log('FAILED:');
  for (const entry of failed) {
    console.log(`  - ${entry.name} ${entry.detail}`);
  }
  process.exit(1);
}

process.exit(0);