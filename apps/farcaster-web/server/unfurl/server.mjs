/**
 * fiddy-unfurl: the server that answers a cast or profile URL as itself.
 *
 *   node server.mjs        (loopback only; nginx is the only caller)
 *
 * It ships inside the client release (`release/server/unfurl/`) and runs from
 * `current`, so the shell it serves and the shell nginx serves are the same
 * bytes from the same release — a page and its metadata cannot drift apart.
 *
 * Everything with a decision in it lives in `handler.mjs`; this file is wiring:
 * read the environment, load the release's own assets, listen, and log.
 *
 * ENVIRONMENT
 *   PORT                  default 3220 (loopback)
 *   FIDDY_WEB_ROOT        the release's web root; default ../../web
 *   FIDDY_SHELL           the shell to answer with; default <web root>/index.html
 *   FIDDY_ORIGIN          the public origin in the tags; default https://fiddy.fun
 *   SNAPCHAIN_HTTP_URL    the node the reads go to
 *   NEYNAR_API_KEY        the cast-hash -> author index. Without it a cast page
 *                         still answers, as the shell: nothing is invented.
 *   PYTHON                default python3, running render-card.py
 *   READ_TIMEOUT_MS       default 8000, for every upstream read
 *   FIDDY_LOOKS_DIR       where shared looks are kept (see looks.mjs). Absent
 *                         means this host stores none: a look it already holds
 *                         still renders, and a share request refuses in one
 *                         sentence rather than failing silently.
 */

import { statSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCardRenderer } from './cards.mjs';
import { createLookStore, LOOK_LIMITS } from './looks.mjs';
import { createUnfurlHandler } from './handler.mjs';
import { createLinkReader } from './reader.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot =
  process.env.FIDDY_WEB_ROOT ?? path.resolve(here, '..', '..', 'web');
const shellPath = process.env.FIDDY_SHELL ?? path.join(webRoot, 'index.html');
const siteCardPath = path.join(webRoot, 'fiddy-share-card.png');
const mascotPath = path.join(webRoot, 'fiddy-mark-poster.png');
const port = Number(process.env.PORT ?? 3220);
const host = process.env.HOST ?? '127.0.0.1';
const timeoutMs = Number(process.env.READ_TIMEOUT_MS ?? 8000);

/**
 * The shell, re-read when it changes on disk.
 *
 * A release cuts `current` to a new directory: a service that cached the shell
 * at boot would answer with the previous release's document, whose entry chunk
 * no longer exists. The release restarts this service, and this is what keeps
 * that from being the only thing standing between a release and a 404 — the
 * check is a `stat` at most once every 30 seconds, not per request.
 */
const shellState = { html: undefined, mtimeMs: 0, checkedAt: 0 };
const loadShell = () => {
  const now = Date.now();
  if (shellState.html !== undefined && now - shellState.checkedAt < 30_000) {
    return shellState.html;
  }
  const stat = statSync(shellPath);
  if (shellState.html === undefined || stat.mtimeMs !== shellState.mtimeMs) {
    shellState.html = readFileSync(shellPath, 'utf8');
    shellState.mtimeMs = stat.mtimeMs;
  }
  shellState.checkedAt = now;
  return shellState.html;
};

const siteCardState = { bytes: undefined, checkedAt: 0 };
const loadSiteCard = () => {
  const now = Date.now();
  if (siteCardState.bytes && now - siteCardState.checkedAt < 30_000) {
    return siteCardState.bytes;
  }
  try {
    siteCardState.bytes = readFileSync(siteCardPath);
  } catch {
    siteCardState.bytes = undefined;
  }
  siteCardState.checkedAt = now;
  return siteCardState.bytes;
};

// A service that cannot find the shell it ships with is not a service that can
// answer anything: refuse to start rather than serve a document from nowhere.
loadShell();

const reader = createLinkReader({
  fetchImpl: (...args) => fetch(...args),
  nodeBaseUrl: process.env.SNAPCHAIN_HTTP_URL ?? 'https://haatz.quilibrium.com',
  neynarApiKey: process.env.NEYNAR_API_KEY,
  timeoutMs,
});

const renderCard = createCardRenderer({
  pythonPath: process.env.PYTHON ?? 'python3',
  scriptPath: path.join(here, 'render-card.py'),
  mascotPath,
}).render;

const looksDir = process.env.FIDDY_LOOKS_DIR;
const looks = looksDir ? createLookStore({ dir: looksDir }) : undefined;

const handler = createUnfurlHandler({
  origin: process.env.FIDDY_ORIGIN ?? 'https://fiddy.fun',
  shellSource: loadShell,
  siteCard: loadSiteCard,
  renderCard,
  reader,
  looks,
});

/**
 * A request body, read up to a cap and no further.
 *
 * The only body this service accepts is a look (`POST /look`), so the cap is
 * the model's own (`LOOK_LIMITS.bytes`): a body that is already too large is
 * refused without being read into this process at all. Anything else with a
 * body is not ours, and the handler answers 405 for it.
 */
const readBody = (request, limit) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });

const server = createServer(async (request, response) => {
  const path = request.url ?? '/';
  let answer;
  try {
    const method = request.method ?? 'GET';
    // Only a share POST has a body worth reading; everything else is answered
    // without one, exactly as before.
    const body =
      method === 'POST' && path.split('?')[0] === '/look'
        ? await readBody(request, LOOK_LIMITS.bytes).catch(() =>
            // A body that ran past the cap is answered by the model's own size
            // check rather than by a second sentence invented here: what
            // arrives is a string longer than a look can be, which is exactly
            // one over-limit body. (`readBody` has already stopped reading it.)
            ' '.repeat(LOOK_LIMITS.bytes + 1),
          )
        : undefined;
    answer = await handler.handle({ method, path, body });
  } catch (error) {
    // Nothing a request can do should reach here; if something does, the answer
    // is still the app rather than a stack trace in a crawler's face.
    process.stderr.write(`unfurl: ${path} failed: ${error?.stack ?? error}\n`);
    answer = {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: 'unfurl failed\n',
    };
  }
  response.writeHead(answer.status, answer.headers);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  response.end(answer.body);
  const note = answer.headers['x-unfurl'] ?? '-';
  // A card on the fallback path says WHY in the same line the service logs, so
  // the host's log answers the question a refused release used to leave open.
  const cause = answer.headers['x-unfurl-note'];
  process.stdout.write(
    `${request.method} ${path} ${answer.status} ${note}${cause ? ` (${cause})` : ''}\n`,
  );
});

server.listen(port, host, () => {
  process.stdout.write(
    `fiddy-unfurl on ${host}:${port} | shell ${shellPath} (${loadShell().length} bytes) | ` +
      `site card ${loadSiteCard() ? 'yes' : 'NO'} | node ${process.env.SNAPCHAIN_HTTP_URL ?? 'https://haatz.quilibrium.com'} | ` +
      `cast-hash index ${process.env.NEYNAR_API_KEY ? 'keyed' : 'unconfigured'}\n`,
  );
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
