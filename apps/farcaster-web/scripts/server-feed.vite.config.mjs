/**
 * A dev-server config for probing the server-drawn `/feed` page END TO END.
 *
 * The probe needs the REAL document the unfurl service would serve, but the
 * React dev preamble has to come from Vite itself (a raw `page.route`
 * fulfillment skips `transformIndexHtml`, and the app dies with "can't detect
 * preamble"). This config keeps the ordinary dev pipeline and replaces only
 * `/feed`'s HTML with the service's answer, transformed by Vite on the way
 * out. Not used by the client build or the release.
 */
import { defineConfig } from 'vite';

import baseConfig from '../vite.config.js';

const SERVICE =
  process.env.SERVER_FEED_PROBE_SERVICE ?? 'http://127.0.0.1:3233';

const serverFeedDevPlugin = () => ({
  name: 'fiddy-server-feed-dev',
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      if ((request.url ?? '').split('?')[0] !== '/feed') {
        next();
        return;
      }
      try {
        const upstream = await fetch(`${SERVICE}/feed`);
        const html = await upstream.text();
        const transformed = await server.transformIndexHtml('/feed', html);
        response.statusCode = upstream.status;
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end(transformed);
      } catch (error) {
        response.statusCode = 500;
        response.setHeader('content-type', 'text/plain; charset=utf-8');
        response.end(`the server-feed dev proxy failed: ${String(error)}`);
      }
    });
  },
});

export default defineConfig(async ({ mode }) => {
  const resolved =
    typeof baseConfig === 'function'
      ? await baseConfig({ mode, command: 'serve' })
      : baseConfig;
  return {
    ...resolved,
    plugins: [...(resolved.plugins ?? []), serverFeedDevPlugin()],
  };
});
