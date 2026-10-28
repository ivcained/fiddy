/**
 * Build the server-side public-feed reader into one plain ESM bundle.
 *
 * The unfurl service is plain Node with no install on the host, so the
 * server-drawn `/feed` page cannot import TypeScript or the workspace packages
 * at runtime. This builds the client's own reader (same `NodeBackedReads`,
 * same public window) into `server/public-feed/generated/reader.mjs`, which
 * `release-client.sh` runs between the client build and the unfurl self-check.
 *
 * Everything except node: builtins is bundled, so the release directory alone
 * is runnable. No client bundle ever imports this entry.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const entry = path.join(appRoot, 'src/snapchain/nodeApi/publicFeedServer.ts');

await build({
  root: appRoot,
  configFile: false,
  publicDir: false,
  logLevel: process.env.PUBLIC_FEED_BUILD_QUIET ? 'silent' : 'warn',
  resolve: {
    alias: {
      '~': path.join(appRoot, 'src'),
    },
  },
  ssr: {
    // The host has no node_modules for this service: carry the code.
    noExternal: true,
  },
  build: {
    ssr: entry,
    outDir: path.join(appRoot, 'server/public-feed/generated'),
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      external: [/^node:/],
      output: {
        entryFileNames: 'reader.mjs',
        format: 'es',
        inlineDynamicImports: true,
      },
    },
  },
});
