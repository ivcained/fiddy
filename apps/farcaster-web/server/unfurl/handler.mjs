/**
 * The route table, as a function of the request — no sockets, no globals.
 *
 * Everything a request can do is decided here, which is what makes the service
 * testable without a network and without a browser: `server.mjs` is the thin
 * part that turns a socket into a call and the answer into bytes.
 *
 * The contract with the host, in one sentence: **this service answers a cast or
 * profile URL with the shell the release ships, or with the shell plus that
 * page's tags; it never answers with a document of its own invention.** A page
 * it cannot read is not an error page — it is the shell, unchanged, exactly
 * what the host served before this service existed. That is what makes the
 * nginx fallback and the honest-miss path the same thing.
 */

import { cardUrl, pageTags, renderPageHtml } from './shellMeta.mjs';
import { castPage, profilePage } from './pages.mjs';
import { CARD_HEIGHT, CARD_WIDTH } from './cards.mjs';

const HTML_TTL_MS = 5 * 60 * 1000;
const MISS_TTL_MS = 30 * 1000;
const CARD_TTL_MS = 60 * 60 * 1000;
const AUTHOR_TTL_MS = 60 * 60 * 1000;

const text = (status, body, headers = {}) => ({
  status,
  headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
  body,
});

export const createUnfurlHandler = ({
  origin = 'https://fiddy.fun',
  shellSource,
  siteCard,
  renderCard,
  reader,
  now = () => Date.now(),
  htmlTtlMs = HTML_TTL_MS,
  missTtlMs = MISS_TTL_MS,
  cardTtlMs = CARD_TTL_MS,
  authorTtlMs = AUTHOR_TTL_MS,
}) => {
  /** Two windows: a page that exists is worth caching, a miss is not. */
  const htmlCache = new Map();
  const cardCache = new Map();
  const authorCache = new Map();

  const cached = (map, key, ttlMs, load) => {
    const hit = map.get(key);
    if (hit && now() - hit.at < hit.ttlMs) {
      return Promise.resolve(hit);
    }
    return Promise.resolve(load()).then((value) => {
      if (map.size >= 500) {
        map.delete(map.keys().next().value);
      }
      const entry = {
        at: now(),
        ttlMs: value?.ok ? ttlMs : missTtlMs,
        ...value,
      };
      map.set(key, entry);
      return entry;
    });
  };

  const png = (buffer, note) => ({
    status: 200,
    headers: {
      'content-type': 'image/png',
      'cache-control': `public, max-age=${Math.floor(cardTtlMs / 1000)}`,
      'content-length': String(buffer.length),
      'x-unfurl': note,
    },
    body: buffer,
  });

  /**
   * A card, or the site card, or — if even that is missing — a 503.
   *
   * The site card is the fallback on purpose: it is 1200x630, it is this
   * product's art, and it is the picture this URL unfurled with yesterday.
   */
  const card = async (kind, id, buildPayload) => {
    const key = `${kind}:${id}`;
    const entry = await cached(cardCache, key, cardTtlMs, async () => {
      try {
        return { ok: true, png: await renderCard(buildPayload()) };
      } catch (error) {
        return {
          ok: false,
          note: `card failed: ${error.message}`,
          png: undefined,
        };
      }
    });
    if (entry.png) {
      return png(entry.png, `card:${kind}`);
    }
    const fallback = typeof siteCard === 'function' ? siteCard() : siteCard;
    if (fallback?.length) {
      return png(fallback, 'card:site');
    }
    return text(503, `no card for ${key}\n`, {
      'x-unfurl': 'card:unavailable',
    });
  };

  /** The shell, with this page's head when the page could be read. */
  const page = async (path, resolve) => {
    const entry = await cached(htmlCache, path, htmlTtlMs, async () => {
      try {
        const facts = await resolve();
        if (!facts) {
          return { ok: false };
        }
        const tags = pageTags({
          ...facts,
          origin,
          imageUrl: cardUrl(
            origin,
            facts.kind,
            facts.kind === 'cast' ? facts.card.hash : facts.card.fid,
          ),
        });
        return {
          ok: true,
          html: renderPageHtml(shellSource(), tags),
          kind: facts.kind,
        };
      } catch {
        // A source that failed is not a page that does not exist; either way the
        // answer is the shell, because a reader is about to load the app.
        return { ok: false };
      }
    });
    if (entry.ok) {
      return {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=300',
          'x-unfurl': `page:${entry.kind ?? 'page'}`,
        },
        body: entry.html,
      };
    }
    return {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=300',
        'x-unfurl': 'shell',
      },
      body: shellSource(),
    };
  };

  return {
    /**
     * @param {{method: string, path: string}} request
     * @returns {Promise<{status: number, headers: Record<string,string>, body: string|Buffer}>}
     */
    async handle({ method, path }) {
      if (method !== 'GET' && method !== 'HEAD') {
        return text(405, 'only GET\n');
      }
      const [, ...segments] = path.split('?')[0].split('/');

      if (segments[0] === 'unfurl' && segments[1] === 'health') {
        return {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          },
          body: `${JSON.stringify({
            ok: true,
            origin,
            shellBytes: shellSource().length,
            siteCard: Boolean(
              typeof siteCard === 'function' ? siteCard() : siteCard,
            ),
            reads: reader.size?.() ?? 0,
            html: htmlCache.size,
            cards: cardCache.size,
          })}\n`,
        };
      }

      // The client's own question: which account wrote this cast? The reader's
      // node cannot answer it (a Snapchain node shards by FID), so the origin
      // that already had to answer it for the crawler answers it here too.
      if (
        segments[0] === 'unfurl' &&
        segments[1] === 'cast-author' &&
        segments[2]
      ) {
        const hash = decodeURIComponent(segments[2]);
        const key = hash.toLowerCase();
        const entry = await cached(authorCache, key, authorTtlMs, async () => {
          try {
            const facts = await reader.cast(hash);
            return facts
              ? { ok: true, fid: facts.cast.fid }
              : { ok: false, fid: undefined };
          } catch {
            return { ok: false, fid: undefined };
          }
        });
        if (entry.fid === undefined) {
          return {
            status: 404,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
              'x-unfurl': 'author:miss',
            },
            body: `${JSON.stringify({ hash, fid: null, why: 'no index on this origin knows that cast hash' })}\n`,
          };
        }
        return {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'x-unfurl': 'author',
          },
          body: `${JSON.stringify({ hash, fid: entry.fid })}\n`,
        };
      }

      if (
        segments[0] === 'unfurl' &&
        segments[1] === 'cards' &&
        segments[2] &&
        segments[3]
      ) {
        const kind = segments[2];
        const id = decodeURIComponent(segments[3].replace(/\.png$/i, ''));
        if (kind === 'cast') {
          return card('cast', id.toLowerCase(), () =>
            reader.cast(id).then((facts) => {
              if (!facts) {
                throw new Error('that cast could not be read');
              }
              return castPage({ origin, hash: id, ...facts }).card;
            }),
          );
        }
        if (kind === 'profile') {
          return card('profile', id, () =>
            reader.profile(id).then((facts) => {
              if (!facts) {
                throw new Error('that profile could not be read');
              }
              return profilePage({ origin, fid: id, ...facts }).card;
            }),
          );
        }
      }

      if (
        segments[0] === '~' &&
        segments[1] === 'conversations' &&
        segments[2]
      ) {
        const hash = decodeURIComponent(segments[2]);
        return page(`/~/conversations/${hash}`, async () => {
          const facts = await reader.cast(hash);
          return facts
            ? { ...castPage({ origin, hash, ...facts }) }
            : undefined;
        });
      }

      if (segments[0] === '~' && segments[1] === 'profiles' && segments[2]) {
        const fid = decodeURIComponent(segments[2]);
        return page(`/~/profiles/${fid}`, async () => {
          const facts = await reader.profile(fid);
          return facts
            ? { ...profilePage({ origin, fid, ...facts }) }
            : undefined;
        });
      }

      // Every OTHER route under the app's own prefix (`/~/conversations/<hash>/
      // reactions`, `/~/profiles/<fid>/followers`, `/~/settings`, …) is a route
      // the client serves itself. nginx routes the whole family here, so the
      // shell is the answer — with the site's own tags, which is what those
      // pages have today, and a page a reader can still use.
      if (segments[0] === '~') {
        return {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'public, max-age=300',
            'x-unfurl': 'shell',
          },
          body: shellSource(),
        };
      }

      return text(404, 'not this service\n', { 'x-unfurl': 'not-found' });
    },
    /** What the host would need to know that this handler holds no state. */
    sizes: () => ({
      html: htmlCache.size,
      cards: cardCache.size,
      authors: authorCache.size,
    }),
    cardSize: { width: CARD_WIDTH, height: CARD_HEIGHT },
  };
};
