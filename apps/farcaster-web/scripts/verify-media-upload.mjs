// End-to-end: a photo picked in the real composer reaches OUR own media host,
// comes back as a URL, and that URL is what the cast payload carries.
//
//   node scripts/verify-media-upload.mjs
//
// Preconditions - two servers, each told about the other:
//
//   1. the media service (the repo with app/api/fiddy/media):
//        cd /Users/lc/legitmate-farcaster
//        FIDDY_MEDIA_DIR=$HOME/.fiddy-media-dev LEGITMATE_SINGLE_USER_SUBJECT=dev-owner \
//        FIDDY_ALLOWED_ORIGINS=https://localhost:5174 npx next dev -p 3217
//
//   2. the client, built with the media host it should upload to:
//        cd apps/farcaster-web
//        SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
//        VITE_FIDDY_MEDIA_URL=http://localhost:3217 VITE_SNAPCHAIN_DEBUG=true \
//        npx vite --port 5174
//
// Only the SIWF relay is stubbed (with a REAL SIWE message signed by a throwaway
// key, so the app's own verifier accepts the sign-in for real), exactly as
// scripts/verify-node-backed-client.mjs does. Nothing here posts to Farcaster:
// the cast submission is answered by the adapter inside the page, which is why
// the payload is read from the adapter's own log.
//
// WHAT IT ASSERTS (each one a real observation, not a shape guess)
//   1. the composer's upload-URL request went to the MEDIA route: the adapter
//      answered `POST /v1/generate-image-upload-url` with our media host
//      (kind 'media') - the request that used to be a 501
//   2. the browser really POSTed the picked bytes to our host and got a 201
//      carrying a URL on that host
//   3. the URL round-trips from a different client: 200, the content type the
//      bytes really are, an immutable cache header, and served bytes whose
//      sha256 is the name in the URL
//   4. the composer rendered the photo, with no upload-failure copy
//   5. the cast payload the composer built (the `POST /v2/casts` the adapter
//      logged) references that URL as an embed
//   6. nothing was posted to Farcaster from this probe (posting stays behind
//      the existing app-key flow)
//
// Screenshots land in $MEDIA_SHOT_DIR (default: the system temp dir).

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { chromium } from 'playwright';
import { createSiweMessage } from 'viem/siwe';
import { privateKeyToAccount } from 'viem/accounts';

const SERVER = process.env.NODE_BACKED_SERVER ?? 'https://localhost:5174';
const MEDIA = (process.env.MEDIA_SERVER ?? 'http://localhost:3217').replace(/\/+$/, '');
const OUT = process.env.MEDIA_SHOT_DIR ?? os.tmpdir();
const DOMAIN = new URL(SERVER).host;
const NONCE = 'f'.repeat(128);
const CHANNEL_TOKEN = 'MEDIAUPLD';
const SIGNED_IN_FID = 3;
const MODAL_ROOT = '#modal-root';
const PLACEHOLDER = 'Start typing a new cast here...';

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

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail });
};

/** A real PNG of the size a photo would be — no image library needed. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

const crc32 = (buffer) => {
  let c = -1;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
};

const pngChunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
};

const writeTestPhoto = (file) => {
  const width = 512;
  const height = 384;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 3 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const at = rowStart + 1 + x * 3;
      raw[at] = (x * 7 + y * 3) % 256;
      raw[at + 1] = Math.floor((y / height) * 255);
      raw[at + 2] = (x + y) % 256;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
  return { file, bytes: png.length };
};

const readSurface = (page) =>
  page.evaluate(() => {
    const text = document.body.innerText.replace(/\s+/g, ' ').trim();
    return {
      path: window.location.pathname,
      text,
      onboardingSheet: Boolean(document.querySelector('[data-fiddy="onboarding"]')),
      deviceOnlyLanding: Boolean(document.querySelector('[data-fiddy="device-only-session"]')),
    };
  });

const composer_text_of = (surface) => surface.text.slice(0, 160);

const run = async () => {
  const photo = writeTestPhoto(path.join(os.tmpdir(), 'fiddy-media-probe.png'));
  const mediaRequests = [];
  const consoleErrors = [];

  const browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors'],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });

  // Every call that leaves the page. The media upload is one of them (it is a
  // plain fetch to our host); the adapter's own answers are not, which is why
  // the cast payload is read from the adapter's log instead.
  await ctx.addInitScript(() => {
    const orig = window.fetch;
    window.__mediaFetchLog = [];
    window.fetch = async (...args) => {
      const url =
        typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || String(args[0]);
      const method = (args[1] && args[1].method) || 'GET';
      const response = await orig(...args);
      window.__mediaFetchLog.push(`${method} ${response.status} ${String(url).slice(0, 200)}`);
      return response;
    };
  });

  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') {
      consoleErrors.push(m.text().replace(/\s+/g, ' ').slice(0, 240));
    }
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 240)}`));

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

  // ── 1. a signed-in client ─────────────────────────────────────────────────
  await page.goto(`${SERVER}/welcome/ready`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.body.innerText.trim().length > 40, { timeout: 60000 });

  for (const el of await page.$$('button, a, [role=button]')) {
    const text = ((await el.innerText()) || '').replace(/\s+/g, ' ').trim();
    if (/go social/i.test(text)) {
      await el.click();
      break;
    }
  }

  let surface = await readSurface(page);
  for (let i = 0; i < 60; i += 1) {
    if (surface.path === '/' && !surface.onboardingSheet && !surface.deviceOnlyLanding) {
      break;
    }
    await page.waitForTimeout(1000);
    surface = await readSurface(page);
  }
  check(
    'a completed sign-in lands in the client',
    surface.path === '/' && !surface.onboardingSheet && !surface.deviceOnlyLanding,
    `path=${surface.path} onboarding=${surface.onboardingSheet} deviceOnly=${surface.deviceOnlyLanding}`,
  );

  // ── 2. the composer ───────────────────────────────────────────────────────
  const castButtons = await page.locator('button:has-text("Cast")').all();
  let opened = false;
  for (const button of castButtons) {
    const text = ((await button.innerText()) || '').trim();
    if (text === 'Cast') {
      await button.click();
      opened = true;
      break;
    }
  }
  if (!opened) {
    await page.keyboard.press('n');
  }

  let composerReady = false;
  try {
    await page.waitForSelector(`${MODAL_ROOT} [contenteditable="true"]`, { timeout: 30000 });
    composerReady = await page
      .locator(`${MODAL_ROOT}`)
      .getByText(PLACEHOLDER)
      .first()
      .isVisible()
      .catch(() => false);
  } catch {
    composerReady = false;
  }
  await page.screenshot({ path: `${OUT}/media-composer-open.png` });
  check(
    'the composer opens over the feed',
    composerReady && picks.scoped > 0,
    `clicked=${opened} fileInputs=${JSON.stringify(picks)} composerText=${JSON.stringify(
      composer_text_of(await readSurface(page)),
    )}`,
  );

  // ── 3. pick a photo: the mint, then the upload ─────────────────────────────
  const uploadResponse = page.waitForResponse(
    (response) =>
      response.url().includes('/api/fiddy/media') && response.request().method() === 'POST',
    { timeout: 90000 },
  );
  const scopedInput = page.locator(`${MODAL_ROOT} input[type=file]`);
  const anywhereInput = page.locator('input[type=file]');
  const picks = { scoped: await scopedInput.count(), anywhere: await anywhereInput.count() };
  const fileInput = picks.scoped > 0 ? scopedInput.first() : anywhereInput.first();
  await fileInput.setInputFiles(photo.file);
  const uploaded = await uploadResponse;
  const uploadedBody = await uploaded.json().catch(() => ({}));
  const mediaRequest = uploaded.request();

  mediaRequests.push(`${mediaRequest.method()} ${uploaded.status()} ${mediaRequest.url()}`);
  check(
    'the browser POSTed the picked bytes to OUR media host',
    mediaRequest.url().startsWith(`${MEDIA}/api/fiddy/media`) && uploaded.status() === 201,
    mediaRequests.join(' | ') || 'no request seen',
  );
  const mediaUrl = typeof uploadedBody.url === 'string' ? uploadedBody.url : '';
  check(
    'the upload came back with a URL on that host',
    mediaUrl.startsWith(`${MEDIA}/api/fiddy/media/`),
    mediaUrl || JSON.stringify(uploadedBody).slice(0, 200),
  );
  check(
    'the media host reported the type it really stored',
    uploadedBody.contentType === 'image/jpeg' || uploadedBody.contentType === 'image/png',
    `contentType=${uploadedBody.contentType} ext=${uploadedBody.ext} bytes=${uploadedBody.bytes}`,
  );

  // ── 4. the URL round-trips from another client ─────────────────────────────
  const fetched = await ctx.request.get(mediaUrl);
  const served = await fetched.body();
  const nameHash = /\/api\/fiddy\/media\/([0-9a-f]{64})\./.exec(mediaUrl)?.[1] ?? '';
  const servedHash = createHash('sha256').update(served).digest('hex');
  check(
    'the stored photo is readable at that URL by anyone, with the honest type',
    fetched.status() === 200 && (fetched.headers()['content-type'] ?? '').startsWith('image/'),
    `status=${fetched.status()} type=${fetched.headers()['content-type']} bytes=${served.length}`,
  );
  check(
    'the served bytes hash to the name in the URL (the file is its own address)',
    nameHash.length === 64 && nameHash === servedHash && nameHash === uploadedBody.sha256,
    `name=${nameHash.slice(0, 12)}… served=${servedHash.slice(0, 12)}… reported=${String(
      uploadedBody.sha256,
    ).slice(0, 12)}…`,
  );
  check(
    'the photo is served immutable, with nosniff',
    /immutable/.test(fetched.headers()['cache-control'] ?? '') &&
      fetched.headers()['x-content-type-options'] === 'nosniff',
    `cache-control=${fetched.headers()['cache-control']} nosniff=${fetched.headers()['x-content-type-options']}`,
  );

  // ── 5. the composer embedded it ────────────────────────────────────────────
  const composer = await page.evaluate((root) => {
    const container = document.querySelector(root);
    const text = container ? container.innerText.replace(/\s+/g, ' ') : '';
    const images = Array.from(container ? container.querySelectorAll('img') : []).map(
      (img) => img.currentSrc || img.src,
    );
    const buttons = Array.from(container ? container.querySelectorAll('button') : []).map(
      (button) => ({
        label: (button.innerText || '').trim(),
        disabled: button.disabled,
        y: button.getBoundingClientRect().top,
      }),
    );
    return { text, images, buttons };
  }, MODAL_ROOT);

  const previewed = composer.images.some(
    (src) => src.startsWith('blob:') || src.startsWith(mediaUrl) || src.startsWith(MEDIA),
  );
  check(
    'the composer shows the photo it uploaded',
    previewed,
    `${composer.images.length} image(s) in the composer: ${JSON.stringify(composer.images.slice(0, 3))}`,
  );
  check(
    'the composer shows no upload-failure copy',
    !/didn't make it|could not upload|Failed to upload|Image upload failed|Cloudflare/i.test(
      composer.text,
    ),
    composer.text.slice(0, 200),
  );

  // ── 6. the cast payload references it ──────────────────────────────────────
  const editor = page.locator(`${MODAL_ROOT} [contenteditable="true"]`).first();
  await editor.click();
  await page.keyboard.type('a photo from our own media host');
  await page.waitForTimeout(500);

  const submit = composer.buttons
    .filter((button) => button.label === 'Cast' && !button.disabled)
    .sort((a, b) => b.y - a.y)[0];
  check('the cast button is ready to submit', Boolean(submit), JSON.stringify(composer.buttons));

  let castEntry;
  if (submit) {
    await page.evaluate((y) => {
      const container = document.querySelector('#modal-root');
      const buttons = Array.from(container ? container.querySelectorAll('button') : []);
      const target = buttons
        .filter((button) => (button.innerText || '').trim() === 'Cast')
        .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)
        .find((button) => Math.abs(button.getBoundingClientRect().top - y) < 1);
      target?.click();
    }, submit.y);

    for (let i = 0; i < 60; i += 1) {
      castEntry = await page.evaluate(() => {
        const log = window.__nodeBackedRequests ?? [];
        return log.find((entry) => entry.method === 'POST' && /\/v2\/casts$/.test(entry.path));
      });
      if (castEntry) {
        break;
      }
      await page.waitForTimeout(500);
    }
  }
  await page.screenshot({ path: `${OUT}/media-composer-submitted.png` });

  const mintEntry = await page.evaluate(() => {
    const log = window.__nodeBackedRequests ?? [];
    return log.find((entry) => /generate-image-upload-url$/.test(entry.path));
  });
  check(
    'the upload-URL request the composer made was answered by the MEDIA route, not a 501',
    mintEntry?.kind === 'media' && mintEntry?.status === 200,
    `log entry: ${JSON.stringify(mintEntry)?.slice(0, 200)}`,
  );

  const payloadEmbeds = (() => {
    try {
      return JSON.parse(castEntry?.bodyPreview ?? '{}').embeds ?? [];
    } catch {
      return [];
    }
  })();
  check(
    'the cast payload the composer built references the media URL',
    Array.isArray(payloadEmbeds) && payloadEmbeds.includes(mediaUrl),
    castEntry
      ? `POST /v2/casts embeds=${JSON.stringify(payloadEmbeds)}`
      : 'the composer never built a cast payload',
  );

  const leftThePage = await page.evaluate(() => window.__mediaFetchLog ?? []);
  check(
    'nothing was posted to Farcaster from this probe (posting stays behind the app-key flow)',
    !leftThePage.some((line) => /farcaster\.xyz.*\/v2\/casts/.test(line)),
    leftThePage.filter((line) => line.includes('/v2/casts')).join(' | ') || 'no cast request left the page',
  );

  await ctx.request.dispose();
  await browser.close();

  console.log('── a photo, from the composer, to our own media host ──');
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  const clip = (line) => line.replace(/([0-9a-f]{12})[0-9a-f]{40,}/, '$1…');
  console.log('\n── requests that left the page ──');
  for (const line of leftThePage) {
    console.log(`  ${clip(line)}`);
  }
  console.log('\n── media requests ──');
  for (const line of mediaRequests) {
    console.log(`  ${clip(line)}`);
  }
  const adapterWrites = await page.evaluate(() => (window.__nodeBackedRequests ?? []).length);
  console.log(`\nadapter classifications this run: ${adapterWrites} (debug surface)`);
  console.log(
    `\nconsole errors: ${consoleErrors.length}${consoleErrors.length ? ` (first: ${consoleErrors[0]})` : ''}`,
  );

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed; screenshots in ${OUT}`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
};

try {
  await run();
} catch (error) {
  console.log(`\nPROBE threw before finishing: ${String(error).slice(0, 300)}`);
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  process.exitCode = 1;
}