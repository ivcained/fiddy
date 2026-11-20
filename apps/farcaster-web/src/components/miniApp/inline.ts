import { SignIn } from '@farcaster/miniapp-host';

/**
 * The Comlink wire behind an inline mini app view (`fc:miniapp:inline`): a
 * mini app's small page, run in its cast's card (`InlineApp`) instead of the
 * whole app. It speaks the same Comlink wire as a full app (`MiniApp.tsx`),
 * but only a few calls are answered here; anything else tells it to open the
 * app.
 *
 * Kept apart from `MiniApp.tsx` on purpose: a feed containing an inline poll
 * must not load the wallets. Anything that would need the app loader or a
 * custody copy is done through the handlers the card injects (`openApp`,
 * `openUrl`, `viewCast`, `viewProfile`, `signIn`) — Fiddy's own provider
 * chain and navigation, scoped to the card.
 */

export type Say = {
  title: string;
  body?: string;
  yes?: string;
  at?: number;
  done?: (ok: boolean) => void;
} | null;

export type Inline = {
  frame: HTMLIFrameElement;
  origin: string;
  host: string;
  name: string;
  /** The cast it is in and its embed (the app's link); none in a preview. */
  cast?: { hash: string; authorFid?: number; text: string } | null;
  embed: string;
  app: { url: string; name?: string; icon?: string; splash?: string };
  /** Draw (or clear) a prompt over the card. */
  say: (s: Say) => void;
  stop?: () => void;
  /** The signed-in reader, or none — a view may not know who is reading. */
  user?: () =>
    | {
        fid: number;
        username?: string | null;
        displayName?: string | null;
        pfpUrl?: string | null;
      }
    | undefined;
  /** Whether a prompt is up (one at a time). */
  asking?: boolean;
  /** Open this app (or another app by url) — the whole app, not the view. */
  openApp: (url: string) => void;
  /** Open a web link in a new tab. */
  openUrl: (url: string) => void;
  /** Go to a cast by its hash (0x-prefixed or bare). */
  viewCast: (hash: string) => void;
  /** Go to a profile by its fid. */
  viewProfile: (fid: number) => void;
  /**
   * Fiddy's sign-in chain, scoped to this card: ask, then sign in and resolve
   * with the SIWF result the view expects.
   */
  signIn: (options: SignIn.SignInOptions) => Promise<SignIn.SignInResult>;
};

const frames = new Set<Inline>();

/** Answer `i.frame`'s calls until the returned function is called. */
export function attach(i: Inline) {
  frames.add(i);
  return () => {
    frames.delete(i);
    i.stop?.();
    i.say(null);
  };
}

// one prompt at a time, as for a whole app: another while one is up is refused
const ask = (i: Inline, title: string, body: string, yes: string) =>
  new Promise<boolean>((resolve) => {
    if (i.asking) {
      return resolve(false);
    }
    i.asking = true;
    i.say({
      title,
      body,
      yes,
      at: Date.now(),
      done: (ok) => {
        i.asking = false;
        i.say(null);
        resolve(ok);
      },
    });
  });

// a call that takes the person somewhere always asks in its card first, so a
// view cannot move the app, open another app or a tab, by itself.
const leaving = (i: Inline, where: string) =>
  ask(i, 'Open this link?', where, 'Open');

// what a preview (no cast yet) may call
const PREVIEW = new Set(['context', 'ready', 'getCapabilities', 'getChains']);

const calls: Record<string, (i: Inline, ...a: unknown[]) => unknown> = {
  ready: () => {},
  getCapabilities: () => [
    'actions.ready',
    'actions.signIn',
    'actions.openUrl',
    'actions.openMiniApp',
    'actions.viewCast',
    'actions.viewProfile',
  ],
  getChains: () => [],
  async signIn(i, o: unknown = {}) {
    const given = (o as Partial<SignIn.SignInOptions> | undefined) ?? {};
    const options: SignIn.SignInOptions = {
      nonce: given.nonce ?? randomNonce(),
      ...given,
    };
    if (document.hidden || !i.cast) {
      return { error: { type: 'rejected_by_user' } };
    }
    // checked before asking, so a bad request never shows a prompt
    try {
      const ok = await ask(
        i,
        `Sign in to ${i.name}?`,
        `${i.host} will know you as this account. This signs a sign-in message with your account.`,
        'Sign in',
      );
      if (!ok) {
        return { error: { type: 'rejected_by_user' } };
      }
    } catch {
      return { error: { type: 'rejected_by_user' } };
    }
    try {
      return await i.signIn(options);
    } catch {
      return { error: { type: 'rejected_by_user' } };
    }
  },
  async openUrl(i, raw: unknown) {
    const u = safeUrl(
      typeof raw === 'string'
        ? raw.trim()
        : (raw as { url?: unknown } | undefined)?.url,
    );
    if (!u) {
      throw new Error('That is not a web link.');
    }
    if (await leaving(i, u)) {
      i.openUrl(u);
    }
  },
  // the whole app, as its card's button opens it, or another app by url
  async openMiniApp(i, o: unknown = {}) {
    const u = safeUrl((o as { url?: unknown } | undefined)?.url);
    if (!u) {
      throw new Error('That is not a web link.');
    }
    if (!(await leaving(i, u))) {
      return;
    }
    i.openApp(u);
  },
  async viewCast(i, o) {
    const h = String((o as { hash?: unknown } | undefined)?.hash ?? '').replace(
      /^0x/,
      '',
    );
    if (!/^[0-9a-f]{40}$/i.test(h)) {
      throw new Error('Invalid cast hash.');
    }
    if (await leaving(i, `${location.host}/c/${h}`)) {
      i.viewCast(h);
    }
  },
  async viewProfile(i, o) {
    const fid = (o as { fid?: unknown } | undefined)?.fid;
    if (typeof fid !== 'number' || !Number.isSafeInteger(fid) || fid <= 0) {
      throw new Error('Invalid fid.');
    }
    if (await leaving(i, `${location.host}/u/${fid}`)) {
      i.viewProfile(fid);
    }
  },
};

const userCtx = (u: {
  fid: number;
  username?: string | null;
  displayName?: string | null;
  pfpUrl?: string | null;
}) => ({
  fid: u.fid,
  username: u.username ?? undefined,
  displayName: u.displayName ?? undefined,
  pfpUrl: u.pfpUrl ?? undefined,
});

const context = (i: Inline) => ({
  client: {
    platformType: matchMedia('(max-width: 559px)').matches
      ? ('mobile' as const)
      : ('web' as const),
    clientFid: 3356862,
    added: false,
    safeAreaInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    inline: true,
  },
  // none for someone not signed in
  ...(i.user?.() && { user: userCtx(i.user()!) }),
  // none in a preview
  ...(i.cast && {
    location: {
      type: 'cast_embed' as const,
      embed: i.embed,
      cast: {
        hash: '0x' + i.cast.hash.replace(/^0x/, ''),
        text: i.cast.text,
        author: { fid: i.cast.authorFid ?? 0 },
      },
    },
  }),
  features: { haptics: false },
});

const randomNonce = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
};

const safeUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  try {
    const u = new URL(value);
    return u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
};

addEventListener('message', (e) => {
  const i = [...frames].find(
    (x) => x.frame.contentWindow && x.frame.contentWindow === e.source,
  );
  const d = e.data;
  if (
    !i ||
    e.origin !== i.origin ||
    !d ||
    typeof d !== 'object' ||
    typeof d.id !== 'string' ||
    !Array.isArray(d.path) ||
    d.path.length !== 1
  ) {
    return;
  }
  const name = String(d.path[0]);
  const args = (Array.isArray(d.argumentList) ? d.argumentList : []).map(
    (v: unknown) =>
      v && typeof v === 'object' && (v as { type?: unknown }).type === 'RAW'
        ? (v as { value?: unknown }).value
        : undefined,
  );
  let out: unknown;
  try {
    out =
      !i.cast && !PREVIEW.has(name)
        ? Promise.reject(new Error(`${i.name} can't use ${name} in a preview.`))
        : d.type === 'GET' && name === 'context'
          ? context(i)
          : d.type === 'APPLY' && Object.hasOwn(calls, name)
            ? calls[name](i, ...args)
            : Promise.reject(
                new Error(
                  `${name} works inside the app, not in the card — tap Open to finish it there.`,
                ),
              );
  } catch (err) {
    out = Promise.reject(err);
  }
  const post = (m: unknown) => {
    try {
      i.frame.contentWindow?.postMessage(m, i.origin);
    } catch {
      // the frame went away
    }
  };
  Promise.resolve(out).then(
    (value) => post({ id: d.id, type: 'RAW', value }),
    (err) =>
      post({
        id: d.id,
        type: 'HANDLER',
        name: 'throw',
        value: {
          isError: true,
          value: {
            message: String((err as Error | null)?.message ?? err),
            name: 'Error',
          },
        },
      }),
  );
});
