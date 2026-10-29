import { type FetchLike, SnapchainNodeClient } from 'farcaster-node-client';
import { describe, expect, it } from 'vitest';

import { NodeBackedReads } from '~/snapchain/nodeApi';

import { offlineEmbedKinds } from './fakeEmbedKinds';
import { createFixtureNodeFetch } from './fakeNodeFetch';

const VIEWER = 3;
const PROFILE = 327154;

type Edge = 'present' | 'missing' | 'failure';

const buildHarness = ({
  fid = VIEWER as number | null,
  forward = 'missing' as Edge,
  reverse = 'missing' as Edge,
} = {}) => {
  const log: string[] = [];
  const fixture = createFixtureNodeFetch({
    log,
    fallback: (request) => {
      if (request.path !== '/v1/linkById') {
        return undefined;
      }
      const source = Number(request.params.get('fid'));
      const target = Number(request.params.get('target_fid'));
      const answer =
        source === VIEWER && target === PROFILE
          ? forward
          : source === PROFILE && target === VIEWER
            ? reverse
            : 'missing';
      return answer === 'present'
        ? { data: { type: 'MESSAGE_TYPE_LINK_ADD', fid: source } }
        : undefined;
    },
  });
  const fetchImpl = (async (input: string) => {
    const url = new URL(input, 'http://node.test');
    if (url.pathname === '/v1/linkById') {
      const source = Number(url.searchParams.get('fid'));
      const target = Number(url.searchParams.get('target_fid'));
      const answer =
        source === VIEWER && target === PROFILE
          ? forward
          : source === PROFILE && target === VIEWER
            ? reverse
            : 'missing';
      if (answer === 'failure') {
        return new Response('node unavailable', { status: 500 });
      }
    }
    return fixture(input);
  }) as unknown as typeof fetch;

  const nodeBaseUrl = 'http://node.test';
  const reads = new NodeBackedReads({
    node: new SnapchainNodeClient({
      baseUrl: nodeBaseUrl,
      fetch: fetchImpl as unknown as FetchLike,
    }),
    nodeBaseUrl,
    fetchImpl,
    embedKinds: offlineEmbedKinds(),
    getSignedInFid: () => fid ?? undefined,
  });

  return { log, reads };
};

const linkRequests = (log: string[], source: number, target: number) =>
  log.filter((entry) => {
    if (!entry.startsWith('/v1/linkById')) {
      return false;
    }
    const params = new URL(entry, 'http://node.test').searchParams;
    return (
      params.get('fid') === String(source) &&
      params.get('target_fid') === String(target)
    );
  });

describe('a node-backed profile reads both viewer follow directions', () => {
  it('asks viewer → profile and profile → viewer, preserving a known false', async () => {
    const { log, reads } = buildHarness({ forward: 'present' });

    const user = await reads.readUser(PROFILE);

    expect(user.viewerContext).toEqual({
      following: true,
      followedBy: false,
    });
    expect(linkRequests(log, VIEWER, PROFILE)).toHaveLength(1);
    expect(linkRequests(log, PROFILE, VIEWER)).toHaveLength(1);
  });

  it('lights up Follows you when only the reverse edge exists', async () => {
    const { reads } = buildHarness({ reverse: 'present' });

    expect((await reads.readUser(PROFILE)).viewerContext).toEqual({
      following: false,
      followedBy: true,
    });
  });

  it('makes no edge reads when signed out or viewing yourself', async () => {
    const signedOut = buildHarness({ fid: null });
    expect(
      (await signedOut.reads.readUser(PROFILE)).viewerContext,
    ).toBeUndefined();
    expect(
      signedOut.log.some((entry) => entry.startsWith('/v1/linkById')),
    ).toBe(false);

    const self = buildHarness();
    expect((await self.reads.readUser(VIEWER)).viewerContext).toBeUndefined();
    expect(self.log.some((entry) => entry.startsWith('/v1/linkById'))).toBe(
      false,
    );
  });

  it('keeps the reverse answer when the forward read fails', async () => {
    const { reads } = buildHarness({ forward: 'failure', reverse: 'present' });

    expect((await reads.readUser(PROFILE)).viewerContext).toEqual({
      followedBy: true,
    });
  });

  it('keeps the forward answer when the reverse read fails', async () => {
    const { reads } = buildHarness({ forward: 'missing', reverse: 'failure' });

    expect((await reads.readUser(PROFILE)).viewerContext).toEqual({
      following: false,
    });
  });

  it('does not add a reverse edge read to cast-shaped authors', async () => {
    const { log, reads } = buildHarness({ reverse: 'present' });

    const author = await reads.readAuthor(PROFILE);

    expect(author.viewerContext).toEqual({ following: false });
    expect(linkRequests(log, VIEWER, PROFILE)).toHaveLength(1);
    expect(linkRequests(log, PROFILE, VIEWER)).toHaveLength(0);
  });
});
