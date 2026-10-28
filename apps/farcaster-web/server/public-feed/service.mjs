/**
 * The service half of the server-drawn `/feed` page: the client's own public
 * window reader (`../generated/reader.mjs`, built from `publicFeedServer.ts`)
 * behind the bounded stale-while-refresh cache. No ranking, anchors or limits
 * are decided here.
 */
import { createPublicFeedCache } from './cache.mjs';
import { createPublicFeedServerReader } from './generated/reader.mjs';

export const PUBLIC_FEED_PAGE_LIMIT = 20;

export const createPublicFeedService = ({
  nodeBaseUrl,
  fetchImpl = (...args) => fetch(...args),
  readTimeoutMs = 8_000,
  ttlMs = 60_000,
  staleMs = 5 * 60_000,
  waitMs = 2_000,
  timeoutMs = 10_000,
  now = () => Date.now(),
}) => {
  const reader = createPublicFeedServerReader({
    nodeBaseUrl,
    fetchImpl,
    timeoutMs: readTimeoutMs,
  });

  return createPublicFeedCache({
    load: () =>
      reader.readPublicFeed({ kind: 'recent', limit: PUBLIC_FEED_PAGE_LIMIT }),
    ttlMs,
    staleMs,
    waitMs,
    timeoutMs,
    now,
  });
};
