/**
 * What one head poll actually costs, measured against a live read node.
 *
 * Run: node scripts/measure-feed-head.mjs https://crackle.farcaster.xyz:3381 3
 * (kept out of the app: this is a measurement, not a feature)
 *
 * Why the loader below: `packages/farcaster-node-client/dist` is TypeScript
 * output in ESM form with extensionless relative imports (`export * from
 * './appKey'`), which is what Metro and the bundlers the app uses resolve but
 * what Node's own ESM resolver refuses. `createRequire` therefore fails with
 * `ERR_MODULE_NOT_FOUND: .../dist/appKey`. Rather than add a bundler dependency
 * for one script, a resolve hook appends `.js` to a relative specifier that only
 * resolves that way — the same rule the bundler applies, applied by hand.
 *
 * Needs Node >= 22.15 for `module.registerHooks` (this machine runs 26).
 */

import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

if (typeof registerHooks !== 'function') {
  throw new Error(
    `this script needs module.registerHooks (Node >= 22.15); running ${process.version}`,
  );
}

const EXTENSIONS = ['.js', '.mjs', '.cjs', '/index.js'];

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.startsWith('.') || !context.parentURL) {
        throw error;
      }
      for (const extension of EXTENSIONS) {
        // `./appKey` → `./appKey.js`; `./feed` → `./feed/index.js` when it is a
        // directory. Query and hash are not used by this package.
        const candidate = new URL(specifier + extension, context.parentURL);
        if (candidate.protocol === 'file:' && existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, shortCircuit: true };
        }
      }
      throw error;
    }
  },
});

const { SnapchainNodeClient, fetchFollowing, fetchFeedHead } = await import(
  '../packages/farcaster-node-client/dist/index.js'
);

const url = process.argv[2] ?? 'http://34.101.47.167:3381';
const fid = Number(process.argv[3] ?? 3);
const node = new SnapchainNodeClient({ baseUrl: url, timeoutMs: 20_000 });

const time = async (label, run) => {
  const started = Date.now();
  const result = await run();
  console.log(`${label}: ${Date.now() - started}ms`);
  return result;
};

console.log(`node: ${url}, viewer fid: ${fid}`);

const following = await time('follow graph', () =>
  fetchFollowing({ node, fid, limit: 120 }),
);
console.log(`follows: ${following.length}`);

const head = await time('head read (one small page per author)', () =>
  fetchFeedHead({
    node,
    fids: [fid, ...following],
    perAuthor: 2,
    concurrency: 6,
  }),
);

console.log(
  JSON.stringify(
    {
      authors: following.length + 1,
      requests: head.requests,
      unread: head.unread.length,
      casts: head.casts.length,
      newest: head.casts[0]?.timestampMs ?? null,
    },
    null,
    2,
  ),
);

const second = await time('second head read', () =>
  fetchFeedHead({
    node,
    fids: [fid, ...following],
    perAuthor: 2,
    concurrency: 6,
  }),
);
console.log(`second read: ${second.requests} requests, ${second.casts.length} casts`);