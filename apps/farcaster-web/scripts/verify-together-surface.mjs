// End-to-end check for Together — "work with your people" — in a real browser,
// against the REAL collaboration service, at both widths the surface has to
// work at.
//
//   cd apps/farcaster-web
//   HTTPS=false TOGETHER_SERVICE_URL=http://127.0.0.1:8767 \
//     VITE_TOGETHER_API_URL='' \
//     npx vite --config scripts/together.vite.config.mjs --port 5199 --strictPort
//
//   TOGETHER_SERVER=http://localhost:5199 node scripts/verify-together-surface.mjs
//
// The service must be running with its offline verifier and an invite base that
// points back at this app, so the link it mints is a link this probe can open:
//
//   cd ~/Projects/hermes-multiplayer
//   HERMES_MULTIPLAYER_SIWF_MODE=trusting \
//   HERMES_MULTIPLAYER_DB_PATH="$PWD/.runtime/together-probe.db" \
//   HERMES_MULTIPLAYER_INVITE_BASE_URL="http://localhost:5199" \
//     .venv-verified/bin/python -m uvicorn server.service:app \
//     --host 127.0.0.1 --port 8767 --no-access-log
//
// Nothing is stubbed in the page: it talks to the service through the dev
// server's own `/spaces` proxy, signs two different Farcaster identities in
// through the service's real challenge/poll handshake (the probe plays the
// phone, calling the dev-only approve endpoint the offline verifier exposes),
// and reads back what the browser actually renders.
//
// WHAT IT ASSERTS (each one an observation, not a shape guess)
//
//   1. at 390x844 and 1440x900: the headline, the promise and the honest note,
//      with no horizontal overflow at either width
//   2. the Farcaster door leads to a real QR (a canvas) the service minted
//   3. approving it in "the phone" lands on the create-space form
//   4. creating a space shows the board: the space name, `#channel`, the three
//      columns (stacked at 390, three across at 1440), every button a tap target
//   5. a card added by the owner is visible on the board
//   6. the invite link is a real URL into this app, and opening it in a SECOND
//      browser context shows whose space it is before asking for anything
//   7. the second identity signs in and joins; the board there shows BOTH
//      members and the owner's card — the same board, not a copy
//   8. the member moves the card to Done, and the owner's already-open page
//      converges to Done on its own (its polling), with no reload
//   9. no console error and no page error in either context
//
// Screenshots land in $TOGETHER_SHOT_DIR (default: the system temp dir).

import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';

const SERVER = process.env.TOGETHER_SERVER ?? 'http://localhost:5199';
const SERVICE = process.env.TOGETHER_SERVICE_URL ?? 'http://127.0.0.1:8767';
const OUT = process.env.TOGETHER_SHOT_DIR ?? os.tmpdir();
const WIDTHS = [
  { label: '390', width: 390, height: 844 },
  { label: '1440', width: 1440, height: 900 },
];

const results = [];

const record = (label, ok, detail = '') => {
  results.push({ label, ok });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

const expect = (label, ok, detail = '') => record(label, Boolean(ok), detail);

const service = async (method, url, body) => {
  const response = await fetch(SERVICE + url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
};

/** Plays the phone: the offline verifier approves whatever the page asked for. */
const approve = async (requestId, fid, username) => {
  const answer = await service('POST', `/spaces/auth/${requestId}/approve`, {
    fid,
    username,
  });

  if (answer.status !== 200) {
    throw new Error(`approve failed: ${answer.status} ${JSON.stringify(answer.body)}`);
  }
};

/**
 * Watches the page's own sign-in requests so the probe can answer the one on
 * screen rather than inventing its own id.
 */
const watchSignIns = (page) => {
  const pending = [];
  page.on('response', async (response) => {
    if (
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith('/spaces/auth')
    ) {
      try {
        pending.push((await response.json()).request_id);
      } catch {
        // Not a challenge; ignore.
      }
    }
  });

  return async () => {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (pending.length > 0) {
        return pending.shift();
      }

      await page.waitForTimeout(100);
    }

    throw new Error('the page never asked the service for a sign-in challenge');
  };
};

const layout = (page) =>
  page.evaluate(() => {
    const title = document.querySelector('.fiddy-page-title');
    const grid = document.querySelector('[class*="md:grid-cols-3"]');
    const buttons = [...document.querySelectorAll('button')].filter(
      (button) => button.offsetParent !== null,
    );

    return {
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      title: title?.textContent ?? null,
      titleSize: title ? parseFloat(getComputedStyle(title).fontSize) : 0,
      background: getComputedStyle(document.body).backgroundColor,
      columns: grid
        ? getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length
        : 0,
      smallestButton: buttons.reduce(
        (smallest, button) =>
          Math.min(smallest, Math.round(button.getBoundingClientRect().height)),
        Number.POSITIVE_INFINITY,
      ),
    };
  });

const run = async (browser, width, index) => {
  const ownerFid = 910000 + index * 10;
  const memberFid = 910001 + index * 10;
  const errors = [];
  const context = await browser.newContext({
    viewport: { width: width.width, height: width.height },
    colorScheme: 'dark',
  });
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  const nextRequestId = watchSignIns(page);

  console.log(`\n${width.label}x${width.height}`);

  // 1. the front door
  await page.goto(`${SERVER}/~/together`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.fiddy-page-title');
  const door = await layout(page);
  expect(
    `${width.label}: reads "Work with your people"`,
    door.title === 'Work with your people',
    String(door.title),
  );
  expect(
    `${width.label}: no horizontal overflow`,
    door.scrollWidth <= door.innerWidth + 1,
    `${door.scrollWidth} vs ${door.innerWidth}`,
  );
  expect(
    `${width.label}: the honest note says what a space never holds`,
    await page.getByText(/never keys, never seed phrases/i).isVisible(),
  );
  expect(
    `${width.label}: the dark brand ground is on`,
    door.background === 'rgb(22, 23, 21)',
    door.background,
  );

  // 2. the Farcaster door → a real QR from the service
  await page.getByRole('button', { name: 'Sign in with Farcaster' }).click();
  await page.waitForSelector('canvas', { timeout: 15000 });
  expect(
    `${width.label}: the service minted a QR to scan`,
    (await page.locator('canvas').count()) > 0,
  );

  // 3. the phone approves → the create-space form
  await approve(await nextRequestId(), ownerFid, 'elena');
  await page.waitForSelector('text=Start a space', { timeout: 20000 });
  expect(`${width.label}: approving lands on "Start a space"`, true);

  // 4. create the space → the board
  await page.fill('input[placeholder="Fiddy launch"]', 'Fiddy launch');
  await page.fill('input[placeholder="fiddy"]', 'fiddy');
  await page.getByRole('button', { name: 'Create the space' }).click();
  await page.waitForSelector('text=#fiddy', { timeout: 20000 });
  const board = await layout(page);
  expect(
    `${width.label}: the space name heads the board`,
    await page.getByRole('heading', { name: 'Fiddy launch' }).isVisible(),
  );
  expect(
    `${width.label}: three columns laid out for this width`,
    board.columns === (width.width >= 768 ? 3 : 1),
    `${board.columns} columns`,
  );
  for (const column of ['To do', 'Doing', 'Done']) {
    expect(`${width.label}: column "${column}" is on the board`, await page.getByRole('heading', { name: column }).isVisible());
  }
  expect(
    `${width.label}: every visible button is a tap target (>=40px)`,
    board.smallestButton >= 40,
    `${board.smallestButton}px`,
  );

  // 5. the owner puts work on the board
  await page.fill('input[placeholder="Write the release note"]', 'Ship the Together surface');
  await page.getByRole('button', { name: 'Add card' }).click();
  await page.waitForSelector('text=Ship the Together surface', { timeout: 15000 });
  expect(`${width.label}: the card is on the board`, true);

  // 6. the invite link is a real URL into this app
  await page.getByRole('button', { name: 'Invite someone' }).click();
  const link = (await page.locator('code').first().textContent())?.trim() ?? '';
  expect(
    `${width.label}: the invite link points at this app`,
    link.startsWith(SERVER) && link.includes('/~/together/join/'),
    link,
  );
  await page.screenshot({ path: path.join(OUT, `together-board-${width.label}.png`) });

  // 7-8. a second identity, in a second browser context, on the same board
  const guestErrors = [];
  const guestContext = await browser.newContext({
    viewport: { width: width.width, height: width.height },
    colorScheme: 'dark',
  });
  const guest = await guestContext.newPage();
  guest.on('console', (message) => {
    if (message.type() === 'error') {
      guestErrors.push(`console: ${message.text()}`);
    }
  });
  guest.on('pageerror', (error) => guestErrors.push(`pageerror: ${error.message}`));
  const guestRequestId = watchSignIns(guest);

  await guest.goto(link, { waitUntil: 'domcontentloaded' });
  await guest.waitForSelector('text=#fiddy', { timeout: 20000 });
  expect(
    `${width.label}: the invite says whose space it is`,
    await guest.getByText('@elena invited you').isVisible(),
  );
  expect(
    `${width.label}: the invite asks for nothing but Farcaster`,
    await guest.getByText(/no email, no password, no keys/i).isVisible(),
  );
  await guest.getByRole('button', { name: /Sign in with Farcaster and join/ }).click();
  await guest.waitForSelector('canvas', { timeout: 15000 });
  await approve(await guestRequestId(), memberFid, 'marcus');
  await guest.waitForSelector('text=You joined the space.', { timeout: 20000 });
  await guest.screenshot({ path: path.join(OUT, `together-join-${width.label}.png`) });

  await guest.getByRole('link', { name: 'Open the board' }).click();
  await guest.waitForSelector('text=Ship the Together surface', { timeout: 20000 });
  expect(
    `${width.label}: the member sees BOTH members on the board`,
    (await guest.getByText(/@elena/).count()) > 0 &&
      (await guest.getByText(/@marcus/).count()) > 0,
  );
  expect(
    `${width.label}: the member sees the owner's card`,
    await guest.getByText('Ship the Together surface').isVisible(),
  );

  await guest.getByRole('button', { name: 'Start' }).click();
  await guest.waitForTimeout(500);
  await guest.getByRole('button', { name: 'Done' }).click();
  await guest.waitForSelector('text=Cast it to the channel', { timeout: 20000 });
  expect(`${width.label}: the member completed the card`, true);

  // The owner's page was never reloaded: polling has to bring it over.
  await page.waitForSelector('text=Cast it to the channel', { timeout: 20000 });
  expect(
    `${width.label}: the owner's open board converged to Done on its own`,
    true,
  );
  await page.screenshot({ path: path.join(OUT, `together-done-${width.label}.png`) });

  expect(`${width.label}: no browser errors`, errors.length === 0, errors.join(' | '));
  expect(
    `${width.label}: no browser errors in the member's context`,
    guestErrors.length === 0,
    guestErrors.join(' | '),
  );

  await guestContext.close();
  await context.close();
};

const main = async () => {
  const health = await service('GET', '/health').catch(() => null);
  if (!health || health.status !== 200) {
    throw new Error(
      `no collaboration service at ${SERVICE} — see the header of this file for the command`,
    );
  }

  // The bundled browser is whatever `playwright install` last fetched; when a
  // machine already has a Chromium build, pointing at it avoids a download.
  const executablePath = process.env.TOGETHER_CHROMIUM;
  const browser = await chromium.launch({
    args: ['--no-sandbox'],
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    for (const [index, width] of WIDTHS.entries()) {
      await run(browser, width, index);
    }
  } finally {
    await browser.close();
  }

  const failed = results.filter((result) => !result.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed` +
      (failed.length ? ` — failing: ${failed.map((f) => f.label).join('; ')}` : ''),
  );
  console.log(`screenshots in ${OUT}`);
  process.exit(failed.length ? 1 : 0);
};

main().catch((error) => {
  console.error('probe failed:', error);
  process.exit(1);
});