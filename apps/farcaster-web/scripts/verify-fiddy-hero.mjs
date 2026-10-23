// What the hero Fiddy does, driven in a real browser at three widths, in two
// motion preferences, and on a browser with no WebGL at all.
//
//   HTTPS=true SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
//     npx vite --port 5199 --strictPort
//   FIDDY_HERO_SERVER=https://localhost:5199 node scripts/verify-fiddy-hero.mjs
//
// The front door is signed-out territory, so nothing here needs a session or a
// seeded SIWF round trip: the page a visitor with no account meets is the page
// this checks.
//
// WHAT IT ASSERTS
//
//   the hero (1) is on the front door in its own variant, (2) paints the still
//   before it asks for anything, and (3) never puts the model on the critical
//   path — the GLB and the three.js chunk both start after first paint.
//
//   (4) NOTHING MOVES WHEN THE MODEL ARRIVES. The stage's box and everything
//   under it are sampled on every frame from the moment the page boots, so the
//   claim "no layout shift" is measured across the swap rather than eyeballed
//   once it is over.
//
//   (5) THE STILL IS NOT A LIE. The canvas the model draws into is screenshotted
//   and compared with `public/fiddy-hero-poster.png`: same figure, same size in
//   the frame, same centre, same brightness. This is the check that fails if the
//   poster is rendered from a recipe the live scene no longer uses.
//
//   (6) the pointer turns it, and the page does not turn with it.
//
//   (7) under `prefers-reduced-motion: reduce` the model is never fetched at all
//   and the still is still there; (8) on a browser with no WebGL the still is
//   what remains, and nothing throws.
//
//   on `/welcome/name` (9) the little Fiddy stands beside the name field where
//   there is room and above it where there is not, and (10) it never takes a
//   pointer that belongs to the field — typing into the field still works with
//   the model mounted next to it.
//
// Screenshots land in $FIDDY_HERO_SHOT_DIR (default: the system temp dir).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { decodePng, visibleBox } from './lib/png.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const POSTER = path.join(APP, 'public', 'fiddy-hero-poster.png');
const GLB = '/fiddy-hero.glb';
const POSTER_URL = '/fiddy-hero-poster.png';

/** The brand ground the page paints, which is what the still sits on. */
const GROUND = { r: 0x16, g: 0x17, b: 0x15 };

const SERVER = process.env.FIDDY_HERO_SERVER ?? 'https://localhost:5199';
const OUT = process.env.FIDDY_HERO_SHOT_DIR ?? os.tmpdir();

/** The widths the design is checked at: a phone, a tablet, a desktop. */
const WIDTHS = [390, 768, 1440];

const failures = [];
let checks = 0;
const check = (name, ok, detail = '') => {
  checks += 1;
  if (!ok) failures.push({ name, detail });
  return ok;
};

/** Everything the page asks for, captured as it happens rather than read back
    later: the app clears the resource timing buffer, and a bucket that has been
    emptied cannot answer "was this on the critical path?". */
const RESOURCES = () => {
  window.__resources = [];
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__resources.push({
          name: entry.name,
          startTime: entry.startTime,
          initiatorType: entry.initiatorType,
        });
      }
    }).observe({ type: 'resource', buffered: true });
  } catch {
    window.__resources = null;
  }
};

/** Records the stage's box and everything under it, every frame, from boot. */
const SAMPLER = () => {
  window.__heroSamples = [];
  const tick = () => {
    const stage = document.querySelector('[data-fiddy-hero-variant]');
    if (stage) {
      const box = stage.getBoundingClientRect();
      const action = document.querySelector('.fiddy-primary-btn');
      const sheet = document.querySelector('[data-fiddy="sheet"]');
      window.__heroSamples.push({
        attr: stage.getAttribute('data-fiddy-hero'),
        variant: stage.getAttribute('data-fiddy-hero-variant'),
        x: +box.x.toFixed(2),
        y: +box.y.toFixed(2),
        w: +box.width.toFixed(2),
        h: +box.height.toFixed(2),
        action: action ? +action.getBoundingClientRect().y.toFixed(2) : null,
        sheet: sheet ? +sheet.getBoundingClientRect().height.toFixed(2) : null,
        doc: document.documentElement.scrollHeight,
      });
      if (window.__heroSamples.length > 900) {
        window.__heroSamples.splice(0, 300);
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

/** The picture as it looks once it is lying on `ground`. */
const overGround = (image, ground) => {
  const data = new Uint8Array(image.width * image.height * 4);
  for (let at = 0; at < image.data.length; at += 4) {
    const alpha = image.data[at + 3] / 255;
    data[at] = Math.round(image.data[at] * alpha + ground.r * (1 - alpha));
    data[at + 1] = Math.round(image.data[at + 1] * alpha + ground.g * (1 - alpha));
    data[at + 2] = Math.round(image.data[at + 2] * alpha + ground.b * (1 - alpha));
    data[at + 3] = 255;
  }
  return { width: image.width, height: image.height, data };
};

/** How bright the drawing is, over `ground` — the "is it rendered dark" number. */
const litPixels = (image, ground) => {
  let sum = 0;
  let count = 0;
  for (let at = 0; at < image.data.length; at += 4) {
    const difference = Math.max(
      Math.abs(image.data[at] - ground.r),
      Math.abs(image.data[at + 1] - ground.g),
      Math.abs(image.data[at + 2] - ground.b),
    );
    if (difference <= 30) continue;
    sum +=
      0.2126 * image.data[at] +
      0.7152 * image.data[at + 1] +
      0.0722 * image.data[at + 2];
    count += 1;
  }
  return count ? sum / count : 0;
};

/** A box as shares of its own frame, so two resolutions can be compared. */
const fraction = (box, image) => ({
  x0: box.x0 / image.width,
  x1: (box.x1 + 1) / image.width,
  y0: box.y0 / image.height,
  y1: (box.y1 + 1) / image.height,
  width: box.width / image.width,
  height: box.height / image.height,
  cx: (box.x0 + box.x1 + 1) / 2 / image.width,
  cy: (box.y0 + box.y1 + 1) / 2 / image.height,
});

/** Screenshots are evidence, not assertions: they land in OUT and are listed. */
const shots = [];
const shot = async (page, label) => {
  const file = path.join(OUT, `fiddy-hero-${label}.png`);
  await page.screenshot({ path: file });
  shots.push(file);
  return file;
};

/**
 * The still is not a lie: the stage as the browser paints it against
 * `public/fiddy-hero-poster.png`.
 *
 * Both are measured the same way, over the ground the page actually uses: an
 * element screenshot composites the stage over that ground for us, and the still
 * is composited over it here. The stage's glow is hidden for the measurement
 * only — it is decoration behind the model, and a halo is not part of the figure
 * this is comparing. This is the check that fails if the poster was rendered
 * from a recipe the live scene no longer uses, and it is the same check the
 * fallback paths are held to: on a browser with no WebGL the still IS the hero,
 * so it has to be a picture of Fiddy and not a hole where one should be.
 */
async function compareStageToPoster(page, stage, label) {
  await page.addStyleTag({
    content: '.fiddy-hero-stage-hero::before { display: none !important }',
  });
  const liveShot = path.join(OUT, `fiddy-hero-${label}-stage.png`);
  await stage.screenshot({ path: liveShot, type: 'png' });
  const live = decodePng(fs.readFileSync(liveShot));
  const poster = decodePng(fs.readFileSync(POSTER));
  const liveBox = visibleBox(live, { ground: GROUND, threshold: 30 });
  const posterBox = visibleBox(overGround(poster, GROUND), {
    ground: GROUND,
    threshold: 30,
  });

  check(`${label}: the stage drew a figure`, liveBox !== null);
  if (!liveBox || !posterBox) {
    return null;
  }
  const a = fraction(liveBox, live);
  const b = fraction(posterBox, poster);
  const near = (one, two, tolerance) => Math.abs(one - two) <= tolerance;
  check(
    `${label}: it is the same figure at the same scale as the still`,
    near(a.height, b.height, 0.12) && near(a.width, b.width, 0.14),
    `painted w/h ${a.width.toFixed(3)}/${a.height.toFixed(3)} vs still ${b.width.toFixed(3)}/${b.height.toFixed(3)}`,
  );
  check(
    `${label}: it is the same shot — same centre`,
    near(a.cx, b.cx, 0.05) && near(a.cy, b.cy, 0.05),
    `painted centre (${a.cx.toFixed(3)},${a.cy.toFixed(3)}) vs still (${b.cx.toFixed(3)},${b.cy.toFixed(3)})`,
  );
  check(
    `${label}: it is lit like the still, not a dark blob`,
    litPixels(live, GROUND) > litPixels(overGround(poster, GROUND), GROUND) * 0.7 &&
      litPixels(live, GROUND) < litPixels(overGround(poster, GROUND), GROUND) * 1.4,
    `painted ${litPixels(live, GROUND).toFixed(1)} vs still ${litPixels(overGround(poster, GROUND), GROUND).toFixed(1)}`,
  );
  check(
    `${label}: the model does not touch the edge of its box at this width`,
    liveBox.x0 > 1 &&
      liveBox.y0 > 1 &&
      liveBox.x1 < live.width - 2 &&
      liveBox.y1 < live.height - 2,
    JSON.stringify(liveBox),
  );
  return liveBox;
}

/** Everything the front door promises, at one width. */
async function checkFrontDoor(browser, width) {
  const label = `front-door-${width}`;
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
  });
  await context.addInitScript(SAMPLER);
  await context.addInitScript(RESOURCES);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  const requested = [];
  page.on('request', (request) => requested.push(request.url()));

  await page.goto(`${SERVER}/welcome`, { waitUntil: 'domcontentloaded' });

  // (1) the hero is here, in its own variant.
  const stage = page.locator('[data-fiddy-hero-variant="hero"]');
  await page.waitForSelector('[data-fiddy-hero-variant="hero"]', {
    timeout: 20000,
  });
  check(`${label}: the hero stage is on the front door`, (await stage.count()) === 1);

  // (2) the still paints before anything is fetched, and it is the real still.
  const still = stage.locator('.fiddy-hero-stage-still');
  check(
    `${label}: the still is the poster, painted as an image with its own box`,
    (await still.getAttribute('src')) === POSTER_URL,
  );

  // (3) nothing on the critical path: first paint, then the chunk, then the GLB.
  await page.waitForFunction(
    () => document.querySelector('[data-fiddy-hero="moving"]'),
    undefined,
    { timeout: 45000 },
  );
  // The observer's own record, not the browser's read-back buffer: the app
  // clears resource timings, and an emptied bucket cannot answer this question.
  const timing = await page.evaluate(() => {
    const entries = window.__resources ?? performance.getEntriesByType('resource');
    const paint = performance.getEntriesByType('paint');
    const at = (match) =>
      entries
        .filter((entry) => match.test(entry.name))
        .map((entry) => Math.round(entry.startTime));
    return {
      firstPaint: paint.length ? Math.round(paint[0].startTime) : null,
      glb: at(/fiddy-hero\.glb/),
      // The chunk three.js lives in, whatever it is called: a bare module under
      // /node_modules/.vite in dev, an assets/ chunk in a build.
      loader: entries
        .filter((entry) => /three|GLTFLoader|fiddyModelScene|fiddyHero/i.test(entry.name))
        .map((entry) => ({
          name: entry.name.split('/').pop(),
          startTime: Math.round(entry.startTime),
        })),
      total: entries.length,
    };
  });
  check(
    `${label}: the model starts after first paint, not before`,
    timing.firstPaint !== null &&
      timing.glb.length === 1 &&
      timing.glb[0] > timing.firstPaint,
    JSON.stringify(timing),
  );
  check(
    `${label}: the loader is a chunk of its own, and it is fetched after first paint too`,
    timing.loader.length > 0 &&
      timing.loader.every((entry) => entry.startTime > timing.firstPaint),
    JSON.stringify(timing.loader),
  );
  check(
    `${label}: the GLB is fetched once`,
    requested.filter((url) => url.endsWith(GLB)).length === 1,
  );

  // (4) nothing moved when it arrived: sampled every frame across the swap.
  const samples = await page.evaluate(() => window.__heroSamples);
  const stills = samples.filter((sample) => sample.attr === 'still');
  const movings = samples.filter((sample) => sample.attr === 'moving');
  check(
    `${label}: the page was watched in both states`,
    stills.length > 0 && movings.length > 0,
    `still=${stills.length} moving=${movings.length}`,
  );
  if (stills.length && movings.length) {
    const shapes = new Set(
      samples.map((sample) =>
        [sample.x, sample.y, sample.w, sample.h, sample.action, sample.doc].join('|'),
      ),
    );
    check(
      `${label}: the model's arrival moves nothing (${samples.length} frames sampled)`,
      shapes.size === 1,
      [...shapes].join(' vs '),
    );
    check(
      `${label}: the reserved box is a real box`,
      movings[0].w > 100 && movings[0].h > 100,
      JSON.stringify(movings[0]),
    );
  }

  // (5) the still is not a lie: what the browser paints against the poster.
  await compareStageToPoster(page, stage, label);

  // (6) the pointer turns the model, and the page stays where it is.
  const before = await page.screenshot({ clip: await stage.boundingBox() });
  const box = await stage.boundingBox();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5, {
    steps: 12,
  });
  await page.mouse.up();
  const after = await page.screenshot({ clip: box });
  const scroll = await page.evaluate(() => ({
    x: window.scrollX,
    y: window.scrollY,
    overflow:
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  check(
    `${label}: dragging the model turns it`,
    !before.equals(after),
    'the canvas is identical before and after the drag',
  );
  check(
    `${label}: dragging the model does not scroll or widen the page`,
    scroll.x === 0 && scroll.overflow <= 0,
    JSON.stringify(scroll),
  );

  await shot(page, label);
  check(`${label}: nothing threw`, errors.length === 0, errors.join(' | '));
  await context.close();
  return { timing, samples };
}

/** Reduced motion: the model is never fetched, and the still is still there. */
async function checkReducedMotion(browser, width) {
  const label = `reduced-motion-${width}`;
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const requested = [];
  page.on('request', (request) => requested.push(request.url()));
  await page.goto(`${SERVER}/welcome`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-fiddy-hero="still"]');
  await page.waitForTimeout(1500);

  check(
    `${label}: the model is never fetched`,
    requested.filter((url) => url.endsWith(GLB)).length === 0,
    requested.filter((url) => url.endsWith(GLB)).join(', '),
  );
  check(
    `${label}: no canvas is created`,
    (await page.locator('[data-fiddy-hero-variant="hero"] canvas').count()) === 0,
  );
  check(
    `${label}: the still is what the visitor sees`,
    await page
      .locator('[data-fiddy-hero-variant="hero"] .fiddy-hero-stage-still')
      .isVisible(),
  );
  // The still is the whole hero here, so it is held to the same measurement the
  // live canvas is: a picture of this model, in this shot, at this scale.
  await compareStageToPoster(
    page,
    page.locator('[data-fiddy-hero-variant="hero"]'),
    label,
  );
  await shot(page, label);
  await context.close();
}

/** No WebGL: the still is what remains, and nothing throws about it. */
async function checkNoWebgl(browser, width) {
  const label = `no-webgl-${width}`;
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
  });
  // The failure every iOS webview and every locked-down desktop can produce:
  // a canvas that answers nothing. The hero must not care.
  await context.addInitScript(() => {
    const real = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
      if (typeof kind === 'string' && kind.includes('webgl')) return null;
      return real.call(this, kind, ...rest);
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`${SERVER}/welcome`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-fiddy-hero-variant="hero"]');
  await page.waitForTimeout(2500);

  check(
    `${label}: the stage stays on the still`,
    (await page
      .locator('[data-fiddy-hero-variant="hero"]')
      .getAttribute('data-fiddy-hero')) === 'still',
  );
  check(
    `${label}: the still is visible, so the box is never empty`,
    await page
      .locator('[data-fiddy-hero-variant="hero"] .fiddy-hero-stage-still')
      .isVisible(),
  );
  // The hard rule: with no WebGL the fallback path must RENDER — a visible
  // image tag is not the same claim as pixels of Fiddy on the page.
  await compareStageToPoster(
    page,
    page.locator('[data-fiddy-hero-variant="hero"]'),
    label,
  );
  check(`${label}: nothing throws`, errors.length === 0, errors.join(' | '));
  await shot(page, label);
  await context.close();
}

/** The name step: the little Fiddy, and the field it must not get in the way of. */
async function checkNameStep(browser, width) {
  const label = `name-step-${width}`;
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
  });
  await context.addInitScript(RESOURCES);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`${SERVER}/welcome/name`, { waitUntil: 'domcontentloaded' });

  const stage = page.locator('[data-fiddy-hero-variant="form"]');
  await page.waitForSelector('[data-fiddy-hero-variant="form"]', {
    timeout: 20000,
  });
  check(`${label}: the little Fiddy is on the name step`, (await stage.count()) === 1);
  await page.waitForFunction(
    () => document.querySelector('[data-fiddy-hero-variant="form"][data-fiddy-hero="moving"]'),
    undefined,
    { timeout: 45000 },
  );

  const layout = await page.evaluate(() => {
    const stage = document.querySelector('[data-fiddy-hero-variant="form"]');
    const field = document.querySelector('.fiddy-field');
    const input = document.querySelector('.fiddy-input');
    const canvas = stage.querySelector('.fiddy-hero-stage-canvas');
    const box = stage.getBoundingClientRect();
    const fieldBox = field.getBoundingClientRect();
    const inputBox = input.getBoundingClientRect();
    return {
      stage: { x: box.x, y: box.y, w: box.width, h: box.height },
      field: { x: fieldBox.x, y: fieldBox.y, w: fieldBox.width, h: fieldBox.height },
      input: { y: inputBox.y, h: inputBox.height },
      canvasPointerEvents: getComputedStyle(canvas).pointerEvents,
      inputPointerEvents: getComputedStyle(input).pointerEvents,
    };
  });

  const beside = layout.stage.x + layout.stage.w <= layout.field.x + 1;
  check(
    `${label}: ${width >= 520 ? 'the model stands beside the field' : 'the model stacks above the field'}`,
    width >= 520 ? beside : !beside,
    JSON.stringify(layout),
  );
  check(
    `${label}: the model never takes the pointer the field needs`,
    layout.canvasPointerEvents === 'none',
    layout.canvasPointerEvents,
  );

  // (10) and the field still works with the model mounted next to it.
  const input = page.locator('.fiddy-input');
  await input.click();
  await input.fill('Pip');
  check(
    `${label}: the name field is still typeable with the model beside it`,
    (await input.inputValue()) === 'Pip',
  );
  check(
    `${label}: the model is small, not a second hero`,
    layout.stage.w <= 120 && layout.stage.h <= 120,
    JSON.stringify(layout.stage),
  );
  await shot(page, label);
  check(`${label}: nothing threw`, errors.length === 0, errors.join(' | '));
  await context.close();
}

const main = async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(POSTER)) {
    console.log(
      JSON.stringify({
        ok: false,
        error: `no poster at ${POSTER} — run scripts/render-hero-poster.mjs first`,
      }),
    );
    process.exit(1);
  }

  // The system Chrome, the same browser the repo's other render script uses.
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    for (const width of WIDTHS) {
      await checkFrontDoor(browser, width);
      await checkReducedMotion(browser, width);
      await checkNoWebgl(browser, width);
      await checkNameStep(browser, width);
    }
  } finally {
    await browser.close();
  }

  console.log(
    JSON.stringify(
      {
        ok: failures.length === 0,
        server: SERVER,
        widths: WIDTHS,
        checks,
        shots,
        failures,
      },
      null,
      1,
    ),
  );
  process.exit(failures.length === 0 ? 0 : 1);
};

main().catch((error) => {
  console.log(
    JSON.stringify({ ok: false, error: String(error?.stack ?? error) }, null, 1),
  );
  process.exit(1);
});