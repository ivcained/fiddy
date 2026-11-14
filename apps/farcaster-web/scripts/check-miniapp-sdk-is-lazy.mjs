/**
 * The Mini App SDK has to stay a lazy import, and this is what says so.
 *
 * WHY IT IS A GATE AND NOT A HABIT
 * `@farcaster/miniapp-sdk` is ~650 kB of code that only does anything inside a
 * Farcaster client's webview or iframe. Every ordinary web visitor who opens
 * fiddy.fun would download it for nothing, so it is imported inside a function
 * (`src/lib/miniappHostSdk.ts`) rather than at module load. That is one careless
 * `import` away from being false, and the mistake is invisible in the source:
 * the diff that breaks it is a single line that looks like the others.
 *
 * HOW IT IS CHECKED
 * Grepping the minified output for the package name does not work (nothing in
 * the bundle carries it) and grepping for a string from the SDK's dependencies
 * finds `@farcaster/miniapp-core`, which the client legitimately imports. So
 * this reads what the build already writes next to each chunk: the source map's
 * `sources`, which name the real files. The SDK's own modules
 * (`@farcaster/miniapp-sdk/dist/*.js`) must appear in exactly ONE chunk, and
 * that chunk must not be one `index.html` loads up front. Everything else about
 * the bundle — sizes, hashes, chunk names — is free to change.
 *
 * WHAT IT ALSO REPORTS
 * The entry chunk's size, because a lazy bundle that quietly pulls the SDK into
 * the entry chunk through a barrel file is the other way this goes wrong, and a
 * number next to the last release is what makes that visible.
 *
 * Run after `pnpm build`:
 *   node scripts/check-miniapp-sdk-is-lazy.mjs [dist dir, default ./dist]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SDK_SOURCE = 'node_modules/@farcaster/miniapp-sdk/';

const failures = [];
const fail = (what) => failures.push(what);

const distDir = resolve(process.argv[2] ?? 'dist');
const assetsDir = join(distDir, 'assets');

let indexHtml;
try {
  indexHtml = readFileSync(join(distDir, 'index.html'), 'utf8');
} catch {
  console.error(
    `No build to check: ${join(distDir, 'index.html')} is not there.`,
  );
  console.error(
    'Run `pnpm build` first — this gate reads the build, not the source.',
  );
  process.exit(2);
}

/** Every chunk the document loads before anything else: the entry and its own. */
const upfront = new Set(
  Array.from(
    indexHtml.matchAll(/assets\/([A-Za-z0-9_.-]+\.js)/g),
    (match) => match[1],
  ),
);

const chunks = readdirSync(assetsDir).filter((name) => name.endsWith('.js'));

/** The chunk names whose source map lists the SDK's own files. */
const sdkChunks = [];
const missingMaps = [];
let entryBytes = null;

for (const chunk of chunks) {
  const mapPath = join(assetsDir, `${chunk}.map`);

  let map;
  try {
    map = JSON.parse(readFileSync(mapPath, 'utf8'));
  } catch {
    missingMaps.push(chunk);
    continue;
  }

  const sources = Array.isArray(map.sources) ? map.sources : [];
  if (sources.some((source) => String(source).includes(SDK_SOURCE))) {
    sdkChunks.push({ chunk, upfront: upfront.has(chunk) });
  }
}

// The entry chunk is the one `index.html` executes as a module; the preloaded
// vendor chunks beside it are its statics. Reporting the entry alone is enough
// to spot a regression, and it is the number that moved when this landed.
const entryMatch = indexHtml.match(
  /<script[^>]+type="module"[^>]+src="\/?assets\/([A-Za-z0-9_.-]+\.js)"/,
);
const entryChunk = entryMatch?.[1] ?? null;
if (entryChunk) {
  entryBytes = statSync(join(assetsDir, entryChunk)).size;
} else {
  fail(
    'the build has no module entry in index.html, so there is nothing to check',
  );
}

if (missingMaps.length > 0) {
  // Source maps are how this gate sees the real module graph. A build without
  // them cannot be checked, and an unchecked bundle is the thing this exists to
  // prevent — so it is a failure, not a warning.
  fail(
    `${missingMaps.length} chunk(s) ship without a source map, so the module graph cannot be read (${missingMaps
      .slice(0, 3)
      .join(', ')})`,
  );
}

if (sdkChunks.length === 0) {
  fail(
    'the Mini App SDK is in no chunk at all: either it was dropped from the client (which breaks the mini app) or the maps are wrong',
  );
} else {
  if (sdkChunks.length > 1) {
    fail(
      `the Mini App SDK is split across ${sdkChunks.length} chunks (${sdkChunks
        .map((found) => found.chunk)
        .join(', ')}) — one lazy chunk is the whole point`,
    );
  }

  const eager = sdkChunks.filter((found) => found.upfront);
  if (eager.length > 0) {
    fail(
      `the Mini App SDK is loaded up front by index.html through ${eager
        .map((found) => found.chunk)
        .join(
          ', ',
        )} — an ordinary web visitor pays ~650 kB for code they cannot use`,
    );
  }
}

if (failures.length > 0) {
  console.error('REFUSING: the Mini App SDK is not lazy in this build.');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log(
  `ok  the Mini App SDK is one lazy chunk, outside index.html's upfront graph`,
);
console.log(
  `    sdk chunk: ${sdkChunks[0].chunk}  entry chunk: ${entryChunk} (${
    entryBytes === null ? 'unknown' : `${(entryBytes / 1024).toFixed(1)} kB`
  })`,
);
