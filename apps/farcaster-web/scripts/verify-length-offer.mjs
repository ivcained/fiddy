// End-to-end: a cast too long to send, and what Fiddy offers to do about it.
//
//   node scripts/verify-length-offer.mjs
//
// Preconditions — one node-backed dev server (a signed-in shell without it
// lands on the device-only session page and the composer never renders):
//
//   cd apps/farcaster-web
//   PROBE_VITE_CACHE_DIR=/tmp/length-offer-vite \
//   VITE_SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
//   SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com HTTPS=true \
//     npx vite --config scripts/probe.vite.config.mjs --port 5216 --strictPort
//
//   LENGTH_OFFER_SERVER=https://localhost:5216 \
//   PROBE_VITE_CACHE_DIR=/tmp/length-offer-vite \
//     node scripts/verify-length-offer.mjs
//
// What it reproduces, and why these checks. The over-limit composer used to
// be a dead end (a red negative number, a button that would not press). Now
// it offers what the agent can do — tighten it into one cast, or split it
// into a thread — and this probe holds that offer to its claims, in two
// worlds:
//
//   A. WITH an agent (the browser paired one through /~/agent, the real
//      autopair flow):
//     1. over the limit, the row appears: the plain sentence, both verbs
//     2. under the limit again, the row is gone
//     3. Tighten makes ONE call even when double-clicked, then asks in the
//        row itself — never a native dialog — and the Replace it offers
//        cannot be answered by the click that opened it (fresh guard)
//     4. Cancel keeps the person's text untouched
//     5. Replace swaps in the shorter text and the Cast button wakes up
//     6. Split loads the parts into the queue (3 editors, "Post all"),
//        after its own ask
//   B. WITHOUT an agent: no row at all. The plain length counter is the
//      whole answer — never a dead button with a spinner.
//
// Only the SIWF relay (with a REAL SIWE message signed by a throwaway key),
// the owner-session route and the agent service (https://fiddy.fun/api/**)
// are stubbed. Nothing posts to Farcaster, and nothing spends a model
// request: the agent's answers are stubbed at the HTTP boundary the client
// really calls.
//
// Screenshots land in $LENGTH_OFFER_SHOT_DIR (default: the system temp dir).

import os from 'node:os';

import { chromium } from 'playwright';
import { createSiweMessage } from 'viem/siwe';
import { privateKeyToAccount } from 'viem/accounts';

const SERVER = process.env.LENGTH_OFFER_SERVER ?? 'https://localhost:5216';
const OUT = process.env.LENGTH_OFFER_SHOT_DIR ?? os.tmpdir();
const DOMAIN = new URL(SERVER).host;
const NONCE = 'l'.repeat(128);
const CHANNEL_TOKEN = 'SI_SECRET_TOKEN_LNGTHOFR';
const SIGNED_IN_FID = 4242;
const AGENT_NAME = 'Flo';
const SESSION_TOKEN = 'owner-session-token-for-the-composer';
const MODAL_ROOT = '#modal-root';
/** Comfortably past every byte limit a build can carry (320, 1024). */
const OVER_LIMIT_TEXT = `a probe cast that is far too long to send in one piece — ${'x'.repeat(1500)}`;
const TIGHTENED_REPLY = 'the probe cast, tightened to fit.';
const SPLIT_REPLY = [
  'the probe cast, part one.',
  'the probe cast, part two.',
  'the probe cast, part three.',
].join('\n%%%\n');

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

/** Press the first visible control whose text matches. */
const pressByText = async (page, re) => {
  for (const el of await page.$$('button, a, [role=button]')) {
    const text = ((await el.innerText()) || '').replace(/\s+/g, ' ').trim();
    if (re.test(text) && (await el.isVisible().catch(() => false))) {
      try {
        await el.click();
      } catch {
        // the page moved under the click; the caller re-reads state anyway
      }
      return text;
    }
  }
  return null;
};

/**
 * A step's buttons render after its sheet paints (the funds step waits on its
 * own config read), so a one-shot press finds nothing on the first pass. Poll
 * for the control instead of assuming it missed because it is absent.
 */
const pressEventually = async (page, re, timeout = 20000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const pressed = await pressByText(page, re);
    if (pressed || Date.now() > deadline) {
      return pressed;
    }
    await page.waitForTimeout(250);
  }
};

const editorText = (page) =>
  page
    .evaluate(
      (root) =>
        (
          document.querySelector(`${root} .public-DraftEditor-content`)
            ?.innerText ?? ''
        ).replace(/\s+/g, ' '),
      MODAL_ROOT,
    )
    .catch(() => '');

const editorCount = (page) =>
  page
    .evaluate(
      (root) =>
        document.querySelectorAll(`${root} [contenteditable="true"]`).length,
      MODAL_ROOT,
    )
    .catch(() => 0);

/** The composer's own submit button, read after whatever just happened. */
const submitButton = (page) =>
  page
    .evaluate((root) => {
      const buttons = Array.from(
        document.querySelectorAll(`${root} button`),
      ).map((button) => ({
        label: (button.innerText || '').trim(),
        disabled: button.disabled,
      }));
      const submit = buttons.find(
        (button) => button.label === 'Cast' || button.label === 'Cast all',
      );
      return submit ?? null;
    }, MODAL_ROOT)
    .catch(() => null);

const offerRow = (page) =>
  page
    .evaluate(() => {
      const row = document.querySelector('[data-fiddy="length-offer"]');
      if (!row) {
        return null;
      }
      const control = (marker) => {
        const el = row.querySelector(`[data-fiddy="${marker}"]`);
        return el
          ? {
              text: (el.innerText || '').replace(/\s+/g, ' ').trim(),
              disabled: el.disabled,
            }
          : null;
      };
      return {
        text: (row.innerText || '').replace(/\s+/g, ' ').trim(),
        tighten: control('length-offer-tighten'),
        split: control('length-offer-split'),
        ask: control('length-offer-ask'),
        confirm: control('length-offer-confirm'),
        cancel: control('length-offer-cancel'),
        status: control('length-offer-status'),
        error: control('length-offer-error'),
      };
    })
    .catch(() => null);

const waitForOffer = async (page, { present = true, timeout = 20000 }) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const row = await offerRow(page);
    if (present === Boolean(row)) {
      return row;
    }
    if (Date.now() > deadline) {
      return row;
    }
    await page.waitForTimeout(250);
  }
};

/** Wait for the ask to actually be on screen (the busy row is also a row). */
const waitAsk = async (page, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const row = await offerRow(page);
    if (row?.ask) {
      return row;
    }
    if (Date.now() > deadline) {
      return row;
    }
    await page.waitForTimeout(250);
  }
};

/** The full way in: greeting, one setup screen, ready sheet, sign-in. */
const signIn = async (page) => {
  await page.goto(`${SERVER}/welcome`, {
    waitUntil: 'commit',
    timeout: 60000,
  });
  await page.waitForSelector('[data-fiddy-step="hi"]', {
    timeout: 180000,
  });
  const said = await pressByText(page, /^Say hi$/);
  await page.waitForSelector('input[placeholder="Fiddy"]', {
    timeout: 30000,
  });
  await page.fill('input[placeholder="Fiddy"]', AGENT_NAME);
  const continued = await pressByText(page, /^Continue$/);
  // The funds step sits between setup and ready; its quiet action walks on.
  const fundsSeen = await page
    .waitForSelector('[data-fiddy-step="funds"]', { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  const walkedPastFunds = await pressEventually(page, /^Add this later$/);
  console.log(
    `[sign-in walk] sayHi=${Boolean(said)} continue=${continued} funds=${fundsSeen} addLater=${walkedPastFunds}`,
  );
  await page.waitForSelector('[data-fiddy-step="ready"]', {
    timeout: 30000,
  });
  await page.waitForTimeout(600);
  await pressByText(page, /Go social|sign in/i);
  // The sign-in is a navigation; wait for the shell, not for a tick count.
  const deadline = Date.now() + 60000;
  for (;;) {
    const landed = await page
      .evaluate(
        () =>
          Boolean(document.querySelector('.fiddy-shell-frame')) &&
          !document.querySelector('[data-fiddy="onboarding"]') &&
          !document.querySelector('[data-fiddy="device-only-session"]'),
      )
      .catch(() => false);
    if (landed || Date.now() > deadline) {
      return landed;
    }
    await page.waitForTimeout(500);
  }
};

/** Open the composer through the shell's own Cast control. */
const openComposer = async (page) => {
  await page.goto(`${SERVER}/`, {
    waitUntil: 'commit',
    timeout: 60000,
  });
  // The desktop Cast button mounts late (after account bootstrap), and the
  // phone header keeps a hidden 0x0 "Cast" of its own: poll for a VISIBLE
  // exact-text control.
  const deadline = Date.now() + 60000;
  let clicked = false;
  while (!clicked && Date.now() < deadline) {
    clicked = await page
      .evaluate(() => {
        const buttons = Array.from(
          document.querySelectorAll('button, [role=button]'),
        );
        const cast = buttons.find((button) => {
          const label = (button.innerText || '').trim();
          if (label !== 'Cast') {
            return false;
          }
          const box = button.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        });
        if (cast) {
          cast.click();
          return true;
        }
        return false;
      })
      .catch(() => false);
    if (!clicked) {
      await page.waitForTimeout(500);
    }
  }
  if (!clicked) {
    return false;
  }
  await page.waitForSelector(`${MODAL_ROOT} [contenteditable="true"]`, {
    timeout: 30000,
  });
  return true;
};

const typeIntoEditor = async (page, text) => {
  await page.locator(`${MODAL_ROOT} [contenteditable="true"]`).first().click();
  // Select-all is Meta+A on this Chromium (Control+A is line-start on macOS).
  await page.keyboard.press('Meta+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText(text);
  await page.waitForTimeout(600);
};

const stubSignInAndAgent = async (page, { agentAvailable }) => {
  const seen = { instances: 0, chat: [] };

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
        username: 'fiddy',
        displayName: 'Fiddy',
        authMethod: 'custody',
      }),
    });
  });

  // The route that pairs this browser with the agent service.
  await page.route('**/api/fiddy/owner-session', async (route) => {
    if (!agentAvailable) {
      return route.fulfill({
        status: 200,
        headers: CORS,
        body: JSON.stringify({
          ok: false,
          code: 'OWNER_SESSION_NOT_OPEN',
          message: 'This service cannot start your agent yet.',
        }),
      });
    }
    return route.fulfill({
      status: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        session: {
          token: SESSION_TOKEN,
          expiresAt: Date.now() + 1_000_000,
          fid: SIGNED_IN_FID,
          subject: `farcaster:${SIGNED_IN_FID}`,
          name: AGENT_NAME,
        },
        agent: { name: AGENT_NAME, brain: { kind: 'default' } },
        provisioning: { open: false },
      }),
    });
  });

  // The agent service itself, at the address the default build uses.
  await page.route('https://fiddy.fun/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/agents/instances') {
      seen.instances += 1;
      return route.fulfill({
        status: 200,
        headers: CORS,
        body: JSON.stringify({
          ok: true,
          data: agentAvailable
            ? [{ id: 'inst-1', name: AGENT_NAME, status: 'running' }]
            : [{ id: 'inst-1', name: AGENT_NAME, status: 'stopped' }],
        }),
      });
    }
    if (url.pathname.endsWith('/chat')) {
      const body = (() => {
        try {
          return JSON.parse(route.request().postData() ?? '{}');
        } catch {
          return {};
        }
      })();
      const prompt = String(body.message ?? '');
      seen.chat.push(prompt.slice(0, 120));
      const reply = /split it into/i.test(prompt)
        ? SPLIT_REPLY
        : TIGHTENED_REPLY;
      return route.fulfill({
        status: 200,
        headers: CORS,
        body: JSON.stringify({
          ok: true,
          result: { output_text: reply },
        }),
      });
    }
    if (url.pathname === '/api/health') {
      return route.fulfill({
        status: 200,
        headers: CORS,
        body: JSON.stringify({ ok: true, mode: 'demo' }),
      });
    }
    return route.fulfill({
      status: 200,
      headers: CORS,
      body: JSON.stringify({ ok: true, data: [] }),
    });
  });

  return seen;
};

const runCase = async (browser, { label, agentAvailable }) => {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  const dialogs = [];
  const pageErrors = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  page.on('pageerror', (error) => {
    pageErrors.push(String(error));
  });

  const seen = await stubSignInAndAgent(page, { agentAvailable });

  const landed = await signIn(page);
  check(
    `${label}: a completed sign-in lands in the client`,
    landed,
    `path=${new URL(page.url()).pathname}`,
  );
  if (!landed) {
    await context.close();
    return { seen, dialogs, pageErrors };
  }

  // Pair an agent through the real surface, so the composer reads a session
  // the app itself stored. In the no-agent world this page says so and
  // stores nothing.
  await page.goto(`${SERVER}/~/agent`, {
    waitUntil: 'commit',
    timeout: 60000,
  });
  await page.waitForTimeout(6000);
  const agentSurface = await page
    .evaluate(() => ({
      chat: Boolean(
        document.querySelector('textarea[placeholder="Message your agent…"]'),
      ),
    }))
    .catch(() => ({ chat: false }));
  check(
    `${label}: /~/agent autopairs and holds a chat when the service is open`,
    agentAvailable ? agentSurface.chat : true,
    `chat=${agentSurface.chat}`,
  );

  const opened = await openComposer(page);
  check(`${label}: the composer opens over the feed`, opened);
  if (!opened) {
    await context.close();
    return { seen, dialogs, pageErrors };
  }

  await typeIntoEditor(page, OVER_LIMIT_TEXT);
  const typed = (await editorText(page)).includes('far too long');
  const submit = await submitButton(page);
  check(
    `${label}: over the limit, Cast refuses and the counter is the only fallback`,
    typed && submit !== null && submit.disabled,
    `typed=${typed} submit=${JSON.stringify(submit)}`,
  );

  const row = await waitForOffer(page, { present: agentAvailable });
  if (agentAvailable) {
    check(
      `${label}: the offer appears: one sentence, two verbs`,
      Boolean(row) &&
        /This is too long for one cast\./.test(row.text) &&
        row.tighten?.text === 'Tighten it' &&
        row.split?.text === 'Split it into a thread' &&
        !row.tighten?.disabled &&
        !row.split?.disabled,
      JSON.stringify(row).slice(0, 300),
    );
    check(
      `${label}: the offer asked the agent service who could answer`,
      seen.instances > 0,
      `instances=${seen.instances}`,
    );
  } else {
    check(
      `${label}: with no agent, no row at all — never a dead button`,
      row === null,
      JSON.stringify(row).slice(0, 200),
    );
    await context.close();
    return { seen, dialogs, pageErrors };
  }

  // Under the limit again: the row leaves on its own.
  await typeIntoEditor(page, 'short text that fits one cast');
  const gone = await waitForOffer(page, { present: false });
  check(
    'back under the limit, the offer is gone',
    gone === null,
    JSON.stringify(gone).slice(0, 200),
  );

  // Tighten: one call even when double-clicked, then an ask in the row.
  await typeIntoEditor(page, OVER_LIMIT_TEXT);
  await waitForOffer(page, { present: true });
  const chatBefore = seen.chat.length;
  await page
    .locator('[data-fiddy="length-offer-tighten"]')
    .dblclick()
    .catch(() => undefined);
  const busySeen = await waitForOffer(page, { present: true });
  check(
    'a double click on Tighten still makes exactly one call',
    seen.chat.length === chatBefore + 1,
    `chat=${seen.chat.length} (was ${chatBefore}) busy=${Boolean(
      busySeen?.status,
    )}`,
  );

  const ask = await waitAsk(page);
  check(
    'the tighten ask lives in the row itself, with a fresh-guarded Replace',
    Boolean(ask?.ask) &&
      /Fiddy made it fit one cast\./.test(ask.ask.text) &&
      ask.confirm?.text === 'Replace' &&
      ask.confirm?.disabled === true &&
      ask.cancel?.text === 'Cancel',
    JSON.stringify(ask).slice(0, 300),
  );

  // The click that opened the question cannot answer it. Playwright's own
  // click() WAITS for the button to enable (so it would answer the ask after
  // the window passed); a double tap is a raw event instead, dispatched the
  // moment the ask appears, and the guard must refuse it.
  await page.evaluate(() => {
    document
      .querySelector('[data-fiddy="length-offer-confirm"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await page.waitForTimeout(400);
  const survivedEarlyPress = (await editorText(page)).includes('far too long');
  check(
    'a press inside the fresh window does not answer the ask',
    survivedEarlyPress,
    `text=${(await editorText(page)).slice(0, 80)}`,
  );

  // Cancel keeps the person's text.
  await page.locator('[data-fiddy="length-offer-cancel"]').click();
  await page.waitForTimeout(400);
  const afterCancel = await offerRow(page);
  check(
    'Cancel keeps the text and returns to the offer',
    (await editorText(page)).includes('far too long') &&
      afterCancel?.tighten?.text === 'Tighten it',
    JSON.stringify(afterCancel).slice(0, 200),
  );

  // Replace swaps in the shorter text and wakes the Cast button.
  await page.locator('[data-fiddy="length-offer-tighten"]').click();
  await waitAsk(page);
  await page.waitForTimeout(700); // the fresh window must pass
  await page.locator('[data-fiddy="length-offer-confirm"]').click();
  await page.waitForTimeout(800);
  const tightenedText = await editorText(page);
  const afterReplace = await submitButton(page);
  const rowAfterReplace = await waitForOffer(page, { present: false });
  check(
    'Replace puts the shorter text in and Cast wakes up',
    tightenedText.includes(TIGHTENED_REPLY) &&
      afterReplace !== null &&
      !afterReplace.disabled,
    `text=${tightenedText.slice(0, 120)} submit=${JSON.stringify(
      afterReplace,
    )}`,
  );
  check(
    'the row leaves once the text fits',
    rowAfterReplace === null,
    JSON.stringify(rowAfterReplace).slice(0, 200),
  );

  // Split: its own ask, then the parts load into the queue.
  await typeIntoEditor(page, OVER_LIMIT_TEXT);
  await waitForOffer(page, { present: true });
  await page.locator('[data-fiddy="length-offer-split"]').click();
  const splitAsk = await waitAsk(page);
  check(
    'the split ask says what to check before posting',
    Boolean(splitAsk?.ask) &&
      /Fiddy split your cast into 3 — check the breaks before posting\./.test(
        splitAsk.ask.text,
      ) &&
      splitAsk.confirm?.text === 'Add to thread',
    JSON.stringify(splitAsk).slice(0, 300),
  );
  await page.waitForTimeout(700);
  await page.locator('[data-fiddy="length-offer-confirm"]').click();
  await page.waitForTimeout(800);
  const parts = await editorCount(page);
  const allText = await editorText(page);
  const postAll = await submitButton(page);
  check(
    'Add to thread loads the parts as a reviewable queue',
    parts === 3 &&
      allText.includes('part one.') &&
      postAll?.label === 'Cast all' &&
      !postAll?.disabled,
    `editors=${parts} submit=${JSON.stringify(postAll)}`,
  );

  await page.screenshot({
    path: `${OUT}/length-offer-${label}-split.png`,
    fullPage: true,
  });

  await context.close();
  return { seen, dialogs, pageErrors };
};

let browser;

const main = async () => {
  browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors'],
  });

  // A. The world where an agent answers.
  const withAgent = await runCase(browser, {
    label: 'agent',
    agentAvailable: true,
  });

  // B. The world where none does: no offer, no dead button.
  const withoutAgent = await runCase(browser, {
    label: 'no-agent',
    agentAvailable: false,
  });

  await browser.close();

  // Zero native dialogs anywhere: the ask is always in the row.
  check(
    'zero native dialogs in both worlds',
    withAgent.dialogs.length === 0 && withoutAgent.dialogs.length === 0,
    JSON.stringify([...withAgent.dialogs, ...withoutAgent.dialogs]).slice(
      0,
      200,
    ),
  );

  // No uncaught page error. The seam's own HANDLED refusals arrive on the
  // error channel by design; everything else must be silence.
  const handled = (errors) =>
    errors.filter((error) => !/HandledFetchError/.test(error));
  check(
    'no uncaught page error in either world',
    handled(withAgent.pageErrors).length === 0 &&
      handled(withoutAgent.pageErrors).length === 0,
    JSON.stringify([
      ...handled(withAgent.pageErrors),
      ...handled(withoutAgent.pageErrors),
    ]).slice(0, 400),
  );

  check(
    'the no-agent world never asked the agent service for instances',
    withoutAgent.seen.instances === 0,
    `instances=${withoutAgent.seen.instances}`,
  );

  const failed = checks.filter((entry) => !entry.ok);
  for (const entry of failed) {
    console.log(`✗ ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`);
  }
  console.log(
    `\n${checks.length - failed.length}/${checks.length} checks passed`,
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
};

main().catch((error) => {
  console.error(error);
  // A throw mid-run must not leave the browser holding the process open.
  if (browser) {
    void browser.close().catch(() => undefined);
  }
  process.exitCode = 1;
});
