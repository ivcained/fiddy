/**
 * What the "new posts" pill says: on the pill, and to a screen reader.
 *
 * Framework-free and type-only, like `newPosts.ts`, because the words are the
 * part worth testing without a simulator. Two rules live here:
 *
 *   - The pill never counts what it cannot stand behind: no number means
 *     "New posts", not "0" and not a guess.
 *   - VoiceOver is never read a FID. The authors of a *new* post are, almost by
 *     definition, not in the profile cache yet, so what we can name at any given
 *     moment changes; an author whose handle has not landed is left out of the
 *     sentence rather than spoken as `fid 12`.
 */

/** The least a profile has to expose to be named. */
export interface NamedProfile {
  username: string | null;
}

/** Where handles come from: the profile map the Feed tab already holds. */
export interface ProfileLookup {
  get(fid: number): NamedProfile | undefined;
}

/** As many authors as the pill has room for at 390 pt, and as many as are named. */
export const NAMED_AUTHORS = 3;

/** "3 new posts", "1 new post", or "New posts" when there is no honest count. */
export const newPostsLabel = (count: number | null): string => {
  // A held count of zero happens when everything new was the viewer's own or
  // filtered out of the feed: there is something to insert, nothing to count.
  if (count === null || count === 0) {
    return 'New posts';
  }
  return count === 1 ? '1 new post' : `${count} new posts`;
};

/**
 * The `@handles` that can be named right now, in the order the authors appear.
 *
 * An unresolved profile is skipped, not rendered as a number: the caller may
 * announce a short list rather than a wrong one. Duplicates collapse, so a
 * recast and a cast from the same author are named once.
 */
export const knownHandles = (
  authors: number[],
  profiles: ProfileLookup,
): string[] => {
  const handles: string[] = [];
  for (const fid of authors) {
    const username = profiles.get(fid)?.username;
    if (!username) {
      continue;
    }
    const handle = `@${username}`;
    if (!handles.includes(handle)) {
      handles.push(handle);
    }
  }
  return handles;
};

/** True once every author can be named: the announcement need not wait longer. */
export const allHandlesKnown = (
  authors: number[],
  profiles: ProfileLookup,
): boolean =>
  authors.every((fid) => Boolean(profiles.get(fid)?.username));

/**
 * What VoiceOver says: the count, who posted, and what the tap does.
 *
 * `handles` is already-resolved `@names` (see `knownHandles`); an empty list
 * simply drops the "from …" clause.
 */
export const newPostsAccessibilityLabel = ({
  count,
  handles,
  replace,
}: {
  count: number | null;
  handles: string[];
  replace: boolean;
}): string => {
  const named = handles.slice(0, NAMED_AUTHORS);
  const rest = handles.length - named.length;
  let from = '';
  if (named.length === 1 && rest === 0) {
    from = ` from ${named[0]}`;
  } else if (named.length > 1 && rest === 0) {
    from = ` from ${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
  } else if (named.length > 0) {
    from = ` from ${named.join(', ')} and ${rest} more`;
  }
  const action = replace ? 'Reload the feed.' : 'Show them.';
  return `${newPostsLabel(count)}${from}. ${action}`;
};