/**
 * The jsdom in this repo does not expose `window.localStorage`, and the Fiddy
 * setup file treats a missing storage API as "nothing saved yet" (correct in a
 * browser that refuses storage, and useless for testing what gets saved). This
 * installs a real in-memory implementation for the duration of a test file, so
 * the tests exercise the same read/write path a browser would.
 */

export const installFakeStorage = (): void => {
  const map = new Map<string, string>();
  const storage: Storage = {
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => {
      map.clear();
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };

  Object.defineProperty(window, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
};

export const clearFakeStorage = (): void => {
  window.localStorage?.clear();
};
