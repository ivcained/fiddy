/**
 * Adapted from quilcast (MIT), https://github.com/backmeupplz/quilcast
 * (src/castsearch.ts at 0.77.0, commit dd9f581ba0df).
 *
 * Searching one person's casts from their profile. A read node keeps no search
 * index (`/v2/search-casts` is hosted for a reason), and its cast-search index
 * has no author field, so this reads the account's own casts page by page
 (`/v1/castsByFid`, newest first, 1000 a page) and keeps the ones whose text
 * has every word searched for — top-level casts and replies alike. The matches
 * are then read in full through the reader's usual build chain, like any
 * feed's casts.
 *
 * Two limits are structural, said in the empty state rather than hidden:
 *   - a hub cast's text has its @mentions cut out (they are FIDs beside the
 *     text), so a mentioned name is not found by these words;
 *   - one load reads at most `SEARCH_MAX_PAGES` pages (`SEARCH_MOST_READ`
 *     casts) before it hands back what it found; when that is nothing the
 *     answer says `capped`, so a word only in a very busy account's older
 *     casts is honestly missed, not pretended absent.
 *
 * Browser-free and dependency-free, like the rest of the node API: the page
 * cache below is plain module state, and nothing here touches the DOM.
 */

import type { ApiCast } from 'farcaster-client-data';
import {
  isTerminalPageToken,
  type NodeCastMessage,
  type NodeMessage,
} from 'farcaster-node-client';

/** How many full matches one page of the search feed holds. */
export const SEARCH_PAGE_WANT = 25;
/** How many hub pages (1000 casts each) one load may read before it stops. */
export const SEARCH_MAX_PAGES = 50;
/** The most casts one load reads. */
export const SEARCH_PAGE_SIZE = 1000;
export const SEARCH_MOST_READ = SEARCH_MAX_PAGES * SEARCH_PAGE_SIZE;
/** How many read pages are kept as hash + text, so a narrower search or a
 * "load more" never re-reads an older page. The raw pages (~750 KB each run)
 * are never kept — only the digest-sized hash and the text the matching
 * needs. A fresh first page is read again on every new search, so a cast
 * posted since the last one is found. */
const KEPT_PAGES = 60;

/**
 * Lowercase, without Latin accents, so "cafe" finds "Café". Only accents on a
 * Latin letter go, and the letter is put back together: other scripts' marks
 * are part of the letter (Japanese dakuten, Hindi matras, Thai vowels and
 * tones, Cyrillic й and ё, Korean syllables' parts), so "か" does not find
 * "が", nor "мой" "мои".
 */
export const foldSearchText = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/(\p{Script=Latin})[\u0300-\u036f]+/gu, '$1')
    .normalize('NFC')
    .toLowerCase();

/** The words of a search. */
export const searchWords = (q: string): string[] =>
  foldSearchText(q).split(/\s+/).filter(Boolean);

/** Whether a cast's text has every word in it. */
export const everyWordIn = (text: string, words: string[]): boolean => {
  if (words.length === 0) {
    return false;
  }
  const folded = foldSearchText(text);
  return words.every((word) => folded.includes(word));
};

/** One read hub page: the cast-adds' hash (bare, lowercase) and text, newest
 * first, plus the token of the page after, or null when the log is over. */
export interface SearchPage {
  items: { hash: string; text: string }[];
  next: string | null;
}

/** Reads one page of `fid`'s own casts, newest first. */
export type SearchPageReader = (
  fid: number,
  pageToken: string | undefined,
) => Promise<SearchPage>;

/**
 * Reads the casts with these hashes in full, in the order given; one the
 * source cannot find is left out. The reader's build chain answers this —
 * `buildCasts` over the messages a node's `castById` gives back.
 */
export type SearchFullReader = (
  fid: number,
  hashes: string[],
) => Promise<ApiCast[]>;

/** A node-shaped page read turned into a `SearchPage`: cast-adds only, the
 * terminal token (`[null,null]`) read as "the log is over". */
export const searchPageOf = (page: {
  messages: NodeMessage[];
  nextPageToken?: string;
}): SearchPage => ({
  items: page.messages.flatMap((message) => {
    const cast = message as NodeCastMessage;
    return typeof message.hash === 'string' && cast.castAdd
      ? [
          {
            hash: message.hash.replace(/^0x/i, '').toLowerCase(),
            text: String(cast.castAdd.text || ''),
          },
        ]
      : [];
  }),
  next:
    page.nextPageToken && !isTerminalPageToken(page.nextPageToken)
      ? page.nextPageToken
      : null,
});

/** The pages already read this session, as hash + text, keyed by
 * `fid:token` — the same shape upstream keeps. One in-flight read is shared
 * by every caller that asks for the same page, and a failed read is dropped
 * rather than kept as a rejected promise. */
const pages = new Map<string, Promise<SearchPage>>();

const forgetOldestPages = (): void => {
  for (const key of pages.keys()) {
    if (pages.size > KEPT_PAGES) {
      pages.delete(key);
    } else {
      break;
    }
  }
};

/** Forget the kept pages. Tests call this so one test's pages are never
 * another test's cache; the cache is session state, like the reader's other
 * indexes (see `forgetCastAuthors`). */
export const forgetSearchPages = (): void => {
  pages.clear();
};

/** Reads one page through the cache. `fresh` re-reads a page the cache holds
 * (a new search's first page, so casts posted since are found). */
const cachedPage = async (
  key: string,
  read: () => Promise<SearchPage>,
  fresh: boolean,
): Promise<SearchPage> => {
  const held = pages.get(key);
  pages.delete(key);
  if (held && !fresh) {
    pages.set(key, held);
    return held;
  }
  const promise = read();
  pages.set(key, promise);
  promise.catch(() => {
    if (pages.get(key) === promise) {
      pages.delete(key);
    }
  });
  forgetOldestPages();
  return promise;
};

export interface SearchUserCastsResult {
  casts: ApiCast[];
  next: { cursor: string | null };
  /** Set when the load stopped at the page cap with nothing found: the
   * account has more casts than were searched, so "no matches" would lie. */
  capped?: true;
  /** The cap, stated next to `capped` so the empty state can name the number
   * honestly ("looked through their newest 50,000 casts"). */
  most?: number;
}

/**
 * A page of `fid`'s casts matching `q`, newest first, built like any feed's.
 *
 * The cursor is where the reading stopped: a bare hub page token to start at
 * a page, `<last hash read>:<hub page token>` to go on inside it. A page
 * re-read since (dropped from the kept pages) may have grown, and then the
 * resume starts over at its top and leaves out what the feed already shows.
 */
export const searchUserCasts = async ({
  fid,
  q,
  cursor,
  readPage,
  readFull,
}: {
  fid: number;
  q: string;
  cursor?: string;
  readPage: SearchPageReader;
  readFull: SearchFullReader;
}): Promise<SearchUserCastsResult> => {
  const words = searchWords(q);
  if (words.length === 0) {
    return { casts: [], next: { cursor: null } };
  }

  const resume = cursor?.match(/^([0-9a-f]{40}):(.*)$/);
  let token = resume ? resume[2] : cursor || '';
  let after = resume?.[1];
  const casts: ApiCast[] = [];

  for (let read = 0; ; read += 1) {
    const page = await cachedPage(
      `${fid}:${token}`,
      () => readPage(fid, token || undefined),
      // A new search (no cursor) re-reads the newest page; a resume does not.
      read === 0 && !cursor,
    );

    const start = after
      ? page.items.findIndex((item) => item.hash === after) + 1
      : 0;
    after = undefined;

    let index = start;
    while (index < page.items.length && casts.length < SEARCH_PAGE_WANT) {
      const hits: string[] = [];
      for (
        ;
        index < page.items.length &&
        casts.length + hits.length < SEARCH_PAGE_WANT;
        index += 1
      ) {
        if (everyWordIn(page.items[index]!.text, words)) {
          hits.push(page.items[index]!.hash);
        }
      }
      if (hits.length > 0) {
        casts.push(...(await readFull(fid, hits)));
      }
    }

    // A full page of matches stops mid-page; the next load goes on from there.
    if (index < page.items.length) {
      return {
        casts,
        next: { cursor: `${page.items[index - 1]!.hash}:${token}` },
      };
    }
    if (!page.next) {
      return { casts, next: { cursor: null } };
    }
    token = page.next;
    if (casts.length >= SEARCH_PAGE_WANT) {
      return { casts, next: { cursor: token } };
    }
    if (read + 1 >= SEARCH_MAX_PAGES) {
      return casts.length > 0
        ? { casts, next: { cursor: token } }
        : {
            casts,
            next: { cursor: token },
            capped: true,
            most: SEARCH_MOST_READ,
          };
    }
  }
};
