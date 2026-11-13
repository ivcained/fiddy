/**
 * Resolve extensionless relative imports the way the app's bundler does.
 *
 * `packages/farcaster-node-client/dist` is TypeScript's ESM output, so it says
 * `export * from './appKey'` with no extension. Metro and the app's bundlers
 * resolve that; Node's ESM resolver does not. This loader appends `.js` (or
 * `/index.js`) to a relative specifier that only resolves that way, for
 * `scripts/measure-feed-head.mjs` and nothing else.
 *
 * Registered with `module.register()` rather than `module.registerHooks()` so it
 * also runs on the Node the repo pins (20.19.5, see `.npmrc`); `registerHooks`
 * only exists from 22.15.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EXTENSIONS = ['.js', '.mjs', '.cjs', '/index.js'];

export const resolve = async (specifier, context, nextResolve) => {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (!specifier.startsWith('.') || !context.parentURL) {
      throw error;
    }
    for (const extension of EXTENSIONS) {
      const candidate = new URL(specifier + extension, context.parentURL);
      if (candidate.protocol === 'file:' && existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true };
      }
    }
    throw error;
  }
};