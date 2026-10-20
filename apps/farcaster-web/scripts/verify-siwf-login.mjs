// End-to-end check of Sign In With Farcaster in this client.
//
//   node scripts/verify-siwf-login.mjs
//
// Needs the dev server on https://localhost:5173 (pnpm start) and, for the
// "after the reload" half, the fork's mock API on :8080 — the same harness the
// shell verification used (see the dev escape hatch in src/constants/api.ts):
//
//   node <mock-api.cjs>
//
// Screenshots land in $SIWF_SHOT_DIR (default: the system temp dir).
//
// It exercises: the QR, the approval handshake, the signed-in state, the
// absence of the dead legacy sync-channel flow, and what the app looks like
// once the reload that follows a sign-in has run.
//
// Only the SIWF relay is stubbed, and it is stubbed with a REAL SIWE message
// signed by a throwaway key, so the app's own verifier has to genuinely accept
// it. Everything else is the app.
//
//   1. the QR renders and points at the SIWF relay URL, not the dead legacy link
//   2. approval lands a signed-in state that names the account and the fid
//   3. no legacy sync-channel traffic exists at all any more
//   4. no /v2/me probe with a local token, no sign-out
//   5a. with the fork's mock API (dev escape hatch): after the reload the authed
//       Fiddy shell is up
//   5b. with the real API (farcaster.xyz): still no ejection to the welcome —
//       the surfaces themselves error out, which is recorded, not hidden
import os from 'node:os';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const OUT = process.env.SIWF_SHOT_DIR ?? os.tmpdir();
const DOMAIN = 'localhost:5173';
const NONCE = 'c'.repeat(128);
const CHANNEL_TOKEN = 'TESTTOK1';

const account = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const message = createSiweMessage({
  address: account.address, chainId: 10, domain: DOMAIN, nonce: NONCE,
  uri: `https://${DOMAIN}/login`, version: '1',
});
const signature = await account.signMessage({ message });

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'content-type': 'application/json',
};

const run = async ({ label, mockApi }) => {
  const relay = [];
  const farcasterApi = [];
  const consoleErrors = [];
  let statusCalls = 0;

  const browser = await chromium.launch({
    channel: 'chrome', ignoreHTTPSErrors: true, args: ['--ignore-certificate-errors'],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  if (mockApi) {
    await ctx.addInitScript(() => { try { window.localStorage.setItem('farcasterApi.local', 'true'); } catch {} });
  }
  const page = await ctx.newPage();

  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 200)}`));
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('farcaster.xyz/~api')) farcasterApi.push(`${r.method()} ${new URL(u).pathname}`);
  });

  await page.route('https://relay.farcaster.xyz/**', async (route) => {
    const method = route.request().method();
    relay.push(`${method} ${new URL(route.request().url()).pathname}`);
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS, body: '' });
    if (method === 'POST') {
      return route.fulfill({ status: 201, headers: CORS, body: JSON.stringify({
        channelToken: CHANNEL_TOKEN,
        url: `https://farcaster.xyz/~/siwf?channelToken=${CHANNEL_TOKEN}`,
        nonce: NONCE,
      }) });
    }
    statusCalls += 1;
    const pending = statusCalls <= 2;
    return route.fulfill({ status: pending ? 202 : 200, headers: CORS, body: JSON.stringify(pending
      ? { state: 'pending', nonce: NONCE }
      : { state: 'completed', nonce: NONCE, message, signature, fid: 4242, username: 'fiddy', displayName: 'Fiddy', bio: 'your agent, living in your pocket', pfpUrl: 'https://example.com/pfp.png' }) });
  });

  await page.goto('https://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(() => document.body.innerText.trim().length > 60, { timeout: 60000 });

  for (const el of await page.$$('button, a, [role=button]')) {
    const txt = ((await el.innerText()) || '').replace(/\s+/g, ' ').trim();
    if (/go social/i.test(txt)) { await el.click(); break; }
  }

  await page.waitForFunction(() => /channelToken=/.test(document.body.innerText), { timeout: 30000 }).catch(() => {});
  const qrText = await page.innerText('body');
  const svgCount = await page.$$eval('svg', (els) => els.length).catch(() => 0);
  await page.screenshot({ path: `${OUT}/login-qr-${label}.png` });

  const signedIn = await page
    .waitForFunction(() => /You're signed in/.test(document.body.innerText), { timeout: 30000 })
    .then(() => true).catch(() => false);
  const signedInText = await page.innerText('body');
  await page.screenshot({ path: `${OUT}/login-signed-in-${label}.png` });

  await page.waitForTimeout(13000);
  const after = await page.evaluate(() => {
    const text = document.body.innerText.replace(/\s+/g, ' ').trim();
    const shell = new Set();
    document.querySelectorAll('[class]').forEach((el) => {
      String(el.className).split(/\s+/).forEach((c) => { if (/^fiddy-/.test(c)) shell.add(c); });
    });
    return {
      text,
      shellClasses: Array.from(shell).slice(0, 12),
      welcome: /Meet Fiddy|Go social/i.test(text),
      apiError: /Could not reach Farcaster|Error retrieving data/i.test(text),
    };
  });
  await page.screenshot({ path: `${OUT}/after-reload-${label}.png` });
  await browser.close();

  return {
    qrRendered: svgCount > 0,
    qrPointsAtSiwf: /farcaster\.xyz\/~\/siwf\?channelToken=/.test(qrText),
    legacyLinkGone: !/farcaster\.xyz\/login-web\?channel-id=/.test(qrText),
    signedInStateRendered: signedIn,
    handleNamed: /@fiddy/.test(signedInText),
    fidShown: /fid 4242/.test(signedInText),
    relayPolledWithChannel: relay.filter((r) => r.startsWith('GET')).length >= 3,
    noSyncChannelTraffic: !farcasterApi.some((u) => u.includes('sync-channel')),
    noMeProbeWithLocalToken: !farcasterApi.some((u) => u.includes('/v2/me')),
    afterReload: {
      shellClasses: after.shellClasses.length,
      welcomeBack: after.welcome,
      apiErrorPage: after.apiError,
      text: after.text.slice(0, 160),
    },
  };
};

const withMock = await run({ label: 'mockapi', mockApi: true });
console.log('--- with the fork mock API ---');
console.log(JSON.stringify(withMock, null, 1));

const realApi = await run({ label: 'realapi', mockApi: false });
console.log('--- with the real farcaster.xyz API ---');
console.log(JSON.stringify(realApi, null, 1));