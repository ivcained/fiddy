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
 */

import { SnapchainNodeClient, type FetchLike } from 'farcaster-node-client';

import { classifyHostedRequest, type HostedRouteMatch } from './hostedRoutes';
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
}

/** The hosted API's error envelope. */
const errorResponse = (status: number, message: string): Response =>
  new Response(JSON.stringify({ errors: [{ message }] }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

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
  const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET'))
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

export interface NodeBackedFetchHandle {
  fetch: typeof fetch;
  reads: NodeBackedReads;
  /** Every classification made, newest last — evidence for the parity doc. */
  log: { method: string; path: string; kind: HostedRouteMatch['kind'] }[];
}

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
  // The node client takes its own narrow fetch signature (a string URL and a
  // `Uint8Array` body for protobuf writes). A platform `fetch` satisfies it at
  // runtime; the cast is the shape difference, not a behaviour one.
  const nodeClient = new SnapchainNodeClient({
    baseUrl: nodeBaseUrl,
    fetch: boundFetch as unknown as FetchLike,
  });
  const reader =
    reads ??
    new NodeBackedReads({
      node: nodeClient,
      nodeBaseUrl,
      fetchImpl: boundFetch,
      getSignedInFid,
      ...(countCap ? { countCap } : {}),
    });

  const log: NodeBackedFetchHandle['log'] = [];

  const answer = async (
    { url, method, body }: ParsedRequest,
    route: HostedRouteMatch,
  ): Promise<Response> => {
    const searchParams = url.searchParams;

    switch (route.kind) {
      case 'hosted':
        return errorResponse(501, route.why);

      case 'local':
        return localAnswer({ path: route.path, searchParams, body, reads: reader });

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
          return jsonResponse({ result: userProfile(await reader.readUser(fid), fid) });
        }

        case '/v2/user-by-username': {
          const username = searchParams.get('username') ?? '';
          const user = await reader.readUserByUsername(username);
          if (!user) {
            return errorResponse(404, `No account holds the handle ${username}.`);
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
          return jsonResponse({ result: await reader.readThread({ castHash, limit }) });
        }

        case '/v2/unseen':
          return jsonResponse({ result: await reader.readUnseen() });

        case '/v1/notifications-for-tab': {
          const groups = await reader.readNotifications({});
          return jsonResponse({ result: { notifications: groups } });
        }

        case '/v2/channel': {
          const key = searchParams.get('key') ?? '';
          return jsonResponse({ result: { channel: channelFromKey(key, reader) } });
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
            ...(requestBody.olderThan !== undefined ? { olderThan: requestBody.olderThan } : {}),
            ...(requestBody.limit !== undefined ? { limit: requestBody.limit } : {}),
            ...(requestBody.updateState !== undefined ? { updateState: requestBody.updateState } : {}),
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
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(502, `Your node did not answer this read: ${message}`);
    }
  };

  const nodeBackedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const parsed = await parseRequest(input, init);
    const route = classifyHostedRequest({ method: parsed.method, path: parsed.url.pathname });
    log.push({ method: parsed.method, path: parsed.url.pathname, kind: route.kind });
    return await answer(parsed, route);
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
  searchParams,
  body,
  reads,
}: {
  path: string;
  searchParams: URLSearchParams;
  body: unknown;
  reads: NodeBackedReads;
}): Promise<Response> => {
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
      const feeds = ((body ?? {}) as { feeds?: { feedKey?: string }[] }).feeds ?? [];
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