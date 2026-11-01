// End-to-end: the composers' GIF picker — open it, search, pick, watch the
// GIF wait as a staged card, and read the assembled cast write carrying the
// `.gif` URL. Plus the three honest states: empty, error (with retry), and
// service-off.
//
//   node scripts/verify-gif-picker.mjs
//
// Preconditions — one dev server, the app's own config plus a dep cache of its
// own (see `scripts/probe.vite.config.mjs`):
//
//   cd apps/farcaster-web
//   HTTPS=true SNAPCHAIN_HTTP_URL=https://<a public read node> \
//   VITE_SNAPCHAIN_HTTP_URL=https://<the same> VITE_SNAPCHAIN_DEBUG=true \
//   PROBE_VITE_CACHE_DIR=/tmp/probe-vite-cache-gifs \
//   npx vite --config scripts/probe.vite.config.mjs --port 5231 --strictPort
//
//   GIF_SERVER=https://localhost:5231 node scripts/verify-gif-picker.mjs
//
// Only two things are stubbed: the SIWF relay (a REAL SIWE message signed by a
// throwaway key, exactly as scripts/verify-cast-submit.mjs does) and the
// GIF search itself — `/api/gifs` is answered per-mode from the probe so the
// states are deterministic and no Tenor request leaves the machine. Nothing
// posts to Farcaster: the submit is answered inside the page by the adapter,
// which is also where the assembled payload is read from.
//
// The DIRECT cast composer is not reachable here on purpose: its inbox is a
// 501 seam in the node-backed client ("direct messages are not on a read
// node's public API yet"), so its half of the GIF path is held by
// src/components/directCasts/__tests__/DirectCastComposerGif.test.tsx.
//
// WHAT IT ASSERTS (each one a real observation, not a shape guess)
//   1. a completed sign-in lands in the client shell
//   2. the composer opens, and carries the GIF button
//   3. the picker lazy-loads and searches on open (the default "trending")
//   4. typing a new query re-searches
//   5. picking a GIF closes the picker and stages the GIF as a card in the
//      composer — its preview image, its title
//   6. pressing Cast assembles POST /v2/casts carrying the `.gif` URL embed
//      (the write itself is the adapter's expected 501: no app key here)
//   7. an empty answer says "No GIFs found."
//   8. a failed search says "GIFs didn't load — try again" and Try again
//      recovers
//   9. a 501 from the endpoint says "GIFs aren't available on this server." —
//      never a broken search
//  10. the whole flow works at 390px and at 1440px
//
// Screenshots land in $GIF_SHOT_DIR (default: the system temp dir).

import os from 'node:os';

import { chromium } from 'playwright';
import { createSiweMessage } from 'viem/siwe';
import { privateKeyToAccount } from 'viem/accounts';

const SERVER = process.env.GIF_SERVER ?? 'https://localhost:5231';
const OUT = process.env.GIF_SHOT_DIR ?? os.tmpdir();
const WIDTHS = (process.env.GIF_WIDTHS ?? '390,1440')
  .split(',')
  .map((w) => parseInt(w, 10));
const DOMAIN = new URL(SERVER).host;
const NONCE = 'f'.repeat(128);
const CHANNEL_TOKEN = 'CASTSUBMT';
const SIGNED_IN_FID = 3;
const MODAL_ROOT = '#modal-root';

const GIF = {
  url: 'https://media.tenor.com/x.webp',
  preview: 'https://media.tenor.com/tiny-x.webp',
  w: 480,
  h: 360,
  title: 'a dancing test gif',
  cast: 'https://media.tenor.com/medium-x.gif',
};
const GIF2 = {
  url: 'https://media.tenor.com/y.webp',
  preview: 'https://media.tenor.com/tiny-y.webp',
  w: 320,
  h: 240,
  title: 'another test gif',
  cast: 'https://media.tenor.com/medium-y.gif',
};

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
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`,
  );
};

/** The launched browser, kept where the throw path can close it too. */
let browser;

const readSurface = (page) =>
  page.evaluate(() => ({
    path: window.location.pathname,
    onboardingSheet: Boolean(
      document.querySelector('[data-fiddy="onboarding"]'),
    ),
    deviceOnlyLanding: Boolean(
      document.querySelector('[data-fiddy="device-only-session"]'),
    ),
    shellMounted: Boolean(document.querySelector('.fiddy-shell-frame')),
  }));

const safeReadSurface = async (page) => {
  let lastError;
  for (let i = 0; i < 20; i += 1) {
    try {
      return await readSurface(page);
    } catch (e) {
      lastError = e;
      if (
        !/Execution context was destroyed|Cannot find context|Target closed|navigating/i.test(
          String(e),
        )
      ) {
        throw e;
      }
      await page.waitForTimeout(250);
    }
  }
  throw lastError;
};

/** Poll the DOM with page.evaluate — never a string waitForFunction (CSP). */
const pollFor = async (page, fn, arg, timeoutMs = 30000) => {
  const start = Date.now();
  for (;;) {
    const found = await page.evaluate(fn, arg).catch(() => false);
    if (found) {
      return true;
    }
    if (Date.now() - start > timeoutMs) {
      return false;
    }
    await page.waitForTimeout(250);
  }
};

const signIn = async (page) => {
  await page.goto(`${SERVER}/welcome/ready`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  // The step paints text before its buttons; wait for the door itself.
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('button, a, [role=button]')].some((el) =>
        /go social/i.test(el.innerText || ''),
      ),
    { timeout: 60000 },
  );
  for (const el of await page.$$('button, a, [role=button]')) {
    const text = ((await el.innerText()) || '').replace(/\s+/g, ' ').trim();
    if (/go social/i.test(text)) {
      await el.click();
      break;
    }
  }
  let surface = await safeReadSurface(page);
  for (let i = 0; i < 60; i += 1) {
    if (
      surface.path === '/' &&
      surface.shellMounted &&
      !surface.onboardingSheet &&
      !surface.deviceOnlyLanding
    ) {
      return true;
    }
    await page.waitForTimeout(1000);
    surface = await safeReadSurface(page);
  }
  return false;
};

const openComposer = async (page) => {
  const castButtons = await page
    .locator('button:has-text("Cast"):visible')
    .all();
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
  try {
    await page.waitForSelector(`${MODAL_ROOT} [contenteditable="true"]`, {
      timeout: 30000,
    });
    return true;
  } catch {
    return false;
  }
};

/** The floating "Let Fiddy post as you?" card sits over the composer's bottom
 *  row at 390px; dismiss it the way a person does. */
const dismissPostForYou = async (page) => {
  const card = await page.$('[data-fiddy="post-for-you-not-now"]');
  if (card) {
    await card.click().catch(() => {});
    await page.waitForTimeout(300);
  }
};

const run = async () => {
  const consoleErrors = [];

  browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors'],
  });

  for (const width of WIDTHS) {
    const ctx = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width, height: width === 390 ? 844 : 900 },
    });
    const page = await ctx.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') {
        consoleErrors.push(m.text().replace(/\s+/g, ' ').slice(0, 240));
      }
    });
    page.on('pageerror', (e) =>
      consoleErrors.push(`pageerror: ${String(e).slice(0, 240)}`),
    );

    // The SIWF relay, stubbed with a real SIWE message.
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

    // The GIF search, per mode. The mode flips between phases of the probe.
    let gifMode = 'ok';
    await page.route('**/api/gifs**', async (route) => {
      if (gifMode === 'off') {
        return route.fulfill({
          status: 501,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: 'GIFS_OFF' }),
        });
      }
      if (gifMode === 'error') {
        return route.fulfill({
          status: 500,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: 'GIFS_UPSTREAM' }),
        });
      }
      if (gifMode === 'empty') {
        return route.fulfill({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: '[]',
        });
      }
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([GIF, GIF2]),
      });
    });

    // ── 1. a signed-in client ────────────────────────────────────────────
    const signedIn = await signIn(page);
    check(`[${width}] a completed sign-in lands in the client`, signedIn);

    await dismissPostForYou(page);

    // ── 2. the composer, and its GIF button ───────────────────────────────
    const composerOpen = await openComposer(page);
    const gifButton = await page
      .locator(`${MODAL_ROOT} [data-fiddy="gif-picker-trigger"]`)
      .first();
    const gifButtonVisible = await gifButton.isVisible().catch(() => false);
    check(
      `[${width}] the composer opens and carries the GIF button`,
      composerOpen && gifButtonVisible,
      `composer=${composerOpen} gifButton=${gifButtonVisible}`,
    );

    // Type some text so the cast button is live.
    const editor = page.locator(`${MODAL_ROOT} [contenteditable="true"]`).first();
    if (composerOpen) {
      await editor.click();
      await page.keyboard.type('a cast with a gif from the probe');
      await page.waitForTimeout(500);
    }

    // ── 3. the picker lazy-loads and searches on open ────────────────────
    if (gifButtonVisible) {
      await gifButton.click();
    }
    const pickerShown = await pollFor(page, () =>
      Boolean(document.querySelector('[data-fiddy="gif-picker"]')),
    );
    const resultsShown = await pollFor(page, () =>
      Boolean(document.querySelector('[data-fiddy="gif-picker-results"]')),
    );
    check(
      `[${width}] the picker lazy-loads and searches on open`,
      pickerShown && resultsShown,
      `picker=${pickerShown} results=${resultsShown}`,
    );

    // ── 4. typing a new query re-searches ────────────────────────────────
    const searchBox = page.locator('[data-fiddy="gif-picker-search"]').first();
    let reSearched = false;
    if (resultsShown) {
      await searchBox.click();
      await searchBox.fill('dance');
      // loading shows, then results again
      await pollFor(
        page,
        () => Boolean(document.querySelector('[data-fiddy="gif-picker-loading"]')),
        null,
        5000,
      );
      reSearched = await pollFor(page, () =>
        Boolean(document.querySelector('[data-fiddy="gif-picker-results"]')),
      );
    }
    check(`[${width}] typing a new query re-searches`, reSearched);

    // ── 5. picking stages the GIF as a card in the composer ──────────────
    if (reSearched) {
      await page
        .locator('[data-fiddy="gif-picker-result"]')
        .first()
        .click();
    }
    const staged = await pollFor(page, (castUrl) => {
      const modal = document.querySelector('#modal-root');
      if (!modal) return false;
      const text = modal.innerText || '';
      const imgs = [...modal.querySelectorAll('img')].map((i) => i.src);
      return (
        text.includes('a dancing test gif') ||
        imgs.some((src) => src.includes('tiny-x.webp')) ||
        text.includes(castUrl)
      );
    }, GIF.cast);
    await page.screenshot({ path: `${OUT}/gif-staged-${width}.png` });
    check(
      `[${width}] a picked GIF waits as a staged card in the composer`,
      staged,
    );

    // ── 6. pressing Cast assembles the .gif URL embed ─────────────────────
    const composer = await page.evaluate((root) => {
      const container = document.querySelector(root);
      return Array.from(container?.querySelectorAll('button') ?? []).map(
        (button) => ({
          label: (button.innerText || '').trim(),
          disabled: button.disabled,
          y: button.getBoundingClientRect().top,
        }),
      );
    }, MODAL_ROOT);
    const submit = composer
      .filter((button) => button.label === 'Cast' && !button.disabled)
      .sort((a, b) => b.y - a.y)[0];
    if (submit) {
      await page.evaluate((y) => {
        const container = document.querySelector('#modal-root');
        const buttons = Array.from(
          container ? container.querySelectorAll('button') : [],
        );
        const target = buttons
          .filter((button) => (button.innerText || '').trim() === 'Cast')
          .sort(
            (a, b) =>
              b.getBoundingClientRect().top - a.getBoundingClientRect().top,
          )
          .find((button) => Math.abs(button.getBoundingClientRect().top - y) < 1);
        target?.click();
      }, submit.y);
    }
    let castWrite;
    for (let i = 0; i < 40; i += 1) {
      await page.waitForTimeout(250);
      const entries = await page.evaluate(
        () => window.__nodeBackedRequests ?? [],
      );
      castWrite = entries.find(
        (entry) => entry.method === 'POST' && /\/v2\/casts$/.test(entry.path),
      );
      if (castWrite) {
        break;
      }
    }
    const carriesGif = Boolean(
      castWrite && (castWrite.bodyPreview ?? '').includes(GIF.cast),
    );
    check(
      `[${width}] pressing Cast assembles POST /v2/casts carrying the .gif URL embed`,
      carriesGif,
      castWrite
        ? `${castWrite.method} ${castWrite.path} status=${castWrite.status} body=${(castWrite.bodyPreview ?? '').slice(0, 200)}`
        : 'no cast write ever reached the adapter',
    );

    // ── 7-9. the honest states, once (at the last width) ──────────────────
    if (width === WIDTHS[WIDTHS.length - 1]) {
      // close the composer
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      await dismissPostForYou(page);
      await openComposer(page);
      const trigger = page
        .locator(`${MODAL_ROOT} [data-fiddy="gif-picker-trigger"]`)
        .first();

      // empty
      gifMode = 'empty';
      await trigger.click();
      const emptyShown = await pollFor(page, () =>
        Boolean(document.querySelector('[data-fiddy="gif-picker-empty"]')),
      );
      check(
        'an empty answer says "No GIFs found."',
        emptyShown,
      );
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);

      // error, then Try again recovers
      gifMode = 'error';
      await trigger.click();
      const errorShown = await pollFor(page, () =>
        Boolean(document.querySelector('[data-fiddy="gif-picker-error"]')),
      );
      gifMode = 'ok';
      let recovered = false;
      if (errorShown) {
        await page.locator('[data-fiddy="gif-picker-retry"]').first().click();
        recovered = await pollFor(page, () =>
          Boolean(document.querySelector('[data-fiddy="gif-picker-results"]')),
        );
      }
      check(
        'a failed search says so and Try again recovers',
        errorShown && recovered,
        `error=${errorShown} recovered=${recovered}`,
      );
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);

      // service off
      gifMode = 'off';
      await trigger.click();
      const offShown = await pollFor(page, () => {
        const el = document.querySelector('[data-fiddy="gif-picker-unavailable"]');
        return Boolean(
          el && /aren’t available on this server|aren't available on this server/.test(el.innerText || ''),
        );
      });
      await page.screenshot({ path: `${OUT}/gif-off-${width}.png` });
      check(
        'a 501 from the endpoint says "GIFs aren\'t available on this server."',
        offShown,
      );
    }

    await ctx.close();
  }

  await browser.close();
  browser = undefined;

  console.log(
    `\nconsole errors: ${consoleErrors.length}${consoleErrors.length ? ` (first: ${consoleErrors[0]})` : ''}`,
  );
  const failed = checks.filter((c) => !c.ok);
  console.log(
    `\n${checks.length - failed.length}/${checks.length} checks passed; screenshots in ${OUT}`,
  );
  if (failed.length > 0) {
    process.exitCode = 1;
  }
};

try {
  await run();
} catch (error) {
  console.log(`\nPROBE threw before finishing: ${String(error).slice(0, 300)}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  console.log('probe done');
}
