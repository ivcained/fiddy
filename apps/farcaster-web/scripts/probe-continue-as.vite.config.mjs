/**
 * The dev server `scripts/verify-continue-as.mjs` asks for.
 *
 * The app's own `vite.config.js`, plus the ONE thing a browser cannot do by
 * itself: be a Farcaster client. `@farcaster/miniapp-sdk` is aliased to
 * `scripts/probe-miniapp-sdk.mjs`, which answers `isInMiniApp() → true`, names a
 * real account in its context, and REFUSES the sign-in — the exact middle state
 * the continue-as surface exists for.
 *
 * Everything else is the real app: the real sign-in guard, the real feed read,
 * the real refusal card.
 *
 * Its own `cacheDir` for the same reason `scripts/probe.vite.config.mjs` has
 * one: several dev servers share `node_modules/.vite`, and one re-optimizing
 * makes the others answer `504 Outdated Optimize Dep`.
 *
 * Not part of the build; nothing imports it.
 */
import path from 'path';
import { fileURLToPath } from 'url';

import { defineConfig } from 'vite';

import base from '../vite.config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');

export default defineConfig(async (env) => {
  const resolved = typeof base === 'function' ? await base(env) : base;

  return {
    ...resolved,
    cacheDir:
      process.env.PROBE_VITE_CACHE_DIR ??
      path.join(appRoot, '.probe-vite-cache'),
    resolve: {
      ...resolved.resolve,
      // FRONT of the app's own list, never instead of it: `~` → `./src` lives
      // there, and dropping it makes every module in the app unloadable
      // (`Failed to resolve import "~/index.css"`).
      alias: [
        {
          find: /^@farcaster\/miniapp-sdk$/,
          replacement: path.join(here, 'probe-miniapp-sdk.mjs'),
        },
        ...(resolved.resolve?.alias ?? []),
      ],
    },
    server: {
      ...resolved.server,
      allowedHosts: ['fiddy.fun'],
    },
  };
});
