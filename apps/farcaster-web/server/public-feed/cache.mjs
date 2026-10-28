/**
 * One recent public-feed page, served fresh when possible and stale briefly
 * when the node is slow. A cold caller waits only for the first-paint budget;
 * the read continues behind it so the next caller can get the finished page.
 * There is one entry by design: this is not a second feed cache or ranking.
 */
export const createPublicFeedCache = ({
  load,
  ttlMs = 60_000,
  staleMs = 5 * 60_000,
  waitMs = 2_000,
  timeoutMs = 8_000,
  retryMs = 10_000,
  now = () => Date.now(),
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) => {
  let entry;
  let pending;
  let retryAt = 0;

  const refresh = () => {
    if (pending) {
      return pending;
    }
    pending = (async () => {
      try {
        const result = await Promise.race([
          Promise.resolve().then(load),
          delay(timeoutMs).then(() => {
            throw new Error('the public feed read reached its hard deadline');
          }),
        ]);
        if (!result || !Array.isArray(result.items) || result.items.length === 0) {
          throw new Error('the public feed read returned no usable page');
        }
        entry = { at: now(), result };
        retryAt = 0;
        return entry;
      } catch {
        // A failed read is not an empty feed. Do not cache it as one, and do
        // not hammer the provider on every request while it is unavailable.
        retryAt = now() + retryMs;
        return undefined;
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  };

  return {
    async get() {
      const age = entry ? now() - entry.at : Number.POSITIVE_INFINITY;
      if (entry && age < ttlMs) {
        return entry;
      }

      let loading = pending;
      if (!loading && now() >= retryAt) {
        loading = refresh();
      }

      // Stale-while-revalidate, but only for a bounded time. An ancient page
      // must not become the permanent answer when the provider has failed.
      if (entry && age < staleMs) {
        return entry;
      }
      if (!loading) {
        return undefined;
      }
      return Promise.race([
        loading,
        delay(waitMs).then(() => undefined),
      ]);
    },
    stats: () => ({
      entries: entry ? 1 : 0,
      refreshing: Boolean(pending),
      ageMs: entry ? Math.max(0, now() - entry.at) : null,
    }),
  };
};
