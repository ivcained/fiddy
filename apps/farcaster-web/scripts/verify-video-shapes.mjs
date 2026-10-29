// Real VideoAttachment + real browser media metadata, at both app widths.
// All media is intercepted same-origin; nothing calls a shape/poster service or
// an off-site host, and no wallet or transaction is involved.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';

const ORIGIN = process.env.VIDEO_SHAPE_ORIGIN ?? 'https://localhost:5237';
const MEDIA_DIR = process.env.VIDEO_SHAPE_MEDIA_DIR;
const OUT = process.env.VIDEO_SHAPE_SHOT_DIR ?? os.tmpdir();
if (!MEDIA_DIR) throw new Error('VIDEO_SHAPE_MEDIA_DIR is required');

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok, detail });
const expected = { first: 404 / 720, square: 1, wide: 1280 / 720 };

const measure = (page, name) =>
  page.evaluate((key) => {
    const host = document.querySelector(`[data-probe="${key}"]`);
    const outer = host?.querySelector('[data-fiddy="video-attachment"]');
    const box = outer?.firstElementChild;
    const video = outer?.querySelector('video');
    return {
      ratio:
        box instanceof HTMLElement
          ? Number.parseFloat(box.style.aspectRatio)
          : null,
      minHeight: outer instanceof HTMLElement ? outer.style.minHeight : null,
      position: box instanceof HTMLElement ? box.style.position : null,
      videoWidth: video?.videoWidth ?? 0,
      videoHeight: video?.videoHeight ?? 0,
      readyState: video?.readyState ?? 0,
    };
  }, name);

const waitRatio = async (page, name, ratio) => {
  await page.waitForFunction(
    ({ key, expected }) => {
      const box = document.querySelector(
        `[data-probe="${key}"] [data-fiddy="video-attachment"]`,
      )?.firstElementChild;
      return (
        box instanceof HTMLElement &&
        Math.abs(Number.parseFloat(box.style.aspectRatio) - expected) < 0.002
      );
    },
    { key: name, expected: ratio },
    { timeout: 20_000 },
  );
};

for (const reducedMotion of ['no-preference', 'reduce']) {
  for (const width of [390, 1440]) {
    const browser = await chromium.launch({
      channel: 'chrome',
      args: ['--ignore-certificate-errors'],
    });
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width, height: width === 390 ? 844 : 900 },
      reducedMotion,
    });
    const page = await context.newPage();
    const requests = [];
    page.on('request', (request) => requests.push(request.url()));
    await page.route('**/media/*', async (route) => {
      const file = path.basename(new URL(route.request().url()).pathname);
      const bytes = fs.readFileSync(path.join(MEDIA_DIR, file));
      if (file.endsWith('.mp4'))
        await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': file.endsWith('.jpg') ? 'image/jpeg' : 'video/mp4',
          'accept-ranges': 'bytes',
        },
        body: bytes,
      });
    });
    const at = `${width}px / ${reducedMotion}`;
    await page.goto(`${ORIGIN}/scripts/video-shape-probe.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });

    for (const [name, ratio] of Object.entries(expected)) {
      await waitRatio(page, name, ratio);
      const learned = await measure(page, name);
      check(
        `${at}: ${name} poster sets its own box before metadata`,
        Math.abs(learned.ratio - ratio) < 0.002,
        JSON.stringify(learned),
      );
    }
    const beforeMetadata = await measure(page, 'first');
    check(
      `${at}: poster learning does not require loaded media`,
      beforeMetadata.readyState === 0,
      JSON.stringify(beforeMetadata),
    );

    await page.waitForFunction(
      () => {
        const video = document.querySelector('[data-probe="first"] video');
        return video?.videoWidth === 1080 && video?.videoHeight === 1920;
      },
      { timeout: 20_000 },
    );
    for (const name of Object.keys(expected)) {
      const loaded = await measure(page, name);
      check(
        `${at}: ${name} keeps its intrinsic ratio after metadata`,
        Math.abs(loaded.ratio - expected[name]) < 0.002,
        JSON.stringify(loaded),
      );
    }
    for (const name of ['strip-tall', 'strip-square']) {
      const tile = await measure(page, name);
      check(
        `${at}: ${name} keeps the shared strip tile`,
        tile.minHeight === '240px' && tile.position === 'absolute',
        JSON.stringify(tile),
      );
    }

    await page.click('[data-probe-action="swap"]');
    await waitRatio(page, 'first', expected.wide);
    check(`${at}: URL replacement drops the previous video ratio`, true);
    await page.click('[data-probe-action="remount"]');
    check(
      `${at}: player unloads without losing the page`,
      (await page.locator('[data-probe="first"]').count()) === 0,
    );
    await page.click('[data-probe-action="remount"]');
    await waitRatio(page, 'first', expected.wide);
    check(`${at}: remount restores the current URL shape`, true);

    check(
      `${at}: no off-site or shape-service read`,
      requests.every(
        (url) =>
          url.startsWith(ORIGIN) ||
          url.startsWith('blob:') ||
          url.startsWith('data:'),
      ) &&
        !requests.some(
          (url) => url.includes('/api/shapes') || url.includes('/api/poster'),
        ),
      requests.filter((url) => !url.startsWith(ORIGIN)).join(', '),
    );
    await page.screenshot({
      path: `${OUT}/video-shapes-${width}-${reducedMotion}.png`,
      fullPage: true,
    });
    await browser.close();
  }
}

const failed = checks.filter((entry) => !entry.ok);
for (const entry of checks)
  console.log(
    `${entry.ok ? 'PASS' : 'FAIL'} ${entry.name}${entry.detail ? ` :: ${entry.detail}` : ''}`,
  );
console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) process.exit(1);
