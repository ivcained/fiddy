// Adapted from quilcast (MIT), https://github.com/backmeupplz/quilcast
// (server/index.mjs /api/gifs at 2abe184cc734).
//
// Mounts the GIF search (./gifs.mjs) on the server that serves this copy of
// Fiddy — same origin, so the picker's searches never leave this origin from
// the browser. Like the instance connect service (./plugin.mjs), it is mounted
// for BOTH ways a person runs the client: `dev` and `preview` (`fiddy client
// up --build`). A client served as static files by something else (nginx, a
// CDN) has no service at that address, and the picker says so in place rather
// than pretending to search.

import { createGifService, GIFS_PATH } from './gifs.mjs';

const sendJson = (response, status, body) => {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  if (status === 200) {
    // Search answers are public and stable for an hour; the service cache is
    // the same length, so a browser refetch inside the hour is free.
    response.setHeader('cache-control', 'public, max-age=3600');
  } else {
    response.setHeader('cache-control', 'no-store');
  }
  response.end(JSON.stringify(body));
};

export const createGifsMiddleware = ({ env = process.env } = {}) => {
  const service = createGifService({ env });

  return async (request, response, next) => {
    const url = new URL(request.url ?? '', 'http://localhost');
    if (url.pathname !== GIFS_PATH) {
      next();
      return;
    }
    if (request.method !== 'GET') {
      sendJson(response, 405, { code: 'GIFS_METHOD' });
      return;
    }
    const ip =
      request.headers?.['x-forwarded-for']?.split(',')[0]?.trim() ??
      request.socket?.remoteAddress ??
      'unknown';
    try {
      const answered = await service.search({ q: url.searchParams.get('q'), ip });
      sendJson(response, answered.status, answered.body);
    } catch {
      // The service logs the cause; the picker gets an honest error state.
      sendJson(response, 502, { code: 'GIFS_UPSTREAM' });
    }
  };
};

/**
 * The vite plugin. `configureServer` is the dev server; `configurePreviewServer`
 * is `vite preview`, which is what `fiddy client up --build` runs.
 */
export const gifsPlugin = ({ env = process.env } = {}) => ({
  name: 'fiddy-instance-gifs',
  configureServer(server) {
    server.middlewares.use(createGifsMiddleware({ env }));
  },
  configurePreviewServer(server) {
    server.middlewares.use(createGifsMiddleware({ env }));
  },
});

export { GIFS_PATH };
