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
 *   farcaster-public   the same request path at `api.farcaster.xyz`, whose
 *                      public reads already speak the hosted shapes — no mapper
 *                      needed, and no credential forwarded. Its signed-in
 *                      endpoints answer 401, which this turns into a sentence
 *                      saying that read needs a node.
 *
 * Two rules this file exists to enforce:
 *
 *   - A reader's session token never travels to a provider that is not what it
 *     was minted for. `Authorization`, `Cookie` and the fork's own device
 *     headers are stripped from anything that is not a node-backed read.
 *   - No provider change is silent. Every switch was decided by the failover
 *     engine and carries a reason the pill renders; this file only obeys.
 */

import { hostedApiPath } from '~/snapchain/nodeApi/hostedRoutes';
import { createNodeBackedFetch } from '~/snapchain/nodeApi/nodeBackedFetch';

import { FARCASTER_PUBLIC_BASE_URL, NEYNAR_BASE_URL } from './catalog';
import { answerFromNeynar } from './neynarMap';
import { neynarApiKeyFromEnv } from './preferences';
import type { NodeProvider } from './providerTypes';

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

export const createProviderBackedFetch = ({
  getActiveProvider,
  getSignedInFid,
  nodeBaseUrl,
  fetchImpl,
  neynarApiKey,
  countCap,
  onRead,
  createNodeAdapter = createNodeBackedFetch,
}: ProviderBackedFetchOptions): ProviderBackedFetchHandle => {
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
    });
    adapters.set(baseUrl, created);
    return created;
  };

  const log: ProviderBackedFetchHandle['log'] = [];

  /** Same request, at Farcaster's own public server, without our session. */
  const answerFromFarcasterPublic = async (
    { url, method }: ParsedRequest,
    provider: NodeProvider,
  ): Promise<Response> => {
    const endpoint = hostedApiPath(url.pathname);

    if (method !== 'GET' && method !== 'HEAD') {
      return errorResponse(
        501,
        `${method} ${endpoint} is a write, and Farcaster's own public server does not take writes from this client. Posting goes through your node (or ours) instead.`,
      );
    }

    const target = `${provider.baseUrl || FARCASTER_PUBLIC_BASE_URL}${endpoint}${url.search}`;
    let response: Response;
    try {
      response = await boundFetch(target, {
        method: 'GET',
        credentials: 'omit',
      });
    } catch (error) {
      return errorResponse(
        502,
        `Farcaster's own public server did not answer: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (response.status === 401 || response.status === 403) {
      return errorResponse(
        501,
        `${endpoint} needs a signed-in session, which only Farcaster's own app can hold. This client reads that from a node — not from the public server.`,
      );
    }

    // The body is already in the hosted shapes the client expects, so it is
    // passed through as-is; only the status and content type are re-stated.
    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: {
        'content-type':
          response.headers.get('content-type') ??
          'application/json; charset=utf-8',
      },
    });
  };

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

      case 'farcaster-public':
        return answerFromFarcasterPublic(parsed, provider);

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

    log.push({ path, providerId: provider.id, kind: provider.kind });

    // `init.headers` is deliberately not forwarded to a provider that is not a
    // node: what the client attaches is this device's session with Fiddy's own
    // API, and handing that to a third-party server is how a token leaks.
    const response = await answer(parsed, provider);
    // A 5xx is the provider failing; a 4xx is this client asking for something
    // that provider does not serve, which is our bug to fix, not a reason to
    // move the reader's feed to another machine.
    onRead?.(provider.id, response.status < 500);
    return response;
  }) as typeof fetch;

  return { fetch: providerBackedFetch, log };
};
