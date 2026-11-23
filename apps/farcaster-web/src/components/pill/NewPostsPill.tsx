/**
 * NewPostsPill: a count-holding pill that shows "New posts" when the feed has
 * unseen items. Tapping it scrolls to the top and refreshes the feed.
 *
 * Borrowed pattern from quilcast (MIT) — new items wait behind the pill on
 * open and at the top, never auto-inserted.
 *   src/app.tsx (pill/poll) / commit 74bc826ebd63
 *
 * Fiddy twist: the unseen signal (useChannelFeedUnseenStatus) returns a
 * boolean, not a count. The pill shows "New posts" when there is at least
 * one unseen item — no precise count, but the key behavioral guarantee (no
 * auto-insertion on open/top, deferred until tap) is preserved.
 */

import { ArrowUpIcon } from '@primer/octicons-react';
import { AnimatePresence, motion } from 'motion/react';
import { FC, memo } from 'react';

interface NewPostsPillProps {
  hasNewItems: boolean;
  onClick: () => void;
}

const NewPostsPill: FC<NewPostsPillProps> = memo(({ hasNewItems, onClick }) => {
  return (
    <AnimatePresence>
      {hasNewItems && (
        <motion.div
          initial={{ opacity: 0, y: -20, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -20, scale: 0.95 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
          className="fixed left-1/2 z-10 -translate-x-1/2"
          style={{ top: 72 }}
        >
          <button
            type="button"
            onClick={onClick}
            className="flex cursor-pointer items-center gap-2 rounded-full border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-900 shadow-md transition-colors hover:bg-gray-50 active:scale-[0.97] dark:border-gray-700 dark:bg-gray-800 dark:text-white dark:hover:bg-gray-700"
          >
            <ArrowUpIcon size="small" />
            <span>New posts</span>
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
});

NewPostsPill.displayName = 'NewPostsPill';

export { NewPostsPill };
