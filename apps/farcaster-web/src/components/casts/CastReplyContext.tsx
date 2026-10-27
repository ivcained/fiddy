import cn from 'classnames';
import { ApiCast } from 'farcaster-client-data';
import { resolveUsername } from 'farcaster-client-hooks';
import { memo } from 'react';

import { LinkToConversationWithoutUsername } from '~/components/links/LinkToConversationWithoutUsername';

function CastReplyContext({
  cast,
  className,
  currentUserFid,
}: {
  cast: ApiCast;
  className?: string;
  currentUserFid?: number;
}) {
  if (!cast.parentHash) {
    return null;
  }

  const parentName = cast.parentAuthor
    ? cast.parentAuthor.fid === currentUserFid
      ? 'you'
      : resolveUsername({
          username: cast.parentAuthor.username,
          fid: cast.parentAuthor.fid,
        })
    : 'the parent cast';

  return (
    <div
      className={cn('pb-1 text-xs text-muted', className)}
      data-fiddy="reply-context"
      data-parent-hash={cast.parentHash}
    >
      <LinkToConversationWithoutUsername
        params={{ castHash: cast.parentHash }}
        title="Open parent cast"
        className="inline-flex max-w-full items-center gap-1 hover:underline"
      >
        <span data-fiddy="reply-parent-link">
          Replying to{' '}
          <span className="font-medium text-default">{parentName}</span>
        </span>
      </LinkToConversationWithoutUsername>
    </div>
  );
}

const MemoizedCastReplyContext = memo(CastReplyContext);

export { MemoizedCastReplyContext as CastReplyContext };
