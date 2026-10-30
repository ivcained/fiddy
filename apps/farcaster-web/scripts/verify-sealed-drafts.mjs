// Sealed drafts, exercised in the real composer at 390 and 1440. SIWF and the
// same-origin owner/draft services are local fixtures; nothing reaches production
// and no signer is minted. Start the probe Vite server, then:
//   SEALED_DRAFTS_SERVER=https://fiddy.fun:5227 node scripts/verify-sealed-drafts.mjs

import os from 'node:os';
import { mkdir } from 'node:fs/promises';

import { chromium } from 'playwright';
import { createSiweMessage } from 'viem/siwe';
import { privateKeyToAccount } from 'viem/accounts';

const SERVER = process.env.SEALED_DRAFTS_SERVER ?? 'https://fiddy.fun:5227';
const SELF_SERVER =
  process.env.SEALED_DRAFTS_SELF_SERVER ?? 'https://localhost:5227';
const OUT = process.env.SEALED_DRAFTS_SHOT_DIR ?? os.tmpdir();
const NONCE = 'f'.repeat(128);
const CHANNEL_TOKEN = 'CASTSUBMT';
const checks = [];
const captures = [];
let browser;

const account = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const makeSiweProof = async (server) => {
  const message = createSiweMessage({
    address: account.address,
    chainId: 10,
    domain: new URL(server).host,
    nonce: NONCE,
    uri: `${server}/login`,
    version: '1',
  });
  return { message, signature: await account.signMessage({ message }) };
};
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'content-type': 'application/json',
};
const check = (name, ok, detail = '') =>
  checks.push({ name, ok: Boolean(ok), detail });
const textOf = (page) =>
  page.evaluate(() => (document.body?.innerText ?? '').replace(/\s+/g, ' '));
const modalText = (page) =>
  page.evaluate(() =>
    (document.querySelector('#modal-root')?.innerText ?? '').replace(/\s+/g, ' '),
  );
const shot = async (page, name, width) => {
  const path = `${OUT}/sealed-drafts-${width}-${name}.png`;
  await page.screenshot({ path, fullPage: true });
  captures.push({ path, width, url: page.url() });
};
const waitForText = async (page, text, timeout = 30000) => {
  try {
    await page.waitForFunction(
      (wanted) => (document.body?.innerText ?? '').includes(wanted),
      text,
      { timeout },
    );
  } catch (error) {
    const body = (await textOf(page)).slice(0, 1200);
    throw new Error(`missing text ${JSON.stringify(text)}; body=${body}`, {
      cause: error,
    });
  }
};

const tokenFor = (fid) => {
  const payload = Buffer.from(JSON.stringify({ fid, exp: Date.now() + 3_600_000 })).toString(
    'base64url',
  );
  return `fiddy-owner.${payload}.fixture`;
};

const installFixtures = async (ctx, state, remote, proof) => {
  await ctx.route('https://relay.farcaster.xyz/**', async (route) => {
    if (route.request().method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: CORS, body: '' });
    }
    if (route.request().method() === 'POST') {
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
        message: proof.message,
        signature: proof.signature,
        fid: state.fid,
        username: state.fid === 3 ? 'dwr' : 'fixture-account',
        displayName: state.fid === 3 ? 'dwr' : 'Fixture account',
      }),
    });
  });
  await ctx.route('**/api/fiddy/owner-session', async (route) => {
    state.ownerCalls += 1;
    if (state.failOwner) {
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, code: 'UNAVAILABLE' }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        session: {
          token: tokenFor(state.fid),
          baseUrl: 'https://fiddy.fun',
          expiresAt: Date.now() + 3_600_000,
        },
      }),
    });
  });
  await ctx.route('**/api/fiddy/drafts', async (route) => {
    const method = route.request().method();
    const body = route.request().postData() ?? '';
    state.draftCalls.push({ method, body });
    if (method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, drafts: [...remote.values()] }),
      });
    }
    if (method === 'PUT') {
      const incoming = JSON.parse(body);
      const current = remote.get(incoming.id);
      const newer =
        !current ||
        incoming.updatedAt > current.updatedAt ||
        (incoming.updatedAt === current.updatedAt &&
          incoming.writerId < current.writerId);
      if (newer) remote.set(incoming.id, incoming);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, draft: remote.get(incoming.id) }),
      });
    }
    remote.clear();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, deleted: 0 }),
    });
  });
};

const makeDevice = async (width, fid = 3, selfHosted = false, remote = new Map()) => {
  const state = { fid, failOwner: false, ownerCalls: 0, draftCalls: [] };
  const server = selfHosted ? SELF_SERVER : SERVER;
  const proof = await makeSiweProof(server);
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width, height: width === 390 ? 844 : 900 },
  });
  await installFixtures(ctx, state, remote, proof);
  const page = await ctx.newPage();
  state.consoleErrors = [];
  page.on('pageerror', (error) =>
    state.consoleErrors.push(
      `${page.url()} :: ${String(error?.stack ?? error)}`,
    ),
  );
  return { ctx, page, state, remote, server };
};

const signIn = async (device) => {
  const { page, state, server } = device;
  // The ready sheet's primary is "Go social — sign in with Farcaster" on a
  // fresh device and "Save <name> & sign in with Farcaster" once the trial
  // agent has answered (its state survives a sign-out), so match the tail.
  const readyButton = () =>
    [...document.querySelectorAll('button, a, [role=button]')].some((el) =>
      /sign in with farcaster/i.test(el.innerText || ''),
    );
  await page.goto(`${server}/welcome/ready`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  // Sign-out is async, and /welcome/ready sends a still-signed-in session
  // back to the client, so re-enter until the ready sheet really renders.
  const deadline = Date.now() + 60000;
  for (;;) {
    if (await page.evaluate(readyButton)) break;
    if (Date.now() > deadline) {
      throw new Error(`ready sheet never rendered; at ${page.url()}`);
    }
    await page.waitForTimeout(500);
    if (new URL(page.url()).pathname !== '/welcome/ready') {
      await page.goto(`${server}/welcome/ready`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
    }
  }
  await page.locator('button, a, [role=button]').filter({ hasText: /sign in with farcaster/i }).first().click();
  await page.waitForFunction(
    () =>
      window.location.pathname === '/' &&
      Boolean(document.querySelector('.fiddy-shell-frame')) &&
      !document.querySelector('[data-fiddy="onboarding"]'),
    { timeout: 60000 },
  );
  check(`sign-in works for FID ${state.fid}`, (await textOf(page)).length > 0);
};

const openComposer = async (page) => {
  const editor = '#modal-root [contenteditable="true"]:visible';
  if (await page.locator(editor).count()) {
    return;
  }
  if (await page.getByText('Compose', { exact: true }).count()) {
    await page.getByText('Compose', { exact: true }).click();
    await page.waitForSelector(editor, { timeout: 30000 });
    return;
  }
  await page.waitForSelector('.fiddy-shell-frame', { timeout: 60000 });
  // The desktop header renders two "Cast" buttons and only one is ever
  // visible; it can also paint a beat after the shell frame, and a click can
  // land on a copy the header then re-renders away — so try, verify, retry.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const cast = page.locator('button:text-is("Cast"):visible').first();
    try {
      await cast.waitFor({ state: 'visible', timeout: 10000 });
      await cast.click({ timeout: 5000 });
    } catch {
      await page.keyboard.press('n').catch(() => {});
    }
    try {
      await page.waitForSelector(editor, { timeout: 8000 });
      return;
    } catch {
      // try again
    }
  }
  await page.waitForSelector(editor, { timeout: 30000 });
};

const openDrafts = async (device) => {
  const { page } = device;
  if (!(await page.getByText('Drafts', { exact: true }).count())) {
    await openComposer(page);
  }
  await page.getByText('Drafts', { exact: true }).click();
  await page.waitForSelector(
    '[data-fiddy="draft-sync"], [data-fiddy="drafts-device-only"]',
    { timeout: 30000 },
  );
};

const saveComposer = async (page) => {
  await page.locator('#modal-root div.rounded-full').last().click();
  const save = page.getByText('Save draft', { exact: true });
  await save.waitFor({ timeout: 15000 });
  await save.click();
  await page
    .locator('#modal-root [contenteditable="true"]:visible')
    .waitFor({ state: 'hidden', timeout: 30000 });
};

const typeDraft = async (page, text) => {
  await openComposer(page);
  const editor = page.locator('#modal-root [contenteditable="true"]:visible').first();
  await editor.click();
  await page.keyboard.type(text);
  await page.waitForTimeout(1200);
};

const enableSync = async (device) => {
  const { page } = device;
  await page.locator('[data-fiddy="draft-sync-offer"]').click();
  await page.locator('[data-fiddy="draft-sync-enroll"]').click();
  await page.waitForSelector('[data-fiddy="draft-recovery-code"] code', {
    timeout: 30000,
  });
  return page.locator('[data-fiddy="draft-recovery-code"] code').innerText();
};

const storageState = (page, fid) =>
  page.evaluate((accountFid) => {
    const values = Object.keys(localStorage)
      .filter((key) => key.startsWith('fiddy:sealed-drafts:'))
      .map((key) => `${key}:${localStorage.getItem(key) ?? ''}`)
      .join('\n');
    return {
      values,
      accountValues: Object.keys(localStorage)
        .filter((key) => key.includes(`:${accountFid}:`))
        .map((key) => localStorage.getItem(key) ?? '')
        .join('\n'),
    };
  }, fid);

const runHosted = async (width) => {
  const remote = new Map();
  const a = await makeDevice(width, 3, false, remote);
  const base = `sealed draft ${width}`;
  const updated = `newer device draft ${width}`;
  const privateFid3 = `only FID three ${width}`;
  const localFid4 = `only FID four ${width}`;
  await signIn(a);
  await typeDraft(a.page, base);
  let beforeReload = await storageState(a.page, 3);
  for (let i = 0; i < 100 && !beforeReload.accountValues.includes('v1.'); i += 1) {
    await a.page.waitForTimeout(100);
    beforeReload = await storageState(a.page, 3);
  }
  check(
    `${width}: auto-recovery is sealed on this device`,
    beforeReload.accountValues.includes('v1.') && !beforeReload.accountValues.includes(base),
  );
  await a.page.reload({ waitUntil: 'domcontentloaded' });
  await openComposer(a.page);
  await waitForText(a.page, base);
  check(`${width}: local recovery survives reload without losing text`, (await modalText(a.page)).includes(base));
  await shot(a.page, 'recovered', width);
  await saveComposer(a.page);
  await openDrafts(a);
  check(`${width}: saved draft appears in the existing Drafts list`, (await modalText(a.page)).includes(base));
  const recoveryCode = await enableSync(a);
  for (let i = 0; i < 100 && remote.size === 0; i += 1) await a.page.waitForTimeout(100);
  check(`${width}: opt-in uploads only ciphertext`, remote.size > 0 && a.state.draftCalls.every(({ body }) => !body.includes(base)));

  const b = await makeDevice(width, 3, false, remote);
  await signIn(b);
  await openDrafts(b);
  await enableSync(b);
  for (let i = 0; i < 100 && !(await modalText(b.page)).includes('locked with another key'); i += 1) {
    await b.page.waitForTimeout(100);
  }
  await b.page.reload({ waitUntil: 'domcontentloaded' });
  await openDrafts(b);
  await waitForText(b.page, 'locked with another key');
  check(`${width}: another key is an honest locked state`, !(await modalText(b.page)).includes(base));
  await shot(b.page, 'locked', width);
  await b.page.getByText('Have a recovery code?', { exact: true }).click();
  await b.page.locator('[data-fiddy="draft-recovery-input"]').fill(recoveryCode);
  await b.page.locator('[data-fiddy="draft-recover"]').click();
  await waitForText(b.page, base);
  check(`${width}: recovery code opens the same draft on another device`, (await modalText(b.page)).includes(base));

  await a.page.reload({ waitUntil: 'domcontentloaded' });
  await openDrafts(a);
  const beforeEditBox = [...remote.values()][0]?.box;
  await a.page.getByText(base, { exact: true }).click();
  const editor = a.page.locator('#modal-root [contenteditable="true"]:visible').first();
  await editor.click();
  await editor.fill(updated);
  await waitForText(a.page, updated);
  await saveComposer(a.page);
  for (let i = 0; i < 100 && [...remote.values()][0]?.box === beforeEditBox; i += 1) {
    await a.page.waitForTimeout(100);
  }
  const remoteEditChanged = [...remote.values()][0]?.box !== beforeEditBox;
  await openDrafts(a);
  check(
    `${width}: edited draft changes locally and reaches the ciphertext mirror`,
    remoteEditChanged && (await modalText(a.page)).includes(updated),
    `remoteChanged=${remoteEditChanged} writes=${JSON.stringify(a.state.draftCalls.map(({ method }) => method))}`,
  );
  await openDrafts(b);
  await b.page.locator('[data-fiddy="draft-sync-now"]').click();
  await waitForText(b.page, updated);
  check(`${width}: newer stable-ID edit wins on the other device`, !(await modalText(b.page)).includes(base));

  await openDrafts(a);
  const draftText = a.page.getByText(updated, { exact: true });
  const row = draftText.locator('xpath=../..');
  await row.locator('svg.rotate-90').click();
  await a.page.getByText('Delete', { exact: true }).click();
  for (let i = 0; i < 100 && ![...remote.values()].some((record) => record.box === null); i += 1) {
    await a.page.waitForTimeout(100);
  }
  await openDrafts(b);
  await b.page.locator('[data-fiddy="draft-sync-now"]').click();
  await b.page.waitForFunction(
    (wanted) => !(document.querySelector('#modal-root')?.innerText ?? '').includes(wanted),
    updated,
    { timeout: 30000 },
  );
  const bStorage = await storageState(b.page, 3);
  check(`${width}: deletion tombstone converges without resurrecting text`, bStorage.accountValues.includes('"box":null'));
  await shot(b.page, 'deleted', width);

  await typeDraft(a.page, privateFid3);
  await saveComposer(a.page);
  const opener = a.page.locator('[data-fiddy="account-menu-button"]:visible, [data-fiddy="mobile-account-tab"]:visible').first();
  await opener.click();
  await a.page.locator('[data-fiddy="account-menu-sign-out"]').click();
  await a.page.locator('[data-fiddy="sign-out-confirm"]').click();
  // signOut() is async storage work; navigating before it finishes leaves a
  // half-cleared session that hangs the next boot on "Loading Fiddy…".
  await a.page
    .locator('[data-fiddy="sign-out-modal"]')
    .waitFor({ state: 'detached', timeout: 30000 });
  await a.page.waitForFunction(
    () =>
      !document.querySelector('[data-fiddy="account-menu-button"]') &&
      !document.querySelector('[data-fiddy="mobile-account-tab"]'),
    { timeout: 30000 },
  );
  await a.page.waitForTimeout(1000);
  a.state.fid = 4;
  await signIn(a);
  await typeDraft(a.page, localFid4);
  await saveComposer(a.page);
  await openDrafts(a);
  const switched = await modalText(a.page);
  check(`${width}: sign-out/account switch isolates drafts`, switched.includes(localFid4) && !switched.includes(privateFid3));
  const isolated = await storageState(a.page, 3);
  check(`${width}: previous account remains sealed, not plaintext`, !isolated.accountValues.includes(privateFid3));
  await shot(a.page, 'account-switch', width);

  a.state.failOwner = true;
  await a.page.locator('[data-fiddy="draft-sync-offer"]').click();
  await a.page.locator('[data-fiddy="draft-sync-enroll"]').click();
  await a.page.waitForSelector('[data-fiddy="draft-sync-error"]', { timeout: 30000 });
  check(`${width}: unavailable service is honest and local text survives`, (await modalText(a.page)).includes(localFid4));
  check(`${width}: no fixture page errors`, a.state.consoleErrors.length === 0 && b.state.consoleErrors.length === 0, [...a.state.consoleErrors, ...b.state.consoleErrors].slice(0, 3).join(' || '));
  await a.ctx.close();
  await b.ctx.close();
};

const runSelfHosted = async (width) => {
  const device = await makeDevice(width, 3, true);
  const text = `self hosted draft ${width}`;
  await signIn(device);
  await typeDraft(device.page, text);
  await saveComposer(device.page);
  await openDrafts(device);
  const copy = await modalText(device.page);
  check(
    `${width}: self-hosted install stays local with no dead sync control`,
    copy.includes('Drafts stay on this device.') &&
      !copy.includes('Sync my drafts') &&
      device.state.draftCalls.length === 0 &&
      device.state.ownerCalls === 0,
  );
  check(`${width}: self-hosted local draft is intact`, copy.includes(text));
  await device.ctx.close();
};

try {
  await mkdir(OUT, { recursive: true });
  browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: [
      '--ignore-certificate-errors',
      '--host-resolver-rules=MAP fiddy.fun 127.0.0.1',
    ],
  });
  for (const width of (process.env.SEALED_DRAFTS_WIDTHS ?? '390,1440')
    .split(',')
    .map((value) => Number(value.trim()))) {
    await runHosted(width);
    await runSelfHosted(width);
  }
} catch (error) {
  let pageState = '';
  try {
    for (const ctx of browser?.contexts() ?? []) {
      for (const p of ctx.pages()) {
        const body = await p.evaluate(
          () => (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 500),
        );
        pageState += `\n[page ${p.url()}] ${body}`;
      }
    }
  } catch {}
  check(
    'probe completed without throwing',
    false,
    `${String(error?.stack ?? error).slice(0, 600)}${pageState}`,
  );
} finally {
  await browser?.close().catch(() => {});
}

for (const result of checks) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? ` — ${result.detail}` : ''}`);
}
console.log(`captures: ${JSON.stringify(captures)}`);
const failed = checks.filter((result) => !result.ok);
console.log(`${checks.length - failed.length}/${checks.length} checks passed; screenshots in ${OUT}`);
if (failed.length) process.exitCode = 1;
