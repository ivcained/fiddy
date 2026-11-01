import React from 'react';

import type { GifSearchResult } from '~/components/composer/gifs/gifSearch';
import { AnchoredPopover } from '~/components/popovers/AnchoredPopover';

type GifPickerPopoverProps = {
  trigger: React.ReactElement;
  onGifPick: (gif: GifSearchResult) => void;
  onOpenChange?: (open: boolean) => void;
  contentClassName?: string;
};

/**
 * The GIF picker — search UI, grid, and the search state machine — is
 * `GifPickerSurface`, and it is an `import()` here rather than a top-level
 * import for the same reason the emoji picker is (`EmojiPickerPopover`): this
 * component's callers are on the feed's own path (`GifComposerPicker` ->
 * `Composer`), so a static import would put the picker in the eager chunk that
 * draws the feed. Nothing about drawing a cast needs a GIF picker.
 *
 * `warmGifPicker` runs from the trigger's own pointer/focus events, so the
 * chunk is already on its way by the time the popover opens.
 */
const loadGifPicker = () =>
  import('~/components/popovers/GifPickerSurface').then((module) => ({
    default: module.GifPickerSurface,
  }));

const LazyGifPickerSurface = React.lazy(loadGifPicker);

const warmGifPicker = () => {
  // The promise IS the load; React.lazy remembers it, so there is nothing to
  // await here and no state to keep.
  void loadGifPicker();
};

/**
 * The picker's own footprint while its chunk arrives, so the popover does not
 * jump when it lands.
 */
const GifPickerSurfaceFallback: React.FC = () => (
  <div
    aria-busy="true"
    className="flex h-[420px] w-[352px] items-center justify-center rounded-md text-sm text-muted"
    data-fiddy="gif-picker-surface-loading"
  >
    Loading GIFs…
  </div>
);

/** Adds the fetch-on-intent handlers to whatever element the caller passes as
 * the trigger, keeping whatever handlers the caller already set on it. */
const warmableTrigger = (trigger: React.ReactElement): React.ReactElement => {
  const element = trigger as React.ReactElement<
    React.HTMLAttributes<HTMLElement>
  >;
  const existing = element.props;

  return React.cloneElement(element, {
    onPointerEnter: (event: React.PointerEvent<HTMLElement>) => {
      warmGifPicker();
      existing.onPointerEnter?.(event);
    },
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      warmGifPicker();
      existing.onFocus?.(event);
    },
  });
};

const GifPickerPopover: React.FC<GifPickerPopoverProps> = ({
  trigger,
  onGifPick,
  onOpenChange,
  contentClassName,
}) => {
  const [open, setOpen] = React.useState(false);

  return (
    <AnchoredPopover
      contentClassName={contentClassName}
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        onOpenChange?.(nextOpen);
      }}
      sideOffset={4}
      trigger={warmableTrigger(trigger)}
    >
      <React.Suspense fallback={<GifPickerSurfaceFallback />}>
        <LazyGifPickerSurface
          onGifPick={(gif) => {
            onGifPick(gif);
            setOpen(false);
          }}
        />
      </React.Suspense>
    </AnchoredPopover>
  );
};

export { GifPickerPopover };
