/**
 * What a feed's first page, read again, has that the list on screen does not.
 *
 * Ported from quilcast `newOnTop` (backmeupplz/quilcast, MIT, commit
 * `2e3437966c00`, PR #640 / mirror #270), including its three rules:
 *
 *   1. Top-anchored feeds (Fiddy's Following feed is one: it is strictly the
 *      follow graph merged on the Farcaster timestamp) find the first entry of
 *      the refreshed page that is one of the list's top five, and take what is
 *      above it.
 *   2. Ranked/time-unstable feeds pass `byTime`: their order is not the
 *      timestamp order, so only casts newer than the newest on screen count.
 *   3. `gap`: none of the list's top entries is on the refreshed page, so the
 *      page cannot say what sits between it and the list (the list is empty, or
 *      more is new than one page holds). Then the page replaces the list rather
 *      than being merged into it, and no count can be stood behind.
 *
 * One rule is ours, not upstream's, because live data needed it: a future-dated
 * cast (a node really serves them; the verification graph had one dated 2061)
 * sorts above everything forever, so it cannot be the top anchor or the feed
 * would never report anything as new. See `FUTURE_SKEW_MS`.
 *
 * The adaptation for Fiddy's node reads: upstream's `Cast` carries an `up`
 * chain of the casts it re-upped and a `recaster`. `farcaster-node-client`
 * returns a recast as the *recaster's own* cast message — `fid` is the
 * recaster, `castAdd.castType` is `CAST_TYPE_RECAST`, and the original cast is
 * not attached. So the identity of an entry is `hash:fid`: a fresh recast of an
 * old cast gets its own hash and does not hide what is genuinely new under it,
 * and two different accounts recasting the same cast stay two entries.
 *
 * This module is deliberately framework-free and type-only: it is the part of
 * the feature that can be reasoned about (and tested) without a simulator.
 */

/** The least a feed entry has to expose to be diffed. */
export interface FeedEntry {
  hash: string;
  /** Who this entry is *from*: the author, or the recaster for a recast. */
  fid: number;
  timestampMs: number;
}

/** An entry is the cast and who it came from, never the cast alone. */
export const entryKey = (entry: FeedEntry): string =>
  `${entry.hash}:${entry.fid}`;

/** How far down the list an anchor is looked for. */
const ANCHOR_DEPTH = 5;

/**
 * How far into the future a timestamp may be before the entry stops being a
 * usable anchor.
 *
 * Nodes do serve future-dated casts: the starter graph used for verification
 * has one dated 2061 at the top of the feed ("oh so we're time traveling now?"),
 * and it stays there because the list is sorted on the timestamp. Such an entry
 * is a fine thing to *show*, but a terrible anchor: everything genuinely new
 * sorts below it, so "what is above the anchor" is always nothing and the pill
 * could never appear. Real clocks also drift by seconds, hence the slack.
 */
export const FUTURE_SKEW_MS = 60_000;

const isAnchorable = (entry: FeedEntry, now: number): boolean =>
  entry.timestampMs <= now + FUTURE_SKEW_MS;

/** Distinct faces the pill has room for at 390 pt. */
export const AUTHORS_SHOWN = 3;

const newestFirst = (a: FeedEntry, b: FeedEntry): number =>
  b.timestampMs - a.timestampMs;

export interface NewOnTop<T extends FeedEntry> {
  /** Entries above the list, newest first: what a tap puts on top. */
  items: T[];
  /** True when the page could not be anchored to the list (see rule 3). */
  gap: boolean;
}

/**
 * The entries on `page` that the list `have` does not show, and whether the
 * page could be anchored to it at all.
 */
export const newOnTop = <T extends FeedEntry>(
  have: FeedEntry[],
  page: T[],
  options: { byTime?: boolean; now?: number } = {},
): NewOnTop<T> => {
  const shown = new Set(have.map((entry) => entry.hash));
  const now = options.now ?? Date.now();

  if (options.byTime) {
    const newest = have.reduce(
      (max, entry) => Math.max(max, entry.timestampMs),
      0,
    );
    return {
      items: page.filter(
        (entry) => !shown.has(entry.hash) && entry.timestampMs > newest,
      ),
      gap: false,
    };
  }

  // A few entries, in case the top one was deleted between reads. An entry is
  // its cast *and* who it came from, so a fresh recast of one of the top casts
  // is not taken for that cast itself (which would hide whatever is new below
  // it). A recast of something further down does not count either way: it is
  // already on screen. A future-dated cast is skipped as an anchor: it sorts
  // above everything forever, so anchoring on it would mean nothing is ever
  // new (see `FUTURE_SKEW_MS`).
  const top = new Set(
    have
      .slice(0, ANCHOR_DEPTH)
      .filter((entry) => isAnchorable(entry, now))
      .map(entryKey),
  );
  const anchor = page.findIndex((entry) => top.has(entryKey(entry)));

  return {
    items: (anchor < 0 ? page : page.slice(0, anchor)).filter(
      (entry) => !shown.has(entry.hash),
    ),
    gap: anchor < 0,
  };
};

/**
 * The new entries the pill may count: never the viewer's own casts, and never
 * anything the feed would filter out.
 */
export const pillNews = <T extends FeedEntry>(
  items: T[],
  options: { viewerFid?: number; keep?: (entry: T) => boolean } = {},
): T[] => {
  const { viewerFid, keep } = options;
  return items.filter(
    (entry) =>
      (viewerFid === undefined || entry.fid !== viewerFid) &&
      (keep ? keep(entry) : true),
  );
};

export interface NewPostsFound<T extends FeedEntry> {
  /** Everything new, whether or not it is counted or has a face on the pill. */
  items: T[];
  /** The entries the pill counts. */
  news: T[];
  /**
   * What the pill says, or `null` when no number can be stood behind: the page
   * could not be anchored (rule 3), or some authors' reads failed so their share
   * of the count is unknown. Then the pill says "New posts" with no number.
   */
  count: number | null;
  /** Up to three distinct authors, in the order their casts appear. */
  authors: number[];
  /** Merging is unsafe (there is a gap): a tap should re-read the list instead. */
  replace: boolean;
}

/**
 * Everything the pill needs, from one refreshed page. `null` when there is
 * nothing new above the list.
 */
export const newPostsFor = <T extends FeedEntry>({
  have,
  page,
  viewerFid,
  keep,
  unread = 0,
  byTime = false,
}: {
  have: FeedEntry[];
  page: T[];
  viewerFid: number;
  keep?: (entry: T) => boolean;
  /** Authors whose head could not be read on this poll. */
  unread?: number;
  byTime?: boolean;
}): NewPostsFound<T> | null => {
  const { items, gap } = newOnTop(have, page, { byTime });
  if (items.length === 0) {
    return null;
  }
  const news = pillNews(items, { viewerFid, keep });
  const authors = [...new Set(news.map((entry) => entry.fid))].slice(
    0,
    AUTHORS_SHOWN,
  );
  const verified = !gap && unread === 0;

  return {
    items: [...items].sort(newestFirst),
    news,
    count: verified ? news.length : null,
    authors,
    replace: gap,
  };
};

/** Put new entries on top of a list, de-duplicated, newest first. */
export const mergeNew = <T extends FeedEntry>(have: T[], items: T[]): T[] => {
  const seen = new Set(have.map(entryKey));
  const added = items.filter((entry) => !seen.has(entryKey(entry)));
  if (added.length === 0) {
    return have;
  }
  return [...have, ...added].sort(newestFirst);
};
