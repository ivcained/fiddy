/**
 * What one head poll actually costs, measured against a live read node.
 *
 * Run: pnpm --filter fiddy-mobile exec node ../../scripts/measure-feed-head.mjs <node> <fid>
 * (kept out of the app: this is a measurement, not a feature)
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SnapchainNodeClient, fetchFeedHead, fetchFollowing } = require(
  '../packages/farcaster-node-client/dist/index.js',
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