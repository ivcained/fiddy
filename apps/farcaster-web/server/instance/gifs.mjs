// Adapted from quilcast (MIT), https://github.com/backmeupplz/quilcast
// (server/shrek.mjs `gifResults`/`gifs` at 2abe184cc734).
//
// The same-origin GIF search the composers' GIF picker reads: GET /api/gifs?q=…
// is answered HERE, by the server that serves this copy of Fiddy, so a search
// never leaves this origin from the browser — Tenor sees one server fetch per
// query, never the reader's browser.
//
// Tenor needs no key for this: the search page carries its results as JSON in
// a `store-cache` script, which is what quilcast parses. An operator who does
// not want their server proxying GIF search at all sets FIDDY_GIFS=off and the
// endpoint answers 501 GIFS_OFF — the picker then says so in place instead of
// pretending to search.
//
// `cast` is what the composer embeds in a cast, which other Farcaster clients
// show too. An embed's type is read from the file: Tenor `.gif`s come back as
// `image/gif` and every client animates a GIF, while an `.mp4` would end up a
// link and an animated `.webp` plays only where a client's image pipeline
// keeps its frames. So a `.gif`: Tenor's `mediumgif` is the 498px GIF with
// fewer colors, about two thirds of the full one's weight; then the full one,
// and the 220px `tinygif` when both are over 4 MB (a few are, at up to 12 MB),
// which is too much for a feed.

const TENOR = /^https:\/\/media\d?\.tenor\.com\//;
const USER_AGENT = 'fiddy-gif-search (+https://fiddy.fun)';

/** One search keeps its answer for an hour, like quilcast's cache below the
 *  browsers' own. Failures are never cached, so a Tenor hiccup retries on the
 *  next keystroke rather than poisoning the query for the hour. */
const CACHE_TTL_MS = 3600e3;
const MAX_CACHE_ENTRIES = 500;
const FETCH_TIMEOUT_MS = 10e3;
/** Tenor's search page is HTML with the JSON inline; cap the read. */
const MAX_PAGE_BYTES = 4e6;
/** Per-IP search budget: a picker types a handful of queries a minute. */
const RATE_LIMIT_PER_MINUTE = 30;

/** The GIFs in one Tenor search page, which carries its results as JSON in a
 *  store-cache script. */
const pageResults = (html) => {
  const json = html.match(
    /<script id="store-cache"[^>]*>([\s\S]*?)<\/script>/,
  )?.[1];
  if (!json) return [];
  try {
    return Object.values(JSON.parse(json).universal?.search || {}).flatMap(
      (s) => s.results || [],
    );
  } catch {
    return [];
  }
};

/** One Tenor search page as { url, preview, w, h, title, cast }. `url` and
 *  `preview` are the picker's own grid; `cast` is the `.gif` the composer
 *  embeds. A result with no castable `.gif` still shows — it just can't be
 *  picked into a cast, so it is left out here. */
export function gifResults(html) {
  return pageResults(html).flatMap((g) => {
    const f = g.media_formats || {};
    const ok = (x) => x?.url && TENOR.test(x.url);
    const big = [f.webp, f.gif].find((x) => x?.size < 4e6 && ok(x));
    const small = [f.tinywebp, f.tinygif].find(ok);
    const cast =
      [f.mediumgif, f.gif].find((x) => x?.size < 4e6 && ok(x)) ||
      [f.tinygif].find(ok);
    return big && small && cast
      ? [
          {
            url: big.url,
            preview: small.url,
            w: big.dims?.[0] || 1,
            h: big.dims?.[1] || 1,
            title: String(g.content_description || '').slice(0, 100),
            cast: cast.url,
          },
        ]
      : [];
  });
}

const readBody = async (response, maxBytes) => {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    return text.slice(0, maxBytes);
  }
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    chunks.push(value);
    if (size >= maxBytes) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
};

export function createGifService({
  env = process.env,
  fetchImpl = fetch,
  now = () => Date.now(),
  log = (message) => console.log(`[fiddy gifs] ${message}`),
} = {}) {
  /** FIDDY_GIFS=off is the operator's switch. Anything else (or unset) is on:
   *  this search needs no key, so "unconfigured" is the endpoint not existing
   *  at all — static hosting — which the picker reads from the 404. */
  const enabled = env.FIDDY_GIFS !== 'off';

  const cache = new Map(); // key -> { at, promise }
  const rate = new Map(); // ip -> { windowStart, count }

  const limited = (ip) => {
    const start = now();
    const entry = rate.get(ip);
    if (!entry || start - entry.windowStart > 60e3) {
      rate.set(ip, { windowStart: start, count: 1 });
      return false;
    }
    entry.count += 1;
    return entry.count > RATE_LIMIT_PER_MINUTE;
  };

  const fetchResults = async (q) => {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(
        `https://tenor.com/search/${encodeURIComponent(q.replace(/\s+/g, '-'))}-gifs`,
        {
          headers: { 'user-agent': USER_AGENT },
          signal: controller.signal,
        },
      );
      // A failure throws, so the search is not cached and gets tried again.
      if (response.status !== 200) {
        throw new Error(`tenor ${response.status}`);
      }
      return gifResults(await readBody(response, MAX_PAGE_BYTES));
    } finally {
      clearTimeout(deadline);
    }
  };

  const search = async ({ q, ip }) => {
    if (!enabled) {
      return { status: 501, body: { code: 'GIFS_OFF' } };
    }
    const query = String(q ?? '').trim().slice(0, 100);
    if (!query) {
      return { status: 400, body: { code: 'GIFS_QUERY' } };
    }
    if (limited(ip ?? 'unknown')) {
      return { status: 429, body: [] };
    }
    const key = query.toLowerCase();
    const cached = cache.get(key);
    if (cached && now() - cached.at < CACHE_TTL_MS) {
      return { status: 200, body: await cached.promise };
    }
    if (cached) {
      cache.delete(key);
    }
    const entry = { at: now(), promise: fetchResults(query) };
    // Cap the cache: drop the oldest entries first.
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
    cache.set(key, entry);
    try {
      return { status: 200, body: await entry.promise };
    } catch (error) {
      cache.delete(key);
      log(`search failed for ${JSON.stringify(query)}: ${error?.message ?? error}`);
      throw error;
    }
  };

  return { enabled, search };
}

export const GIFS_PATH = '/api/gifs';
