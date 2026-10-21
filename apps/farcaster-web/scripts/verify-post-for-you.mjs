// End-to-end check for the one-time "let Fiddy post as you" offer: is it made,
// where it is made, in whose words, with what in front of it — and does saying
// not now really end it?
//
//   cd apps/farcaster-web
//   SNAPCHAIN_HTTP_URL=https://<a public read node> \
//   VITE_SNAPCHAIN_HTTP_URL=https://<the same> \
//   npx vite --config scripts/probe.vite.config.mjs --port 5201 --strictPort
//
//   NODE_BACKED_SERVER=https://localhost:5201 node scripts/verify-post-for-you.mjs
//
// Only the SIWF relay is stubbed, and it is stubbed with a REAL SIWE message
// signed by a throwaway key, so the app's own verifier accepts the sign-in for
// real — the same scaffolding `scripts/verify-node-backed-client.mjs` uses. The
// signed-in account is `fid 3` (`dwr`), which has a real follow graph, so the
// feed behind the offer is a real one.
//
// WHAT IT ASSERTS (each one an observation, not a shape guess)
//
//   1. a completed sign-in lands in the CLIENT (not the setup sheet, not the
//      device-only landing that says nothing can load here)
//   2. the offer is on screen after it, in the shell, without the reader
//      navigating anywhere (`[data-fiddy="post-for-you"]`)
//   3. it is the one-time step the card asked for, in plain words: "Set it up"
//      and "Not now", and none of the protocol's own vocabulary on it
//   4. the blocking test-account warning still stands between the offer and the
//      setup: the confirm control is disabled with nothing typed AND with a
//      phrase typed, and only the acknowledgement enables it
//   5. nothing was signed and nothing was sent from this run — no
//      `/v1/submitMessage` left the page (the parent card's rule: a probe never
//      posts to mainnet, so the probe stops at the enabled button)
//   6. the same signed-in session is still reading the feed from a node — a
//      `200` on a cast route at a server that is not this app
//   7. "Not now" takes the offer away, and the device remembers: a reload keeps
//      it away (its own storage read, not a flag this probe set by hand)
//
// Screenshots land in $NODE_BACKED_SHOT_DIR (default: the system temp dir).

import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const SERVER = process.env.NODE_BACKED_SERVER ?? 'https://localhost:5201';
const DOMAIN = new URL(SERVER).host;
const OUT = process.env.NODE_BACKED_SHOT_DIR ?? os.tmpdir();
const NONCE = 'f'.repeat(128);
const CHANNEL_TOKEN = 'POSTFOR1';
const SIGNED_IN_FID = 3;

const account = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const message = createSiweMessage({
  address: account.address,
  chainId: 10,
  domain: DOMAIN,
  nonce: NONCE,
  uri: `${SERVER}/login`,
  version: '1',
});
const signature = await account.signMessage({ message });

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'content-type': 'application/json',
};

/** The offer card, as the page itself sees it. */
const readOffer = async (page) =>
  page.evaluate(() => {
    const card = document.querySelector('[data-fiddy="post-for-you"]');
    const main = document.querySelector('main');
    return {
      present: card !== null,
      text: (card?.innerText ?? document.body.innerText ?? '')
        .replace(/\s+/g, ' ')
        .trim(),
      cardText: (card?.innerText ?? '').replace(/\s+/g, ' ').trim(),
      path: window.location.pathname,
      hasMain: main !== null,
      deviceOnlyLanding: document.body.innerText.includes(
        'Farcaster signed this device in',
      ),
      setupSheet: /go social/i.test(document.body.innerText),
    };
  });

const findButton = async (page, pattern) => {
  for (const element of await page.$$('button, a, [role=button]')) {
    const text = ((await element.innerText()) || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (new RegExp(pattern, 'i').test(text)) {
      return { element, text };
    }
  }
  return null;
};

const checks = [];
const failed = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (detail) console.log(`        ${detail}`);
  if (!ok) failed.push(name);
};

const shot = async (page, name) => {
  await page.screenshot({ path: path.join(OUT, `post-for-you-${name}.png`) });
};

const run = async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors'],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  /** Every request the page made that would be a write to a Farcaster node. */
  const writes = [];
  /** Cast reads the network saw answered `200` by a server that is not this app. */
  const nodeCastReads = [];

  page.on('request', (request) => {
    const url = request.url();
    if (/\/v1\/(submitMessage|validateMessage)/.test(url)) {
      writes.push(`${request.method()} ${url.slice(0, 120)}`);
    }
  });
  page.on('response', (response) => {
    const url = response.url();
    const isCastRoute = /\/v1\/(castsByFid|castsByParent|castById)/.test(url);
    const onThisApp = url.startsWith(SERVER);
    if (isCastRoute && response.status() === 200 && !onThisApp) {
      nodeCastReads.push(`${response.status()} ${url.slice(0, 110)}`);
    }
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error')
      console.log(`  console: ${msg.text().slice(0, 160)}`);
  });

  // ── the sign-in: real SIWE, stubbed relay ─────────────────────────────────
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
        username: 'dwr',
        displayName: 'dwr',
      }),
    });
  });

  const signIn = async () => {
    await page.goto(`${SERVER}/welcome/ready`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('button, a, [role=button]')).some(
          (el) => /go social/i.test((el.innerText || '').replace(/\s+/g, ' ')),
        ),
      undefined,
      { timeout: 120_000 },
    );
    const button = await findButton(page, 'go social');
    let clicked = null;
    if (button) {
      await button.element.click();
      clicked = button.text;
    }
    await page
      .waitForFunction(
        () =>
          window.location.pathname === '/' &&
          document.querySelector('main') !== null &&
          !document.body.innerText.includes('Farcaster signed this device in'),
        undefined,
        { timeout: 60_000 },
      )
      .catch(() => undefined);
    return clicked;
  };

  const clicked = await signIn();
  await page.waitForTimeout(2000);
  const afterSignIn = await readOffer(page);
  await shot(page, 'after-signin');

  check(
    'a completed sign-in lands in the client, not on a setup or device-only screen',
    clicked !== null &&
      afterSignIn.path === '/' &&
      afterSignIn.hasMain &&
      !afterSignIn.deviceOnlyLanding &&
      !afterSignIn.setupSheet,
    `clicked="${clicked}" path=${afterSignIn.path} main=${afterSignIn.hasMain} deviceOnly=${afterSignIn.deviceOnlyLanding}`,
  );

  // ── 2 + 3. the offer, in plain words ──────────────────────────────────────
  let offer = afterSignIn;
  if (!offer.present) {
    await page
      .waitForSelector('[data-fiddy="post-for-you"]', { timeout: 45_000 })
      .catch(() => undefined);
    offer = await readOffer(page);
  }
  await shot(page, 'offer');

  check(
    'the offer is made right after sign-in, in the shell, without navigating',
    offer.present,
    offer.present
      ? `path=${offer.path} card="${offer.cardText.slice(0, 140)}"`
      : `no [data-fiddy="post-for-you"] on screen; text="${offer.text.slice(0, 160)}"`,
  );

  const setItUp = await findButton(page, 'set it up');
  const notNow = await findButton(page, 'not now');
  const banned = /gasless|signer|scope|ttl\b|key_add|app key|nonce|eip-?712/i;
  check(
    'the offer is the two-button one-time step the card asked for, in plain words',
    setItUp !== null &&
      notNow !== null &&
      /post/i.test(offer.cardText) &&
      !banned.test(offer.cardText),
    `"Set it up"=${setItUp?.text ?? 'missing'} "Not now"=${notNow?.text ?? 'missing'} ${
      banned.test(offer.cardText)
        ? `| the card uses a protocol word: "${banned.exec(offer.cardText)?.[0]}"`
        : '| no protocol vocabulary on the card'
    }`,
  );

  // ── 4. the blocking test-account warning, unchanged ───────────────────────
  let warning = {
    shown: false,
    ackEnabled: false,
    disabledAtFirst: false,
    disabledWithPhrase: false,
  };
  if (setItUp) {
    await page
      .click('[data-fiddy="post-for-you-set-up"]')
      .catch(() => undefined);
    await page
      .waitForFunction(
        () => /Security warning/.test(document.body.innerText),
        undefined,
        { timeout: 20_000 },
      )
      .catch(() => undefined);

    const state = async () => {
      const confirm = await findButton(
        page,
        'I understand, use a TEST account',
      );
      return {
        shown: /Security warning/.test(
          (await page.evaluate(() => document.body.innerText)) ?? '',
        ),
        testAccount: /Use a TEST account/.test(
          await page.evaluate(() => document.body.innerText),
        ),
        disabled: confirm ? await confirm.element.isDisabled() : null,
      };
    };

    const first = await state();
    // A phrase with no acknowledgement must still not be submittable.
    await page.fill(
      '#mnemonic',
      'test test test test test test test test test test test junk',
    );
    const withPhrase = await state();
    // And the acknowledgement is what enables it — the gate is the warning, not
    // a dead end.
    await page.evaluate(() => {
      const box = document.querySelector('input[type=checkbox]');
      if (box) box.click();
    });
    const acknowledged = await state();

    warning = {
      shown: first.shown && first.testAccount,
      disabledAtFirst: first.disabled === true,
      disabledWithPhrase: withPhrase.disabled === true,
      ackEnabled: acknowledged.disabled === false,
    };
    await shot(page, 'warning');

    // Never press the enabled confirm: that would ask a node to merge a real
    // KEY_ADD for a real account. The parent card's rule is that a probe does
    // not post to mainnet.
    const cancel = await findButton(page, '^cancel$');
    if (cancel)
      await page.click('button:has-text("Cancel")').catch(() => undefined);
    await page.waitForTimeout(500);
  }

  check(
    'the blocking test-account warning stands between the offer and the setup',
    warning.shown &&
      warning.disabledAtFirst &&
      warning.disabledWithPhrase &&
      warning.ackEnabled,
    `warning="${warning.shown ? 'shown, names a test account' : 'not shown'}" confirm disabled: empty=${warning.disabledAtFirst} phrase-only=${warning.disabledWithPhrase} acknowledged=${!warning.ackEnabled ? 'still disabled' : 'enabled'}`,
  );

  // ── 5 + 6. nothing signed, and the session still reads a node ─────────────
  await page.waitForTimeout(1500);
  check(
    'nothing was signed and nothing was sent from this run',
    writes.length === 0,
    writes.length === 0
      ? 'no /v1/submitMessage left the page'
      : writes.join(' | '),
  );
  check(
    'the same signed-in session is still reading the feed from a server that is not this app',
    nodeCastReads.length > 0,
    nodeCastReads.length > 0
      ? `${nodeCastReads.length} cast reads, first: ${nodeCastReads[0]}`
      : 'no cast read answered 200 at an absolute origin',
  );

  // ── 7. "Not now" ends it, and the device remembers ────────────────────────
  let afterNotNow = await readOffer(page);
  if (notNow && afterNotNow.present) {
    // Found again by its own attribute, not by a handle taken minutes ago: the
    // card re-renders whenever the pass or dismissal read resolves.
    await page
      .click('[data-fiddy="post-for-you-not-now"]')
      .catch(() => undefined);
    await page.waitForTimeout(1200);
    afterNotNow = await readOffer(page);
  }
  const goneAfterClick = !afterNotNow.present;

  await page.goto(`${SERVER}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForTimeout(4000);
  const afterReload = await readOffer(page);
  await shot(page, 'after-reload');

  check(
    '"Not now" takes the offer away, and the device remembers it across a reload',
    goneAfterClick && !afterReload.present,
    `after "Not now": present=${afterNotNow.present}; after reload at ${afterReload.path}: present=${afterReload.present}`,
  );

  await browser.close();

  console.log(
    `\n${checks.length - failed.length}/${checks.length} checks passed; screenshots in ${OUT}`,
  );
  if (failed.length > 0) {
    console.log(`failed: ${failed.join(' | ')}`);
    process.exitCode = 1;
  }
};

await run();
