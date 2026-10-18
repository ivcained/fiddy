/**
 * Feeds built from your own node's reads.
 *
 * A read node has no "home feed" endpoint — that is an indexer's job, and not
 * having one is the price of not asking anyone's permission. What the node does
 * have is everything needed to build one locally:
 *
 *   1. `GET /v1/linksByFid?fid=<you>&link_type=follow` — who you follow;
 *   2. `GET /v1/castsByFid?fid=<them>` — their casts, newest first;
 *   3. merge on the Farcaster timestamp, de-duplicate, cap.
 *
 * Both reads are paged with `nextPageToken`, and the fan-out is bounded so a
 * few hundred follows do not become a few hundred sockets at once.
 */

import type { SnapchainNodeClient } from './http';
import type { NodeMessage } from './types';

export interface FetchFollowingOptions {
  node: SnapchainNodeClient;
  fid: number;
  /** Stop after this many follows. */
  limit?: number;
  pageSize?: number;
  /** Protocol link type; `follow` is the follow graph. */
  linkType?: string;
}

/** The FIDs this account follows, read straight from its own node. */
export const fetchFollowing = async ({
  node,
  fid,
  limit = 500,
  pageSize = 100,
  linkType = 'follow',
}: FetchFollowingOptions): Promise<number[]> => {
  const following: number[] = [];
  let pageToken: string | undefined;
  do {
    const page = await node.linksByFid({ fid, linkType, pageSize, pageToken });
    for (const message of page.messages) {
      const targetFid = message.link?.targetFid;
      if (typeof targetFid === 'number') {
        following.push(targetFid);
      }
    }
    pageToken = page.nextPageToken;
  } while (pageToken && following.length < limit);

  return [...new Set(following)].slice(0, limit);
};

export interface FetchCastsOptions {
  node: SnapchainNodeClient;
  fid: number;
  limit?: number;
  pageSize?: number;
}

/** One FID's own casts, newest first. */
export const fetchCastsByFid = async ({
  node,
  fid,
  limit = 25,
  pageSize,
}: FetchCastsOptions): Promise<NodeMessage[]> => {
  const page = await node.castsByFid({
    fid,
    pageSize: pageSize ?? Math.max(limit, 25),
  });
  return page.messages
    .filter((message) => message.castAdd)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
};

/** Run `worker` over `items` with a bounded number in flight. */
export const mapWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.max(1, Math.min(concurrency, items.length)))
    .fill(undefined)
    .map(async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(items[index]);
      }
    });
  await Promise.all(runners);
  return results;
};

export interface FollowingFeedOptions {
  node: SnapchainNodeClient;
  fid: number;
  /** Total casts to return. */
  limit?: number;
  /** How many follows to read. */
  followingLimit?: number;
  /** Casts fetched per followed account. */
  castsPerAccount?: number;
  /** Parallel `castsByFid` reads. */
  concurrency?: number;
  /** Include your own casts in the feed. */
  includeSelf?: boolean;
  /** Called after the follow graph is read, for progress UI. */
  onFollowing?: (following: number[]) => void;
}

/**
 * A home feed assembled on the client from your node: follow graph, their
 * casts, merged by timestamp. No third-party indexer, no API key.
 */
export const fetchFollowingFeed = async ({
  node,
  fid,
  limit = 50,
  followingLimit = 150,
  castsPerAccount = 10,
  concurrency = 6,
  includeSelf = true,
  onFollowing,
}: FollowingFeedOptions): Promise<NodeMessage[]> => {
  const following = await fetchFollowing({ node, fid, limit: followingLimit });
  onFollowing?.(following);

  const fids = includeSelf ? [fid, ...following] : following;
  const perAccount = await mapWithConcurrency(
    fids,
    concurrency,
    async (authorFid) => {
      try {
        return await fetchCastsByFid({
          node,
          fid: authorFid,
          limit: castsPerAccount,
        });
      } catch {
        // One unreachable author must not blank the feed.
        return [] as NodeMessage[];
      }
    },
  );

  const byHash = new Map<string, NodeMessage>();
  for (const cast of perAccount.flat()) {
    byHash.set(`${cast.fid}:${cast.hash}`, cast);
  }

  return [...byHash.values()]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
};

export interface ThreadOptions {
  node: SnapchainNodeClient;
  /** The addressing pair: parent author + cast hash, or a channel URL. */
  parentCastId?: { fid: number; hash: string };
  parentUrl?: string;
  limit?: number;
}

/** Replies to a cast (or casts in a channel) straight from the node. */
export const fetchReplies = async ({
  node,
  parentCastId,
  parentUrl,
  limit = 50,
}: ThreadOptions): Promise<NodeMessage[]> => {
  const page = await node.castsByParent({
    ...(parentCastId ? { fid: parentCastId.fid, hash: parentCastId.hash } : {}),
    ...(parentUrl ? { url: parentUrl } : {}),
    pageSize: limit,
  });
  return page.messages
    .filter((message) => message.castAdd)
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(0, limit);
};
