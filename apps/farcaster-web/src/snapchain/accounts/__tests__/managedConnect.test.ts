/**
 * The connect module, driven by a fake service: what it reports, and what it
 * refuses to report.
 *
 * The rules these tests hold the module to are the ones that matter to a
 * person: it never says "connected" unless the service did, it never writes as
 * one account for another, and every failure arrives as a sentence.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  canWriteThroughConnect,
  connectStatus,
  forgetRememberedConnect,
  rememberConnectStatus,
  startConnect,
  stopConnect,
  writeThroughConnect,
} from '~/snapchain/accounts/managedConnect';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const fakeFetch = (
  handler: (url: string, init?: RequestInit) => Promise<Response>,
) =>
  vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );

beforeEach(() => {
  forgetRememberedConnect();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('managedConnect', () => {
  it('asks the service what is true, and reads only what it knows', async () => {
    const fetchImpl = fakeFetch(async () =>
      json({ ok: true, state: 'connected', fid: 4242, username: 'someone' }),
    );
    await expect(
      connectStatus({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toEqual({
      state: 'connected',
      approvalUrl: null,
      fid: 4242,
      username: 'someone',
    });
  });

  it('reads an answer it does not recognise as unknown, never as connected', async () => {
    for (const payload of [
      { state: 'approved' },
      { state: 'ok' },
      {},
      null,
      'connected',
    ]) {
      const fetchImpl = fakeFetch(async () => json(payload));
      const status = await connectStatus({
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(status.state).toBe('unknown');
      expect(status.fid).toBeNull();
    }
  });

  it('starts a connection and hands back the link to open', async () => {
    const fetchImpl = fakeFetch(async (url, init) => {
      expect(url).toBe('/api/fiddy/connect');
      expect(init?.method).toBe('POST');
      // The handle is in an HttpOnly cookie, so the request must be same-origin.
      expect(init?.credentials).toBe('same-origin');
      return json({
        ok: true,
        state: 'waiting',
        approvalUrl: 'https://warpcast.com/~/add-signer?signer_uuid=x',
        reused: false,
      });
    });

    const started = await startConnect({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(started.reused).toBe(false);
    expect(started.status.state).toBe('waiting');
    expect(started.status.approvalUrl).toBe(
      'https://warpcast.com/~/add-signer?signer_uuid=x',
    );
  });

  it('says what the service said when it refuses, in its own words', async () => {
    const fetchImpl = fakeFetch(async () =>
      json(
        {
          ok: false,
          code: 'CONNECT_NOT_SET_UP',
          message: 'connecting an account is not switched on here yet.',
        },
        501,
      ),
    );
    await expect(
      startConnect({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({
      code: 'CONNECT_NOT_SET_UP',
      status: 501,
      message: 'connecting an account is not switched on here yet.',
    });
  });

  it('answers an unreachable service with a sentence, not a crash', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(
      connectStatus({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({
      code: 'CONNECT_UNREACHABLE',
    });
    // A writer that cannot ask must answer "no", so the caller falls back to
    // the device's own key rather than pretending a write went somewhere.
    await expect(canWriteThroughConnect(4242)).resolves.toBe(false);
  });

  it('only lets a write through for the account the connection belongs to', async () => {
    rememberConnectStatus({
      state: 'connected',
      approvalUrl: null,
      fid: 4242,
      username: 'someone',
    });
    await expect(canWriteThroughConnect(4242)).resolves.toBe(true);
    // A different account signed in on this device must not write as that one.
    await expect(canWriteThroughConnect(9999)).resolves.toBe(false);
    await expect(canWriteThroughConnect(undefined)).resolves.toBe(false);
  });

  it('hands a cast over with its text, and brings the hash back', async () => {
    const fetchImpl = fakeFetch(async (url, init) => {
      expect(url).toBe('/api/fiddy/connect/write');
      expect(JSON.parse(String(init?.body))).toEqual({
        kind: 'cast',
        text: 'hello',
        embeds: [],
      });
      return json({ ok: true, kind: 'cast', hash: '0xabc' });
    });
    await expect(
      writeThroughConnect(
        { kind: 'cast', text: 'hello', embeds: [] },
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).resolves.toEqual({ ok: true, hash: '0xabc' });
  });

  it('turns it off, and takes the service’s answer for the state', async () => {
    const fetchImpl = fakeFetch(async (_url, init) => {
      expect(init?.method).toBe('DELETE');
      return json({ ok: true, state: 'revoked' });
    });
    await expect(
      stopConnect({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toMatchObject({
      state: 'revoked',
      approvalUrl: null,
    });
  });
});
