/**
 * A node-assembled feed, the notifications a node derives, and the reader's own
 * mutes.
 *
 * Farcaster carries neither a mute list nor muted words, and a read node holds
 * nothing for either — so the only thing that can make "hide this person" true
 * of a node-assembled page is the reader holding the list and the read seam
 * consulting it. These tests drive the REAL page read through the recorded
 * fixture node (`fakeNodeFetch`) and the REAL store, so what is measured is the
 * seam's own behaviour rather than a stub of it:
 *
 *   - a muted author's casts are gone from a page,
 *   - a muted word removes exactly the casts carrying it, whole-word matched,
 *   - the reader's own casts are never hidden, whatever the list says,
 *   - nothing is hidden when the reader holds no list,
 *   - notifications a node derives are filtered by the same list (the node knows
 *     no mutes, so nobody upstream would apply one),
 *   - the list is asked for while the page is being read, not once per session.
 */

import { type FetchLike, SnapchainNodeClient } from 'farcaster-node-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import {
  loadActiveMutes,
  type MuteQuery,
  mutesInUse,
  resetActiveMutes,
  setMute,
  wordsRe,
} from '~/snapchain/mutePreferences';
import { NodeBackedReads } from '~/snapchain/nodeApi';
import {
  createEmbedCardResolver,
  type EmbedCardResolver,
} from '~/snapchain/nodeApi/embedCards';
import type { EmbedKindResolver } from '~/snapchain/nodeApi/embedKinds';

import { offlineEmbedKinds } from './fakeEmbedKinds';
import {
  createFixtureNodeFetch,
  type FakeNodeRequest,
  TERMINAL_PAGE_TOKEN,
} from './fakeNodeFetch';

/** A page a test states for the fixture node, in place of a recording. */
type StatedPage = Record<string, unknown>;

const NODE = 'http://node.test';
/** The account the recording belongs to, and the reader in these tests. */
const READER_FID = 3;

beforeEach(() => {
  store.clear();
  resetActiveMutes();
});

/** The card resolver a test uses: it asks nothing, and says so. */
const offlineEmbedCards = (): EmbedCardResolver =>
  createEmbedCardResolver({
    storage: null,
    fetchImpl: (async () => {
      throw new TypeError('probes are offline in tests');
    }) as typeof fetch,
  });

/**
 * A reader over the recorded node.
 *
 * `mutes` defaults to the app's own answer — the store this module keeps in step
 * with storage — because that is what the seam is wired to. A test that wants to
 * ask a narrower question can hand its own predicates instead.
 */
const readerFor = (
  mutes: () => MuteQuery | undefined = mutesInUse,
  fallback?: (request: FakeNodeRequest) => StatedPage | undefined,
): NodeBackedReads => {
  const fetchImpl = createFixtureNodeFetch({ fallback });
  return new NodeBackedReads({
    node: new SnapchainNodeClient({
      baseUrl: NODE,
      fetch: fetchImpl as unknown as FetchLike,
    }),
    nodeBaseUrl: NODE,
    fetchImpl,
    embedKinds: offlineEmbedKinds() as EmbedKindResolver,
    embedCards: offlineEmbedCards(),
    getSignedInFid: () => READER_FID,
    mutes,
  });
};

/** The home feed of the recording: the reader's own casts. */
const readHome = (reads: NodeBackedReads) =>
  reads.readFeed({ feedKey: 'home', updateState: false });

/** A channel feed from the recording, whose casts are other people's. */
const readChannel = (reads: NodeBackedReads) =>
  reads.readFeed({ feedKey: 'dev', updateState: false });

/** The longest word in a text, so a test mutes something worth matching. */
const longestWord = (text: string): string =>
  text.split(/[^\p{L}\p{N}_$#]+/u).sort((a, b) => b.length - a.length)[0] ?? '';

const hideAuthors = (authors: number[]): MuteQuery => ({
  hidesAuthor: (fid) => fid !== undefined && authors.includes(fid),
  hidesText: () => false,
});

describe('the reader’s mutes narrow a node-assembled feed', () => {
  it('hides every cast of an author the reader muted, and keeps the rest', async () => {
    const page = await readChannel(readerFor());
    expect(page.items).toHaveLength(2);

    const muted = page.items[0]!.cast.author.fid;
    const kept = page.items.filter((item) => item.cast.author.fid !== muted);
    expect(kept).toHaveLength(1);

    const narrowed = await readChannel(readerFor(() => hideAuthors([muted])));

    expect(narrowed.items.map((item) => item.cast.author.fid)).toEqual(
      kept.map((item) => item.cast.author.fid),
    );
  });

  it('removes exactly the casts carrying a muted word', async () => {
    const page = await readChannel(readerFor());
    const word = longestWord(page.items[0]!.cast.text);
    expect(word.length).toBeGreaterThan(4);

    const re = wordsRe([word])!;
    const matching = page.items.filter((item) =>
      re.test(item.cast.text),
    ).length;
    expect(matching).toBe(1);

    const narrowed = await readChannel(
      readerFor(() => ({
        hidesAuthor: () => false,
        hidesText: (text) => re.test(text),
      })),
    );

    expect(narrowed.items).toHaveLength(page.items.length - matching);
    for (const item of narrowed.items) {
      expect(re.test(item.cast.text)).toBe(false);
    }
  });

  it('never hides the reader’s own casts, even with their own FID muted', async () => {
    const page = await readHome(readerFor());
    expect(page.items.length).toBeGreaterThan(10);
    for (const item of page.items) {
      expect(item.cast.author.fid).toBe(READER_FID);
    }

    // The store refuses to hide the reader's own FID, which is what stops a
    // mute from looking like the app had lost the reader's own posts.
    await loadActiveMutes(READER_FID);
    await setMute({ fid: READER_FID, kind: 'users', value: READER_FID });

    expect(mutesInUse()!.hidesAuthor(READER_FID)).toBe(false);
    expect((await readHome(readerFor())).items).toHaveLength(page.items.length);
  });

  it('hides nothing when the reader holds no list', async () => {
    const page = await readHome(readerFor());
    await loadActiveMutes(READER_FID);

    expect(mutesInUse()).toBeUndefined();
    expect((await readHome(readerFor())).items).toHaveLength(page.items.length);
  });

  it('applies a word the reader has just muted to the very next page', async () => {
    const page = await readChannel(readerFor());
    const word = longestWord(page.items[0]!.cast.text);

    await loadActiveMutes(READER_FID);
    await setMute({ fid: READER_FID, kind: 'words', value: word });

    // No reload and no cache invalidation in between: the seam asks the store,
    // and the store already holds what was just saved.
    const narrowed = await readChannel(readerFor());
    expect(narrowed.items).toHaveLength(1);
    expect(narrowed.items[0]!.cast.text).not.toContain(word);
  });

  it('asks the reader’s own list while it is reading the page', async () => {
    const mutes = vi.fn(() => undefined);
    await readHome(readerFor(mutes));

    expect(mutes).toHaveBeenCalled();
  });
});

describe('the same list filters the notifications a node derives', () => {
  it('drops the mention of a cast carrying a muted word', async () => {
    const reads = readerFor();
    const before = (await reads.readNotifications({ fid: READER_FID })).find(
      (group) => group.type === 'cast-mention',
    );
    const mentions = before?.previewItems.filter(
      (item) => item.content?.cast.text !== undefined,
    );
    expect(mentions?.length ?? 0).toBeGreaterThan(0);

    const word = longestWord(mentions![0]!.content!.cast.text);
    const re = wordsRe([word])!;

    const after = (
      await readerFor(() => ({
        hidesAuthor: () => false,
        hidesText: (text) => re.test(text),
      })).readNotifications({ fid: READER_FID })
    ).find((group) => group.type === 'cast-mention');

    // Whatever survives, carries no muted word — the node derived these and
    // knows nothing about the reader's list, so nobody else would apply it.
    for (const item of after?.previewItems ?? []) {
      expect(re.test(item.content!.cast.text)).toBe(false);
    }
    expect(after?.totalItemCount ?? 0).toBeLessThan(before!.totalItemCount);
  });

  it('drops a muted author’s follow notification', async () => {
    const before = (
      await readerFor().readNotifications({ fid: READER_FID })
    ).find((group) => group.type === 'follow');
    expect(before!.totalItemCount).toBeGreaterThan(0);

    const actor = before!.previewItems[0]!.actor.fid;
    const after = (
      await readerFor(() => hideAuthors([actor])).readNotifications({
        fid: READER_FID,
      })
    ).find((group) => group.type === 'follow');

    expect(after?.totalItemCount ?? 0).toBe(before!.totalItemCount - 1);
  });
});

describe('a muted word also matches a cast’s linked sites and quoted casts', () => {
  /** A node message the fixture states, shaped like the recording's own. */
  const castMessage = ({
    fid,
    hash,
    text,
    embeds = [],
  }: {
    fid: number;
    hash: string;
    text: string;
    embeds?: { url?: string; castId?: { fid: number; hash: string } }[];
  }): StatedPage => ({
    data: {
      type: 'MESSAGE_TYPE_CAST_ADD',
      fid,
      timestamp: 171124288,
      network: 'FARCASTER_NETWORK_MAINNET',
      castAddBody: {
        embedsDeprecated: [],
        mentions: [],
        parentCastId: null,
        parentUrl: null,
        text,
        embeds,
        mentionsPositions: [],
        type: 'CAST',
      },
    },
    hash,
    hashScheme: 'HASH_SCHEME_BLAKE3',
    signature:
      'S5E2Ixa8C0nyHN9/ioBeY5UlFRBUFrHMy0YMhbHfP9x9+o9508GcTv9q1jnejmFLCRyFaYh10KlJxJHrjN13Dg==',
    signatureScheme: 'SIGNATURE_SCHEME_ED25519',
    signer:
      '0xc887f5bf385a4718eaee166481f1832198938cf33e98a82dc81a0b4b81ffe33d',
  });

  /** A channel feed whose casts are the given messages, and nothing else. */
  const devFeed = (casts: StatedPage[]): StatedPage => ({
    messages: casts,
    nextPageToken: TERMINAL_PAGE_TOKEN,
  });

  const muteWord = async (word: string): Promise<void> => {
    await loadActiveMutes(READER_FID);
    await setMute({ fid: READER_FID, kind: 'words', value: word });
  };

  it('hides a cast that links a muted site, without its words naming it', async () => {
    const siteHash = `0x${'a1'.repeat(20)}`;
    const plainHash = `0x${'a2'.repeat(20)}`;
    const feeds = (): StatedPage =>
      devFeed([
        castMessage({
          fid: 15211,
          hash: siteHash,
          text: 'see this',
          embeds: [{ url: 'https://news.site.com/story' }],
        }),
        castMessage({ fid: 16969, hash: plainHash, text: 'unrelated' }),
      ]);

    await muteWord('site.com');
    const page = await readChannel(
      readerFor(mutesInUse, (request) =>
        request.path === '/v1/castsByParent' ? feeds() : undefined,
      ),
    );

    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.cast.hash).toBe(plainHash);
  });

  it('hides a cast that quotes another carrying a muted word', async () => {
    const quoteHash = `0x${'b1'.repeat(20)}`;
    const quotingHash = `0x${'b2'.repeat(20)}`;
    const plainHash = `0x${'b3'.repeat(20)}`;
    const quotedBy = 16969;

    await muteWord('spoilers');
    const page = await readChannel(
      readerFor(mutesInUse, (request) => {
        if (request.path === '/v1/castsByParent') {
          return devFeed([
            castMessage({
              fid: quotedBy,
              hash: quotingHash,
              text: 'check this out',
              embeds: [{ castId: { fid: 15211, hash: quoteHash } }],
            }),
            castMessage({ fid: 15211, hash: plainHash, text: 'fine' }),
          ]);
        }
        if (request.path === '/v1/castById') {
          return castMessage({
            fid: 15211,
            hash: quoteHash,
            text: 'full of spoilers here',
          });
        }
        return undefined;
      }),
    );

    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.cast.hash).toBe(plainHash);
  });

  it('never hides a quote of the reader’s own cast, whatever it says', async () => {
    const myHash = `0x${'c1'.repeat(20)}`;
    const quotingHash = `0x${'c2'.repeat(20)}`;

    await muteWord('news');
    const page = await readChannel(
      readerFor(mutesInUse, (request) => {
        if (request.path === '/v1/castsByParent') {
          return devFeed([
            castMessage({
              fid: 15211,
              hash: quotingHash,
              text: 'quoting me',
              embeds: [{ castId: { fid: READER_FID, hash: myHash } }],
            }),
          ]);
        }
        if (request.path === '/v1/castById') {
          // The reader's own cast carries the muted word — but a quote of the
          // reader's own post is not news to hide.
          return castMessage({
            fid: READER_FID,
            hash: myHash,
            text: 'my news',
          });
        }
        return undefined;
      }),
    );

    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.cast.hash).toBe(quotingHash);
  });
});
