/**
 * A fixture-backed fake Snapchain node.
 *
 * Every fixture in `./fixtures` is a page captured from a live public read node
 * (HTTP `GET /v1/…`, recorded 2026-10-20) — real FIDs, real hashes, real
 * signatures, so the code under test decodes actual node JSON rather than a
 * shape somebody typed by hand.
 *
 * ONE PAGE THEN THE END. A node's `pageSize` is a minimum, not a maximum (a
 * request for 3 can come back with 6), and a page token of `[null,null]` means
 * "nothing after this". The fake therefore answers the first request for a
 * route with the recorded page and every later request for the same route with
 * an empty page and that terminal token — which is what the real node does for
 * an account whose log fits in one page.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Json = Record<string, unknown>;

const read = (name: string): Json =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8')) as Json;

export const TERMINAL_PAGE_TOKEN = 'W251bGwsbnVsbF0=';

export interface FakeNodeRequest {
  path: string;
  params: URLSearchParams;
}

export interface FixtureNodeOptions {
  /** Answer for a route with no fixture. `undefined` → 404. */
  fallback?: (request: FakeNodeRequest) => Json | undefined;
  /** Records every route served, for assertions about what was read. */
  log?: string[];
}

const byName = (params: URLSearchParams): Json =>
  read('userNameProofByName.dwr.json') as Json;

/**
 * A `fetch` that speaks the node's own routes, backed by the recorded pages.
 */
export const createFixtureNodeFetch = ({ fallback, log }: FixtureNodeOptions = {}) => {
  const served = new Set<string>();

  const route = (request: FakeNodeRequest): Json | undefined => {
    const { path, params } = request;
    const key = `${path}?${params.toString()}`;

    // A request that carries a page token is asking for the page AFTER the
    // recorded one. The recording is one page, so the honest answer is an
    // empty page and a terminal token — never the recorded page again, which
    // would double every counted number (the counters page until they see a
    // terminal token).
    const pageToken = params.get('pageToken');
    if (pageToken !== null && pageToken.length > 0) {
      return { messages: [], nextPageToken: TERMINAL_PAGE_TOKEN };
    }

    // One page per route: later pages are empty and terminal.
    if (served.has(key)) {
      return { messages: [], nextPageToken: TERMINAL_PAGE_TOKEN };
    }

    // The captured pages are one account's (fid 3). Anything else is answered
    // with an empty page rather than with somebody else's data.
    const fidParam = params.get('fid') ?? params.get('target_fid');
    const isRecordedFid = fidParam === '3' || fidParam === '2';
    const fidScoped = [
      '/v1/userDataByFid',
      '/v1/linksByFid',
      '/v1/linksByTargetFid',
      '/v1/castsByFid',
      '/v1/castsByMention',
      '/v1/verificationsByFid',
    ];
    if (fidScoped.includes(path) && fidParam !== null && !isRecordedFid) {
      return { messages: [], nextPageToken: TERMINAL_PAGE_TOKEN };
    }

    switch (path) {
      case '/v1/userDataByFid':
        return read('userDataByFid.fid3.json');
      case '/v1/linksByFid':
        return read('linksByFid.fid3.follow.json');
      case '/v1/linksByTargetFid':
        return read('linksByTargetFid.fid3.follow.json');
      case '/v1/userNameProofByName':
        return byName(params);
      case '/v1/verificationsByFid':
        return read('verificationsByFid.fid2.json');
      case '/v1/castsByFid':
        return read('castsByFid.fid3.json');
      case '/v1/castsByMention':
        return read('castsByMention.fid3.json');
      case '/v1/castById':
        return read('castById.sample.json');
      case '/v1/castsByParent': {
        const url = params.get('url') ?? '';
        return url.includes('~/channel/')
          ? read('castsByParent.channel.dev.json')
          : read('castsByParent.sample.json');
      }
      case '/v1/reactionsByCast':
        return read('reactionsByCast.sample.json');
      default:
        return fallback?.(request);
    }
  };

  const fakeFetch = async (input: string) => {
    const url = new URL(input, 'http://node.test');
    const params = url.searchParams;
    const key = `${url.pathname}?${params.toString()}`;
    log?.push(`${url.pathname}${url.search}`);

    const body = route({ path: url.pathname, params });
    if (body === undefined) {
      served.add(key);
      return new Response('Not Found', { status: 404 });
    }

    served.add(key);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  return fakeFetch as unknown as typeof fetch;
};