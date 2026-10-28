import {
  type ApiCastFeedItem,
  type ApiFeedItemsResult,
} from 'farcaster-client-data';

/**
 * The server-drawn `/feed` seed, held between the document and React.
 *
 * A visitor's first HTML can already carry the public window's recent page.
 * The boot document is a non-executable JSON script inside the app root, so
 * this module reads and remembers it BEFORE `src/index.tsx` clears the root,
 * and the public browse hook consumes it exactly once as the first page's
 * `initialData`. If it is absent (a shell fallback, a self-hosted build with
 * no generated reader) the hook simply reads as it always did.
 */

export interface PublicFeedBoot {
  at: number;
  result: ApiFeedItemsResult;
}

let captured: PublicFeedBoot | undefined;

const isBoot = (value: unknown): value is PublicFeedBoot =>
  typeof value === 'object' &&
  value !== null &&
  Number.isFinite((value as PublicFeedBoot).at) &&
  typeof (value as PublicFeedBoot).result === 'object' &&
  (value as PublicFeedBoot).result !== null &&
  Array.isArray((value as PublicFeedBoot).result.items);

/**
 * Called before the root is cleared. A malformed or unrelated document never
 * becomes data: the visitor gets the app's own loading/error paths.
 */
export const capturePublicFeedBoot = (): void => {
  captured = undefined;
  const source = document
    .getElementById('fiddy-public-feed-boot')
    ?.textContent?.trim();
  if (!source) {
    return;
  }
  try {
    const value: unknown = JSON.parse(source);
    if (isBoot(value)) {
      captured = value;
    }
  } catch {
    // No seed is the same as no server page.
  }
};

/** The captured seed, once. Later reads are the live query's own. */
export const consumePublicFeedBoot = (): PublicFeedBoot | undefined => {
  const seed = captured;
  captured = undefined;
  return seed;
};

/**
 * A fresh page keeps the initial casts on top, using its own values where it
 * has them, and puts anything new underneath. Nothing on screen moves when
 * hydration's first refresh arrives.
 */
export const mergeRefreshedPublicFeed = ({
  bootItems,
  freshItems,
}: {
  bootItems: ApiCastFeedItem[];
  freshItems: ApiCastFeedItem[];
}): ApiCastFeedItem[] => {
  const freshById = new Map(freshItems.map((item) => [item.id, item]));
  const keptIds = new Set<string>();
  const kept = bootItems.flatMap((item) => {
    if (keptIds.has(item.id)) {
      return [];
    }
    keptIds.add(item.id);
    return [freshById.get(item.id) ?? item];
  });
  return [...kept, ...freshItems.filter((item) => !keptIds.has(item.id))];
};
