// Adapted from quilcast (MIT), https://github.com/backmeupplz/quilcast
// (src/gifs.tsx at 2abe184cc734) — concept-level: theirs is a Preact component
// with the fetch inline; ours keeps the search's STATE separate from the UI so
// the machine is testable without a browser.
//
// The GIF picker's search, as data. One endpoint, same origin: GET
// /api/gifs?q=… (server/instance/gifs.mjs). The picker only ever reads three
// answers:
//
//   results   an array (possibly empty) of GIFs
//   error     the search failed — "GIFs didn't load — try again"
//   off       this server has no GIF search (static hosting, or the operator
//             set FIDDY_GIFS=off) — the picker says so in place and never
//             pretends to search
//
// "off" is read from the ANSWER, not guessed: a 501 (the endpoint is mounted
// but disabled), a 404 (nothing is mounted there at all), or a reply that is
// not JSON (a static host's SPA fallback answering the API path with HTML).

export type GifSearchResult = {
  /** The picker's grid tile. */
  url: string;
  /** The small tile the grid actually paints. */
  preview: string;
  w: number;
  h: number;
  title: string;
  /** The `.gif` URL a cast embeds — never the heavy grid URL. */
  cast: string;
};

export type GifSearchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'results'; results: GifSearchResult[] }
  | { status: 'empty' }
  | { status: 'error' }
  | { status: 'off' };

export type GifSearchAction =
  | { type: 'search' }
  | { type: 'results'; results: GifSearchResult[] }
  | { type: 'error' }
  | { type: 'off' };

export const gifSearchReducer = (
  _state: GifSearchState,
  action: GifSearchAction,
): GifSearchState => {
  switch (action.type) {
    case 'search':
      return { status: 'loading' };
    case 'results':
      return action.results.length > 0
        ? { status: 'results', results: action.results }
        : { status: 'empty' };
    case 'error':
      return { status: 'error' };
    case 'off':
      return { status: 'off' };
  }
};

const GIFS_ENDPOINT = '/api/gifs';

const isGifArray = (body: unknown): body is GifSearchResult[] =>
  Array.isArray(body) &&
  body.every(
    (g) =>
      g &&
      typeof g === 'object' &&
      typeof (g as GifSearchResult).url === 'string' &&
      typeof (g as GifSearchResult).preview === 'string' &&
      typeof (g as GifSearchResult).cast === 'string',
  );

/**
 * One search. Resolves with the results array; rejects never — a failure is a
 * value ({ ok: false, reason }), because the picker's job is to SAY what
 * happened, not to crash.
 */
export const searchGifs = async (
  query: string,
  {
    fetchImpl = fetch,
    endpoint = GIFS_ENDPOINT,
  }: {
    fetchImpl?: typeof fetch;
    endpoint?: string;
  } = {},
): Promise<
  | { ok: true; results: GifSearchResult[] }
  | { ok: false; reason: 'error' | 'off' }
> => {
  let response: Response;
  try {
    response = await fetchImpl(
      `${endpoint}?q=${encodeURIComponent(query.trim())}`,
      { credentials: 'same-origin' },
    );
  } catch {
    return { ok: false, reason: 'error' };
  }
  if (response.status === 501 || response.status === 404) {
    return { ok: false, reason: 'off' };
  }
  if (!response.ok) {
    return { ok: false, reason: 'error' };
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    // A static host answers the API path with the SPA's HTML. There is no
    // search here, and saying so is the honest state.
    return { ok: false, reason: 'off' };
  }
  try {
    const body: unknown = await response.json();
    if (!isGifArray(body)) {
      return { ok: false, reason: 'error' };
    }
    return { ok: true, results: body };
  } catch {
    return { ok: false, reason: 'error' };
  }
};
