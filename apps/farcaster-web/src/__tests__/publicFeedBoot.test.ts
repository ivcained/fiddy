// @vitest-environment jsdom
import { type ApiCastFeedItem } from 'farcaster-client-data';
import { describe, expect, it } from 'vitest';

import {
  capturePublicFeedBoot,
  consumePublicFeedBoot,
  mergeRefreshedPublicFeed,
} from '~/lib/publicFeedBoot';

const HASH_A = `0x${'a'.repeat(40)}`;
const HASH_B = `0x${'b'.repeat(40)}`;
const HASH_C = `0x${'c'.repeat(40)}`;

const item = (hash: string, text: string): ApiCastFeedItem =>
  ({
    id: `cast-${hash}`,
    cast: { hash, text },
  }) as unknown as ApiCastFeedItem;

const boot = {
  at: 1234,
  result: {
    latestMainCastTimestamp: 99,
    items: [item(HASH_A, 'server A'), item(HASH_B, 'server B')],
  },
};

describe('the public feed boot seed', () => {
  it('is captured before the static root is cleared, then consumed once', () => {
    document.body.innerHTML = `<div id="root"><article>static cast</article><script type="application/json" id="fiddy-public-feed-boot">${JSON.stringify(
      boot,
    )}</script></div>`;

    capturePublicFeedBoot();
    document.getElementById('root')?.replaceChildren();

    expect(consumePublicFeedBoot()).toEqual(boot);
    expect(consumePublicFeedBoot()).toBeUndefined();
  });

  it('ignores malformed or unrelated boot data', () => {
    document.body.innerHTML = `<div id="root"><script type="application/json" id="fiddy-public-feed-boot">{"at":1234,"result":{"items":"no"}}</script></div>`;
    capturePublicFeedBoot();
    expect(consumePublicFeedBoot()).toBeUndefined();
  });

  it('keeps the initial cast order across a fresh merge without moving old cards', () => {
    const freshB = item(HASH_B, 'fresh B with new counts');
    const freshC = item(HASH_C, 'fresh C');
    const freshA = item(HASH_A, 'fresh A');

    const merged = mergeRefreshedPublicFeed({
      bootItems: boot.result.items,
      freshItems: [freshB, freshC, freshA],
    });

    expect(merged.map((entry) => entry.cast.hash)).toEqual([
      HASH_A,
      HASH_B,
      HASH_C,
    ]);
    expect(merged[0]).toBe(freshA);
    expect(merged[1]).toBe(freshB);
    expect(merged[2]).toBe(freshC);
  });
});
