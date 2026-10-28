/**
 * The one place the app can reach the provider seam directly.
 *
 * Every request the fork's hooks make goes through the apiClient, whose
 * `fetch` IS the seam (`WebFarcasterApiClientProvider` builds
 * `createProviderBackedFetch`). But a surface the fork has no endpoint for —
 * today, the people-to-follow request `GET /v2/people-suggestions`, which
 * this client owns outright — has no generated client method to ride. The
 * provider therefore registers the seam's fetch here when it builds one, and
 * a surface that needs it asks for it by name.
 *
 * `undefined` means no seam exists in this build (the fork's mock API is on,
 * or the node-backed client is off): a surface that needs the seam must say
 * THAT, in its own words, rather than fetching a relative URL that would hit
 * the dev server and read as a broken feature.
 */

let seamFetch: typeof fetch | undefined;

/** Called by the provider when it builds (or drops) the seam's fetch. */
export const registerSeamFetch = (
  nextFetch: typeof fetch | undefined,
): void => {
  seamFetch = nextFetch;
};

/** The seam's fetch, or undefined when this build has no seam. */
export const getSeamFetch = (): typeof fetch | undefined => seamFetch;
