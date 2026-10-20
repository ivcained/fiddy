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
 *   mediaUpload.ts    the media pipeline (bytes → our own host, not Warpcast's CDN)
 *   localDrafts.ts    cast drafts, which are this device's own state
 *
 * Writes (reactions, follows) are node-backed elsewhere: `~/snapchain/useNodeClient`
 * + the gasless app-key flow in `~/pages/settingsNode`. Posting a cast is NOT:
 * `POST /v2/casts` is classified `hosted` and refuses in plain words, because
 * sending a cast needs a signed message and this device holds no app key yet.
 * The draft write in front of every submit, which used to be the first refusal
 * a person hit, is answered locally (`localDrafts.ts`) so the submit reaches
 * that one honest answer instead of stopping at a store that was never ours.
 */

export * from './fromNode';
export * from './hostedRoutes';
export * from './localDrafts';
export * from './mediaUpload';
export * from './nodeBackedClientFlag';
export * from './nodeBackedFetch';
export * from './nodeCannotAnswer';
export * from './reads';
