/**
 * The node-backed readers: the hosted API's answers, read from your own node.
 *
 * Every method here answers a request the fork's data layer would have sent to
 * `farcaster.xyz`, using only what a Snapchain read node serves: `/v1/castsByFid`,
 * `/v1/castsByParent`, `/v1/castById`, `/v1/userDataByFid`, `/v1/linksByFid`,
 * `/v1/linksByTargetFid`, `/v1/reactionsByCast`, `/v1/castsByMention`,
 * `/v1/userNameProofByName`, `/v1/verificationsByFid`.
 *
 * MEASURED THINGS THIS FILE DEPENDS ON (probed against a live read node, not
 * assumed — see docs/CLIENT-PARITY.md for the raw evidence):
 *
 *   - `pageSize` is a *minimum*. Asking for 3 returns 6; asking for 1000
 *     returns 2000. So a paged count stops when a page comes back empty, not
 *     when it came back shorter than asked.
 *   - A page token of `[null,null]` (base64 `W251bGwsbnVsbF0=`) means the end
 *     of the results, and it is repeated on an empty page rather than omitted.
 *   - `castsByFid` without `reverse` serves the *oldest* page first.
 *
 * WHAT IS NOT HERE
 *
 * A read node shards by FID, so a cast can only be addressed by (author, hash)
 * — there is no hash-only lookup. Cast detail pages carry a hash only, so the
 * reader remembers the author of every cast it has served (`castFidMemo`) and
 * says so plainly when a hash has never been seen. That is a structural
 * property of the node's API, not a bug being hidden.
 */

import {
  ApiCast,
  ApiCastReaction,
  ApiFeedItemsResult,
  ApiGetUnseen200Response,
  ApiNotificationCastMention,
  ApiNotificationCastReaction,
  ApiNotificationCastReply,
  ApiNotificationFollow,
  ApiNotificationGroup,
  ApiThreadResult,
  ApiUser,
  ApiVerification,
} from 'farcaster-client-data';
import {
  fetchFollowing,
  isTerminalPageToken,
  mapWithConcurrency,
  type NodeCastAddBody,
  type NodeMessage,
  SnapchainNodeClient,
} from 'farcaster-node-client';

import {
  createEmbedKindResolver,
  type EmbedKindAnswer,
  type EmbedKindResolver,
} from './embedKinds';
import {
  apiCastFeedItemFromNode,
  apiCastFromNode,
  apiUserFromNode,
  castEmbedsFromNode,
  exactCount,
  floorCount,
  NodeCount,
} from './fromNode';

/** Raised when the node genuinely cannot answer a request the app made. */
export class NodeCannotAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NodeCannotAnswerError';
  }
}

const DEFAULT_COUNT_CAP = 6000;
const COUNT_PAGE_SIZE = 1000;
/** How many quotes/names to resolve per response, to keep fan-out bounded. */
const RESOLVE_CONCURRENCY = 12;
/** Walk at most this far up a thread looking for its root. */
const MAX_ANCESTOR_HOPS = 20;

/**
 * hash → the FID that authored it: the index that makes a hash-only page
 * answerable at all.
 *
 * A Snapchain node shards by FID, so `castById` needs the author as well as the
 * hash, while the fork's client asks for threads and reactions by hash alone.
 * Every cast this client has served is therefore remembered here by the reader
 * that served it — see `readThread`.
 *
 * ONE index for the whole client, not one per reader, and that is load-bearing
 * now that writes exist: a cast is normally READ through the node that serves
 * the feed and WRITTEN through whichever server answers that account's writes
 * (they can be different servers — a Neynar key answers profiles and writes
 * while the feed comes from a node). The author of a cast is a fact about the
 * network, not about which server told us, so a like must not fail because the
 * server that will carry it never served the page it was pressed on.
 */
const castFidIndex = new Map<string, number>();

/** Remember who wrote a cast, so a hash-only request can be resolved later. */
export const rememberCastAuthor = (hash: string, fid: number): void => {
  if (hash.length > 0) {
    castFidIndex.set(hash, fid);
  }
};

/** The author of a cast this client has seen, or undefined when never seen. */
export const castAuthorOf = (hash: string): number | undefined =>
  castFidIndex.get(hash);

/** Forget the shared index (sign-out, and tests). */
export const forgetCastAuthors = (): void => {
  castFidIndex.clear();
};
const USER_DATA_PAGE_SIZE = 100;
const SEEN_STORAGE_PREFIX = 'fiddy:node-seen';

/** `[null,null]` — measured as "there is nothing after this page". Shared with
 * the node client so the browser and the library stop for the same reason. */

const fcTimestampToMs = (timestamp: number): number =>
  timestamp * 1000 + 1609459200000;

/**
 * The embed URLs a cast body carries, in the order it carries them.
 *
 * Only `url` embeds: a quote addresses another cast and is resolved by hash,
 * not by fetching anything here.
 */
const embedUrlsOf = (body: NodeCastAddBody | undefined): string[] => {
  if (!body?.embeds) {
    return [];
  }
  const urls: string[] = [];
  for (const embed of body.embeds) {
    if ('url' in embed && typeof embed.url === 'string' && embed.url !== '') {
      urls.push(embed.url);
    }
  }
  return urls;
};

const seenStore = (): Storage | undefined => {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
};

export interface NodeBackedReadsOptions {
  node: SnapchainNodeClient;
  /** Where the node answers, for the one route the typed client does not cover. */
  nodeBaseUrl: string;
  /** Requests to the node. Same seam the client uses, so tests can fake it. */
  fetchImpl: typeof fetch;
  /** The signed-in account, or undefined when this device has no identity yet. */
  getSignedInFid: () => number | undefined;
  /** Above this, a paged count is reported as a floor. */
  countCap?: number;
  /**
   * What each embed URL's media type is (image / video / link), so a photo is
   * rendered as a photo rather than as a link card. Defaults to the real thing:
   * one bounded, cached probe per URL (`embedKinds.ts`). Injectable so a test
   * can answer without a network.
   */
  embedKinds?: EmbedKindResolver;
}

interface CacheEntry<T> {
  at: number;
  value: T;
}

const USER_CACHE_MS = 60_000;
const COUNT_CACHE_MS = 60_000;

/**
 * A channel's parent URL from its key.
 *
 * MEASURED: a consolidated channel is addressed on chain by
 * `https://farcaster.xyz/~/channel/<key>` and the node serves its casts by
 * that URL (`/v1/castsByParent?url=…`, verified against a live node). A channel
 * owned by an NFT is addressed `chain://eip155:7777777/erc721:0x…` and its
 * short key lives only in Warpcast's directory — the node cannot turn one into
 * the other, which is why that case is an honest error, not an empty feed.
 *
 * A module function as well as a reader method because a *write* needs it too:
 * a channel cast is a cast to this URL, so the writer must speak it without
 * owning a reader (a Neynar-themed client writes through a different server
 * than the one that served the channel page).
 */
export const channelParentUrlFor = (key: string): string => {
  if (/^(https?:\/\/|chain:\/\/)/.test(key)) {
    return key;
  }
  return `https://farcaster.xyz/~/channel/${key}`;
};

/**
 * Reads the hosted API's answers out of a Snapchain node, with the caches a
 * browser client needs (one page of feed asks for ~25 authors).
 */
export class NodeBackedReads {
  private readonly node: SnapchainNodeClient;
  private readonly nodeBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly getSignedInFid: () => number | undefined;
  private readonly countCap: number;
  private readonly embedKinds: EmbedKindResolver;

  private readonly userCache = new Map<number, CacheEntry<ApiUser>>();
  private readonly userPromiseCache = new Map<number, Promise<ApiUser>>();
  private readonly countCache = new Map<string, CacheEntry<NodeCount>>();
  private readonly castCache = new Map<string, CacheEntry<NodeMessage>>();

  constructor({
    node,
    nodeBaseUrl,
    fetchImpl,
    getSignedInFid,
    countCap = DEFAULT_COUNT_CAP,
    embedKinds = createEmbedKindResolver(),
  }: NodeBackedReadsOptions) {
    this.node = node;
    this.nodeBaseUrl = nodeBaseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.getSignedInFid = getSignedInFid;
    this.countCap = countCap;
    this.embedKinds = embedKinds;
  }

  /**
   * What a URL is, as far as anything has been able to establish. Passed to the
   * cast translator, which is the only other place that decides which bucket an
   * embed lands in.
   */
  private readonly embedKindLookup = (
    url: string,
  ): EmbedKindAnswer | undefined => this.embedKinds.kindOf(url);

  /**
   * Ask what this page's embed URLs are, together, before any cast is built.
   *
   * One batch per page rather than per cast: the probes share one concurrency
   * pool and one deadline, and the answer is cached, so the per-cast call in
   * `buildCast` is a lookup rather than a second round of network.
   */
  private async classifyEmbeds(messages: NodeMessage[]): Promise<void> {
    const urls = messages.flatMap((message) => embedUrlsOf(message.castAdd));
    if (urls.length === 0) {
      return;
    }
    await this.embedKinds.classify(urls);
  }

  /** The account every signed-in read is relative to. */
  requireFid(): number {
    const fid = this.getSignedInFid();
    if (fid === undefined) {
      throw new NodeCannotAnswerError(
        'No account is signed in on this device, so there is nothing to read for it.',
      );
    }
    return fid;
  }

  /** The account every signed-in read is relative to, or undefined. */
  signedInFid(): number | undefined {
    return this.getSignedInFid();
  }

  // ---------------------------------------------------------------- user reads

  private async userDataMessages(fid: number): Promise<NodeMessage[]> {
    const page = await this.node.userDataByFid({
      fid,
      pageSize: USER_DATA_PAGE_SIZE,
    });
    // User data is a log; the newest message for each field is the current
    // value, which is why they are handed over oldest-first.
    return [...page.messages].sort((a, b) => a.timestamp - b.timestamp);
  }

  private async countLinkDirection({
    fid,
    targetFid,
  }: {
    fid?: number;
    targetFid?: number;
  }): Promise<NodeCount> {
    const key = fid !== undefined ? `from:${fid}` : `to:${targetFid}`;
    const cached = this.countCache.get(key);
    if (cached && Date.now() - cached.at < COUNT_CACHE_MS) {
      return cached.value;
    }

    let count = 0;
    let pageToken: string | undefined;
    let isFloor = false;

    for (;;) {
      const page =
        fid !== undefined
          ? await this.node.linksByFid({
              fid,
              linkType: 'follow',
              pageSize: COUNT_PAGE_SIZE,
              pageToken,
            })
          : await this.node.linksByTargetFid({
              targetFid: targetFid as number,
              linkType: 'follow',
              pageSize: COUNT_PAGE_SIZE,
              pageToken,
            });

      count += page.messages.length;
      pageToken = page.nextPageToken;

      if (page.messages.length === 0 || isTerminalPageToken(pageToken)) {
        break;
      }
      if (count >= this.countCap) {
        isFloor = true;
        break;
      }
    }

    const value = isFloor ? floorCount(count) : exactCount(count);
    this.countCache.set(key, { at: Date.now(), value });
    return value;
  }

  /**
   * A profile. Counts are counted by paging the follow graph, so they are exact
   * below the cap and a floor above it — `NodeCount.isFloor` says which.
   */
  async readUser(fid: number): Promise<ApiUser> {
    const cached = this.userCache.get(fid);
    if (cached && Date.now() - cached.at < USER_CACHE_MS) {
      return cached.value;
    }

    const inFlight = this.userPromiseCache.get(fid);
    if (inFlight) {
      return inFlight;
    }

    const promise = (async () => {
      const [userData, followerCount, followingCount] = await Promise.all([
        this.userDataMessages(fid),
        this.countLinkDirection({ targetFid: fid }),
        this.countLinkDirection({ fid }),
      ]);

      const viewerFid = this.getSignedInFid();
      const viewerContext =
        viewerFid !== undefined && viewerFid !== fid
          ? { following: await this.isFollowing({ viewerFid, targetFid: fid }) }
          : undefined;

      const user = apiUserFromNode({
        fid,
        userData,
        followerCount,
        followingCount,
        ...(viewerContext ? { viewerContext } : {}),
      });

      this.userCache.set(fid, { at: Date.now(), value: user });
      return user;
    })();

    this.userPromiseCache.set(fid, promise);
    try {
      return await promise;
    } finally {
      this.userPromiseCache.delete(fid);
    }
  }

  private async isFollowing({
    viewerFid,
    targetFid,
  }: {
    viewerFid: number;
    targetFid: number;
  }): Promise<boolean> {
    // One page is enough to answer this for real: the question is "is there a
    // follow link from me to them", and the node serves the links themselves.
    try {
      const page = await this.node.linksByFid({
        fid: viewerFid,
        linkType: 'follow',
        pageSize: COUNT_PAGE_SIZE,
      });
      return page.messages.some(
        (message) => message.link?.targetFid === targetFid,
      );
    } catch {
      return false;
    }
  }

  async readUserByUsername(username: string): Promise<ApiUser | undefined> {
    const proof = (await this.node.userNameProofByName(username)) as
      | { fid?: number }
      | undefined;
    if (!proof || typeof proof.fid !== 'number') {
      return undefined;
    }
    return await this.readUser(proof.fid);
  }

  /** Verified addresses, straight from the node's verification messages. */
  async readVerifications(fid: number): Promise<ApiVerification[]> {
    const url = `${this.nodeBaseUrl}/v1/verificationsByFid?fid=${fid}&pageSize=${USER_DATA_PAGE_SIZE}`;
    const response = await this.fetchImpl(url, { method: 'GET' });
    if (!response.ok) {
      throw new NodeCannotAnswerError(
        `Your node refused the verification read (${response.status}).`,
      );
    }

    const body = (await response.json()) as {
      messages?: {
        data?: {
          type?: string;
          fid?: number;
          timestamp?: number;
          verificationAddAddressBody?: { address?: string; protocol?: string };
        };
      }[];
    };

    return (body.messages ?? []).flatMap((message) => {
      const data = message.data;
      const address = data?.verificationAddAddressBody?.address;
      if (!data || !address) {
        return [];
      }
      const isSolana = (data.type ?? '').includes('SOLANA');
      return [
        {
          fid: data.fid ?? fid,
          address,
          timestamp: fcTimestampToMs(data.timestamp ?? 0),
          version: 'v1' as const,
          protocol: isSolana ? ('solana' as const) : ('ethereum' as const),
          // `isPrimary` is a hosted statement about which address a profile
          // shows first. The node does not rank them, so this is not claimed.
          isPrimary: false,
        },
      ];
    });
  }

  // ---------------------------------------------------------------- cast reads

  private rememberCasts(messages: NodeMessage[]): void {
    for (const message of messages) {
      if (message.castAdd) {
        rememberCastAuthor(message.hash, message.fid);
        this.castCache.set(`${message.fid}:${message.hash}`, {
          at: Date.now(),
          value: message,
        });
      }
    }
  }

  /**
   * One cast, as the hosted shapes — for a caller that already holds a node
   * message (the writer, answering `POST /v2/casts` with the cast it just got
   * the node to store). Counts are not read: a cast that was just accepted has
   * no reactions to report, and the client re-reads it as soon as the composer
   * invalidates its queries.
   */
  async apiCastFor(message: NodeMessage): Promise<ApiCast | undefined> {
    return this.buildCast({ message, withCounts: false });
  }

  private async castById(
    fid: number,
    hash: string,
  ): Promise<NodeMessage | undefined> {
    const cached = this.castCache.get(`${fid}:${hash}`);
    if (cached) {
      return cached.value;
    }
    try {
      const message = await this.node.castById({ fid, hash });
      this.rememberCasts([message]);
      return message;
    } catch {
      return undefined;
    }
  }

  private async countReactions({
    targetFid,
    targetHash,
    reactionType,
  }: {
    targetFid: number;
    targetHash: string;
    reactionType: 'Like' | 'Recast';
  }): Promise<NodeCount> {
    const key = `${reactionType}:${targetFid}:${targetHash}`;
    const cached = this.countCache.get(key);
    if (cached && Date.now() - cached.at < COUNT_CACHE_MS) {
      return cached.value;
    }

    let count = 0;
    let pageToken: string | undefined;
    let isFloor = false;

    for (;;) {
      const page = await this.node.reactionsByCast({
        targetFid,
        targetHash,
        reactionType,
        pageSize: COUNT_PAGE_SIZE,
        pageToken,
      });
      count += page.messages.length;
      pageToken = page.nextPageToken;
      if (page.messages.length === 0 || isTerminalPageToken(pageToken)) {
        break;
      }
      if (count >= this.countCap) {
        isFloor = true;
        break;
      }
    }

    const value = isFloor ? floorCount(count) : exactCount(count);
    this.countCache.set(key, { at: Date.now(), value });
    return value;
  }

  /** Which casts the signed-in account has already liked / recast. */
  private async viewerReactionHashes(
    reactionType: 'Like' | 'Recast',
  ): Promise<Set<string>> {
    const fid = this.getSignedInFid();
    if (fid === undefined) {
      return new Set();
    }
    try {
      const page = await this.node.reactionsByFid({
        fid,
        reactionType,
        pageSize: COUNT_PAGE_SIZE,
      });
      return new Set(
        page.messages
          .map((message) => message.reaction?.targetCastId?.hash)
          .filter((hash): hash is string => typeof hash === 'string'),
      );
    } catch {
      return new Set();
    }
  }

  /** Resolve one node cast into the API's cast shape, with its counts. */
  private async buildCast({
    message,
    likedHashes,
    recastHashes,
    parentAuthor,
    threadHash,
    ancestors,
    replies,
    withCounts = true,
    embedsAsked = false,
  }: {
    message: NodeMessage;
    likedHashes?: Set<string>;
    recastHashes?: Set<string>;
    parentAuthor?: ApiUser;
    threadHash?: string;
    ancestors?: { count: number; casts?: ApiCast[] };
    replies?: { count: number; casts?: ApiCast[] };
    withCounts?: boolean;
    /**
     * True when the caller already asked about this page's embed URLs as one
     * batch (`classifyEmbeds`), so this cast only looks the answers up. One
     * wait per read, not one per cast.
     */
    embedsAsked?: boolean;
  }): Promise<ApiCast | undefined> {
    const body = message.castAdd;
    if (!body) {
      return undefined;
    }

    // Which of this cast's URLs are media. The page's own batch already asked
    // when this cast came out of a feed; a cast read on its own (a thread root
    // by hash, say) asks here, so a photo is a photo on the first paint either
    // way. Either way it is one bounded wait, never two.
    if (!embedsAsked) {
      const embedUrls = embedUrlsOf(body);
      if (embedUrls.length > 0) {
        await this.embedKinds.classify(embedUrls);
      }
    }

    const [author, reactions, recasts] = await Promise.all([
      this.readUser(message.fid),
      withCounts
        ? this.countReactions({
            targetFid: message.fid,
            targetHash: message.hash,
            reactionType: 'Like',
          })
        : Promise.resolve(exactCount(0)),
      withCounts
        ? this.countReactions({
            targetFid: message.fid,
            targetHash: message.hash,
            reactionType: 'Recast',
          })
        : Promise.resolve(exactCount(0)),
    ]);

    // Quoted casts are resolved for real (they address their parent), so a
    // quote renders as a quote rather than an empty box.
    const { quoteTargets } = castEmbedsFromNode({ body });
    const quoted = await mapWithConcurrency(
      quoteTargets,
      RESOLVE_CONCURRENCY,
      async (target) => {
        const quotedMessage = await this.castById(target.fid, target.hash);
        if (!quotedMessage?.castAdd) {
          return undefined;
        }
        const quotedAuthor = await this.readUser(quotedMessage.fid);
        return {
          hash: quotedMessage.hash,
          threadHash: quotedMessage.hash,
          author: quotedAuthor,
          text: quotedMessage.castAdd.text,
          timestamp: quotedMessage.timestampMs,
        };
      },
    );

    const viewerContext =
      likedHashes || recastHashes
        ? {
            ...(likedHashes?.has(message.hash) ? { reacted: true } : {}),
            ...(recastHashes?.has(message.hash) ? { recast: true } : {}),
          }
        : undefined;

    return apiCastFromNode({
      message,
      body,
      author,
      ...(parentAuthor ? { parentAuthor } : {}),
      ...(threadHash ? { threadHash } : {}),
      ...(ancestors ? { ancestors } : {}),
      ...(replies ? { replies } : {}),
      reactions,
      recasts,
      quotedCasts: quoted.filter((cast) => cast !== undefined),
      embedKind: this.embedKindLookup,
      ...(viewerContext && Object.keys(viewerContext).length > 0
        ? { viewerContext }
        : {}),
    });
  }

  /** Assemble a page of casts from raw node messages, order preserved. */
  private async buildCasts(
    messages: NodeMessage[],
    {
      withCounts = true,
      withViewer = true,
    }: { withCounts?: boolean; withViewer?: boolean } = {},
  ): Promise<ApiCast[]> {
    this.rememberCasts(messages);
    // The page's embed URLs are asked about together, before any cast is built:
    // a photo is drawn as a photo on the first paint rather than after a reload.
    await this.classifyEmbeds(messages);
    const [likedHashes, recastHashes] = withViewer
      ? await Promise.all([
          this.viewerReactionHashes('Like'),
          this.viewerReactionHashes('Recast'),
        ])
      : [undefined, undefined];

    const casts = await mapWithConcurrency(
      messages,
      RESOLVE_CONCURRENCY,
      (message) =>
        this.buildCast({
          message,
          likedHashes,
          recastHashes,
          withCounts,
          embedsAsked: true,
        }),
    );

    return casts.filter((cast): cast is ApiCast => cast !== undefined);
  }

  // ---------------------------------------------------------------- feed reads

  /**
   * A channel's parent URL from its key — `channelParentUrlFor` is the one
   * implementation; this is the reader-shaped door onto it.
   */
  channelParentUrl(key: string): string {
    return channelParentUrlFor(key);
  }

  private async followingFeedMessages({
    fid,
    olderThan,
    limit,
    includeSelf,
  }: {
    fid: number;
    olderThan?: number;
    limit: number;
    includeSelf: boolean;
  }): Promise<NodeMessage[]> {
    // MEASURED (a real follow graph, a real node, a browser): reading 200
    // accounts' casts at 25 each took ~55s to answer the feed's first page —
    // long past the point a user believes the client is working. The read is
    // therefore bounded twice over: 60 accounts (the most recently followed,
    // which is the freshest slice of a large follow graph) and 10 casts each,
    // with the merge below taking the newest 25. Same shape as before, roughly
    // an order of magnitude less wall clock.
    const following = await fetchFollowing({ node: this.node, fid, limit: 60 });
    const authorFids = includeSelf ? [fid, ...following] : following;

    // The feed is assembled locally, so a page is: the newest few casts from
    // each followed account, merged on the protocol timestamp.
    //
    // One unreachable account must not blank the feed — but "no account
    // answered" is not an empty feed, it is an unreadable one. MEASURED (the
    // relay pointed at a refused port): every per-author read came back 500,
    // every one was swallowed by the `catch` below, and the feed answered `200`
    // with zero items — the same "there is nothing here" a genuinely quiet
    // follow graph produces. Counted, so the two can be told apart.
    let answered = 0;
    let lastFailure: unknown;
    const perAuthor = await mapWithConcurrency(
      authorFids,
      RESOLVE_CONCURRENCY,
      async (authorFid) => {
        try {
          const page = await this.node.castsByFid({
            fid: authorFid,
            pageSize: Math.min(limit, 10),
            reverse: true,
          });
          answered += 1;
          return page.messages.filter((message) => message.castAdd);
        } catch (error) {
          // One unreachable account must not blank the feed.
          lastFailure = error;
          return [] as NodeMessage[];
        }
      },
    );

    if (answered === 0 && authorFids.length > 0) {
      const message =
        lastFailure instanceof Error
          ? lastFailure.message
          : String(lastFailure);
      throw new Error(
        `none of the ${authorFids.length} accounts this read asked answered (${message})`,
      );
    }

    const byHash = new Map<string, NodeMessage>();
    for (const message of perAuthor.flat()) {
      if (message.castAdd?.parentCastId || message.castAdd?.parentUrl) {
        // Replies and channel posts belong to their own surfaces; the home
        // feed is the accounts' own casts, the way the hosted feed reads.
        continue;
      }
      if (olderThan !== undefined && message.timestampMs >= olderThan) {
        continue;
      }
      byHash.set(`${message.fid}:${message.hash}`, message);
    }

    return [...byHash.values()]
      .sort((a, b) => b.timestampMs - a.timestampMs)
      .slice(0, limit);
  }

  private async channelFeedMessages({
    key,
    olderThan,
    limit,
  }: {
    key: string;
    olderThan?: number;
    limit: number;
  }): Promise<NodeMessage[]> {
    const page = await this.node.castsByParent({
      url: this.channelParentUrl(key),
      pageSize: Math.min(limit * 2, 50),
      reverse: true,
    });
    return page.messages
      .filter((message) => message.castAdd)
      .filter(
        (message) => olderThan === undefined || message.timestampMs < olderThan,
      )
      .sort((a, b) => b.timestampMs - a.timestampMs)
      .slice(0, limit);
  }

  /**
   * `POST /v2/feed-items`. The feed the app asks for decides the source:
   * `home` and `following` are your follow graph, anything else is treated as
   * a channel key (the app passes `feed.key` for channel feeds).
   */
  async readFeed({
    feedKey,
    feedType,
    olderThan,
    limit = 25,
    updateState = false,
  }: {
    feedKey: string;
    feedType?: string;
    olderThan?: number;
    limit?: number;
    updateState?: boolean;
  }): Promise<ApiFeedItemsResult> {
    const fid = this.requireFid();

    const isHome = feedKey === 'home';
    const isFollowing = feedKey === 'following';
    if (
      feedType === 'for-you' ||
      feedType === 'trending' ||
      feedType === 'curated'
    ) {
      // Ranking is an indexer's job; saying so is better than serving the
      // follow graph under a "For you" label.
      throw new NodeCannotAnswerError(
        `“${feedType}” is a ranked feed, and ranking is the indexer’s job. Your node can build the following feed.`,
      );
    }

    const messages =
      isHome || isFollowing
        ? await this.followingFeedMessages({
            fid,
            olderThan,
            limit,
            includeSelf: isHome,
          })
        : await this.channelFeedMessages({ key: feedKey, olderThan, limit });

    const casts = await this.buildCasts(messages);

    if (updateState) {
      this.markSeen(fid, isHome || isFollowing ? 'home' : feedKey);
    }

    return {
      items: casts.map((cast) => apiCastFeedItemFromNode({ cast })),
      latestMainCastTimestamp: casts[0]?.timestamp ?? Date.now(),
    };
  }

  // -------------------------------------------------------------- thread reads

  /**
   * `GET /v2/thread-casts`: the ancestors, the cast, then its replies.
   *
   * The request carries only a hash. A Snapchain node shards by FID, so a hash
   * alone cannot be looked up — the author comes from the memo filled by every
   * cast this reader has served (your feed, a profile, a channel). When the
   * hash has never been seen, that is reported in plain words.
   */
  async readThread({
    castHash,
    limit = 15,
    replyPreviewLimit = 25,
  }: {
    castHash: string;
    limit?: number;
    replyPreviewLimit?: number;
  }): Promise<ApiThreadResult> {
    const fid = castAuthorOf(castHash);
    if (fid === undefined) {
      throw new NodeCannotAnswerError(
        'Your node addresses a cast by its author and its hash, and this page only has the hash. Open the cast from your feed or a profile and it will load.',
      );
    }

    const root = await this.castById(fid, castHash);
    if (!root?.castAdd) {
      throw new NodeCannotAnswerError('Your node does not have that cast.');
    }

    // Walk up to the thread root. Bounded, because a deep thread should not
    // turn into an unbounded walk on a click.
    const ancestors: NodeMessage[] = [];
    let cursor = root;
    for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop += 1) {
      const parent = cursor.castAdd?.parentCastId;
      if (!parent) {
        break;
      }
      const parentMessage = await this.castById(parent.fid, parent.hash);
      if (!parentMessage?.castAdd) {
        break;
      }
      ancestors.unshift(parentMessage);
      cursor = parentMessage;
    }

    const repliesPage = await this.node.castsByParent({
      fid,
      hash: castHash,
      pageSize: Math.min(replyPreviewLimit, 50),
      reverse: false,
    });
    const replies = repliesPage.messages.filter((message) => message.castAdd);

    this.rememberCasts([...ancestors, root, ...replies]);
    const [likedHashes, recastHashes] = await Promise.all([
      this.viewerReactionHashes('Like'),
      this.viewerReactionHashes('Recast'),
    ]);

    const castMessages = [...ancestors, root, ...replies];
    const built = await mapWithConcurrency(
      castMessages,
      RESOLVE_CONCURRENCY,
      (message) =>
        this.buildCast({
          message,
          likedHashes,
          recastHashes,
          threadHash: ancestors[0]?.hash ?? root.hash,
          ...(message.hash === root.hash
            ? {
                ancestors: { count: ancestors.length },
                // Only the page we fetched is claimed: a floor, not a total.
                replies: { count: replies.length },
              }
            : {}),
        }),
    );

    const casts = built.filter((cast): cast is ApiCast => cast !== undefined);
    return {
      casts: casts.slice(0, limit + ancestors.length + 1),
      ...(repliesPage.nextPageToken &&
      !isTerminalPageToken(repliesPage.nextPageToken)
        ? { hasHiddenReplies: false }
        : {}),
    };
  }

  /** `GET /v2/user-casts`: one account's own casts, newest first. */
  async readUserCasts({
    fid,
    limit = 25,
    olderThan,
  }: {
    fid: number;
    limit?: number;
    olderThan?: number;
  }): Promise<ApiCast[]> {
    const page = await this.node.castsByFid({
      fid,
      pageSize: Math.min(limit * 2, 100),
      reverse: true,
    });
    const messages = page.messages
      .filter((message) => message.castAdd)
      .filter(
        (message) => olderThan === undefined || message.timestampMs < olderThan,
      )
      .slice(0, limit);
    return await this.buildCasts(messages);
  }

  // -------------------------------------------------- notifications, derived

  private seenKey(fid: number): string {
    return `${SEEN_STORAGE_PREFIX}:${fid}`;
  }

  /** Read the local watermark (ms) for a feed key. */
  readSeen(fid: number, feedKey: string): number {
    const store = seenStore();
    if (!store) {
      return 0;
    }
    try {
      const raw = store.getItem(this.seenKey(fid));
      if (!raw) {
        return 0;
      }
      const parsed = JSON.parse(raw) as Record<string, number>;
      return parsed[feedKey] ?? 0;
    } catch {
      return 0;
    }
  }

  /** Record that the account has now seen this feed. Local, and said so. */
  markSeen(fid: number, feedKey: string): void {
    const store = seenStore();
    if (!store) {
      return;
    }
    try {
      const raw = store.getItem(this.seenKey(fid));
      const parsed: Record<string, number> = raw
        ? (JSON.parse(raw) as Record<string, number>)
        : {};
      parsed[feedKey] = Date.now();
      store.setItem(this.seenKey(fid), JSON.stringify(parsed));
    } catch {
      // A full or unavailable localStorage must not break a read.
    }
  }

  private async myRecentCastHashes(fid: number, limit = 25): Promise<string[]> {
    try {
      const page = await this.node.castsByFid({
        fid,
        pageSize: Math.min(limit, 50),
        reverse: true,
      });
      const messages = page.messages.filter((message) => message.castAdd);
      this.rememberCasts(messages);
      return messages.map((message) => message.hash);
    } catch {
      return [];
    }
  }

  /**
   * Notifications derived from the node, grouped the way the tab view groups
   * them: mentions, replies, reactions and follows aimed at the signed-in FID.
   *
   * The hosted API also sends invites, wallet activity, streak updates, tips
   * and mini-app news; none of those are protocol messages, so they cannot be
   * derived here and are simply absent rather than faked.
   */
  async readNotifications({
    fid,
    limit = 15,
  }: {
    fid?: number;
    limit?: number;
  } = {}): Promise<ApiNotificationGroup[]> {
    const accountFid = fid ?? this.requireFid();
    const myHashes = await this.myRecentCastHashes(accountFid);

    const [mentions, repliesByCast, reactionsByCast, follows] =
      await Promise.all([
        this.node
          .castsByMention({
            fid: accountFid,
            pageSize: Math.min(limit, 50),
            reverse: true,
          })
          .catch(() => ({ messages: [] as NodeMessage[] })),
        mapWithConcurrency(myHashes.slice(0, 10), RESOLVE_CONCURRENCY, (hash) =>
          this.node
            .castsByParent({
              fid: accountFid,
              hash,
              pageSize: 10,
              reverse: true,
            })
            .then((page) => page.messages.filter((message) => message.castAdd))
            .catch(() => [] as NodeMessage[]),
        ),
        mapWithConcurrency(
          myHashes.slice(0, 10),
          RESOLVE_CONCURRENCY,
          async (hash) => {
            const page = await this.node
              .reactionsByCast({
                targetFid: accountFid,
                targetHash: hash,
                reactionType: 'Like',
                pageSize: 10,
                reverse: true,
              })
              .catch(() => ({ messages: [] as NodeMessage[] }));
            return { hash, messages: page.messages };
          },
        ),
        this.node
          .linksByTargetFid({
            targetFid: accountFid,
            linkType: 'follow',
            pageSize: Math.min(limit, 50),
            reverse: true,
          })
          .catch(() => ({ messages: [] as NodeMessage[] })),
      ]);

    const groups: ApiNotificationGroup[] = [];

    const mentionMessages = mentions.messages.filter(
      (message) => message.castAdd,
    );
    if (mentionMessages.length > 0) {
      this.rememberCasts(mentionMessages);
      const items = await mapWithConcurrency(
        mentionMessages.slice(0, 3),
        RESOLVE_CONCURRENCY,
        async (message) => {
          const cast = await this.buildCast({ message, withCounts: false });
          const actor = await this.readUser(message.fid);
          if (!cast) {
            return undefined;
          }
          return {
            type: 'cast-mention' as const,
            id: `mention:${message.hash}`,
            timestamp: message.timestampMs,
            actor,
            content: { cast },
          } satisfies ApiNotificationCastMention;
        },
      );

      groups.push({
        id: `mentions:${accountFid}`,
        type: 'cast-mention',
        latestTimestamp: mentionMessages[0]!.timestampMs,
        totalItemCount: mentionMessages.length,
        previewItems: items.filter((item) => item !== undefined),
        isUnread: mentionMessages.some(
          (message) =>
            message.timestampMs > this.readSeen(accountFid, 'notifications'),
        ),
      });
    }

    const replyMessages = repliesByCast
      .flat()
      .filter((message) => message.castAdd);
    if (replyMessages.length > 0) {
      this.rememberCasts(replyMessages);
      const items = await mapWithConcurrency(
        replyMessages.slice(0, 3),
        RESOLVE_CONCURRENCY,
        async (message) => {
          const cast = await this.buildCast({ message, withCounts: false });
          const actor = await this.readUser(message.fid);
          if (!cast) {
            return undefined;
          }
          return {
            type: 'cast-reply' as const,
            id: `reply:${message.hash}`,
            timestamp: message.timestampMs,
            actor,
            content: { cast },
          } satisfies ApiNotificationCastReply;
        },
      );

      groups.push({
        id: `replies:${accountFid}`,
        type: 'cast-reply',
        latestTimestamp: replyMessages[0]!.timestampMs,
        totalItemCount: replyMessages.length,
        previewItems: items.filter((item) => item !== undefined),
        isUnread: replyMessages.some(
          (message) =>
            message.timestampMs > this.readSeen(accountFid, 'notifications'),
        ),
      });
    }

    const reactionMessages = reactionsByCast
      .map((entry) => ({
        hash: entry.hash,
        messages: entry.messages.filter((m) => m.reaction),
      }))
      .filter((entry) => entry.messages.length > 0);
    if (reactionMessages.length > 0) {
      const items: ApiNotificationCastReaction[] = [];
      for (const entry of reactionMessages.slice(0, 3)) {
        const target = castAuthorOf(entry.hash);
        const targetMessage =
          target !== undefined
            ? await this.castById(target, entry.hash)
            : undefined;
        if (!targetMessage?.castAdd) {
          continue;
        }
        const cast = await this.buildCast({
          message: targetMessage,
          withCounts: false,
        });
        const reactionMessage = entry.messages[0]!;
        const actor = await this.readUser(reactionMessage.fid);
        if (!cast) {
          continue;
        }
        const reaction: ApiCastReaction = {
          type: 'like',
          hash: reactionMessage.hash,
          reactor: actor,
          timestamp: reactionMessage.timestampMs,
          castHash: entry.hash,
        };
        items.push({
          type: 'cast-reaction',
          id: `reaction:${reactionMessage.hash}`,
          timestamp: reactionMessage.timestampMs,
          actor,
          content: { cast, reaction },
        });
      }

      if (items.length > 0) {
        groups.push({
          id: `reactions:${accountFid}`,
          type: 'cast-reaction',
          latestTimestamp: Math.max(...items.map((item) => item.timestamp)),
          totalItemCount: reactionMessages.reduce(
            (sum, entry) => sum + entry.messages.length,
            0,
          ),
          previewItems: items,
          isUnread: items.some(
            (item) =>
              item.timestamp > this.readSeen(accountFid, 'notifications'),
          ),
        });
      }
    }

    const followMessages = follows.messages.filter((message) => message.link);
    if (followMessages.length > 0) {
      const items = await mapWithConcurrency(
        followMessages.slice(0, 3),
        RESOLVE_CONCURRENCY,
        async (message) => {
          const actor = await this.readUser(message.fid);
          return {
            type: 'follow' as const,
            id: `follow:${message.fid}`,
            timestamp: message.timestampMs,
            actor,
          } satisfies ApiNotificationFollow;
        },
      );

      groups.push({
        id: `follows:${accountFid}`,
        type: 'follow',
        latestTimestamp: followMessages[0]!.timestampMs,
        totalItemCount: followMessages.length,
        previewItems: items,
        isUnread: followMessages.some(
          (message) =>
            message.timestampMs > this.readSeen(accountFid, 'notifications'),
        ),
      });
    }

    return groups.sort((a, b) => b.latestTimestamp - a.latestTimestamp);
  }

  /**
   * `GET /v2/unseen`, derived. `notificationTabs` names the one tab this client
   * serves, and `inboxCount` stays zero because direct messages are not on the
   * node's read API — the DM surface says so rather than showing an empty inbox.
   */
  async readUnseen(): Promise<ApiGetUnseen200Response['result']> {
    const fid = this.requireFid();
    const seenAt = this.readSeen(fid, 'notifications');

    const [mentions, follows] = await Promise.all([
      this.node
        .castsByMention({ fid, pageSize: 50, reverse: true })
        .catch(() => ({
          messages: [] as NodeMessage[],
        })),
      this.node
        .linksByTargetFid({
          targetFid: fid,
          linkType: 'follow',
          pageSize: 50,
          reverse: true,
        })
        .catch(() => ({ messages: [] as NodeMessage[] })),
    ]);

    const unreadMentions = mentions.messages.filter(
      (message) => message.timestampMs > seenAt,
    ).length;
    const unreadFollows = follows.messages.filter(
      (message) => message.timestampMs > seenAt,
    ).length;

    return {
      notificationsCount: unreadMentions + unreadFollows,
      notificationTabs:
        unreadMentions + unreadFollows > 0
          ? [{ tab: 'default', unseenCount: unreadMentions + unreadFollows }]
          : [],
      inboxCount: 0,
      channelFeeds: [],
      warpTransactionCount: 0,
      articlesCount: 0,
    };
  }

  /** Forget the per-session caches (used by tests and on sign-out). */
  clearCaches(): void {
    this.userCache.clear();
    this.userPromiseCache.clear();
    this.countCache.clear();
    this.castCache.clear();
    forgetCastAuthors();
  }
}
