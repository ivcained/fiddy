/**
 * People to follow, from node data only.
 *
 * PORTED 1:1 from `src/phunk/recommend.py` in phunk-client
 * (https://github.com/Ramitphi/phunk-client), MIT license, © Ramitphi —
 * see docs/CLIENT-PEOPLE.md for the attribution record. Same inputs, same
 * outputs, same tie-breaks; only the spelling is TypeScript.
 *
 * Two signals, both read straight from the node:
 *
 * - Friends of friends. Accounts followed by several of the people you
 *   follow. We read the newest follows of a sample of the people you follow
 *   (the ones you followed most recently), not everyone, to keep request
 *   counts low on a shared node.
 * - Shared channels. People who posted recently in the channels you post in.
 *
 * The score is a plain count: one point for each person you follow who
 * follows them, plus `CHANNEL_POINTS` for each channel you share. People you
 * already follow, and you, are never suggested.
 *
 * NOTHING in this module touches the network: it is the pure half of the
 * port, and the node reads that feed it live in `reads.ts`
 * (`readPeopleSuggestions`). There is no model, no AI and no ranking
 * anywhere in this surface — counts off the node are the whole ranking.
 */

/** Points for each channel you and a suggestion both post in. */
export const CHANNEL_POINTS = 2;

/** One person worth following, and the counts that put them on the list. */
export interface Suggestion {
  fid: number;
  score: number;
  /** The people you follow who follow them, sorted. */
  followedBy: number[];
  /** The channel parent URLs you both post in, sorted. */
  channels: string[];
}

export interface ScoreOptions {
  /** A friend-of-friend needs this many people you follow behind them,
   * unless they also share a channel with you. phunk default: 2. */
  minFollowedBy?: number;
  /** Extra fids never to suggest. */
  exclude?: ReadonlySet<number>;
  /** Cap on the returned list. */
  limit?: number;
}

/**
 * Rank candidates. No network.
 *
 * `theirFollows` maps each sampled account you follow to the fids it
 * follows. `channelAuthors` maps a channel URL to {fid: recent posts}.
 */
export const scoreSuggestions = (
  me: number,
  following: ReadonlySet<number>,
  theirFollows: ReadonlyMap<number, ReadonlySet<number>>,
  channelAuthors: ReadonlyMap<string, ReadonlyMap<number, number>>,
  { minFollowedBy = 2, exclude = new Set<number>(), limit }: ScoreOptions = {},
): Suggestion[] => {
  const skip = new Set<number>(following);
  skip.add(me);
  for (const fid of exclude) {
    skip.add(fid);
  }

  // fid → the people you follow who follow them.
  const by = new Map<number, number[]>();
  for (const [friend, targets] of theirFollows) {
    for (const target of targets) {
      if (!skip.has(target)) {
        const list = by.get(target);
        if (list === undefined) {
          by.set(target, [friend]);
        } else {
          list.push(friend);
        }
      }
    }
  }

  // fid → the channel URLs you both post in, plus their post counts.
  const chans = new Map<number, string[]>();
  const posts = new Map<number, number>();
  for (const [url, authors] of channelAuthors) {
    for (const [fid, count] of authors) {
      if (!skip.has(fid)) {
        const list = chans.get(fid);
        if (list === undefined) {
          chans.set(fid, [url]);
        } else {
          list.push(url);
        }
        posts.set(fid, (posts.get(fid) ?? 0) + count);
      }
    }
  }

  const out: Suggestion[] = [];
  const candidates = new Set<number>([...by.keys(), ...chans.keys()]);
  for (const fid of candidates) {
    const followedBy = [...(by.get(fid) ?? [])].sort((a, b) => a - b);
    const channels = [...(chans.get(fid) ?? [])].sort();
    if (followedBy.length < minFollowedBy && channels.length === 0) {
      continue;
    }
    out.push({
      fid,
      score: followedBy.length + CHANNEL_POINTS * channels.length,
      followedBy,
      channels,
    });
  }

  // Ties: more people you follow first, then more channel posts, then the
  // older account.
  out.sort(
    (a, b) =>
      b.score - a.score ||
      b.followedBy.length - a.followedBy.length ||
      (posts.get(b.fid) ?? 0) - (posts.get(a.fid) ?? 0) ||
      a.fid - b.fid,
  );
  return limit === undefined ? out : out.slice(0, limit);
};

/**
 * A channel's name for the reason line: `/founders` from the URL the casts
 * carry. Unknown `chain://` channels keep their URL (same rule as phunk's
 * `channel_name`).
 */
export const channelNameFor = (url: string): string => {
  for (const prefix of [
    'https://warpcast.com/~/channel/',
    'https://farcaster.xyz/~/channel/',
  ]) {
    if (url.startsWith(prefix)) {
      return `#${url.slice(prefix.length).replace(/^\/+|\/+$/g, '')}`;
    }
  }
  return url;
};

/** How many names the reason line spells out before "and N more". */
const REASON_NAMES_SHOWN = 3;

export interface ReasonName {
  fid: number;
  username?: string;
  displayName?: string;
}

const nameOf = (name: ReasonName): string =>
  name.username ? `@${name.username}` : (name.displayName ?? `fid ${name.fid}`);

/**
 * Why someone is suggested, in words. One plain line, phunk's vocabulary
 * ("Followed by @a and @b", channel activity), no score jargon.
 *
 * `followedBy` may be plain fids or resolved names — a name that was not
 * resolved reads as its fid, never as an invented handle.
 */
export const suggestionReason = (
  suggestion: {
    followedBy: ReadonlyArray<ReasonName | number>;
    channels: readonly string[];
  },
  names: ReadonlyMap<number, ReasonName>,
): string => {
  const parts: string[] = [];
  const who = suggestion.followedBy.map((entry) => {
    const fid = typeof entry === 'number' ? entry : entry.fid;
    const name =
      names.get(fid) ?? (typeof entry === 'number' ? undefined : entry);
    return name ? nameOf(name) : `fid ${fid}`;
  });
  if (who.length === 1) {
    parts.push(`Followed by ${who[0]}, whom you follow`);
  } else if (who.length > 1) {
    const shown = who
      .slice(0, REASON_NAMES_SHOWN)
      .join(who.length === 2 ? ' and ' : ', ');
    const more = who.length - REASON_NAMES_SHOWN;
    parts.push(
      `Followed by ${shown}${more > 0 ? ` and ${more} more` : ''} you follow`,
    );
  }
  if (suggestion.channels.length > 0) {
    const channelNames = suggestion.channels.map(channelNameFor);
    parts.push(
      `posts in ${
        who.length > 0
          ? channelNames[0]
          : `${channelNames.slice(0, 2).join(' and ')}${
              channelNames.length > 2 ? ' and more' : ''
            }`
      }, a channel you read`,
    );
  }
  return parts.join(' · ');
};
