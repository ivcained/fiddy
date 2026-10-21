/**
 * The one `fetch` the client is handed, now provider-aware.
 *
 * Before this file the client had a single seam: a `fetch` that answered the
 * hosted API's requests from one node (`nodeApi/nodeBackedFetch`). This wraps
 * that seam once more so *which server* answers can change while the app is
 * open, without the client being rebuilt:
 *
 *   client request → the live provider → that provider's own way of answering
 *
 * How each provider answers, honestly:
 *
 *   snapchain          the existing node-backed adapter, pointed at that
 *                      node's address. This is the real thing: the signed-in
 *                      reads (feed, unseen, notifications) only exist here.
 *   neynar             the thin mapper in `neynarMap.ts`, for the reads Neynar
 *                      actually serves. Everything else is refused by name.
 *   farcaster-public   `api.farcaster.xyz`. A page cannot read it at all
 *                      (measured 2026-10-21; see `publicServerOffTheWeb`), so
 *                      its requests are refused here in the words of their own
 *                      classification: no cross-origin fetch is fired at an
 *                      origin that would refuse it, and no credential is ever
 *                      forwarded anywhere.
 *
 * Two rules this file exists to enforce:
 *
 *   - A reader's session token never travels to a provider that is not what it
 *     was minted for. `Authorization`, `Cookie` and the fork's own device
 *     headers are stripped from anything that is not a node-backed read.
 *   - No provider change is silent. Every switch was decided by the failover
 *     engine and carries a reason the pill renders; this file only obeys.
 *
 * One request is never a provider's to answer: the media pipeline (`POST
 * /v1/generate-image-upload-url`, classified `media`) is answered here, before
 * any provider sees it, because the bytes belong to our own host rather than to
 * whichever machine is answering today's feed. A provider that takes no writes
 * would otherwise turn "post a photo" into a 501. Cast drafts are the second:
 * they are this device's own state (`localDrafts.ts`), so the draft write the
 * composer makes before every Cast is answered here too, for the same reason
 * (`local`, see `answerLocalDraftRequest`).
 */

import {
  classifyHostedRequest,
  hostedApiPath,
} from '~/snapchain/nodeApi/hostedRoutes';
import {
  answerLocalDraftRequest,
  LocalDraftStore,
} from '~/snapchain/nodeApi/localDrafts';
import {
  createNodeBackedFetch,
  hostedRefusal,
  isRequestDebugEnabled,
  mediaUploadAnswer,
  REQUEST_BODY_PREVIEW_LIMIT,
  type RequestLogEntry,
} from '~/snapchain/nodeApi/nodeBackedFetch';

import { NEYNAR_BASE_URL } from './catalog';
import { answerFromNeynar } from './neynarMap';
import { neynarApiKeyFromEnv } from './preferences';
import type { NodeProvider } from './providerTypes';
import {
  PUBLIC_SERVER_OFF_THE_WEB_STATUS,
  publicServerCannotAnswer,
} from './publicServerOffTheWeb';

export interface ProviderBackedFetchOptions {
  /** Which provider is live right now, asked fresh on every request. */
  getActiveProvider: () => NodeProvider | null;
  /** The signed-in FID, if this device has one. */
  getSignedInFid: () => number | undefined;
  /** The address this build was configured with, used when nothing else is live. */
  nodeBaseUrl: string;
  fetchImpl?: typeof fetch;
  /** Neynar key from the build's own configuration; injectable for tests. */
  neynarApiKey?: string | null;
  /** Cap on paged counts, passed through to the node-backed readers. */
  countCap?: number;
  /**
   * Called after every request a provider answered, with whether that answer was
   * usable. This is how "repeated errors" reaches the failover engine: a server
   * can pass a status check and still fail every read, and only the reads know.
   */
  onRead?: (providerId: string, ok: boolean) => void;
  /** Test seam: stand in for the node-backed adapter. */
  createNodeAdapter?: typeof createNodeBackedFetch;
  /**
   * The classification sink, shared with every node adapter this seam builds —
   * one request, one log, whichever layer answered. Injectable for tests; the
   * page's debug surface (`window.__nodeBackedRequests`, on with
   * `VITE_SNAPCHAIN_DEBUG=true`) reads this same array.
   */
  requestLog?: RequestLogEntry[];
  /**
   * Where cast drafts are kept. Defaults to a store over this browser's own
   * storage; injectable so a test can use a storage of its own.
   */
  drafts?: LocalDraftStore;
}

export interface ProviderBackedFetchHandle {
  fetch: typeof fetch;
  /** Every request, with the provider that answered it — evidence, not logs. */
  log: { path: string; providerId: string; kind: NodeProvider['kind'] }[];
}

interface ParsedRequest {
  url: URL;
  method: string;
  body?: unknown;
}

/** Same parsing rules as the node-backed adapter, for the same reasons. */
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

const errorResponse = (status: number, message: string): Response =>
  new Response(JSON.stringify({ errors: [{ message }] }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/**
 * Headers that belong to this device's session with Fiddy's own API. They are
 * never replayed to a third-party server: the non-node branches below build
 * their own requests and pass no headers through at all.
 */

/**
 * The sink a write's refusal goes to when the seam answers it itself; the same
 * shape the adapter keeps.
 */
const recordSelfAnswered = (
  requestLog: RequestLogEntry[],
  parsed: ParsedRequest,
  route: { path: string; kind: RequestLogEntry['kind'] },
  response: Response,
  bodyPreview: { bodyPreview?: string },
): void => {
  requestLog.push({
    method: parsed.method,
    path: parsed.url.pathname,
    kind: route.kind,
    status: response.status,
    ...bodyPreview,
  });
};

export const createProviderBackedFetch = ({
  getActiveProvider,
  getSignedInFid,
  nodeBaseUrl,
  fetchImpl,
  neynarApiKey,
  countCap,
  onRead,
  createNodeAdapter = createNodeBackedFetch,
  requestLog: requestLogOption,
  drafts: draftsOption,
}: ProviderBackedFetchOptions): ProviderBackedFetchHandle => {
  const drafts = draftsOption ?? new LocalDraftStore();
  const nodeFetch = fetchImpl ?? fetch;
  const boundFetch = (nodeFetch as (...args: unknown[]) => unknown).bind(
    globalThis,
  ) as typeof fetch;

  // One adapter per node address: building one constructs a client and its
  // readers, so it is worth keeping between requests. A provider that is not a
  // node never lands here.
  const adapters = new Map<string, ReturnType<typeof createNodeBackedFetch>>();
  const nodeAdapter = (
    baseUrl: string,
  ): ReturnType<typeof createNodeBackedFetch> => {
    const existing = adapters.get(baseUrl);
    if (existing) {
      return existing;
    }
    const created = createNodeAdapter({
      nodeBaseUrl: baseUrl,
      getSignedInFid,
      fetchImpl: boundFetch,
      ...(countCap ? { countCap } : {}),
      // The same draft store the seam answers with, so a draft written while a
      // node was live is the draft read back when it is not.
      drafts,
      // One sink for the whole client: a request the node adapter answers and a
      // request this seam answers land in the same list, in order.
      log: requestLog,
    });
    adapters.set(baseUrl, created);
    return created;
  };

  const log: ProviderBackedFetchHandle['log'] = [];
  const requestLog: RequestLogEntry[] = requestLogOption ?? [];
  const debugEnabled = isRequestDebugEnabled();
  if (debugEnabled) {
    (globalThis as unknown as Record<string, unknown>).__nodeBackedRequests =
      requestLog;
  }

  /** What a write was about to submit, kept only on the debug surface. */
  const bodyPreviewOf = (parsed: ParsedRequest): { bodyPreview?: string } => {
    const isWrite = parsed.method !== 'GET' && parsed.method !== 'HEAD';
    if (!debugEnabled || parsed.body === undefined || !isWrite) {
      return {};
    }
    try {
      return {
        bodyPreview: JSON.stringify(parsed.body).slice(
          0,
          REQUEST_BODY_PREVIEW_LIMIT,
        ),
      };
    } catch {
      return {};
    }
  };

  // (Farcaster's own public server used to be answered right here, by fetching
  // the same path cross-origin and passing the hosted body through. That is
  // gone: measured 2026-10-21, a page on another origin cannot read that server
  // at all, so every one of those fetches came back a CORS failure while the
  // client showed "Failed to fetch". What replaced it is `publicServerOffTheWeb`
  // and the refusal in `providerBackedFetch`.)

  const answer = async (
    parsed: ParsedRequest,
    provider: NodeProvider,
  ): Promise<Response> => {
    switch (provider.kind) {
      case 'neynar': {
        const key = neynarApiKey ?? neynarApiKeyFromEnv();
        if (key === null) {
          return errorResponse(
            501,
            'Neynar needs your own API key before it can answer. Run scripts/fiddy-setup.command to add one, or pick another server.',
          );
        }
        return answerFromNeynar({
          path: hostedApiPath(parsed.url.pathname),
          searchParams: parsed.url.searchParams,
          signedInFid: getSignedInFid(),
          apiKey: key,
          fetchImpl: boundFetch,
          baseUrl: provider.baseUrl || NEYNAR_BASE_URL,
        });
      }

      // `farcaster-public` never reaches this switch: the caller refuses its
      // requests in place, because a page cannot read that server at all (see
      // `publicServerOffTheWeb`, and the guard in `providerBackedFetch`).

      case 'snapchain':
      default: {
        const adapter = nodeAdapter(provider.baseUrl || nodeBaseUrl);
        return adapter.fetch(parsed.url.toString(), {
          method: parsed.method,
          ...(parsed.body !== undefined
            ? { body: JSON.stringify(parsed.body) }
            : {}),
        });
      }
    }
  };

  const providerBackedFetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const parsed = await parseRequest(input, init);
    const provider = getActiveProvider();
    const path = hostedApiPath(parsed.url.pathname);
    const route = classifyHostedRequest({ method: parsed.method, path });

    // The media pipeline is ours, not a provider's read.
    //
    // MEASURED (2026-10-21, headless Chrome, the real composer): with
    // `farcaster-public` as the live provider the mint never reached the node
    // adapter, so the `media` route added there was unreachable and "post a
    // photo" failed with that provider's write guard
    // (`501 POST /v1/generate-image-upload-url is a write …`) — the same
    // user-visible failure, one layer up. Answering it here, before any
    // provider sees it, makes the answer the same whichever machine answers
    // today's feed: the bytes always go to our own host.
    if (route.kind === 'media') {
      const response = mediaUploadAnswer();
      recordSelfAnswered(
        requestLog,
        parsed,
        route,
        response,
        bodyPreviewOf(parsed),
      );
      return response;
    }

    // A cast draft is this device's own state, so it is answered here too —
    // before any provider sees it. A provider that takes no writes would
    // otherwise refuse `POST /v2/draft-caststorms` as a write with a sentence
    // about itself, in front of every Cast attempt, for a request that never
    // had to leave the browser at all (measured on `farcaster-public`; the same
    // shape of failure the media mint had one endpoint over).
    if (route.kind === 'local') {
      const local = answerLocalDraftRequest(
        {
          method: parsed.method,
          path,
          body: parsed.body,
          searchParams: parsed.url.searchParams,
          fid: getSignedInFid(),
        },
        drafts,
      );
      if (local) {
        recordSelfAnswered(
          requestLog,
          parsed,
          route,
          local,
          bodyPreviewOf(parsed),
        );
        return local;
      }
    }

    // The cast submit itself is refused in one set of words, whichever server
    // is live: no provider in this client's catalog posts a cast (a node has no
    // writer wired up, and the public server and Neynar take no writes), and a
    // provider's generic write guard would name a way to post that this device
    // does not have yet. The classification's sentence says what is really
    // missing (a signing app key), and the composer shows it to the person who
    // pressed Cast.
    if (
      route.kind === 'hosted' &&
      route.method === 'POST' &&
      path === '/v2/casts'
    ) {
      const refusal = hostedRefusal(route);
      recordSelfAnswered(
        requestLog,
        parsed,
        route,
        refusal,
        bodyPreviewOf(parsed),
      );
      return refusal;
    }

    if (provider === null) {
      // Nothing has been measured yet (or the reader's list is empty). The
      // build's own node is the honest answer, exactly as before this file.
      log.push({ path, providerId: 'build-configured', kind: 'snapchain' });
      return nodeAdapter(nodeBaseUrl).fetch(parsed.url.toString(), {
        method: parsed.method,
        ...(parsed.body !== undefined
          ? { body: JSON.stringify(parsed.body) }
          : {}),
      });
    }

    // Farcaster's own public server cannot be read from a web page at all —
    // measured on the live site: eleven distinct reads, every one of them
    // refused by CORS (see `publicServerOffTheWeb`). So it is refused here
    // rather than asked. The reader gets a sentence about the read itself
    // instead of "Failed to fetch", and no request leaves the page for an
    // origin that will throw it away.
    //
    // It counts as a failed read through `onRead`, exactly like any other 5xx
    // answer: this server did not answer the read, and the engine should be
    // able to move the reader onto a node because of it. (The measurement also
    // fixed the other half of this: `probeFarcasterPublic` now asks a read this
    // client actually makes, so in a page this server is measured as not
    // answering and is never made live in the first place.)
    if (provider.kind === 'farcaster-public') {
      // The routing log keeps it: this request WAS routed to that provider, and
      // the provider could not answer it — that is the fact worth recording.
      log.push({ path, providerId: provider.id, kind: provider.kind });
      const refusal = errorResponse(
        PUBLIC_SERVER_OFF_THE_WEB_STATUS,
        publicServerCannotAnswer(route),
      );
      recordSelfAnswered(
        requestLog,
        parsed,
        route,
        refusal,
        bodyPreviewOf(parsed),
      );
      onRead?.(provider.id, refusal.status < 500);
      return refusal;
    }

    log.push({ path, providerId: provider.id, kind: provider.kind });

    // `init.headers` is deliberately not forwarded to a provider that is not a
    // node: what the client attaches is this device's session with Fiddy's own
    // API, and handing that to a third-party server is how a token leaks.
    const response = await answer(parsed, provider);
    if (provider.kind !== 'snapchain') {
      // A provider that is not a node answers inside this seam, so nothing else
      // would record what it was asked, or what a write was about to submit.
      // (A node provider's requests are recorded by the adapter itself, which
      // was handed this same sink.)
      requestLog.push({
        method: parsed.method,
        path: parsed.url.pathname,
        kind: route.kind,
        status: response.status,
        ...bodyPreviewOf(parsed),
      });
    }
    // A 5xx is the provider failing; a 4xx is this client asking for something
    // that provider does not serve, which is our bug to fix, not a reason to
    // move the reader's feed to another machine.
    onRead?.(provider.id, response.status < 500);
    return response;
  }) as typeof fetch;

  return { fetch: providerBackedFetch, log };
};
