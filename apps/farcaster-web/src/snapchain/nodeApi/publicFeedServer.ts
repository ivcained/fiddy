/**
 * The server-side entry for the server-drawn `/feed` page.
 *
 * This file exists to be BUNDLED (scripts/build-public-feed-server.mjs) into
 * `server/public-feed/generated/reader.mjs`; the release builds it and the
 * unfurl service imports the bundle. It deliberately contains no second feed
 * definition: it constructs the client's own `NodeBackedReads` against the
 * same node the release names, which means handle anchors, bounded fan-out,
 * root-cast filtering, timestamps and engagement ranking all keep the public
 * window's exact semantics.
 *
 * The embed probes are deliberately offline here. A public first paint must
 * not fan out to arbitrary embed hosts; unclassified URLs simply stay links,
 * exactly as they do in the browser before its own probes answer.
 */

import { SnapchainNodeClient } from 'farcaster-node-client';

import { createEmbedCardResolver } from './embedCards';
import { createEmbedKindResolver } from './embedKinds';
import { NodeBackedReads } from './reads';

const offlineProbe: typeof fetch = (async () => {
  throw new TypeError('the server public feed does not probe embeds');
}) as typeof fetch;

/** Embed questions the server public feed refuses to ask off the node. */
const offlineEmbedResolvers = () => ({
  embedKinds: createEmbedKindResolver({
    storage: null,
    imageProbe: async () => undefined,
    fetchImpl: offlineProbe,
    probeTimeoutMs: 100,
  }),
  embedCards: createEmbedCardResolver({
    storage: null,
    fetchImpl: offlineProbe,
    timeoutMs: 100,
    waitMs: 20,
  }),
});

export const createPublicFeedServerReader = ({
  nodeBaseUrl,
  fetchImpl = fetch,
  timeoutMs = 8_000,
}: {
  nodeBaseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}) => {
  // Every read gets its own hard deadline, independent of the page cache's
  // overall budget: a stuck socket cannot hold a refresh open forever.
  const withTimeout: typeof fetch = (async (input, init = {}) =>
    fetchImpl(input, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    })) as typeof fetch;

  const embeds = offlineEmbedResolvers();
  const reader = new NodeBackedReads({
    node: new SnapchainNodeClient({
      baseUrl: nodeBaseUrl,
      fetch: withTimeout as never,
    }),
    nodeBaseUrl,
    fetchImpl: withTimeout,
    getSignedInFid: () => undefined,
    embedKinds: embeds.embedKinds,
    embedCards: embeds.embedCards,
  });

  return {
    readPublicFeed: reader.readPublicFeed.bind(reader),
  };
};
