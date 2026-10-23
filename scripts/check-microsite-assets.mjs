#!/usr/bin/env node
/**
 * Refuse to deploy the microsite (`site/` -> /var/www/fiddy-client/) when the
 * mini app it launches advertises a picture that this tree cannot back up.
 *
 * WHY THIS EXISTS
 *
 * `/client/` is served from its own directory, outside the client release tree,
 * by a manual `ssh` pipe (docs/CLIENT-MICROSITE-HOSTING.md) — so nothing in
 * `scripts/release-client.sh` ever looks at it, and `site/` had no gate at all.
 * Measured 2026-10-22 (card t_5890479d), what that let through: the "Deploy a
 * Node" mini app's `splashImageUrl` was a 512x512 file on a cream ground, its
 * drawing 28px right of centre, and the drawing was not Fiddy's mark at all but
 * the SIBLING FSSC app's judge-baby — the same art leak card t_90a2eee2 found in
 * the app-list icon and the embed card, on the one surface that paints it over
 * `splashBackgroundColor` at launch. Every one of those is invisible to a check
 * that only asks whether the file exists.
 *
 * So this reads the pages, holds the launch contract to the picture the tree
 * actually carries, and looks INSIDE the splash the way the client's own gate
 * does (`apps/farcaster-web/scripts/check-manifest.mjs`, sharing its reader at
 * apps/farcaster-web/scripts/lib/png.mjs): the size comes from the PNG's own
 * IHDR, the ground from its pixels against the colour the page declares, and
 * the drawing's placement from the same `visibleBox` measurement the renderer
 * crops with — so the picture and the check cannot disagree.
 *
 * It runs from the repo root on the tree about to be uploaded, and in CI on
 * every pull request (`node scripts/check-microsite-assets.mjs`).
 *
 *   node scripts/check-microsite-assets.mjs            # the working tree's site/
 *   node scripts/check-microsite-assets.mjs <site dir> # any copy, e.g. a frozen
 *                                                      # tree extracted from a sha
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  boxCentre,
  decodePng,
  dominantColour,
  hex,
  minAlpha,
  rgbOf,
  visibleBox,
} from '../apps/farcaster-web/scripts/lib/png.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = process.argv[2] ? path.resolve(process.argv[2]) : path.join(repoRoot, 'site');

const refuse = (why) => {
  console.error(`REFUSING to deploy: ${why}`);
  process.exit(1);
};

/** Every `.html` under a directory, repo-relative order irrelevant but stable. */
const htmlFiles = (dir) => {
  const found = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...htmlFiles(full));
    else if (entry.endsWith('.html')) found.push(full);
  }
  return found;
};

let pages;
try {
  pages = htmlFiles(root);
} catch (error) {
  refuse(`the site tree is not readable at ${root} (${error.message})`);
}
if (pages.length === 0) refuse(`${root} carries no page at all`);

// The content of a `<meta>` tag, in either quoting style, with the name and the
// content on the SAME tag (a scan forward from the needle, not a pattern built
// out of it).
const metaContent = (html, attribute, key) => {
  const needle = attribute + '="' + key + '"';
  for (const chunk of html.split('<meta')) {
    if (!chunk.includes(needle)) continue;
    const at = chunk.indexOf('content=');
    if (at < 0) continue;
    const quote = chunk[at + 'content='.length];
    if (quote !== '"' && quote !== "'") continue;
    const from = at + 'content='.length + 1;
    const to = chunk.indexOf(quote, from);
    if (to < 0) continue;
    return chunk.slice(from, to);
  }
  return undefined;
};

/**
 * The URL the page advertises resolves to a file in THIS tree or the deploy
 * ships a launch whose first frame is a 404. `/client/...` is the microsite's
 * own mount point (nginx `location ^~ /client/` aliases it to
 * /var/www/fiddy-client/), so the mapping is the one thing this gate has to
 * know: `/client/<rest>` -> `<site root>/<rest>`, and a trailing slash is
 * `index.html` — the same answer nginx's `try_files $uri $uri/` gives.
 */
const localPathFor = (url, label) => {
  if (url.origin !== 'https://fiddy.fun') {
    refuse(`the ${label} is served from ${url.origin}, not https://fiddy.fun`);
  }
  if (url.pathname === '/client') return path.join(root, 'index.html');
  if (!url.pathname.startsWith('/client/')) {
    refuse(
      `the ${label} is ${url.pathname}, outside this tree's mount point — the microsite deploy only ships /client/`,
    );
  }
  const rest = url.pathname.slice('/client/'.length);
  return path.join(root, rest.endsWith('/') ? `${rest}index.html` : rest);
};

const url = (value, label) => {
  try {
    return new URL(value);
  } catch {
    refuse(`the ${label} is not a URL: ${value}`);
  }
};

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * A picture the page names must be a PNG in this tree at the size the mini app
 * spec asks, read from the PNG's own header so a mis-sized asset cannot pass on
 * its name.
 */
const ownedPng = (value, label, [wantWidth, wantHeight]) => {
  const parsed = url(value, label);
  const file = localPathFor(parsed, label);
  let png;
  try {
    png = readFileSync(file);
  } catch {
    refuse(`the tree carries no ${file} for the ${label} it asks for`);
  }
  if (PNG_MAGIC.some((byte, at) => png[at] !== byte)) {
    refuse(`${file} is not a PNG`);
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width !== wantWidth || height !== wantHeight) {
    refuse(
      `the ${label} is ${width}x${height}; the spec asks ${wantWidth}x${wantHeight}`,
    );
  }
  return { pathname: parsed.pathname, file, width, height, bytes: png };
};

const measured = [];
for (const page of pages) {
  const html = readFileSync(page, 'utf8');
  const raw = metaContent(html, 'name', 'fc:miniapp');
  if (raw === undefined) continue;

  const where = path.relative(repoRoot, page);
  let embed;
  try {
    embed = JSON.parse(raw);
  } catch (error) {
    refuse(`${where} carries an fc:miniapp tag that is not JSON (${error.message})`);
  }
  const action = embed?.button?.action ?? {};
  if (embed?.version !== '1') {
    refuse(`${where}: the mini app version is ${embed?.version}, the spec asks "1"`);
  }
  if (action.type !== 'launch_miniapp') {
    refuse(`${where}: the button's action is ${action.type}, not a launch_miniapp`);
  }
  if (!embed?.button?.title || !action.name) {
    refuse(`${where}: the launch carries no button title or app name`);
  }

  // The launch URL itself must land on a page this tree ships: a mini app whose
  // host page is missing opens onto a 404.
  const launch = localPathFor(url(action.url, 'launch url'), 'launch url');
  if (!launch.startsWith(root + path.sep)) {
    refuse(`${where}: the launch url ${action.url} escapes this tree`);
  }
  try {
    readFileSync(launch);
  } catch {
    refuse(`${where}: the launch url ${action.url} names no page in this tree (${launch})`);
  }

  const splash = ownedPng(action.splashImageUrl, 'splash', [200, 200]);
  const card = ownedPng(embed.imageUrl, 'embed card', [1200, 800]);
  const unfurl = metaContent(html, 'property', 'og:image');
  if (unfurl !== embed.imageUrl) {
    refuse(
      `${where} unfurls ${unfurl} while it launches ${embed.imageUrl} — one mini app, one card`,
    );
  }

  // WHERE the splash's art sits, and on WHAT ground — the defects a header-only
  // check cannot see. Same rules as the client's gate and the same reader:
  // a drawing composited on the colour the page paints behind it, centred on
  // the canvas within a couple of pixels, filling about half the square.
  let ground;
  try {
    ground = rgbOf(action.splashBackgroundColor);
  } catch {
    refuse(
      `${where}: splashBackgroundColor is ${action.splashBackgroundColor}, not a #rrggbb colour`,
    );
  }
  const image = decodePng(splash.bytes);
  const picture = dominantColour(image);
  const transparent = minAlpha(image) < 250;
  const drawn = visibleBox(image, { ground, threshold: 30 });
  if (drawn === null) {
    refuse(`${where}: ${splash.pathname} carries no drawing at all — a blank splash`);
  }
  if (!transparent && hex(picture) !== hex(ground)) {
    refuse(
      `${where}: ${splash.pathname} is drawn on ${hex(picture)} while the page paints ${action.splashBackgroundColor} behind it`,
    );
  }
  const centre = boxCentre(drawn);
  const offBy = Math.max(
    Math.abs(centre.x - splash.width / 2),
    Math.abs(centre.y - splash.height / 2),
  );
  if (offBy > 2) {
    refuse(
      `${where}: ${splash.pathname}'s art is off-centre — its drawing occupies (${drawn.x0},${drawn.y0})-(${drawn.x1},${drawn.y1}), centre (${centre.x},${centre.y}) on a ${splash.width}x${splash.height} canvas whose centre is (${splash.width / 2},${splash.height / 2}), ${offBy}px away — so the launch transition paints the mark in the wrong place`,
    );
  }
  const fills = Math.min(drawn.width / splash.width, drawn.height / splash.height);
  if (fills < 0.3 || fills > 0.8) {
    refuse(
      `${where}: ${splash.pathname}'s drawing fills ${Math.round(fills * 100)}% of the square; a mark takes about half of it`,
    );
  }

  measured.push(
    `${where} launches "${action.name}" -> ${action.url} — splash ${splash.pathname} (${splash.width}x${splash.height} on ${action.splashBackgroundColor}; mark ${drawn.width}x${drawn.height} centred at (${centre.x},${centre.y})), card ${card.pathname} (${card.width}x${card.height})`,
  );
}

if (measured.length === 0) {
  refuse(
    'no page in this tree declares an fc:miniapp — the Deploy a Node mini app would launch with no splash, no card and no button',
  );
}

for (const line of measured) console.log(`  microsite ok  ${line}`);