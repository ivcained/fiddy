// Delete account, exercised in the real Settings flow at 390 and 1440: the
// intro's plain-words screens, the deliberate arm, a stubbed server purge, and
// a stubbed node erase driven to its done state — with the remove messages the
// page really sent decoded and counted.
//
//   HTTPS=true SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
//     VITE_SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com VITE_SNAPCHAIN_DEBUG=true \
//     PROBE_VITE_CACHE_DIR=/tmp/fiddy-delete-probe-vite \
//     npx vite --config scripts/probe.vite.config.mjs --port 5231 --strictPort
//   DELETE_ACCOUNT_SERVER=https://fiddy.fun:5231 node scripts/verify-delete-account.mjs
//
// WHAT IS REAL HERE, WHAT IS STUBBED
// The page runs as https://fiddy.fun (mapped to the loopback dev server with
// --host-resolver-rules, exactly like verify-sealed-drafts.mjs) so the
// hosted-only server purge half is exercised for real. Stubbed: the SIWF relay
// (a real SIWE message from a throwaway key, FID 3 = dwr), the control plane
// (/api/fiddy/owner-session, /api/fiddy/funding/balance, DELETE
// /api/fiddy/account), and the node's five erase endpoints (castsByFid,
// reactionsByFid, linksByFid, userDataByFid, submitMessage) — the fixture
// account's app key is a throwaway hex string and every remove is answered by
// the stub. NOTHING is submitted to a real node and nothing is deleted
// anywhere real; non-GET requests to any other host are aborted and counted.
//
// Screenshots land in $DELETE_ACCOUNT_SHOT_DIR (default: the system temp dir).

import { mkdir } from 'node:fs/promises';
import os from 'node:os';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const SERVER = process.env.DELETE_ACCOUNT_SERVER ?? 'https://fiddy.fun:5231';
const SELF_SERVER =
  process.env.DELETE_ACCOUNT_SELF_SERVER ?? 'https://localhost:5231';
const OUT = process.env.DELETE_ACCOUNT_SHOT_DIR ?? os.tmpdir();
const NODE_ORIGIN = 'https://haatz.quilibrium.com';
const NONCE = 'd'.repeat(128);
const CHANNEL_TOKEN = 'SI_SECRET_TOKEN_KM3TXS0N';

/** The account the stubbed sign-in names: a real, active one. */
const SIGNED_IN_FID = 3;
/** The throwaway app key this device pretends to hold for the account. */
const APP_KEY = `0x${'03'.repeat(32)}`;

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
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
  'content-type': 'application/json',
};

const check = (name, ok, detail = '') =>
  checks.push({ name, ok: Boolean(ok), detail });
const textOf = (page) =>
  page.evaluate(() => (document.body?.innerText ?? '').replace(/\s+/g, ' '));
const containerText = (page) =>
  page.evaluate(() =>
    (
      document.querySelector('[data-fiddy="delete-account-page"]')?.innerText ??
      ''
    ).replace(/\s+/g, ' '),
  );
const shot = async (page, name, width) => {
  const path = `${OUT}/delete-account-${width}-${name}.png`;
  await page.screenshot({ path, fullPage: true });
  captures.push({ path, width, url: page.url() });
};
const marker = (page, name) =>
  page.evaluate(
    (wanted) =>
      document.querySelector(`[data-fiddy="${wanted}"]`) !== null,
    name,
  );
const waitForMarker = async (page, name, timeout = 60000) => {
  try {
    await page.waitForFunction(
      (wanted) =>
        document.querySelector(`[data-fiddy="${wanted}"]`) !== null,
      name,
      { timeout },
    );
  } catch (error) {
    const body = (await textOf(page)).slice(0, 1200);
    throw new Error(`missing marker ${name}; at ${page.url()}; body=${body}`, {
      cause: error,
    });
  }
};

/** A session token the app's own reader accepts: payload carries fid + exp. */
const tokenFor = (fid) => {
  const payload = Buffer.from(
    JSON.stringify({ fid, exp: Date.now() + 3_600_000 }),
  ).toString('base64url');
  return `fiddy-owner.${payload}.fixture`;
};

// ---------------------------------------------------------------------------
// a tiny protobuf reader, so the probe can say WHICH message was submitted

const varint = (b, i) => {
  let value = 0;
  let shift = 0;
  for (;;) {
    value += (b[i] & 0x7f) * 2 ** shift;
    if (!(b[i] & 0x80)) {
      return [value, i + 1];
    }
    i += 1;
    shift += 7;
  }
};

/** The MessageData inside a submitted Message: type (1), fid (2), timestamp (3). */
const messageData = (bytes) => {
  if (bytes[0] >> 3 !== 1) {
    throw new Error('expected data first');
  }
  const [length, after] = varint(bytes, 1);
  const data = bytes.subarray(after, after + length);
  const out = { type: 0, fid: 0, timestamp: 0 };
  let j = 0;
  while (j < data.length) {
    const [fieldKey, afterKey] = varint(data, j);
    const field = fieldKey >> 3;
    const wire = fieldKey & 7;
    if (wire === 0) {
      const [value, next] = varint(data, afterKey);
      if (field === 1) out.type = value;
      if (field === 2) out.fid = value;
      if (field === 3) out.timestamp = value;
      j = next;
    } else if (wire === 2) {
      const [innerLength, afterLength] = varint(data, afterKey);
      j = afterLength + innerLength;
    } else {
      throw new Error(`wire type ${wire} not read here`);
    }
  }
  return out;
};

// Protocol message type numbers (@farcaster/core's MessageType).
const MT = { CAST_REMOVE: 2, REACTION_REMOVE: 4, LINK_REMOVE: 6, USER_DATA_ADD: 11 };

// ---------------------------------------------------------------------------
// the fake node's fixtures: 3 casts (paged 2+1), 1 like + 1 recast, 2 follows,
// a profile with two clearable fields set (pfp, display), an already-empty bio
// and the username that stays with the account

const envelope = (data, hash) => ({
  hash,
  signer: `0x${'00'.repeat(32)}`,
  signature: '',
  signatureScheme: 'SIGNATURE_SCHEME_ED25519',
  hashScheme: 'HASH_SCHEME_BLAKE3',
  data: {
    fid: SIGNED_IN_FID,
    timestamp: 100,
    network: 'FARCASTER_NETWORK_MAINNET',
    ...data,
  },
});
const cast = (n) =>
  envelope(
    {
      type: 'MESSAGE_TYPE_CAST_ADD',
      castAddBody: {
        text: `cast ${n}`,
        embeds: [],
        embedsDeprecated: [],
        mentions: [],
        mentionsPositions: [],
        type: 'CAST',
      },
    },
    `0x${n.toString(16).padStart(40, '0')}`,
  );
const reaction = (type) =>
  envelope(
    {
      type: 'MESSAGE_TYPE_REACTION_ADD',
      reactionBody: {
        type,
        targetCastId: { fid: 2, hash: `0x${'ab'.repeat(20)}` },
        targetUrl: null,
      },
    },
    `0x${'cd'.repeat(20)}`,
  );
const follow = (targetFid) =>
  envelope(
    {
      type: 'MESSAGE_TYPE_LINK_ADD',
      linkBody: { type: 'follow', targetFid, displayTimestamp: null },
    },
    `0x${'ef'.repeat(20)}`,
  );
const userData = (type, value) =>
  envelope(
    { type: 'MESSAGE_TYPE_USER_DATA_ADD', userDataBody: { type, value } },
    `0x${'0a'.repeat(20)}`,
  );

const CASTS = [cast(1), cast(2), cast(3)];
const LIKES = [reaction('REACTION_TYPE_LIKE')];
const RECASTS = [reaction('REACTION_TYPE_RECAST')];
const FOLLOWS = [follow(2), follow(3)];
const PROFILE = [
  userData('USER_DATA_TYPE_PFP', 'https://x/p.png'),
  userData('USER_DATA_TYPE_DISPLAY', 'Fixture'),
  userData('USER_DATA_TYPE_BIO', ''),
  userData('USER_DATA_TYPE_USERNAME', 'dwr'),
];

/**
 * The routes one device needs. `state` accumulates what the page really sent:
 * node removals (decoded), the purge calls (run ids + auth header), and any
 * non-GET that tried to leave for a host that is not the dev server or the
 * stubbed node.
 */
const installFixtures = async (ctx, state, proof, server) => {
  // Registered FIRST so the specific stubs below win (Playwright consults
  // routes in reverse registration order): the write guard.
  await ctx.route('**', async (route) => {
    const request = route.request();
    const method = request.method();
    const url = request.url();
    if (
      ['GET', 'HEAD', 'OPTIONS'].includes(method) ||
      url.startsWith(server)
    ) {
      return route.continue();
    }
    state.strayWrites.push(`${method} ${url.slice(0, 110)}`);
    return route.abort();
  });

  await ctx.route('https://relay.farcaster.xyz/**', async (route) => {
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
        message: proof.message,
        signature: proof.signature,
        fid: SIGNED_IN_FID,
        username: 'dwr',
        displayName: 'dwr',
      }),
    });
  });

  await ctx.route('**/api/fiddy/owner-session', async (route) => {
    state.ownerCalls += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        session: {
          token: tokenFor(SIGNED_IN_FID),
          baseUrl: 'https://fiddy.fun',
          expiresAt: Date.now() + 3_600_000,
        },
      }),
    });
  });

  await ctx.route('**/api/fiddy/funding/balance', async (route) => {
    const usdc = state.balanceUsdc;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        credit: {
          availableUsdc: usdc,
          availableBaseUnits: usdc === '0' ? '0' : '2500000',
          creditedUsdc: usdc,
          creditedBaseUnits: usdc === '0' ? '0' : '2500000',
          spentUsdc: '0',
          spentBaseUnits: '0',
        },
        entries: [],
      }),
    });
  });

  await ctx.route('**/api/fiddy/account**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname !== '/api/fiddy/account' || request.method() !== 'DELETE') {
      return route.continue();
    }
    const run = url.searchParams.get('run') ?? '';
    state.accountCalls.push({
      run,
      authorization: request.headers()['authorization'] ?? '',
    });
    const seen = state.accountCalls.filter((call) => call.run === run).length;
    if (seen === 1) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, state: 'running' }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        state: 'done',
        drafts: 2,
        media: 1,
        mediaKept: 1,
        connect: 1,
        connectFailed: 0,
        fundingKept: true,
      }),
    });
  });

  // The node's five erase endpoints. Everything else on the node host is a
  // real read the shell needs, so it continues.
  const nodeList = async (route, body) => {
    if (route.request().method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: CORS, body: '' });
    }
    // Once the first removal has landed the node lists nothing — that is what
    // makes the erase's read-back pass answer "all gone".
    const empty = { messages: [], nextPageToken: '' };
    return route.fulfill({
      status: 200,
      headers: CORS,
      body: JSON.stringify(state.submitted.length > 0 ? empty : body),
    });
  };
  await ctx.route(`${NODE_ORIGIN}/v1/castsByFid**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('pageToken') === 'next') {
      return nodeList(route, { messages: CASTS.slice(2), nextPageToken: '' });
    }
    return nodeList(route, { messages: CASTS.slice(0, 2), nextPageToken: 'next' });
  });
  await ctx.route(`${NODE_ORIGIN}/v1/reactionsByFid**`, async (route) => {
    const url = new URL(route.request().url());
    const list =
      url.searchParams.get('reaction_type') === 'Like' ? LIKES : RECASTS;
    return nodeList(route, { messages: list, nextPageToken: '' });
  });
  await ctx.route(`${NODE_ORIGIN}/v1/linksByFid**`, async (route) =>
    nodeList(route, { messages: FOLLOWS, nextPageToken: '' }),
  );
  await ctx.route(`${NODE_ORIGIN}/v1/userDataByFid**`, async (route) =>
    nodeList(route, { messages: PROFILE, nextPageToken: '' }),
  );
  await ctx.route(`${NODE_ORIGIN}/v1/submitMessage**`, async (route) => {
    if (route.request().method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: CORS, body: '' });
    }
    const data = messageData(route.request().postDataBuffer() ?? Buffer.alloc(0));
    state.submitted.push(data);
    return route.fulfill({
      status: 200,
      headers: CORS,
      body: JSON.stringify(
        envelope({ type: 'MESSAGE_TYPE_CAST_REMOVE' }, `0x${'0b'.repeat(20)}`),
      ),
    });
  });
};

const makeDevice = async (width, server, { seedKey = true, balanceUsdc = '0' } = {}) => {
  const state = {
    balanceUsdc,
    ownerCalls: 0,
    accountCalls: [],
    submitted: [],
    strayWrites: [],
    pageErrors: [],
    console: [],
  };
  const proof = await makeSiweProof(server);
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width, height: width === 390 ? 844 : 900 },
  });
  await installFixtures(ctx, state, proof, server);
  const page = await ctx.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      state.console.push(`${msg.type()}: ${msg.text().slice(0, 120)} @ ${(msg.location()?.url ?? '').slice(0, 120)}`);
    }
  });
  page.on('requestfailed', (request) => {
    state.console.push(
      `reqfail: ${request.method()} ${request.url().slice(0, 120)} :: ${request.failure()?.errorText ?? '?'}`,
    );
  });
  page.on('pageerror', (error) => {
    const text = String(error?.stack ?? error);
    // The seam's own handled refusals arrive on the error channel by design.
    if (!/HandledFetchError/.test(text)) {
      state.pageErrors.push(text.slice(0, 300));
    }
  });
  return { ctx, page, state, server, seedKey, width };
};

const signIn = async (device) => {
  const { page, server } = device;
  const readyButton = () =>
    [...document.querySelectorAll('button, a, [role=button]')].some((el) =>
      /sign in with farcaster/i.test(el.innerText || ''),
    );
  await page.goto(`${server}/welcome/ready`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
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
  await page
    .locator('button, a, [role=button]')
    .filter({ hasText: /sign in with farcaster/i })
    .first()
    .click();
  await page.waitForFunction(
    () =>
      window.location.pathname === '/' &&
      Boolean(document.querySelector('.fiddy-shell-frame')) &&
      !document.querySelector('[data-fiddy="onboarding"]'),
    { timeout: 120000 },
  );
};

/** The one-time "Let Fiddy post as you?" card floats over the page's bottom
 *  and would intercept a tap meant for anything under it. */
const dismissPostForYou = async (page) => {
  await page.evaluate(() => {
    document.querySelector('[data-fiddy="post-for-you-not-now"]')?.click();
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    document.querySelector('[data-fiddy="post-for-you"]')?.remove();
  });
};

/** Seed this device's app key for the signed-in account, through the app's own
 *  storage layer (the same module the settings page reads it back with). */
const seedAppKey = async (page) => {
  await page.evaluate(async (key) => {
    const storage = await import('/src/utils/storageUtils.ts');
    await storage.setItem({ key: 'snapchain_app_key_3', value: key });
  }, APP_KEY);
};

/** From the settings list, the way a person finds it. */
const openDeleteAccount = async (device) => {
  const { page, server, width } = device;
  await page.goto(`${server}/~/settings`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('a, button, [role=button]')].some((el) =>
        /^delete account$/i.test((el.innerText || '').trim()),
      ),
    { timeout: 60000 },
  );
  check(
    `${width}: Delete account is listed in Settings`,
    true,
  );
  // The one-time posting-key card can mount late (it waits on the key lookup)
  // and would sit over the link — dismiss it again right before the press.
  await dismissPostForYou(page);
  // The chrome mounts the nav at both widths and hides one with CSS, so the
  // first DOM match can be the invisible one — click the VISIBLE match with a
  // real mouse, at its centre (the hit test is part of the check).
  const target = await page.evaluate(() => {
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) > 0.01 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const link = [...document.querySelectorAll('a, button, [role=button]')]
      .filter((el) => /^delete account$/i.test((el.innerText || '').trim()))
      .find(visible);
    if (!link) {
      return null;
    }
    const rect = link.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  if (!target) {
    throw new Error('no visible Delete account link on the settings list');
  }
  await page.mouse.click(target.x, target.y);
  await waitForMarker(page, 'delete-account-intro');
  check(
    `${width}: the entry lands on the delete screen`,
    new URL(page.url()).pathname === '/~/settings/delete-account' &&
      (await marker(page, 'delete-account-page')),
    page.url(),
  );
};

const expectIntro = async (device) => {
  const { page, width } = device;
  const copy = await containerText(page);
  check(
    `${width}: the intro says what goes and that it cannot be undone`,
    copy.includes('Delete your account?') &&
      copy.includes('your posts, likes, recasts and follows') &&
      copy.includes('It cannot be undone'),
  );
  check(
    `${width}: the intro is honest about the public network`,
    copy.includes('public network'),
  );
  check(
    `${width}: no jargon on the delete screens`,
    !/\b(signer|hub|fid)\b/i.test(copy),
    copy.slice(0, 200),
  );
  await shot(page, 'intro', width);
};

/** The arm screen: the destructive button stays inert until the person says
 *  they understand. */
const armAndConfirm = async (device) => {
  const { page, width } = device;
  await waitForMarker(page, 'delete-account-arm');
  const disabledBefore = await page.evaluate(() => {
    const button = document.querySelector('[data-fiddy="delete-account-confirm"]');
    return button ? button.disabled : null;
  });
  check(`${width}: Delete everything is inert until the check`, disabledBefore === true);
  await shot(page, 'arm', width);
  await page.locator('[data-fiddy="delete-account-arm-check"]').first().click();
  const disabledAfter = await page.evaluate(() => {
    const button = document.querySelector('[data-fiddy="delete-account-confirm"]');
    return button ? button.disabled : null;
  });
  check(`${width}: the check arms Delete everything`, disabledAfter === false);
  await page.locator('[data-fiddy="delete-account-confirm"]').first().click();
};

const expectDone = async (device, { withServer }) => {
  const { page, state, width } = device;
  // The purge's first answer is {state:'running'} and the poll waits a second,
  // so the progress stage is guaranteed on screen for a window.
  await waitForMarker(page, 'delete-account-progress');
  check(`${width}: progress is shown while it runs`, true);
  await shot(page, 'progress', width);
  try {
    await waitForMarker(page, 'delete-account-done', 120000);
  } catch (error) {
    let samples = '';
    try {
      samples = await page.evaluate(
        () =>
          document.querySelector('[data-fiddy="delete-account-page"]')?.innerText ??
          '(container gone)',
      );
    } catch (sampleError) {
      samples = `(sample failed: ${sampleError})`;
    }
    throw new Error(
      `STATE accountCalls=${JSON.stringify(state.accountCalls)} submitted=${state.submitted.length} stray=${state.strayWrites.join(';')} console=${state.console.slice(0, 8).join(' || ')} ||| container=${samples.replace(/\s+/g, ' ').slice(0, 400)} ||| ${error.message.slice(0, 200)}`,
    );
  }
  const copy = await containerText(page);
  check(
    `${width}: done says what was removed, with the real counts`,
    copy.includes('Removed 3 posts, 2 likes and recasts, 2 follows') &&
      copy.includes('cleared your profile'),
    copy.slice(0, 300),
  );
  if (withServer) {
    check(
      `${width}: done says what Fiddy itself forgot, including the kept file`,
      (await marker(page, 'delete-account-server-result')) &&
        copy.includes('Fiddy forgot 2 drafts and 1 of your uploads') &&
        copy.includes('1 file stays'),
    );
  } else {
    check(
      `${width}: a self-hosted copy never mentions a server half`,
      !(await marker(page, 'delete-account-server-result')),
    );
  }
  const submitted = state.submitted;
  const count = (type) => submitted.filter((m) => m.type === type).length;
  check(
    `${width}: the page really sent the removes — 3 casts, 2 reactions, 2 follows, 2 profile fields, all for the account`,
    submitted.length === 9 &&
      count(MT.CAST_REMOVE) === 3 &&
      count(MT.REACTION_REMOVE) === 2 &&
      count(MT.LINK_REMOVE) === 2 &&
      count(MT.USER_DATA_ADD) === 2 &&
      submitted.every((m) => m.fid === SIGNED_IN_FID),
    JSON.stringify(submitted.map((m) => m.type)),
  );
  await shot(page, 'done', width);
};

const runHostedHappy = async (width) => {
  const device = await makeDevice(width, SERVER);
  const { page, state } = device;
  await signIn(device);
  await dismissPostForYou(page);
  await seedAppKey(page);
  await openDeleteAccount(device);
  await expectIntro(device);
  await page.locator('[data-fiddy="delete-account-continue"]').first().click();
  await armAndConfirm(device);
  await expectDone(device, { withServer: true });
  const runs = new Set(state.accountCalls.map((call) => call.run));
  const bearerFid = (authorization) => {
    try {
      const payload = authorization.replace(/^Bearer /, '').split('.')[1];
      return JSON.parse(Buffer.from(payload, 'base64url').toString()).fid;
    } catch {
      return null;
    }
  };
  check(
    `${width}: the purge was polled with one run id, as the signed-in account`,
    state.accountCalls.length >= 2 &&
      runs.size === 1 &&
      state.accountCalls.every(
        (call) => bearerFid(call.authorization) === SIGNED_IN_FID,
      ),
    JSON.stringify(state.accountCalls),
  );
  check(
    `${width}: nothing wrote to any real host`,
    state.strayWrites.length === 0,
    state.strayWrites.join('; '),
  );
  check(
    `${width}: no uncaught page error`,
    state.pageErrors.length === 0,
    state.pageErrors.join(' | ').slice(0, 400),
  );
  await page.locator('[data-fiddy="delete-account-finish"]').first().click();
  await page.waitForFunction(
    () => document.querySelector('[data-fiddy="onboarding"]') !== null,
    { timeout: 60000 },
  );
  check(
    `${width}: Finish and sign out lands on the front door`,
    new URL(page.url()).pathname === '/',
    page.url(),
  );
  await device.ctx.close();
};

const runHostedBalance = async (width) => {
  const device = await makeDevice(width, SERVER, { balanceUsdc: '2.5' });
  const { page } = device;
  await signIn(device);
  await dismissPostForYou(page);
  await seedAppKey(page);
  await openDeleteAccount(device);
  await page.locator('[data-fiddy="delete-account-continue"]').first().click();
  await waitForMarker(page, 'delete-account-balance');
  const copy = await containerText(page);
  check(
    `${width}: a remaining balance is named before anything arms`,
    copy.includes('You have $2.50 left') &&
      copy.includes('stays on the books'),
    copy.slice(0, 300),
  );
  const disabledBefore = await page.evaluate(() => {
    const button = document.querySelector('[data-fiddy="delete-account-balance-continue"]');
    return button ? button.disabled : null;
  });
  check(`${width}: the balance screen waits for the acknowledgment`, disabledBefore === true);
  await shot(device.page, 'balance', width);
  await page.locator('[data-fiddy="delete-account-balance-ack"]').first().click();
  await page.locator('[data-fiddy="delete-account-balance-continue"]').first().click();
  await waitForMarker(page, 'delete-account-arm');
  check(`${width}: the acknowledged balance leads to the last step`, true);
  await device.ctx.close();
};

const runBlockedNoKey = async (width) => {
  const device = await makeDevice(width, SERVER, { seedKey: false });
  const { page } = device;
  await signIn(device);
  await dismissPostForYou(page);
  await openDeleteAccount(device);
  await page.locator('[data-fiddy="delete-account-continue"]').first().click();
  await waitForMarker(page, 'delete-account-blocked');
  const copy = await containerText(page);
  check(
    `${width}: with no posting key the flow refuses in place and says what fixes it`,
    copy.includes('Not from here yet') && copy.includes('Issue app key'),
    copy.slice(0, 300),
  );
  await shot(page, 'blocked', width);
  check(
    `${width}: a refused flow deleted nothing`,
    device.state.submitted.length === 0 && device.state.accountCalls.length === 0,
  );
  await device.ctx.close();
};

const runSelfHosted = async (width) => {
  const device = await makeDevice(width, SELF_SERVER);
  const { page, state } = device;
  await signIn(device);
  await dismissPostForYou(page);
  await seedAppKey(page);
  await openDeleteAccount(device);
  await expectIntro(device);
  await page.locator('[data-fiddy="delete-account-continue"]').first().click();
  // No control plane at this origin: no balance screen, straight to the arm.
  await armAndConfirm(device);
  await expectDone(device, { withServer: false });
  check(
    `${width}: a self-hosted copy never called the purge`,
    state.accountCalls.length === 0 && state.ownerCalls === 0,
    `account=${state.accountCalls.length} owner=${state.ownerCalls}`,
  );
  check(
    `${width}: nothing wrote to any real host`,
    state.strayWrites.length === 0,
    state.strayWrites.join('; '),
  );
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
  const widths = (process.env.DELETE_ACCOUNT_WIDTHS ?? '390,1440')
    .split(',')
    .map((value) => Number(value.trim()));
  for (const width of widths) {
    await runHostedHappy(width);
  }
  await runHostedBalance(widths[0]);
  await runBlockedNoKey(widths[widths.length - 1]);
  await runSelfHosted(widths[widths.length - 1]);
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
    `${String(error?.stack ?? error).slice(0, 2500)}${pageState}`,
  );
} finally {
  await browser?.close().catch(() => {});
}

for (const result of checks) {
  console.log(
    `${result.ok ? 'PASS' : 'SI_SECRET_PASSWORD_PDFSNW44'}  ${result.name}${result.detail ? ` — ${result.detail}` : ''}`,
  );
}
console.log(`captures: ${JSON.stringify(captures)}`);
const failed = checks.filter((result) => !result.ok);
console.log(`${checks.length - failed.length}/${checks.length} checks passed; screenshots in ${OUT}`);
if (failed.length) process.exitCode = 1;
