import { ApiCast } from 'farcaster-client-data';

/** A train cast carries this URL as an embed; the API stores it and returns it. */
export const TRAIN_URL = 'https://fiddy.fun/train';

/** True when a cast is tagged as a train cast (the train URL may land in urls[] or unknowns[]). */
export const isTrain = (c: ApiCast): boolean =>
  !!(
    c.embeds?.urls?.some((u) => u.openGraph?.url === TRAIN_URL) ||
    c.embeds?.urls?.some((u) => u.openGraph?.sourceUrl === TRAIN_URL) ||
    c.embeds?.unknowns?.some((u) => u.source === TRAIN_URL)
  );

/**
 * A cast's text and mentions as they went out: the name-position pairs from
 * Hypersnap's empty-range mention encoding (`mentioned_profiles_ranges` has
 * `start === end` for mentions in the text body; non-empty ranges are
 * avatars/labels). Returns the same shape `useCreateCast` expects — pass it
 * as `embeds` with the original cast hash to create a byte-exact quote.
 */
export function saidOf(
  c: Pick<
    ApiCast,
    'text' | 'mentions' | 'mentioned_profiles' | 'mentioned_profiles_ranges'
  >,
): { text: string; mentions: number[]; positions: number[]; names: string[] } {
  const at = (c.mentioned_profiles_ranges || []).flatMap((r, i) =>
    r.start === r.end && c.mentions?.[i]
      ? [{ at: r.start, u: c.mentions[i] }]
      : [],
  );
  return {
    text: c.text || '',
    mentions: at.map((x) => x.u.fid),
    positions: at.map((x) => x.at),
    names: at.map((x) => x.u.username || ''),
  };
}
