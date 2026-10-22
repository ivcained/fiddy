#!/usr/bin/env node
/**
 * Refuse to release a build whose app-list manifest is unsigned, mis-sized, or
 * describes a different product than the shell it ships with.
 *
 * WHY THIS IS A RELEASE GATE AND NOT ONLY A TEST
 *
 * `/.well-known/farcaster.json` is Fiddy's listing identity: the signed
 * per-domain manifest a Farcaster client reads to list, search and notify this
 * app. The vhost serves it from `/var/www/fiddy-well-known/farcaster.json`, and
 * the repo's copy under `public/.well-known/` is what `release-client.sh`
 * installs there — so a release is the thing that changes the listing, and a
 * release is where it has to be checked. Measured 2026-10-22 (card t_8654d91e):
 * the served manifest asked for a 512x512 splash (the spec asks 200x200),
 * painted the splash in upstream Warpcast purple (#6200EA) while the app's
 * ground is #161715, and advertised "deploy always on agents with onchain
 * identities" — a different product than the one `index.html` unfurls as.
 *
 * This checks the BUILT tree (dist/), not the sources: what must be right is
 * what ships. It reads the PNG's own header for the splash size, so a
 * mis-sized asset cannot pass on its name. It never touches the signature: the
 * domain association is the owner's cryptographic approval — carried through
 * unchanged, never regenerated.
 *
 *   node scripts/check-manifest.mjs <built web root>    # e.g. apps/farcaster-web/dist
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('usage: check-manifest.mjs <built web root>');
  process.exit(2);
}

const refuse = (why) => {
  console.error(`REFUSING to ship: ${why}`);
  process.exit(1);
};

const read = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return refuse(`${file} is missing from the build`);
  }
};

let manifest;
try {
  manifest = JSON.parse(read(path.join(root, '.well-known', 'farcaster.json')));
} catch (error) {
  refuse(`the manifest is not JSON (${error.message})`);
}

const association = manifest.accountAssociation ?? {};
if (!association.header || !association.payload) {
  refuse('the manifest carries no account association');
}
if (
  typeof association.signature !== 'string' ||
  association.signature.length < 64
) {
  refuse(
    'the manifest association is unsigned — an unsigned manifest cannot be listed',
  );
}

const app = manifest.miniapp ?? {};
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;
if (app.version !== '1')
  refuse(`manifest version is ${app.version}, the spec asks "1"`);
if (!app.name || app.name.length > 32)
  refuse('manifest name is missing or over 32 characters');
if (!/^https:\/\//.test(app.homeUrl ?? ''))
  refuse('manifest homeUrl is not absolute https');
if (!/^https:\/\//.test(app.iconUrl ?? ''))
  refuse('manifest iconUrl is not absolute https');
if (!app.description || app.description.length > 170) {
  refuse('manifest description is missing or over 170 characters');
}
if (!PRINTABLE_ASCII.test(app.description)) {
  refuse('manifest description carries an emoji or a special character');
}
if (app.subtitle && app.subtitle.length > 30)
  refuse('manifest subtitle is over 30 characters');
if (app.tagline && app.tagline.length > 30)
  refuse('manifest tagline is over 30 characters');
if (Array.isArray(app.tags) && app.tags.length > 5)
  refuse('manifest carries more than 5 tags');
if (
  !Array.isArray(app.tags) ||
  app.tags.some((tag) => !/^[a-z0-9-]+$/.test(tag))
) {
  refuse('manifest tags are not lowercase, single-word values');
}

// The link and the listing are the same app or they are broken: `index.html` is
// what a shared URL unfurls as, the manifest is what the app list shows.
const shell = read(path.join(root, 'index.html'));
const metaContent = (attribute, key) => {
  const tag = new RegExp(
    `<meta\\s+${attribute}="${key}"\\s+content=(?:"([^"]*)"|'([^']*)')`,
  ).exec(shell);
  return tag?.[1] ?? tag?.[2];
};

let embed;
try {
  embed = JSON.parse(metaContent('name', 'fc:miniapp') ?? 'null');
} catch {
  refuse('the shell carries an fc:miniapp tag that is not JSON');
}
const action = embed?.button?.action ?? {};
if (action.name !== app.name) {
  refuse(
    `the shell launches "${action.name}" while the listing is named "${app.name}"`,
  );
}
if (action.splashImageUrl !== app.splashImageUrl) {
  refuse(
    `the shell's splash is ${action.splashImageUrl} and the listing's is ${app.splashImageUrl}`,
  );
}
if (action.splashBackgroundColor !== app.splashBackgroundColor) {
  refuse(
    `the splash colour disagrees: shell ${action.splashBackgroundColor}, listing ${app.splashBackgroundColor}`,
  );
}
if (metaContent('property', 'og:description') !== app.description) {
  refuse(
    'the unfurl sentence and the listing description are not the same sentence',
  );
}

// The splash is painted before any of our code runs, so it must be an asset
// this repo owns — a URL the host aliases into another app's asset directory is
// another product's art waiting to happen.
let splashUrl;
try {
  splashUrl = new URL(app.splashImageUrl);
} catch {
  refuse(`the splash URL is not a URL: ${app.splashImageUrl}`);
}
const splash = path.join(root, splashUrl.pathname);
let png;
try {
  png = readFileSync(splash);
} catch {
  refuse(
    `the build carries no ${splashUrl.pathname} for the splash it asks for`,
  );
}
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
if (PNG_MAGIC.some((byte, at) => png[at] !== byte)) {
  refuse(`${splash} is not a PNG`);
}
const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);
if (width !== 200 || height !== 200) {
  refuse(`the splash is ${width}x${height}; the spec asks 200x200`);
}

console.log(
  `  manifest ok  ${app.name} "${app.description}" — signed, splash ${app.splashImageUrl} (${width}x${height} on ${app.splashBackgroundColor}), shell and listing agree`,
);
