// A PICTURE of the thing the probe measures.
//
//   MINIAPP_SERVER=https://localhost:5183 \
//     node scripts/shot-miniapp-in-feed.mjs
//
// WHY THIS IS A COMPANION AND NOT PART OF `verify-miniapp-in-feed.mjs`: the
// probe's own screenshots are viewport shots taken the moment its waits end, and
// on a signed-in client the lower half of a fresh session is covered by the
// shell's own "Let Fiddy post as you?" sheet — so the probe's feed screenshot
// shows the top of the column and a modal, not the card it just measured.
// MEASURED (2026-10-22 02:11, this card's own run): `fixtureTextOnScreen=true` at
// both widths while the attached mobile feed shot carried neither the fixture's
// row nor its card.
//
// So the picture is taken a second way, deliberately: sign in the same way the
// probe does, press **Following**, dismiss the shell's own sheet, scroll the
// fixture cast into the middle of the viewport, and shoot. Everything here is a
// read: it writes two PNGs and nothing else.
//
// The evidence stays the probe's report; this is the illustration. It does not
// assert anything, and it prints what it found (or did not) so a reader can tell
// a scrolled card from a blank screen.

import fs from 'node:fs';
import path from 'node:path';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const SERVER = process.env.MINIAPP_SERVER ?? 'https://localhost:5183';
const DOMAIN = new URL(SERVER).host;
const OUT =
  process.env.MINIAPP_SHOT_DIR ??
  path.join(process.cwd(), 'miniapp-shots');
const NONCE = 'f'.repeat(128);
const CHANNEL_TOKEN = 'MINIAPP1';

const FIXTURE = {
  fid: Number(process.env.MINIAPP_FIXTURE_FID ?? 1062481),
  hash:
    process.env.MINIAPP_FIXTURE_HASH ??
    '0x8b3019a85bdbd946bab5f1105f62f7b926746ace',
  text: process.env.MINIAPP_FIXTURE_TEXT ?? 'ask me anything for $0.05',
  url:
    process.env.MINIAPP_FIXTURE_URL ??
    'https://beep.works/send/cmi8mtgn500afiolnh4qelc53',
};

const SIGNED_IN_FID = Number(process.env.MINIAPP_SIGNED_IN_FID ?? 259576);
const SIGNED_IN_USERNAME = process.env.MINIAPP_SIGNED_IN_USERNAME ?? 'ogmaro';
const SIGNIN_BUDGET_MS = Number(process.env.MINIAPP_SIGNIN_BUDGET_MS ?? 480_000);
const FEED_BUDGET_MS = Number(process.env.MINIAPP_FEED_BUDGET_MS ?? 480_000);
const SHOT_MS = Number(process.env.MINIAPP_SHOT_MS ?? 30_000);
const SHOT_RETRY_MS = Number(process.env.MINIAPP_SHOT_RETRY_MS ?? 240_000);

fs.mkdirSync(OUT, { recursive: true });

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

const browser = await chromium.launch({
  channel: 'chrome',
  ignoreHTTPSErrors: true,
  args: ['--ignore-certificate-errors'],
});

/** In page, one evaluate: what the reader would do with a mouse. */
const press = (page, pattern) =>
  page.evaluate((source) => {
    const wanted = new RegExp(source, 'i');
    const target = Array.from(
      document.querySelectorAll('button, a, [role=button]'),
    ).find((el) => wanted.test((el.innerText || '').replace(/\s+/g, ' ')));
    if (!target) return null;
    target.click();
    return (target.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  }, pattern);

const scrollFixtureIntoView = (page, text) =>
  page.evaluate((needle) => {
    const candidates = Array.from(
      document.querySelectorAll('div, article, li, section'),
    ).filter((el) => (el.innerText ?? '').includes(needle));
    candidates.sort(
      (a, b) => (a.innerText ?? '').length - (b.innerText ?? '').length,
    );
    // The cast's own row, then three levels up: that is the card and its embed.
    let target = candidates[0];
    if (!target) return { found: false };
    for (let i = 0; i < 3 && target.parentElement; i += 1) {
      target = target.parentElement;
    }
    target.scrollIntoView({ block: 'center' });
    return {
      found: true,
      text: (target.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 240),
    };
  }, text);

const waitForText = async (page, text, budgetMs) => {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const seen = await page
      .evaluate(
        (needle) => (document.body?.innerText ?? '').includes(needle),
        text,
      )
      .catch(() => false);
    if (seen) return true;
    await page.waitForTimeout(2000);
  }
  return false;
};

const runViewport = async ({ label, width, height }) => {
  const context = await browser.newContext({
    viewport: { width, height },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  await page.route('https://relay.farcaster.xyz/**', async (route) => {
    const method = route.request().method();
    if (method === 'OPTIONS')
      return route.fulfill({ status: 204, headers: CORS, body: '' });
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
        username: SIGNED_IN_USERNAME,
        displayName: SIGNED_IN_USERNAME,
      }),
    });
  });

  // Sign in the way the probe does.
  await page.goto(`${SERVER}/welcome/ready`, {
    waitUntil: 'commit',
    timeout: 180_000,
  });
  let pressed = null;
  const signInDeadline = Date.now() + SIGNIN_BUDGET_MS;
  while (Date.now() < signInDeadline && pressed === null) {
    pressed = await press(page, 'go social').catch(() => null);
    if (pressed === null) await page.waitForTimeout(3000);
  }
  const inClient = await (async () => {
    const until = Date.now() + SIGNIN_BUDGET_MS;
    while (Date.now() < until) {
      const p = await page
        .evaluate(() => window.location.pathname)
        .catch(() => '/welcome/ready');
      if (p === '/' || p.startsWith('/~/')) return true;
      await page.waitForTimeout(2000);
    }
    return false;
  })();
  console.log(`${label}: pressed=${JSON.stringify(pressed)} inClient=${inClient}`);

  // The Following feed, the shell's own sheet dismissed, the fixture scrolled in.
  await page.goto(`${SERVER}/`, { waitUntil: 'commit', timeout: 180_000 });
  await page.waitForTimeout(2000);
  const tab = await press(page, 'following');
  console.log(`${label}: pressed Following -> ${JSON.stringify(tab)}`);
  await waitForText(page, FIXTURE.text, FEED_BUDGET_MS);
  const dismissed = await press(page, 'not now');
  console.log(`${label}: dismissed the shell's sheet -> ${JSON.stringify(dismissed)}`);
  await page.waitForTimeout(1500);
  const scrolled = await scrollFixtureIntoView(page, FIXTURE.text);
  console.log(`${label}: scrolled to the fixture -> ${JSON.stringify(scrolled)}`);
  await page.waitForTimeout(2500);

  const name = `${label}-feed-fixture-in-view`;
  for (const [index, budget] of [SHOT_MS, SHOT_RETRY_MS].entries()) {
    try {
      await page.screenshot({
        path: path.join(OUT, `${name}.png`),
        fullPage: false,
        animations: 'disabled',
        timeout: budget,
      });
      console.log(`${label}: wrote ${path.join(OUT, `${name}.png`)}`);
      break;
    } catch (error) {
      if (index === 1) {
        console.log(`${label}: screenshot skipped — ${String(error).split('\n')[0]}`);
      }
    }
  }

  await context.close();
};

for (const viewport of [
  { label: 'mobile-390', width: 390, height: 844 },
  { label: 'desktop-1440', width: 1440, height: 900 },
]) {
  try {
    await runViewport(viewport);
  } catch (error) {
    console.log(`!! ${viewport.label} ended early — ${String(error).split('\n')[0]}`);
  }
}

await browser.close().catch(() => {});
process.exit(0);