// @vitest-environment jsdom

/**
 * The one-time "let Fiddy post as you" offer, pinned where it can be pinned:
 * the decision (every reason it is not offered), the setup (a real KEY_ADD, a
 * real custody signature, a fake node), and what the reader actually sees —
 * including that the test-account warning still stands between the offer and
 * the setup.
 *
 * Why here and not only in the browser probe: the offer's whole value is that
 * it appears in exactly the one situation it is for. An offer that shows up for
 * someone whose session a server can serve, or for an account that already has
 * a pass, is worse than no offer at all — so the negative cases are the ones
 * worth pinning.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import {
  appKeyFromPrivateKeyHex,
  bytesToHex,
  decodeMessageBytes,
  type NodeSigner,
  type SnapchainNodeClient,
} from 'farcaster-node-client';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DecidePostForYouInput } from '~/components/session/postForYouOffer';

const store = new Map<string, unknown>();

vi.mock('~/utils/storageUtils', () => ({
  getItem: vi.fn(
    async ({ key, fallback }: { key: string; fallback: unknown }) =>
      store.has(key) ? store.get(key) : fallback,
  ),
  setItem: vi.fn(async ({ key, value }: { key: string; value: unknown }) => {
    store.set(key, value);
  }),
  deleteItem: vi.fn(async (key: string) => {
    store.delete(key);
  }),
}));

const state = vi.hoisted(() => ({
  authToken: undefined as { secret: string; expiresAt: number } | undefined,
  localApiEnabled: false,
  nodeBackedClient: true,
  nodeConfigured: true,
  user: undefined as { fid?: number; username?: string } | undefined,
}));

vi.mock('~/contexts/AuthProvider', () => ({
  useAuth: () => ({ authToken: state.authToken }),
}));

vi.mock('farcaster-client-hooks', () => ({
  useCachedOnboardingState: () => ({ result: { state: { user: state.user } } }),
}));

vi.mock('~/constants/api', () => ({
  get localApiEnabled() {
    return state.localApiEnabled;
  },
}));

vi.mock('~/snapchain/nodeApi/nodeBackedClientFlag', () => ({
  isNodeBackedClientEnabled: () => state.nodeBackedClient,
}));

vi.mock('~/snapchain/nodeChoice', () => ({
  isNodeConfigured: () => state.nodeConfigured,
}));

// The card only offers when there is a server to set the pass up against; the
// client itself is replaced per-test by the fake node below.
const fakeNodeRef = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('~/snapchain/useNodeClient', () => ({
  useNodeClient: () => fakeNodeRef.current,
}));

const { LOCAL_SESSION_SECRET_PREFIX } = await import('~/lib/siwfSession');
const { loadAppKey, loadAppNonce } = await import('~/snapchain/appKeyStorage');
const { decidePostForYou, describeSetupFailure, setUpPostingForYou } =
  await import('~/components/session/postForYouOffer');
const { PostForYouStep } = await import('~/components/session/PostForYouStep');

const localToken = {
  secret: `${LOCAL_SESSION_SECRET_PREFIX}4242:abc`,
  expiresAt: 0,
};
const serverToken = { secret: 'a-real-token', expiresAt: 0 };
const TEST_ACCOUNT_WORDS =
  'test test test test test test test test test test test junk';

/** A node that reads a nonce, accepts one KEY_ADD, and then reports the signer. */
const createFakeNode = (options: { nonce?: number } = {}) => {
  const submitted: Uint8Array[] = [];
  const signers = new Map<string, NodeSigner>();
  const reads: string[] = [];

  const node = {
    submitted,
    reads,
    async signersByFid() {
      reads.push('signersByFid');
      return {
        signers: [...signers.values()],
        gaslessSignerCount: signers.size,
        gaslessSignerLimit: 1000,
        currentUserNonce: options.nonce ?? 7,
      };
    },
    async submitMessage(bytes: Uint8Array) {
      submitted.push(bytes);
      const message = decodeMessageBytes(bytes);
      const body = message.data?.keyAddBody as { key?: Uint8Array } | undefined;
      const key = body?.key;
      if (key) {
        const keyHex = bytesToHex(key);
        signers.set(keyHex.toLowerCase(), {
          key: keyHex,
          keyType: 1,
          source: 'SIGNER_SOURCE_OFFCHAIN',
          fid: 4242,
        } as NodeSigner);
      }
      return { hash: '0xsubmitted', fid: 4242 } as never;
    },
  };

  return node as unknown as SnapchainNodeClient & {
    submitted: Uint8Array[];
    reads: string[];
  };
};

const offerAppears = async () => screen.findByText('Let Fiddy post as you?');

/**
 * "Not there" has to mean "not there", not "not yet": the pass and dismissal
 * reads are promises, so the queue is drained before the card is looked for.
 */
const offerIsAbsent = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.queryByText('Let Fiddy post as you?')).toBeNull();
};

beforeEach(() => {
  store.clear();
  state.authToken = localToken;
  state.localApiEnabled = false;
  state.nodeBackedClient = true;
  state.nodeConfigured = true;
  state.user = { fid: 4242, username: 'fiddy' };
  fakeNodeRef.current = createFakeNode();
});

describe('decidePostForYou', () => {
  const base: DecidePostForYouInput = {
    isLocalDeviceSession: true,
    adapterEnabled: true,
    nodeConfigured: true,
    fid: 4242,
    passState: 'absent',
    saidNotNow: false,
  };

  it('offers once a signed-in device session has a server and no pass yet', () => {
    expect(decidePostForYou(base)).toEqual({ kind: 'offered', fid: 4242 });
  });

  it('stays quiet for every situation it is not for', () => {
    const cases: Array<[string, Partial<DecidePostForYouInput>]> = [
      ['a session a server can serve', { isLocalDeviceSession: false }],
      ['the adapter is off', { adapterEnabled: false }],
      ['no server is named', { nodeConfigured: false }],
      ['no account is known yet', { fid: undefined }],
      ['this device already has a pass', { passState: 'present' }],
      ['the reader already said not now', { saidNotNow: true }],
    ];

    for (const [why, patch] of cases) {
      const decision = decidePostForYou({ ...base, ...patch });
      expect(decision.kind, why).toBe('not-offered');
    }

    expect(
      decidePostForYou({ ...base, passState: 'unknown' }).kind,
      'the pass read has not answered yet',
    ).toBe('not-offered');
    expect(
      decidePostForYou({ ...base, saidNotNow: undefined }).kind,
      'the dismissal read has not answered yet',
    ).toBe('not-offered');
  });
});

describe('describeSetupFailure', () => {
  it('says a full account is full, in the reader words, not the node words', () => {
    const said = describeSetupFailure(
      'This FID already has 1000/1000 gasless keys — revoke one first',
    );
    expect(said).toMatch(/as many of these passes as it can/);
    expect(said).toMatch(/Advanced/);
    expect(said).not.toMatch(/gasless|FID|revoke/);
  });

  it('leaves a reason it does not know as the reason, prefixed', () => {
    expect(describeSetupFailure('the node said no')).toBe(
      'It did not go through: the node said no',
    );
  });
});

describe('setUpPostingForYou', () => {
  it('issues one pass, signs it with the account, and stores only the pass', async () => {
    const node = createFakeNode();

    const result = await setUpPostingForYou({
      node,
      fid: 4242,
      mnemonic: TEST_ACCOUNT_WORDS,
      confirmAttempts: 2,
      confirmIntervalMs: 0,
      sleep: async () => undefined,
    });

    // The node was read for the account's state, then handed exactly one
    // message — the custody-signed authorization.
    expect(node.reads.length).toBeGreaterThan(0);
    expect(node.submitted.length).toBe(1);

    // What is kept on this device is the pass, and it is the pass that was
    // built: the KEY_ADD in the submitted bytes carries this key's public half.
    const storedKey = await loadAppKey(4242);
    expect(storedKey).toMatch(/^0x[0-9a-f]+$/);
    const built = decodeMessageBytes(node.submitted[0]);
    const body = built.data?.keyAddBody as { key?: Uint8Array } | undefined;
    const derived = await appKeyFromPrivateKeyHex(storedKey as string);
    expect(derived.publicKeyHex.toLowerCase()).toBe(
      bytesToHex(body?.key as Uint8Array).toLowerCase(),
    );

    // The account's next nonce is recorded for the follow-up writes.
    expect(await loadAppNonce(4242)).toBe(9);
    expect(result.signer.fid).toBe(4242);

    // No other account's storage was touched, and no phrase was written down.
    expect(await loadAppKey(9999)).toBeNull();
    expect(
      [...store.keys()].some((key) => /mnemonic|seed|phrase/i.test(key)),
    ).toBe(false);
  });
});

describe('PostForYouStep', () => {
  it('offers the step, right where the reader is, once sign-in is done', async () => {
    render(<PostForYouStep />);

    await offerAppears();
    expect(screen.getByText('Set it up')).toBeTruthy();
    expect(screen.getByText('Not now')).toBeTruthy();
    expect(
      screen.getByText(/Use a test account, never your main one/),
    ).toBeTruthy();
    // Plain words only: none of the protocol's vocabulary reaches the reader.
    expect(
      screen.queryByText(/gasless|signer|scope|app key|KEY_ADD/i),
    ).toBeNull();
  });

  it('offers nothing when a server can serve this session', async () => {
    state.authToken = serverToken;
    render(<PostForYouStep />);
    await offerIsAbsent();
  });

  it('offers nothing when no server is named', async () => {
    state.nodeConfigured = false;
    render(<PostForYouStep />);
    await offerIsAbsent();
  });

  it('offers nothing to an account this device already posts for', async () => {
    store.set('snapchain_app_key_4242', '0xalready');
    render(<PostForYouStep />);
    await offerIsAbsent();
  });

  it('remembers "not now" on the device, so the offer is made once', async () => {
    const { getByText } = render(<PostForYouStep />);
    await offerAppears();

    getByText('Not now').click();

    await waitFor(() =>
      expect(screen.queryByText('Let Fiddy post as you?')).toBeNull(),
    );
    expect(store.get('fiddy_post_for_you_4242_said_not_now')).toBe(true);
  });

  it('puts the blocking test-account warning in front of the setup', async () => {
    render(<PostForYouStep />);
    await offerAppears();

    screen.getByText('Set it up').click();

    // The card's own screen is replaced by Advanced's warning, verbatim: the
    // reader has to acknowledge, and the confirm button stays disabled until
    // there is both an acknowledgement and a phrase.
    await screen.findByText(/Security warning/);
    expect(screen.getByText(/Use a TEST account/)).toBeTruthy();
    const confirm = screen.getByText('I understand, use a TEST account');
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    // A pass this device already stores is never re-issued by the offer.
    expect(await loadAppKey(4242)).toBeNull();
  });
});
