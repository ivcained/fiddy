/**
 * The profile cast search's own contract (castSearch.ts, adapted from
 * quilcast 0.77.0): the word folding stays inside the Latin script, a match
 * needs every word, a full page stops mid-page with a cursor that resumes
 * past what was already shown, and a load that hits the page cap with
 * nothing found says `capped` rather than pretending the cast is not there.
 */

import type { ApiCast } from 'farcaster-client-data';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  everyWordIn,
  foldSearchText,
  forgetSearchPages,
  SEARCH_MOST_READ,
  SEARCH_PAGE_WANT,
  searchUserCasts,
  searchWords,
} from '~/snapchain/nodeApi/castSearch';

beforeEach(() => {
  forgetSearchPages();
});

/** A `SearchPageReader` over in-memory pages, counting its reads. Pages are
 * addressed by their token, a number in string form; `undefined` is the first. */
const fakePages = (
  pages: { items: { hash: string; text: string }[]; next?: string }[],
  { log }: { log?: string[] } = {},
) => {
  let reads = 0;
  return {
    get reads(): number {
      return reads;
    },
    readPage: async (fid: number, pageToken: string | undefined) => {
      reads += 1;
      log?.push(`${fid}:${pageToken ?? ''}`);
      const page = pages[Number(pageToken ?? 0)] ?? { items: [] };
      return { items: page.items, next: page.next ?? null };
    },
  };
};

const fakeFull = (log: string[] = []) => {
  return async (fid: number, hashes: string[]): Promise<ApiCast[]> => {
    log.push(...hashes);
    return hashes.map((hash) => ({ hash }) as ApiCast);
  };
};

describe('the word folding', () => {
  it('folds Latin accents, so "cafe" finds "Café"', () => {
    expect(foldSearchText('Café')).toBe('cafe');
    expect(everyWordIn('Fresh coffee at the Café', searchWords('cafe'))).toBe(
      true,
    );
  });

  it('leaves marks of other scripts alone, so "か" does not find "が"', () => {
    expect(foldSearchText('が')).toBe('が');
    expect(everyWordIn('が', searchWords('か'))).toBe(false);
  });

  it('leaves Cyrillic й and ё alone, so "мой" does not find "мои"', () => {
    expect(foldSearchText('мой')).toBe('мой');
    expect(everyWordIn('мои', searchWords('мой'))).toBe(false);
  });

  it('needs every word', () => {
    expect(everyWordIn('base chain gas', searchWords('base gas'))).toBe(true);
    expect(everyWordIn('base chain', searchWords('base gas'))).toBe(false);
    expect(everyWordIn('anything at all', searchWords('   '))).toBe(false);
  });
});

describe('searchUserCasts', () => {
  const page = (text: string, hash: string) => ({ hash, text });

  it('keeps the casts whose text has every word, in page order, read in full', async () => {
    const fullLog: string[] = [];
    const pages = fakePages([
      {
        items: [
          page('Neat', 'a'.repeat(40)),
          page('nothing here', 'b'.repeat(40)),
          page('neat things', 'c'.repeat(40)),
        ],
      },
    ]);
    const result = await searchUserCasts({
      fid: 3,
      q: 'neat',
      readPage: pages.readPage,
      readFull: fakeFull(fullLog),
    });

    expect(result.casts.map((cast) => cast.hash)).toEqual([
      'a'.repeat(40),
      'c'.repeat(40),
    ]);
    expect(fullLog).toEqual(['a'.repeat(40), 'c'.repeat(40)]);
    expect(result.next.cursor).toBeNull();
    expect(result.capped).toBeUndefined();
  });

  it('stops mid-page when a full page of matches is in hand, and the cursor resumes past the shown ones', async () => {
    const items = Array.from({ length: SEARCH_PAGE_WANT + 5 }, (_, index) =>
      page(`neat ${index}`, String(index).padStart(40, '0')),
    );
    const pages = fakePages([{ items }]);

    const first = await searchUserCasts({
      fid: 3,
      q: 'neat',
      readPage: pages.readPage,
      readFull: fakeFull(),
    });
    expect(first.casts).toHaveLength(SEARCH_PAGE_WANT);
    expect(first.next.cursor).toBe(`${items[SEARCH_PAGE_WANT - 1]!.hash}:`);

    const resume = await searchUserCasts({
      fid: 3,
      q: 'neat',
      cursor: first.next.cursor ?? undefined,
      readPage: pages.readPage,
      readFull: fakeFull(),
    });
    // The five the first load did not show, not the whole page again.
    expect(resume.casts).toHaveLength(5);
    expect(resume.next.cursor).toBeNull();
  });

  it('says capped when the page cap stops the load with nothing found', async () => {
    const pages = fakePages(
      Array.from({ length: 60 }, (_, index) => ({
        items: [page(`page ${index}`, String(index).padStart(40, '0'))],
        next: String(index + 1),
      })),
    );
    const result = await searchUserCasts({
      fid: 3,
      q: 'missing word',
      readPage: pages.readPage,
      readFull: fakeFull(),
    });

    expect(result.casts).toEqual([]);
    expect(result.capped).toBe(true);
    expect(result.most).toBe(SEARCH_MOST_READ);
    expect(pages.reads).toBeLessThanOrEqual(50);
  });

  it('does not say capped when the log of the account simply ended', async () => {
    const pages = fakePages([{ items: [page('hello', 'a'.repeat(40))] }]);
    const result = await searchUserCasts({
      fid: 3,
      q: 'missing word',
      readPage: pages.readPage,
      readFull: fakeFull(),
    });
    expect(result.casts).toEqual([]);
    expect(result.capped).toBeUndefined();
    expect(result.next.cursor).toBeNull();
  });

  it('keeps read pages, so a narrower search reads no old page twice, and re-reads a fresh first page', async () => {
    const log: string[] = [];
    const pages = fakePages(
      [
        {
          items: [
            page('first', 'a'.repeat(40)),
            page('also first', 'b'.repeat(40)),
          ],
          next: '1',
        },
        { items: [page('second', 'c'.repeat(40))] },
      ],
      { log },
    );
    const readFull = fakeFull();

    await searchUserCasts({
      fid: 3,
      q: 'first',
      readPage: pages.readPage,
      readFull,
    });
    // Both pages were read to reach the end of the log.
    expect(log).toEqual(['3:', '3:1']);

    log.length = 0;
    await searchUserCasts({
      fid: 3,
      q: 'also first',
      readPage: pages.readPage,
      readFull,
    });
    // The fresh search re-reads the newest page (a cast posted since is then
    // found) but the older page is served from the cache.
    expect(log).toEqual(['3:']);

    log.length = 0;
    await searchUserCasts({
      fid: 3,
      q: 'first',
      cursor: `${'a'.repeat(40)}:1`,
      readPage: pages.readPage,
      readFull,
    });
    // A resume reads nothing here: the cursor's page is still in the cache,
    // and the resume's hash is not in it, so the search simply ends.
    expect(log).toEqual([]);
  });

  it('answers no words with no casts and no reads', async () => {
    const pages = fakePages([]);
    const result = await searchUserCasts({
      fid: 3,
      q: '   ',
      readPage: pages.readPage,
      readFull: fakeFull(),
    });
    expect(result.casts).toEqual([]);
    expect(pages.reads).toBe(0);
  });
});
