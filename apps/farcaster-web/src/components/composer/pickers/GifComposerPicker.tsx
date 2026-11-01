import classNames from 'classnames';
import { AnalyticsEvent } from 'farcaster-analytics';
import type React from 'react';

import type { GifSearchResult } from '~/components/composer/gifs/gifSearch';
import { GifPickerPopover } from '~/components/popovers/GifPickerPopover';
import { useAnalytics } from '~/contexts/AnalyticsProvider';

type GifComposerPickerProps = {
  onGifPick: (gif: GifSearchResult) => void;
  className?: string;
  iconClassName?: string;
  popoverClassName?: string;
};

/**
 * The composers' GIF button. The picker itself lazy-loads behind it
 * (`GifPickerPopover`), exactly like the emoji picker beside it.
 *
 * The trigger is the word "GIF", not an icon font's guess: there is no GIF
 * glyph in the icon set this app ships, and three letters everyone can read
 * beat a lookalike.
 */
const GifComposerPicker: React.FC<GifComposerPickerProps> = ({
  onGifPick,
  className,
  iconClassName,
  popoverClassName,
}) => {
  const { trackEvent } = useAnalytics();

  return (
    <GifPickerPopover
      onGifPick={(gif) => {
        trackEvent(AnalyticsEvent.CastComposerGifSelected, {});
        onGifPick(gif);
      }}
      contentClassName={popoverClassName}
      trigger={
        <div
          role="button"
          tabIndex={0}
          aria-label="Add a GIF"
          title="Add a GIF"
          className={classNames(
            'flex cursor-pointer flex-row items-center rounded-md p-1 px-4 py-2',
            className,
          )}
          onClick={() => {
            trackEvent(AnalyticsEvent.CastComposerGifPressed, {});
          }}
          data-fiddy="gif-picker-trigger"
        >
          <span
            className={classNames(
              'text-[11px] font-bold leading-4 tracking-wide',
              iconClassName,
            )}
          >
            GIF
          </span>
        </div>
      }
    />
  );
};

export { GifComposerPicker };
