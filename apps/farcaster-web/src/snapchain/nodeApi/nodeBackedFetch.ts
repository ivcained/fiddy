/**
 * A `fetch` that answers the fork's hosted-API calls from your own node.
 *
 * WHY A FETCH
 *
 * The client's data layer is one class (`FarcasterApiClient`) with ~700
 * endpoint methods, and the app's pages and hooks sit on top of it. Rewriting
 * them is not the job; changing where their bytes come from is. The one seam
 * that every request already passes through is the `fetch` handed to the
 * client (`FarcasterApiClientOptions.getFetch`), so this wraps it:
 *
 *        host request → classify (hostedRoutes) → node reader → hosted shape
 *
 * Everything downstream — react-query keys, hooks, components — is untouched,
 * which is exactly what "behind a clean adapter" has to mean here.
 *
 * WHAT IT REFUSES TO DO
 *
 * - It never answers a request it has no real source for with an empty success.
 *   Those come back as the hosted API's own error envelope (HTTP 501) with a
 *   sentence saying whose job the endpoint is, so the UI can show a truthful
 *   line instead of "there is nothing here".
 * - It never falls through to `farcaster.xyz` when the node fails. Falling
 *   through would silently mix two data sources and hand the user someone
 *   else's session requirement half way through a page.
 *
 * THE ONE WRITE IT ANSWERS
 *
 * `POST /v1/generate-image-upload-url` is the media pipeline, not a read. The
 * answer names our own media host (`mediaUploadUrl`, see `mediaUpload.ts`),
 * which really stores the bytes; the composer then uploads to it and keeps the
 * URL it gets back. Everything else about media that belongs to Warpcast's
 * pipeline (video transcoding, attachment resolution) still says so.
 */

import { type FetchLike, SnapchainNodeClient } from 'farcaster-node-client';

import { classifyHostedRequest, type HostedRouteMatch } from './hostedRoutes';
import { answerLocalDraftRequest, LocalDraftStore } from './localDrafts';
import { mediaUploadUrl } from './mediaUpload';
import { NodeBackedReads, NodeCannotAnswerError } from './reads';

export interface NodeBackedFetchOptions {
  /** The node's base URL, already resolved (proxy path in the browser). */
  nodeBaseUrl: string;
  /** The signed-in FID, if this device has one. */
  getSignedInFid: () => number | undefined;
  /** Requests to the node. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Reads, injectable so tests can drive them without a network. */
  reads?: NodeBackedReads;
  /** Cap on paged counts. */
  countCap?: number;
  /** How long one read to the node may take. Defaults to NODE_READ_TIMEOUT_MS. */
  readTimeoutMs?: number;
  /**
   * Where our own media host takes uploads. Defaults to this build's media
   * host (`VITE_FIDDY_MEDIA_URL`, else https://fiddy.fun); injectable so a test
   * can point at a local instance without an env.
   */
  mediaUploadUrl?: string;
  /**
   * Where cast drafts are kept (this browser, one list per signed-in FID).
   * Defaults to a store over `localStorage`; injectable so a test can use a
   * storage of its own (the test runner has no `window`).
   */
  drafts?: LocalDraftStore;
  /**
   * Where this adapter appends what it classified. Defaults to an array of its
   * own. The provider layer passes one shared sink here so that whichever layer
   * answered a request — the node adapter, or the provider seam above it — the
   * page's debug surface reads one continuous log (`scripts/verify-media-upload.mjs`
   * depends on that: the cast payload is only visible there).
   */
  log?: RequestLogEntry[];
}

/**
 * How long a single read to your node may take before the adapter stops waiting.
 *
 * MEASURED (2026-10-20, a live public read node, exactly the feed's fan-out: 60
 * accounts × `pageSize=10` at concurrency 12): p50 **258 ms**, p90 759 ms,
 * p95 **773 ms**, p99 986 ms, max **986 ms**; a cold first read 819 ms. Ten
 * seconds is an order of magnitude above the worst healthy read, so a read that
 * has not been answered in ten seconds is a read the node is not answering —
 * while still leaving room for a slow-but-alive node.
 *
 * This is the *second* deadline, not the first: the client already times every
 * endpoint out itself (`DEFAULT_TIMEOUT_FEED_ITEMS` = 5 s, threads/notifications
 * 10 s — see `farcaster-client-data`'s `constants/endpointTimeouts`) and passes
 * that `AbortSignal` in. This one only covers reads the client gives no deadline
 * for, and any read still in flight after the client has stopped waiting.
 */
export const NODE_READ_TIMEOUT_MS = 10_000;

/** The sentence a read that ran out of time is answered with. */
export const nodeDidNotAnswerWithin = (ms: number): string => {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `Your node did not answer this read within ${seconds} s.`;
};

/** A read the adapter stopped waiting for. */
export class NodeReadTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`no reply within ${timeoutMs}ms`);
    this.name = 'NodeReadTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Is this failure the read's deadline running out?
 *
 * The node client answers a failed fetch with `NodeUnreachableError`
 * (`packages/farcaster-node-client/src/errors.ts`), which folds the cause's
 * message into its own and does not keep the cause object — so the timeout is
 * also recognised by the sentence this file writes, not only by its type.
 */
export const isNodeReadTimeout = (error: unknown): boolean =>
  error instanceof NodeReadTimeoutError ||
  (error instanceof Error && /no reply within \d+ms/.test(error.message));

/** The hosted API's error envelope. */
const errorResponse = (status: number, message: string): Response =>
  new Response(JSON.stringify({ errors: [{ message }] }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/**
 * The answer every `hosted` route gets: the hosted API's error envelope with the
 * classification's own sentence, which the UI shows as written.
 *
 * Exported because one of those routes is answered by the provider seam as well
 * as by this adapter — `POST /v2/casts`, whose refusal must read the same
 * whichever server is answering today's feed. A provider's generic write guard
 * ("Farcaster's own public server does not take writes from this client. Posting
 * goes through your node (or ours) instead") names a way to post that this
 * client does not have yet; the classification's sentence names the real one.
 */
export const hostedRefusal = (route: HostedRouteMatch): Response =>
  errorResponse(501, route.why);

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/**
 * Protocol limits, not server data: these are the Farcaster cast limits and the
 * client's own capabilities. Answering them locally is the truth — the hosted
 * API is reporting the same constants.
 */
const LOCAL_USER_APP_CONTEXT = {
  canAddLinks: true,
  showConnectedApps: false,
  signerRequestsEnabled: false,
  prompts: [] as string[],
  castActions: [] as unknown[],
  canAddCastAction: false,
  canEditAllChannels: false,
  adminForChannelKeys: [] as string[],
  modOfChannelKeys: [] as string[],
  memberOfChannelKeys: [] as string[],
  canUploadVideo: false,
  regularCastByteLimit: 320,
  longCastByteLimit: 1024,
  castEmbedLimit: 2,
  // The one notification tab this client serves. Everything else the hosted
  // API offers (invites, wallet, mini apps) is not on the node.
  notificationTabsV2: [{ id: 'default', name: 'All' }],
  higherClientEventSamplingRateEnabled: false,
  castShareEnabledMiniApps: [] as unknown[],
};

interface ParsedRequest {
  url: URL;
  method: string;
  body?: unknown;
}

const parseRequest = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<ParsedRequest> => {
  const rawUrl =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const method = (
    init?.method ??
    (typeof input === 'object' && 'method' in input ? input.method : 'GET')
  )
    .toString()
    .toUpperCase();

  let body: unknown;
  const rawBody = init?.body;
  if (typeof rawBody === 'string' && rawBody.length > 0) {
    try {
      body = JSON.parse(rawBody) as unknown;
    } catch {
      body = undefined;
    }
  }

  return { url: new URL(rawUrl, 'http://localhost'), method, body };
};

/**
 * The caller's own deadline, whether it was handed in as `init.signal` or on a
 * `Request` object. The fork's client always uses the `init` form; a `Request`
 * is accepted too because `fetch` accepts one and dropping its signal here would
 * silently restore the old "never settles" behaviour for that caller.
 */
const requestSignal = (
  input: RequestInfo | URL,
  init?: RequestInit,
): AbortSignal | undefined => {
  if (init?.signal) {
    return init.signal;
  }
  if (typeof input === 'object' && input !== null && 'signal' in input) {
    return (input as Request).signal;
  }
  return undefined;
};

export interface RequestLogEntry {
  method: string;
  path: string;
  kind: HostedRouteMatch['kind'];
  /** The status this adapter answered with, when it answered locally. */
  status?: number;
  /**
   * A bounded preview of the request body for a request this adapter answered
   * (or refused) itself — what a write asked for, e.g. the embeds a composer
   * submitted. Only kept when the debug surface is on; never sent anywhere.
   */
  bodyPreview?: string;
}

export interface NodeBackedFetchHandle {
  fetch: typeof fetch;
  reads: NodeBackedReads;
  /** Every classification made, newest last — evidence for the parity doc. */
  log: RequestLogEntry[];
}

/** How much of a write's body the debug log keeps. */
export const REQUEST_BODY_PREVIEW_LIMIT = 2000;

/**
 * A probe surface for the page, off unless a build asks for it.
 *
 * `VITE_SNAPCHAIN_DEBUG=true` puts the classification log on
 * `window.__nodeBackedRequests`, which is how `scripts/verify-media-upload.mjs`
 * reads back the cast payload the composer built: the adapter answers writes
 * inside the page, so no network trace can show what was submitted. Nothing
 * leaves the tab, and a normal build never sets the flag.
 */
export const isRequestDebugEnabled = (
  env: Record<string, unknown> = import.meta.env,
): boolean =>
  String(env.VITE_SNAPCHAIN_DEBUG ?? '')
    .trim()
    .toLowerCase() === 'true';

/**
 * The media pipeline's answer, in one place.
 *
 * The hosted API mints a signed CDN upload URL here (`POST
 * /v1/generate-image-upload-url`); we hand back our own upload endpoint
 * instead. The shape is kept (`url` + `optimisticImageId`) because that is what
 * `useFetchImageUploadUrl` and the composer read; the id is a fresh random
 * value that our own path never uses — the composer recognises this URL as ours
 * and reads the final URL back from the upload response (`mediaUpload.ts`).
 *
 * Exported because two layers can be the one that answers: the node adapter's
 * `case 'media'`, and the provider seam above it (`providers/providerFetch`),
 * which is where a request lands when the reader's live server is not a node.
 * The media pipeline belongs to neither: the same bytes must go to the same
 * host whichever machine answers today's feed, so both layers must give exactly
 * this answer, and a test can assert it without a page.
 */
export const mediaUploadAnswer = (
  target: string = mediaUploadUrl(),
): Response =>
  jsonResponse({
    result: {
      url: target,
      optimisticImageId:
        globalThis.crypto?.randomUUID?.() ??
        `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
  });

/**
 * Build the adapter. The returned `fetch` has the platform's signature, so it
 * drops straight into the client's options.
 */
export const createNodeBackedFetch = ({
  nodeBaseUrl,
  getSignedInFid,
  fetchImpl,
  reads,
  countCap,
  readTimeoutMs = NODE_READ_TIMEOUT_MS,
  mediaUploadUrl: mediaUploadUrlOption,
  drafts: draftsOption,
  log: logOption,
}: NodeBackedFetchOptions): NodeBackedFetchHandle => {
  const nodeFetch = fetchImpl ?? fetch;
  // `window.fetch` has to be called with `this === window`: passing the bare
  // function along and calling it as `this.fetch(...)` on the node client
  // throws `TypeError: Failed to execute 'fetch' on 'Window': Illegal
  // invocation` — measured, and it is what made every request the adapter
  // answered come back 502 ("your node did not answer") even though the node
  // was fine. The client's own provider binds for the same reason; do it here
  // so the seam is safe for every caller.
  const boundFetch = (nodeFetch as (...args: unknown[]) => unknown).bind(
    globalThis,
  ) as typeof fetch;
  // Every read to the node goes out under this deadline, so a node that never
  // answers fails as a read instead of holding a socket open: the abort reaches
  // the fetch, and the failure is named as a timeout rather than as whatever
  // the engine calls an abort. The node client's own timeout is set to the same
  // number below, so a read has one deadline, from one place.
  const readFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const controller = new AbortController();
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, readTimeoutMs);
    return (
      boundFetch(input, {
        ...(init ?? {}),
        signal: controller.signal,
      }) as Promise<Response>
    )
      .catch((error: unknown) => {
        // Our deadline, or the node client's identical one, cut the read.
        if (timedOut || init?.signal?.aborted) {
          throw new NodeReadTimeoutError(readTimeoutMs);
        }
        throw error;
      })
      .finally(() => clearTimeout(deadline));
  }) as typeof fetch;
  // The node client takes its own narrow fetch signature (a string URL and a
  // `Uint8Array` body for protobuf writes). A platform `fetch` satisfies it at
  // runtime; the cast is the shape difference, not a behaviour one.
  const nodeClient = new SnapchainNodeClient({
    baseUrl: nodeBaseUrl,
    fetch: readFetch as unknown as FetchLike,
    timeoutMs: readTimeoutMs,
  });
  const reader =
    reads ??
    new NodeBackedReads({
      node: nodeClient,
      nodeBaseUrl,
      fetchImpl: readFetch,
      getSignedInFid,
      ...(countCap ? { countCap } : {}),
    });

  const log: RequestLogEntry[] = logOption ?? [];
  // Off unless a build sets VITE_SNAPCHAIN_DEBUG=true; see isRequestDebugEnabled.
  const debugEnabled = isRequestDebugEnabled();
  if (debugEnabled) {
    (globalThis as unknown as Record<string, unknown>).__nodeBackedRequests =
      log;
  }

  const mediaUploadTarget = mediaUploadUrlOption ?? mediaUploadUrl();
  const mediaAnswer = (): Response => mediaUploadAnswer(mediaUploadTarget);
  // One store per adapter; the provider seam keeps its own over the same
  // browser storage, so both layers read the same drafts.
  const drafts = draftsOption ?? new LocalDraftStore();

  const answer = async (
    { url, method, body }: ParsedRequest,
    route: HostedRouteMatch,
  ): Promise<Response> => {
    const searchParams = url.searchParams;

    switch (route.kind) {
      case 'hosted':
        return hostedRefusal(route);

      case 'media':
        return mediaAnswer();

      case 'local':
        return localAnswer({
          path: route.path,
          method,
          searchParams,
          body,
          reads: reader,
          drafts,
        });

      case 'node':
        break;
    }

    try {
      switch (route.path) {
        case '/v2/me': {
          const fid = reader.requireFid();
          const user = await reader.readUser(fid);
          return jsonResponse({ result: { user, enabledFeatureFlags: [] } });
        }

        case '/v2/user':
        case '/v2/user-by-fid': {
          const fid = Number(searchParams.get('fid'));
          if (!Number.isFinite(fid)) {
            return errorResponse(400, 'This read needs a fid.');
          }
          return jsonResponse({
            result: userProfile(await reader.readUser(fid), fid),
          });
        }

        case '/v2/user-by-username': {
          const username = searchParams.get('username') ?? '';
          const user = await reader.readUserByUsername(username);
          if (!user) {
            return errorResponse(
              404,
              `No account holds the handle ${username}.`,
            );
          }
          return jsonResponse({ result: userProfile(user, user.fid) });
        }

        case '/v2/user-casts': {
          const fid = Number(searchParams.get('fid'));
          const limit = Number(searchParams.get('limit') ?? 25);
          const casts = await reader.readUserCasts({ fid, limit });
          return jsonResponse({ result: { casts }, next: {} });
        }

        case '/v2/verifications': {
          const fid = Number(searchParams.get('fid'));
          const verifications = await reader.readVerifications(fid);
          return jsonResponse({ result: { verifications } });
        }

        case '/v2/thread-casts': {
          const castHash = searchParams.get('castHash') ?? '';
          const limit = Number(searchParams.get('limit') ?? 15);
          return jsonResponse({
            result: await reader.readThread({ castHash, limit }),
          });
        }

        case '/v2/unseen':
          return jsonResponse({ result: await reader.readUnseen() });

        case '/v1/notifications-for-tab': {
          const groups = await reader.readNotifications({});
          return jsonResponse({ result: { notifications: groups } });
        }

        case '/v2/channel': {
          const key = searchParams.get('key') ?? '';
          return jsonResponse({
            result: { channel: channelFromKey(key, reader) },
          });
        }

        case '/v2/feed-items': {
          const requestBody = (body ?? {}) as {
            feedKey?: string;
            feedType?: string;
            olderThan?: number;
            limit?: number;
            updateState?: boolean;
          };
          const result = await reader.readFeed({
            feedKey: requestBody.feedKey ?? 'home',
            ...(requestBody.feedType ? { feedType: requestBody.feedType } : {}),
            ...(requestBody.olderThan !== undefined
              ? { olderThan: requestBody.olderThan }
              : {}),
            ...(requestBody.limit !== undefined
              ? { limit: requestBody.limit }
              : {}),
            ...(requestBody.updateState !== undefined
              ? { updateState: requestBody.updateState }
              : {}),
          });
          return jsonResponse({ result });
        }

        default:
          return errorResponse(
            501,
            `No node-backed reader has been written for ${route.path} yet.`,
          );
      }
    } catch (error) {
      if (error instanceof NodeCannotAnswerError) {
        // The hosted API's own error envelope, so the client turns this into a
        // HandledFetchError with this sentence in `message` — a component with
        // an error branch can show it as written.
        return errorResponse(501, error.message);
      }
      if (isNodeReadTimeout(error)) {
        // A node that never answers is the one failure the generic 502 sentence
        // reads badly for: say how long the wait was, because that is the fact
        // the user needs (the node is not slow, it is silent).
        return errorResponse(502, nodeDidNotAnswerWithin(readTimeoutMs));
      }
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(
        502,
        `Your node did not answer this read: ${message}`,
      );
    }
  };

  /**
   * Wait for `work`, but stop when the caller's own deadline fires.
   *
   * The fork's client times every endpoint out itself: it builds an
   * `AbortController`, hands the signal to the fetch it was given, and aborts at
   * the endpoint's configured timeout (`DEFAULT_TIMEOUT_FEED_ITEMS` = 5 s, and
   * 10 s for threads and notifications — `farcaster-client-data`'s
   * `constants/endpointTimeouts`). MEASURED, at the state of this card: that
   * abort did nothing at all, because this adapter never looked at
   * `init.signal` — the client's own promise never settled, no request ever
   * failed, and the feed stayed in its loading state for as long as the page was
   * open. Honouring it is what makes the client's deadline real.
   *
   * The read itself is not cancelled mid-flight: it is already bounded by the
   * per-read deadline above, and its failure (or its success) is simply no
   * longer what the caller is waiting for.
   */
  const raceClientDeadline = (
    work: Promise<Response>,
    signal: AbortSignal | undefined,
    startedAt: number,
  ): Promise<Response> => {
    if (!signal) {
      return work;
    }
    if (signal.aborted) {
      // Nobody is waiting for this read any more, so its outcome is only
      // interesting to the log; it must not surface as an unhandled rejection.
      void work.catch(() => undefined);
      return Promise.resolve(
        errorResponse(502, nodeDidNotAnswerWithin(Date.now() - startedAt)),
      );
    }
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => {
        resolve(
          errorResponse(502, nodeDidNotAnswerWithin(Date.now() - startedAt)),
        );
      };
      signal.addEventListener('abort', onAbort, { once: true });
      work.then(
        (response) => {
          signal.removeEventListener('abort', onAbort);
          resolve(response);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  };

  const nodeBackedFetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const startedAt = Date.now();
    const parsed = await parseRequest(input, init);
    const route = classifyHostedRequest({
      method: parsed.method,
      path: parsed.url.pathname,
    });
    const entry: RequestLogEntry = {
      method: parsed.method,
      path: parsed.url.pathname,
      kind: route.kind,
    };
    log.push(entry);
    const response = await raceClientDeadline(
      answer(parsed, route),
      requestSignal(input, init),
      startedAt,
    );
    entry.status = response.status;
    // What a request the adapter answered itself actually carried. The request
    // never leaves the page, so this is the only way a probe can see the cast
    // payload a composer built. A write is kept even when the node is the one
    // asked: what a write was going to submit is the question a probe has, and
    // reading it costs nothing when the debug surface is on.
    const isWrite = parsed.method !== 'GET' && parsed.method !== 'HEAD';
    if (
      debugEnabled &&
      parsed.body !== undefined &&
      (route.kind !== 'node' || isWrite)
    ) {
      try {
        entry.bodyPreview = JSON.stringify(parsed.body).slice(
          0,
          REQUEST_BODY_PREVIEW_LIMIT,
        );
      } catch {
        /* a body that cannot be serialised is not worth failing the request for */
      }
    }
    return response;
  }) as typeof fetch;

  return { fetch: nodeBackedFetch, reads: reader, log };
};

/** `ApiUserProfile`: the user plus the fields the profile page reads. */
const userProfile = (
  user: Awaited<ReturnType<NodeBackedReads['readUser']>>,
  fid: number,
) => ({
  user,
  collectionsOwned: [],
  // `custodyAddress` is an on-chain fact this read does not fetch. Empty rather
  // than invented; nothing in the signed-in surfaces renders it.
  extras: { fid, custodyAddress: '' },
});

/**
 * A channel object from its key.
 *
 * The node has no channel directory (measured: `/v1/channel` and
 * `/v1/channelDetails` are 404 on a live node), so the name and image the hosted
 * API would return cannot be read. What *can* be stated is the key and the
 * parent URL the channel's casts carry; everything else is left at its neutral
 * value instead of being made up.
 */
const channelFromKey = (key: string, reader: NodeBackedReads) => ({
  type: 'channel' as const,
  key,
  name: key,
  showCastSourceLabels: false,
  showCastTags: false,
  sectionRank: 0,
  subscribable: false,
  viewerContext: {
    following: false,
    isMember: false,
    hasUnseenItems: false,
  },
  // Kept in the object so callers can see where the casts come from without
  // reading this file.
  parentUrl: reader.channelParentUrl(key),
});

const localAnswer = async ({
  path,
  method,
  searchParams,
  body,
  reads,
  drafts,
}: {
  path: string;
  method: string;
  searchParams: URLSearchParams;
  body: unknown;
  reads: NodeBackedReads;
  drafts: LocalDraftStore;
}): Promise<Response> => {
  // Drafts first: this device's own state, answered from the real store in
  // `localDrafts.ts`. A store that cannot be written says so (501) rather than
  // reporting a save that did not happen.
  const draftAnswer = answerLocalDraftRequest(
    { method, path, searchParams, body, fid: reads.signedInFid() },
    drafts,
  );
  if (draftAnswer) {
    return draftAnswer;
  }

  switch (path) {
    case '/v2/user-app-context':
      return jsonResponse({ result: { context: LOCAL_USER_APP_CONTEXT } });

    case '/v2/user-preferences':
      // Every field of these preferences is an email toggle. This client sends
      // no email, so the honest answer is "no preferences", not a fake set.
      return jsonResponse({ result: { preferences: {} } });

    case '/v2/snap/blocklist':
    case '/v2/frame-blocklist':
      return jsonResponse({ result: [] });

    case '/v2/mark-all-notifications-read':
    case '/v2/mark-tab-notifications-seen': {
      const fid = reads.requireFid();
      reads.markSeen(fid, 'notifications');
      return jsonResponse({ result: { success: true } });
    }

    case '/v2/feed-seen': {
      const feeds =
        ((body ?? {}) as { feeds?: { feedKey?: string }[] }).feeds ?? [];
      const fid = reads.requireFid();
      for (const feed of feeds) {
        reads.markSeen(fid, feed.feedKey ?? 'home');
      }
      return jsonResponse({ result: { success: true } });
    }

    default:
      // A local route with no local answer is a routing bug, and saying so is
      // better than an empty 200.
      return errorResponse(500, `No local answer for ${path}.`);
  }
};

export { NodeCannotAnswerError };
