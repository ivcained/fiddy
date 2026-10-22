#!/usr/bin/env node
/**
 * Refuse to deploy the microsite (`site/` -> /var/www/fiddy-client/) when a page
 * in it advertises a picture this tree cannot back up — the mini app's launch
 * splash and card, and the card a shared link unfurls with.
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
 * THE OTHER HALF: THE CARD A SHARED LINK UNFURLS WITH
 *
 * A launch is not the only way this tree's pages are seen. Measured 2026-10-22
 * (card t_d4a88ae2), `site/index.html` -> /client and `site/zh/index.html` ->
 * /client/zh/ declared `og:title`, `og:description` and `og:url` and NO
 * `og:image` — no `twitter:card`, no `twitter:image` either — so
 * `https://fiddy.fun/client`, the URL the README, docs/SPEC.md and `bin/fiddy`
 * all point at, unfurled as bare text on the one surface most likely to be
 * pasted by a human, while every other Fiddy surface carried a card it owned.
 *
 * That is the same defect one layer out, and it needs the same reading: a page
 * that says what a shared link looks like must name a picture THIS tree really
 * carries, at the size the page states and the file's own header proves, must
 * say the same thing to every crawler (`twitter:image` == `og:image`,
 * `rel=canonical` == `og:url` == the address the page actually answers at),
 * must describe the picture for a reader who cannot see it (`og:image:alt`),
 * and must not be a picture-shaped hole (a flat rectangle passes any check that
 * only reads headers). A page with no unfurl card at all is refused too: this
 * tree exists to be shared, so every page it serves says what a shared link is.
 *
 * The two halves are one rule from two directions: *a page may not advertise a
 * picture nobody can back up.*
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

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const root = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(repoRoot, 'site');

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
  if (url.origin !== ORIGIN) {
    refuse(`the ${label} is served from ${url.origin}, not ${ORIGIN}`);
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

/** The href of a `<link rel="...">`, in either quoting style, read the same way. */
const linkHref = (html, rel) => {
  const needle = `rel="${rel}"`;
  for (const chunk of html.split('<link')) {
    if (!chunk.includes(needle)) continue;
    const at = chunk.indexOf('href=');
    if (at < 0) continue;
    const quote = chunk[at + 'href='.length];
    if (quote !== '"' && quote !== "'") continue;
    const from = at + 'href='.length + 1;
    const to = chunk.indexOf(quote, from);
    if (to < 0) continue;
    return chunk.slice(from, to);
  }
  return undefined;
};

/** The one origin every URL in this tree is advertised from. */
const ORIGIN = 'https://fiddy.fun';

/**
 * The address a page ANSWERS at, derived from where it sits in the tree — the
 * inverse of `localPathFor`, and the same mapping nginx gives (`/client` for the
 * root page, a directory URL for a page inside a directory). A page whose
 * `og:url` disagrees with this one tells a crawler that a link to /client/zh/ is
 * really /client, or the other way round, and a platform that honours it
 * rewrites the link a human pasted.
 */
const servedUrlFor = (file) => {
  const rel = path.relative(root, file).split(path.sep).join('/');
  if (rel === 'index.html') return '/client';
  if (rel.endsWith('/index.html'))
    return `/client/${rel.slice(0, -'index.html'.length)}`;
  return `/client/${rel}`;
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

/**
 * The half of the rule that a crawler sees: the card a shared link unfurls with.
 * It runs on every page (see the header) and returns the line this run prints.
 *
 * Nothing here is a style opinion — each refusal is a claim the page makes that
 * this tree cannot back up:
 *
 *   * a page that says nothing about a shared link at all (the defect that put
 *     this half here: /client and /client/zh/ unfurled as bare text);
 *   * a page missing one of the four tags a card is made of;
 *   * an `og:url` that is not the address the page answers at, or a
 *     `rel=canonical` that disagrees with it — a platform that honours the
 *     wrong one rewrites the link a human pasted;
 *   * an `og:image` this tree does not carry, or is not a PNG;
 *   * an `og:image` with no stated size, or a stated size the file's own header
 *     contradicts (the mini app half's rule, one layer out: the size comes from
 *     the bytes, not from the claim);
 *   * an `og:image` with no alt text — the picture is the one thing a reader who
 *     cannot see it gets nothing from;
 *   * `twitter:image` naming a different picture than `og:image`, or
 *     `twitter:card` asking for a thumbnail (this is a wide card);
 *   * a picture that is a flat rectangle: a header check passes a blank file,
 *     and a blank file is what an unfurl shows as a picture-shaped hole.
 */
const readUnfurl = (page, html) => {
  const where = path.relative(repoRoot, page);
  const own = `${ORIGIN}${servedUrlFor(page)}`;
  const title = metaContent(html, 'property', 'og:title');
  const description = metaContent(html, 'property', 'og:description');
  const declared = metaContent(html, 'property', 'og:url');
  const image = metaContent(html, 'property', 'og:image');
  const alt = metaContent(html, 'property', 'og:image:alt');
  const statedWidth = metaContent(html, 'property', 'og:image:width');
  const statedHeight = metaContent(html, 'property', 'og:image:height');
  const canonical = linkHref(html, 'canonical');
  const twitterCard = metaContent(html, 'name', 'twitter:card');
  const twitterTitle = metaContent(html, 'name', 'twitter:title');
  const twitterDescription = metaContent(html, 'name', 'twitter:description');
  const twitterImage = metaContent(html, 'name', 'twitter:image');

  if (
    [title, description, declared, image].every((value) => value === undefined)
  ) {
    refuse(
      `${where} declares no og: tags at all — a shared ${own} unfurls as bare text`,
    );
  }
  const claims = [
    ['og:title', title],
    ['og:description', description],
    ['og:url', declared],
    ['og:image', image],
  ];
  for (const [label, value] of claims) {
    if (value === undefined) {
      refuse(
        `${where} carries an unfurl card with no ${label} — a shared ${own} would unfurl with that line blank`,
      );
    }
  }
  if (declared !== own) {
    refuse(
      `${where} declares og:url ${declared} while it answers at ${own} — a platform that honours it rewrites the pasted link`,
    );
  }
  if (canonical !== declared) {
    refuse(
      `${where}: rel=canonical is ${canonical ?? 'absent'} while og:url is ${declared} — one page, one address`,
    );
  }

  // The picture itself, and the size the page claims for it.
  const label = `og:image in ${where}`;
  const parsed = url(image, label);
  const file = localPathFor(parsed, label);
  let png;
  try {
    png = readFileSync(file);
  } catch {
    refuse(
      `${where} unfurls ${parsed.pathname}, which this tree does not carry (${file})`,
    );
  }
  if (PNG_MAGIC.some((byte, at) => png[at] !== byte)) {
    refuse(`${where} unfurls ${parsed.pathname}, which is not a PNG`);
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (statedWidth === undefined || statedHeight === undefined) {
    refuse(
      `${where} unfurls ${parsed.pathname} with no og:image:width/og:image:height — a card with no stated size is a card no platform can lay out and nothing here can back up`,
    );
  }
  if (!/^\d+$/.test(statedWidth) || !/^\d+$/.test(statedHeight)) {
    refuse(
      `${where}: og:image:width/height state "${statedWidth}"/"${statedHeight}", not pixel counts`,
    );
  }
  if (Number(statedWidth) !== width || Number(statedHeight) !== height) {
    refuse(
      `${where}: og:image:width/height state ${statedWidth}x${statedHeight} while ${parsed.pathname} is ${width}x${height}`,
    );
  }
  if (alt === undefined || alt.trim() === '') {
    refuse(
      `${where} unfurls ${parsed.pathname} with no og:image:alt — the picture is the one part of the card a reader who cannot see it gets nothing from`,
    );
  }

  // One page, one card: X's own tags must name the same picture the og pair does.
  if (twitterCard !== 'summary_large_image') {
    refuse(
      `${where}: twitter:card is ${twitterCard ?? 'absent'}, not summary_large_image — a wide card asked for as a thumbnail`,
    );
  }
  if (twitterImage !== image) {
    refuse(
      `${where} unfurls ${twitterImage ?? 'nothing'} on X while og:image is ${image} — one page, one card`,
    );
  }
  if (twitterTitle === undefined || twitterDescription === undefined) {
    refuse(
      `${where} carries twitter:card with no twitter:title/twitter:description — X would print the card with an empty line beside it`,
    );
  }

  // And look INSIDE it: a flat rectangle passes every check above.
  const picture = decodePng(png);
  const ground = dominantColour(picture);
  const drawn = visibleBox(picture, { ground });
  if (drawn === null) {
    refuse(
      `${where} unfurls ${parsed.pathname}, which is a flat ${hex(ground)} rectangle — an unfurl shows a picture-shaped hole`,
    );
  }

  return `${where} unfurls ${own} — card ${parsed.pathname} (${width}x${height} on ${hex(ground)}, drawing ${drawn.width}x${drawn.height}, alt "${alt}")`;
};

const measured = [];
const unfurls = [];
for (const page of pages) {
  const html = readFileSync(page, 'utf8');
  unfurls.push(readUnfurl(page, html));

  const raw = metaContent(html, 'name', 'fc:miniapp');
  if (raw === undefined) continue;

  const where = path.relative(repoRoot, page);
  let embed;
  try {
    embed = JSON.parse(raw);
  } catch (error) {
    refuse(
      `${where} carries an fc:miniapp tag that is not JSON (${error.message})`,
    );
  }
  const action = embed?.button?.action ?? {};
  if (embed?.version !== '1') {
    refuse(
      `${where}: the mini app version is ${embed?.version}, the spec asks "1"`,
    );
  }
  if (action.type !== 'launch_miniapp') {
    refuse(
      `${where}: the button's action is ${action.type}, not a launch_miniapp`,
    );
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
    refuse(
      `${where}: the launch url ${action.url} names no page in this tree (${launch})`,
    );
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
    refuse(
      `${where}: ${splash.pathname} carries no drawing at all — a blank splash`,
    );
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
  const fills = Math.min(
    drawn.width / splash.width,
    drawn.height / splash.height,
  );
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

// Every page got a card (readUnfurl refuses a page without one), so this half's
// tree-level assertion is that there was a page to check at all — which the top
// of the file already holds.
for (const line of unfurls) console.log(`  unfurl ok    ${line}`);
for (const line of measured) console.log(`  microsite ok ${line}`);
