/**
 * `@faker-js/faker`, stubbed out of the browser bundle.
 *
 * WHY THIS EXISTS (MEASURED, 2026-10-22)
 *
 * `@farcaster/core`'s ESM build is ONE file with a bare top-level
 * `import { faker } from "@faker-js/faker"`, and the only thing it uses faker
 * for is its message FACTORIES — `makeCastAdd`, `makeMessage` and friends, the
 * test-data builders nobody ships. Because that import is static and faker
 * declares no side effects, every consumer of `@farcaster/core` carries faker's
 * whole locale corpus: 3.6 MB of source, the single largest contributor to this
 * client's 8.0 MB entry chunk (see the `faker` guard in
 * `scripts/verify-mask-surfaces.mjs`, and the entry measurement in
 * `docs/evidence/`).
 *
 * `farcaster-node-client` — the only reason this app depends on
 * `@farcaster/core` at all — uses its message decoding, signing and key
 * derivation, and never one of its factories. Nothing else in the app or in the
 * packages imports faker (`pnpm why @faker-js/faker` names exactly one path:
 * `farcaster-node-client → @farcaster/core → @faker-js/faker`).
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * It is a module that answers the import so the bundle stops carrying the
 * corpus. It is NOT a silent "no data" faker: any use of it throws, loudly and
 * by name, because the only way to reach it is a factory call this client never
 * makes — and a factory that quietly returned undefined would be a bug wearing
 * the shape of a smaller bundle.
 *
 * The alias lives in `vite.config.js` (build and dev server). `vitest.config.js`
 * is a separate config, so a test that ever wants the real faker still can.
 */

const why = (use) =>
  `@faker-js/faker is not bundled into this client (reached via ${use}). ` +
  `Only @farcaster/core's test-data factories use it, and this app never calls ` +
  `them; if something now does, import the real package in that module instead ` +
  `of relying on this stub (see apps/farcaster-web/config/fakerInterop.mjs).`;

const refusingCallable = (use) => {
  const refuse = () => {
    throw new Error(why(use));
  };
  // `faker.datatype.number({...})` reaches a property of a property, so the
  // refusal has to be walkable rather than a plain function.
  return new Proxy(refuse, {
    get: (_target, property) =>
      property === 'toString' ? () => why(use) : refusingCallable(`${use}.${String(property)}`),
    apply: () => {
      throw new Error(why(use));
    },
  });
};

export const faker = refusingCallable('faker');

export default faker;