/**
 * providers — where this client reads from, and what happens when that stops
 * working well.
 *
 * The reader may keep several servers on their list, in the order they want them
 * tried. This folder measures each one, decides which is live, and points the
 * client's single fetch seam at it:
 *
 *   catalog.ts        the known providers, and the order rules
 *   preferences.ts    the reader's order, stored per FID
 *   health.ts         the measurements (speed + is it following the network)
 *   failover.ts       which one is live, and why — pure, so it is testable
 *   runtime.ts        the loop that watches, and the live snapshot everything reads
 *   providerFetch.ts  the fetch the client is handed, now provider-aware
 *   neynarMap.ts      Neynar's JSON → the hosted shapes the pages already read
 *
 * Reads only. Writing (posting, reactions, follows) stays where it was: the
 * gasless app-key flow in `~/snapchain/useNodeClient` and `~/pages/settingsNode`.
 */

export * from './catalog';
export * from './failover';
export * from './health';
export * from './neynarMap';
export * from './pill';
export * from './preferences';
export * from './providerFetch';
export * from './providerTypes';
export * from './runtime';
export * from './useProviders';
