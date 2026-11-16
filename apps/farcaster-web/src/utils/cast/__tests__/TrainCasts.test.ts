import { ApiCast } from 'farcaster-client-data';
import { describe, expect, it } from 'vitest';

import { isTrain, saidOf, TRAIN_URL } from '~/utils/cast/TrainCasts';

describe('TrainCasts', () => {
  describe('TRAIN_URL', () => {
    it('is the fiddy.fun/train sentinel', () => {
      expect(TRAIN_URL).toBe('https://fiddy.fun/train');
    });
  });

  describe('isTrain', () => {
    it('detects a train cast by its URL embed openGraph.url', () => {
      const c = {
        embeds: {
          urls: [{ openGraph: { url: TRAIN_URL, sourceUrl: TRAIN_URL } }],
          unknowns: [],
        },
      } as unknown as ApiCast;
      expect(isTrain(c)).toBe(true);
    });

    it('detects a train cast by its unknown embed source', () => {
      const c = {
        embeds: {
          urls: [],
          unknowns: [{ source: TRAIN_URL }],
        },
      } as unknown as ApiCast;
      expect(isTrain(c)).toBe(true);
    });

    it('returns false for a cast with no embeds', () => {
      expect(isTrain({ embeds: undefined } as unknown as ApiCast)).toBe(false);
    });

    it('returns false for a cast with no train URL', () => {
      const c = {
        embeds: {
          urls: [
            {
              openGraph: {
                url: 'https://example.com',
                sourceUrl: 'https://example.com',
              },
            },
          ],
          unknowns: [],
        },
      } as unknown as ApiCast;
      expect(isTrain(c)).toBe(false);
    });

    it('does not false-positive on a similar domain', () => {
      const c = {
        embeds: {
          urls: [],
          unknowns: [{ source: 'https://fiddy.fun/trains' }],
        },
      } as unknown as ApiCast;
      expect(isTrain(c)).toBe(false);
    });
  });

  describe('saidOf', () => {
    it('extracts text and mentions from empty-range mention encoding', () => {
      const c = {
        text: 'gm  and ✨ ',
        mentions: [
          { fid: 2, username: 'v' } as ApiCast['mentions'][number],
          { fid: 3, username: 'dwr' } as ApiCast['mentions'][number],
          { fid: 4, username: 'x' } as ApiCast['mentions'][number],
        ],
        mentioned_profiles_ranges: [
          { start: 3, end: 3 },
          { start: 12, end: 12 },
          { start: 0, end: 2 },
        ],
      } as unknown as ApiCast;
      const said = saidOf(c);
      expect(said).toEqual({
        text: 'gm  and ✨ ',
        mentions: [2, 3],
        positions: [3, 12],
        names: ['v', 'dwr'],
      });
    });

    it('returns empty arrays when there are no mention ranges', () => {
      const c = {
        text: 'hello world',
        mentions: [],
        mentioned_profiles_ranges: [],
      } as unknown as ApiCast;
      expect(saidOf(c)).toEqual({
        text: 'hello world',
        mentions: [],
        positions: [],
        names: [],
      });
    });
  });
});
