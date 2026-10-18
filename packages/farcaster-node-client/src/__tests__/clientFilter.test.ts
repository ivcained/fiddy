/**
 * Include/exclude casts by the client they came from.
 *
 * The resolving half talks to the node (signer -> `requestFid`); the filtering
 * half is pure. Both are tested: the pure part exhaustively, the resolving part
 * against the fake node counting its own `/v1/signer` lookups so the caching
 * claim is measured, not asserted by eye.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateAppKey } from '../appKey';
import {
  CastClientResolver,
  clientIdentityFor,
  defaultClientFilterPolicy,
  filterCastsByClient,
} from '../clientFilter';
import { SnapchainNodeClient } from '../http';
import { buildCastAddMessage } from '../messages';
import type { NodeMessage } from '../types';
import {
  fixedRandomBytes,
  startTestNode,
  TEST_FID,
  type TestNode,
} from './fixtures';

const OTHER_APP_FID = 9152;

let node: TestNode;
let client: SnapchainNodeClient;

beforeEach(async () => {
  node = await startTestNode();
  client = new SnapchainNodeClient({ baseUrl: node.url });
});

afterEach(async () => {
  await node.close();
});

const seedCast = async (options: {
  fid: number;
  signerPrivateKey: Uint8Array;
  text: string;
  timestamp: number;
}): Promise<NodeMessage> => {
  const built = await buildCastAddMessage(options);
  node.store(built.message);
  const page = await client.castsByFid({ fid: options.fid });
  return page.messages.find((message) => message.hash === built.hash)!;
};

const messageFor = (signer: string, fid = TEST_FID): NodeMessage =>
  ({
    hash: '0x00',
    signer,
    signature: '',
    signatureScheme: 'SIGNATURE_SCHEME_ED25519',
    hashScheme: 'HASH_SCHEME_BLAKE3',
    fid,
    timestamp: 1,
    timestampMs: 1,
    network: 'FARCASTER_NETWORK_MAINNET',
    type: 'MESSAGE_TYPE_CAST_ADD',
    castAdd: {
      text: 'x',
      castType: 'CAST',
      embeds: [],
      embedsDeprecated: [],
      mentions: [],
      mentionsPositions: [],
    },
  }) as NodeMessage;

describe('clientIdentityFor (pure)', () => {
  it('calls a key that your own FID requested "this client"', () => {
    const identity = clientIdentityFor({
      signerHex: '0xabc',
      signer: {
        source: 'SIGNER_SOURCE_OFFCHAIN',
        key: '0xabc',
        keyType: 1,
        fid: TEST_FID,
        requestFid: TEST_FID,
        scopes: ['MESSAGE_TYPE_CAST_ADD'],
      },
      selfAppFid: TEST_FID,
    });
    expect(identity).toMatchObject({
      id: 'self',
      kind: 'self',
      label: 'Fiddy (this client)',
    });
  });

  it('names an app when the caller supplies a registry entry, and says "another client" otherwise', () => {
    const signer = {
      source: 'SIGNER_SOURCE_OFFCHAIN' as const,
      key: '0xdef',
      keyType: 1,
      fid: 5,
      requestFid: OTHER_APP_FID,
    };
    const named = clientIdentityFor({
      signerHex: '0xdef',
      signer,
      selfAppFid: TEST_FID,
      knownClients: { [OTHER_APP_FID]: 'Some Client' },
    });
    expect(named).toMatchObject({
      id: `app:${OTHER_APP_FID}`,
      kind: 'known',
      label: 'Some Client',
    });

    const unnamed = clientIdentityFor({
      signerHex: '0xdef',
      signer,
      selfAppFid: TEST_FID,
    });
    expect(unnamed.kind).toBe('unknown');
    expect(unnamed.label).toBe(`Another client (app fid ${OTHER_APP_FID})`);
  });

  it('separates on-chain signers, which have no app FID at all', () => {
    const identity = clientIdentityFor({
      signerHex: '0xfed',
      signer: {
        source: 'SIGNER_SOURCE_ONCHAIN',
        key: '0xfed',
        keyType: 1,
        fid: 2,
      },
    });
    expect(identity).toMatchObject({
      kind: 'onchain',
      label: 'Direct on-chain signer',
    });
    expect(identity.requestFid).toBeUndefined();
  });

  it('degrades to "unknown client" when the node has no signer record', () => {
    const identity = clientIdentityFor({ signerHex: '0x999' });
    expect(identity).toMatchObject({ kind: 'unknown', id: 'signer:0x999' });
  });
});

describe('CastClientResolver (against the node)', () => {
  it('resolves the client behind each cast from the node\u2019s signer records', async () => {
    const ownKey = await generateAppKey(fixedRandomBytes(21));
    const otherKey = await generateAppKey(fixedRandomBytes(22));
    node.addSigner({
      key: ownKey.publicKeyHex,
      fid: TEST_FID,
      source: 'SIGNER_SOURCE_OFFCHAIN',
      requestFid: TEST_FID,
    });
    node.addSigner({
      key: otherKey.publicKeyHex,
      fid: OTHER_APP_FID,
      source: 'SIGNER_SOURCE_OFFCHAIN',
      requestFid: OTHER_APP_FID,
    });

    const mine = await seedCast({
      fid: TEST_FID,
      signerPrivateKey: ownKey.privateKey,
      text: 'from my node',
      timestamp: 12_000_001,
    });
    const theirs = await seedCast({
      fid: OTHER_APP_FID,
      signerPrivateKey: otherKey.privateKey,
      text: 'from another client',
      timestamp: 12_000_002,
    });

    const resolver = new CastClientResolver({
      node: client,
      selfAppFid: TEST_FID,
      knownClients: { [OTHER_APP_FID]: 'Warpcast-like client' },
    });
    const clients = await resolver.resolveAll([mine, theirs]);

    expect(clients.get(mine.signer.toLowerCase())).toMatchObject({
      id: 'self',
      kind: 'self',
    });
    expect(clients.get(theirs.signer.toLowerCase())).toMatchObject({
      id: `app:${OTHER_APP_FID}`,
      kind: 'known',
      label: 'Warpcast-like client',
      requestFid: OTHER_APP_FID,
    });
  });

  it('looks up each signer once, even across repeat calls', async () => {
    const appKey = await generateAppKey(fixedRandomBytes(23));
    node.addSigner({
      key: appKey.publicKeyHex,
      fid: TEST_FID,
      source: 'SIGNER_SOURCE_OFFCHAIN',
      requestFid: TEST_FID,
    });
    const first = await seedCast({
      fid: TEST_FID,
      signerPrivateKey: appKey.privateKey,
      text: 'one',
      timestamp: 12_000_001,
    });
    const second = await seedCast({
      fid: TEST_FID,
      signerPrivateKey: appKey.privateKey,
      text: 'two',
      timestamp: 12_000_002,
    });

    const resolver = new CastClientResolver({
      node: client,
      selfAppFid: TEST_FID,
    });
    await resolver.resolveAll([first, second, first]);
    expect(node.requestsFor('/v1/signer')).toHaveLength(1);

    await resolver.resolve(second);
    expect(node.requestsFor('/v1/signer')).toHaveLength(1);

    resolver.clear();
    await resolver.resolve(second);
    expect(node.requestsFor('/v1/signer')).toHaveLength(2);
  });

  it('does not fail the feed when a signer cannot be resolved', async () => {
    const unknown = messageFor(`0x${'aa'.repeat(32)}`);
    const resolver = new CastClientResolver({
      node: client,
      selfAppFid: TEST_FID,
    });
    const identity = await resolver.resolve(unknown);
    expect(identity.kind).toBe('unknown');
  });
});

describe('filterCastsByClient (pure view layer)', () => {
  const mine = messageFor('0xself');
  const theirs = messageFor('0xother', 42);
  const unknown = messageFor('0xunknown', 43);
  const clients = new Map([
    [
      '0xself',
      clientIdentityFor({
        signerHex: '0xself',
        signer: {
          source: 'SIGNER_SOURCE_OFFCHAIN',
          key: '0xself',
          keyType: 1,
          fid: TEST_FID,
          requestFid: TEST_FID,
        },
        selfAppFid: TEST_FID,
      }),
    ],
    [
      '0xother',
      clientIdentityFor({
        signerHex: '0xother',
        signer: {
          source: 'SIGNER_SOURCE_OFFCHAIN',
          key: '0xother',
          keyType: 1,
          fid: 42,
          requestFid: 7,
        },
        selfAppFid: TEST_FID,
      }),
    ],
  ]);

  it('shows everything by default', () => {
    expect(
      filterCastsByClient({
        messages: [mine, theirs, unknown],
        clients,
        policy: defaultClientFilterPolicy,
      }),
    ).toHaveLength(3);
  });

  it('excludes the clients you named', () => {
    const kept = filterCastsByClient({
      messages: [mine, theirs, unknown],
      clients,
      policy: { mode: 'exclude', clientIds: ['app:7'] },
    });
    expect(kept.map((message) => message.signer)).toEqual([
      '0xself',
      '0xunknown',
    ]);
  });

  it('shows only the clients you named', () => {
    const kept = filterCastsByClient({
      messages: [mine, theirs, unknown],
      clients,
      policy: { mode: 'only', clientIds: ['self'] },
    });
    expect(kept.map((message) => message.signer)).toEqual(['0xself']);
  });

  it('hides unresolved clients only when asked, since hiding is destructive', () => {
    const kept = filterCastsByClient({
      messages: [mine, theirs, unknown],
      clients,
      policy: { mode: 'exclude', clientIds: ['app:7'] },
      unknownClientBehavior: 'hide',
    });
    expect(kept.map((message) => message.signer)).toEqual(['0xself']);
  });

  it('treats an empty client list as "no filtering", never as "hide everything"', () => {
    expect(
      filterCastsByClient({
        messages: [mine, theirs],
        clients,
        policy: { mode: 'only', clientIds: [] },
      }),
    ).toHaveLength(2);
  });
});
