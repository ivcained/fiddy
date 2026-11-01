// Adapted from quilcast (MIT), https://github.com/backmeupplz/quilcast
// (src/gifs.tsx at 2abe184cc734) — concept-level: theirs is Preact; ours is
// the fork's React, and the search state machine lives in
// `~/components/composer/gifs/gifSearch` so it is testable without a browser.
//
// The GIF picker's own surface — the chunk that lazy-loads behind the GIF
// button (`GifPickerPopover` imports this module with `import()`), so none of
// this is in the eager bundle.
//
// Every state says something true, in plain words:
//   loading   the spinner
//   results   the grid
//   empty     "No GIFs found."
//   error     "GIFs didn't load — try again" (with the retry)
//   off       "GIFs aren't available on this server." — static hosting or the
//             operator's FIDDY_GIFS=off; never a broken search box

import React from 'react';

import {
  gifSearchReducer,
  type GifSearchResult,
  type GifSearchState,
  searchGifs,
} from '~/components/composer/gifs/gifSearch';

type GifPickerSurfaceProps = {
  onGifPick: (gif: GifSearchResult) => void;
};

/** What an empty box searches: the same default quilcast opens on. */
const DEFAULT_SEARCH = 'trending';

/** Quilcast's debounce: 350 ms between the last keystroke and the search. */
const SEARCH_DEBOUNCE_MS = 350;

const GifPickerSurface: React.FC<GifPickerSurfaceProps> = ({ onGifPick }) => {
  const [query, setQuery] = React.useState('');
  const [state, dispatch] = React.useReducer(gifSearchReducer, {
    status: 'idle',
  } as GifSearchState);
  // Bumped by the retry button so the same query searches again.
  const [attempt, setAttempt] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => inputRef.current?.focus(), []);

  React.useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      dispatch({ type: 'search' });
      searchGifs(query.trim() || DEFAULT_SEARCH).then((answer) => {
        if (!live) {
          return;
        }
        if (answer.ok) {
          dispatch({ type: 'results', results: answer.results });
        } else {
          dispatch({ type: answer.reason });
        }
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, attempt]);

  return (
    <div
      className="flex h-[420px] w-[352px] max-w-full flex-col rounded-md border bg-elevated border-default"
      data-fiddy="gif-picker"
    >
      <div className="border-b p-2 border-default">
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search GIFs"
          aria-label="Search GIFs"
          className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none border-default text-default placeholder:text-faint"
          data-fiddy="gif-picker-search"
        />
      </div>
      <div className="scrollbar-vert min-h-0 flex-1 overflow-y-auto p-2">
        {state.status === 'idle' || state.status === 'loading' ? (
          <div
            aria-busy="true"
            className="flex h-full items-center justify-center text-sm text-muted"
            data-fiddy="gif-picker-loading"
          >
            Loading GIFs…
          </div>
        ) : state.status === 'empty' ? (
          <div
            className="flex h-full items-center justify-center text-sm text-muted"
            data-fiddy="gif-picker-empty"
          >
            No GIFs found.
          </div>
        ) : state.status === 'error' ? (
          <div
            className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted"
            data-fiddy="gif-picker-error"
          >
            <span>GIFs didn&rsquo;t load — try again.</span>
            <button
              type="button"
              className="rounded-md border px-3 py-1 border-default text-default hover:bg-overlay-faint"
              onClick={() => setAttempt((n) => n + 1)}
              data-fiddy="gif-picker-retry"
            >
              Try again
            </button>
          </div>
        ) : state.status === 'off' ? (
          <div
            className="flex h-full items-center justify-center px-6 text-center text-sm text-muted"
            data-fiddy="gif-picker-unavailable"
          >
            GIFs aren&rsquo;t available on this server.
          </div>
        ) : (
          <div
            className="grid grid-cols-2 gap-2"
            data-fiddy="gif-picker-results"
          >
            {state.results.map((gif) => (
              <button
                key={gif.cast}
                type="button"
                aria-label={gif.title || 'GIF'}
                title={gif.title || 'GIF'}
                className="overflow-hidden rounded-md border border-default hover:border-[#d4ff3f]"
                onClick={() => onGifPick(gif)}
                data-fiddy="gif-picker-result"
                data-gif-cast-url={gif.cast}
              >
                <img
                  src={gif.preview}
                  alt={gif.title || 'GIF'}
                  width={gif.w}
                  height={gif.h}
                  loading="lazy"
                  className="h-auto w-full object-cover"
                />
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="border-t px-2 py-1 text-right text-xs border-default text-faint">
        GIFs from Tenor.
      </div>
    </div>
  );
};

export { GifPickerSurface };
