/**
 * nodeApi — the signed-in client's reads, served by your own Snapchain node.
 *
 * The fork's client reads and writes Farcaster's hosted API, which a
 * third-party client can never hold a session for. This folder replaces the
 * *reads* behind that API with node reads, without touching the pages, the
 * hooks or the return shapes they already depend on:
 *
 *   hostedRoutes.ts   which request goes where, and why
 *   reads.ts          the node-backed readers (feed, profile, thread, …)
 *   fromNode.ts       node messages → the shapes the fork's components read
 *   nodeBackedFetch.ts  the `fetch` that ties the three together
 *
 * Writes (posting, reactions, follows) are already node-backed elsewhere:
 * `~/snapchain/useNodeClient` + the gasless app-key flow in
 * `~/pages/settingsNode`, wired into the composer.
 */

export * from './fromNode';
export * from './hostedRoutes';
export * from './nodeBackedClientFlag';
export * from './nodeBackedFetch';
export * from './nodeCannotAnswer';
export * from './reads';
