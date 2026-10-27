import { ApiCast, ApiUser } from 'farcaster-client-data';
import { mapWithConcurrency, NodeMessage } from 'farcaster-node-client';

/**
 * Fill reply labels from casts already on the page. A conversation has the full
 * parent profile beside the reply, so no second lookup or guessed handle is needed.
 */
export function attachParentAuthors(casts: ApiCast[]): ApiCast[] {
  const byHash = new Map(casts.map((cast) => [cast.hash, cast]));
  return casts.map((cast) => {
    if (!cast.parentHash || cast.parentAuthor) {
      return cast;
    }
    const parentAuthor = byHash.get(cast.parentHash)?.author;
    return parentAuthor ? { ...cast, parentAuthor } : cast;
  });
}

/** Read each distinct reply parent once. An unreadable parent only omits its name. */
export async function readParentAuthors({
  messages,
  castById,
  readAuthor,
}: {
  messages: NodeMessage[];
  castById: (fid: number, hash: string) => Promise<NodeMessage | undefined>;
  readAuthor: (fid: number) => Promise<ApiUser>;
}): Promise<Map<string, ApiUser>> {
  const parents = new Map<string, { fid: number; hash: string }>();
  for (const message of messages) {
    const parent = message.castAdd?.parentCastId;
    if (parent) {
      parents.set(parent.hash, parent);
    }
  }

  const entries = await mapWithConcurrency(
    [...parents.values()],
    6,
    async (parent) => {
      try {
        const message = await castById(parent.fid, parent.hash);
        if (!message?.castAdd) {
          return [];
        }
        const author = await readAuthor(message.fid);
        return [[parent.hash, author] as const];
      } catch {
        return [];
      }
    },
  );
  return new Map(entries.flat());
}
