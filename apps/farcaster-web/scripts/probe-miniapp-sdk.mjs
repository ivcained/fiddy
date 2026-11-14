/**
 * What a Farcaster client's own SDK says when Fiddy is opened INSIDE one, and
 * the person does not approve the host's sign-in.
 *
 * Probe-only: `scripts/probe-continue-as.vite.config.mjs` aliases
 * `@farcaster/miniapp-sdk` to this file for one dev server, so the whole
 * "refused inside a host" path can be walked in a browser without a Farcaster
 * phone. It is never imported by the app and never part of a build.
 *
 * The FID and name are a real, long-standing public Farcaster account (dwr,
 * fid 3), because the continue-as surface reads that account's REAL Following
 * graph from the node the server is pointed at — a made-up FID would prove the
 * plumbing and nothing about the product.
 */

/** A one-pixel picture, so the front door's avatar slot really paints. */
const PFP =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#d4ff3f"/></svg>',
  );

const sdk = {
  isInMiniApp: async () => true,
  context: Promise.resolve({
    client: { clientFid: 9152, added: false, safeAreaInsets: undefined },
    user: {
      fid: 3,
      username: 'dwr',
      displayName: 'Dan Romero',
      pfpUrl: PFP,
    },
  }),
  actions: {
    ready: async () => undefined,
    // The refusal this probe exists for: the host's approval is declined, so
    // nothing is signed and the person is left named but not signed in.
    signIn: async () => {
      const error = new Error('SignIn.RejectedByUser');
      error.name = 'RejectedByUser';
      throw error;
    },
    openUrl: async () => undefined,
  },
  back: { enableWebNavigation: async () => undefined },
  wallet: {
    getEthereumProvider: async () => {
      throw new Error('the probe has no host wallet');
    },
  },
};

export default sdk;
export { sdk };
