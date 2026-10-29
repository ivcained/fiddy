// Real wallet-resolution modules in a real browser. Every provider and transfer
// is mocked inside the page: no real wallet prompt, no real transaction, no live
// RPC. Measures the fallback priority quilcast fixed without adding a picker.
import os from 'node:os';

import { chromium } from 'playwright';

const ORIGIN = process.env.WALLET_FALLBACK_ORIGIN ?? 'https://localhost:5211';
const OUT = process.env.WALLET_FALLBACK_SHOT_DIR ?? os.tmpdir();
const BOOT_TIMEOUT = Number(process.env.WALLET_FALLBACK_BOOT_TIMEOUT ?? 90_000);

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok, detail });

const run = async ({ width }) => {
  const browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors'],
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width, height: width < 600 ? 844 : 900 },
  });
  const page = await context.newPage();
  let pageError = null;
  page.on('pageerror', (error) => {
    pageError = String(error?.stack ?? error);
  });
  const requests = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.startsWith('http')) {
      requests.push(url);
    }
  });

  await page.goto(`${ORIGIN}/scripts/wallet-fallback-probe.html`, {
    waitUntil: 'domcontentloaded',
    timeout: BOOT_TIMEOUT,
  });
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-wallet-probe-ready]')
        ?.getAttribute('data-wallet-probe-ready') === 'true',
    { timeout: 60_000 },
  );
  const result = await page.evaluate(() =>
    document.querySelector('#wallet-fallback-result')?.textContent,
  );
  const outcome = JSON.parse(result ?? '{}');
  const at = `${width}px`;

  const stale = outcome.staleGlobalWithAnnounced ?? {};
  check(
    `${at}: the module harness reports its own failure instead of an empty run`,
    pageError === null || Object.keys(outcome).length > 0,
    pageError ?? JSON.stringify(outcome),
  );
  check(
    `${at}: a live announced wallet beats a global that never answers`,
    stale.label === 'Live Wallet' && stale.hash === `0x${'cd'.repeat(32)}`,
    JSON.stringify(stale),
  );
  check(
    `${at}: discovery requests no account before the send is chosen`,
    Array.isArray(stale.discoveryMethods) && stale.discoveryMethods.length === 0,
    JSON.stringify(stale.discoveryMethods),
  );
  check(
    `${at}: the announced provider answers chain, account and transfer`,
    (stale.methods ?? []).join(',').includes('eth_chainId') &&
      (stale.methods ?? []).join(',').includes('eth_requestAccounts') &&
      (stale.methods ?? []).includes('eth_sendTransaction'),
    JSON.stringify(stale.methods),
  );

  const two = outcome.twoAnnounced ?? {};
  check(
    `${at}: duplicate announcements are deduped`,
    two.label === 'Matching Wallet' &&
      two.hash === `0x${'cd'.repeat(32)}` &&
      (two.firstMethods ?? []).length === 0,
    JSON.stringify(two),
  );
  check(
    `${at}: one provider answers every step of the chosen send`,
    (two.methods ?? []).join(',').includes('eth_chainId') &&
      (two.methods ?? []).join(',').includes('eth_requestAccounts') &&
      (two.methods ?? []).includes('eth_sendTransaction'),
    JSON.stringify(two.methods),
  );

  const dead = outcome.deadGlobalNoAnnounced ?? {};
  check(
    `${at}: a dead fallback ends in a bounded, named refusal`,
    dead.code === 'WALLET_UNRESPONSIVE' &&
      dead.ownerLine ===
        'Your browser wallet is not answering. Reconnect it or choose another wallet.',
    JSON.stringify(dead),
  );

  const host = outcome.hostAheadOfConnected ?? {};
  const connected = outcome.connectedAheadOfAnnounced ?? {};
  check(
    `${at}: the Farcaster host stays ahead of a connected wallet`,
    host.label === 'your Farcaster wallet' && connected.label === 'Connected Wallet',
    JSON.stringify({ host, connected }),
  );
  check(
    `${at}: a connected wallet stays ahead of announced discovery`,
    (outcome.connectedAheadOfAnnounced ?? {}).label === 'Connected Wallet',
    JSON.stringify(outcome.connectedAheadOfAnnounced),
  );

  const copy = await page.textContent('[data-probe="copy"]');
  check(
    `${at}: the refusal copy is ELI5, with no EIP-6963 or RPC jargon`,
    (copy ?? '').trim() ===
      'Your browser wallet is not answering. Reconnect it or choose another wallet.',
    copy ?? '(nothing)',
  );

  const storedKeys = await page.evaluate(() => Object.keys(localStorage).join(','));
  check(
    `${at}: no localStorage wallet registry is written`,
    !storedKeys.toLowerCase().includes('wallet'),
    storedKeys || '(empty)',
  );
  check(
    `${at}: no off-site read and no wallet picker appears`,
    requests.every((url) => url.startsWith(ORIGIN)) &&
      !requests.some((url) => url.includes('/connect')),
    requests.filter((url) => !url.startsWith(ORIGIN)).join(', '),
  );

  await page.screenshot({
    path: `${OUT}/wallet-fallback-${width}.png`,
    fullPage: true,
  });
  await browser.close();
};

for (const width of [390, 1440]) {
  await run({ width });
}

const failed = checks.filter((entry) => !entry.ok);
for (const entry of checks) {
  console.log(
    `${entry.ok ? 'PASS' : 'FAIL'} ${entry.name}${entry.detail ? ` :: ${entry.detail}` : ''}`,
  );
}
console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) process.exit(1);
