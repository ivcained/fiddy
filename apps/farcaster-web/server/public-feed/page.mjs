import {
  escapeHtml,
  pageTags,
  renderPageHtml,
} from '../unfurl/shellMeta.mjs';

/**
 * Fields the interactive feed can read back for itself, but which a public
 * boot document has no reason to disclose. The filter is recursive because
 * mentioned accounts carry the same profile shape as authors.
 */
const PRIVATE_BOOT_FIELDS = new Set([
  'address',
  'addresses',
  'apiKey',
  'api_key',
  'authAddresses',
  'auth_addresses',
  'custodyAddress',
  'custody_address',
  'signature',
  'signatureScheme',
  'signature_scheme',
  'signer',
  'signerUuid',
  'signer_uuid',
  'verifiedAddresses',
  'verified_addresses',
  'verifications',
  'viewerContext',
  'viewer_context',
]);

const LOCAL_HOST =
  /^(localhost|.*\.localhost|.*\.local|0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\[)/i;

/** Only public HTTP(S), with no credentials or viewer-local destination. */
export const safePublicHttpUrl = (value) => {
  if (typeof value !== 'string') {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (
      !/^https?:$/.test(url.protocol) ||
      url.username ||
      url.password ||
      LOCAL_HOST.test(url.hostname)
    ) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
};

/**
 * The static cards and the boot seed are two views of exactly this result.
 * Root-cast filtering is repeated here as a defensive boundary even though
 * `readPublicFeed` already applies it to the main feed.
 */
export const cleanPublicFeedResult = (result) => {
  const stripped = JSON.parse(
    JSON.stringify(result, (key, value) =>
      PRIVATE_BOOT_FIELDS.has(key) ? undefined : value,
    ),
  );
  return {
    ...stripped,
    items: (Array.isArray(stripped.items) ? stripped.items : []).filter(
      (item) => !item?.cast?.parentHash && !item?.cast?.parentUrl,
    ),
  };
};

const count = (cast, key, label, marker) => {
  const value = cast?.[key]?.count;
  return typeof value === 'number'
    ? `<span><span data-fiddy-server-${marker}-count="${escapeHtml(value)}">${escapeHtml(value)}</span> ${label}</span>`
    : '';
};

const castHtml = (item) => {
  const cast = item.cast;
  const hash = /^0x[0-9a-f]{40}$/i.test(cast.hash ?? '') ? cast.hash : undefined;
  const fid = Number.isSafeInteger(cast.fid) ? cast.fid : undefined;
  const author = cast.author ?? {};
  const handle = author.username ? `@${author.username}` : `fid ${fid ?? ''}`;
  const name = author.displayName?.trim() || handle;
  const profile = fid
    ? `<a href="/~/profiles/${fid}">${escapeHtml(name)} <span>${escapeHtml(handle)}</span></a>`
    : `<span>${escapeHtml(name)}</span>`;
  const time = Number.isFinite(cast.timestamp)
    ? `<time datetime="${escapeHtml(new Date(cast.timestamp).toISOString())}">${escapeHtml(new Date(cast.timestamp).toISOString())}</time>`
    : '';
  const conversation = hash
    ? `<a class="fiddy-server-cast-open" href="/~/conversations/${hash}">Open cast</a>`
    : '';
  const links = (cast.embeds?.urls ?? [])
    .map((embed) => safePublicHttpUrl(embed?.url))
    .filter(Boolean)
    .map((url) => {
      const host = new URL(url).hostname.replace(/^www\./, '');
      return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(host)}</a>`;
    })
    .join('');

  return `<article class="fiddy-server-cast" data-fiddy-server-cast="${escapeHtml(hash ?? '')}">
    <header>${profile}${time}</header>
    <p class="fiddy-server-cast-text" dir="auto">${escapeHtml(cast.text ?? '')}</p>
    ${links ? `<div class="fiddy-server-cast-links">${links}</div>` : ''}
    <footer>${count(cast, 'replies', 'replies', 'reply')}${count(cast, 'recasts', 'recasts', 'recast')}${count(cast, 'reactions', 'likes', 'like')}${conversation}</footer>
  </article>`;
};

const bootJson = (value) =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

/** The whole `/feed` document, over the release's ordinary application shell. */
export const publicFeedPage = ({ origin, shell, result, at }) => {
  const cleaned = cleanPublicFeedResult(result);
  const cards = cleaned.items.map(castHtml).join('');
  const crawlerHtml = `<main class="fiddy-server-feed" data-fiddy-server-feed>
    <header class="fiddy-server-feed-head"><span class="fiddy-server-feed-brand">fiddy</span><h1>Feed</h1><p>Newest casts from people on Farcaster.</p></header>
    <div class="fiddy-server-feed-list">${cards}</div>
    <p class="fiddy-public-source">This window is assembled from the network itself: the newest casts from the accounts a few long-standing public Farcaster accounts follow, read from the server this app is pointed at. No account of yours is involved, and signing in changes nothing about what is shown here.</p>
  </main><script type="application/json" id="fiddy-public-feed-boot">${bootJson({ at, result: cleaned })}</script>`;
  const tags = pageTags({
    origin,
    title: 'Fiddy / Feed',
    description: 'Read what Farcaster is saying right now, with no account needed.',
    url: `${origin}/feed`,
    imageUrl: `${origin}/fiddy-share-card.png`,
    embedImageUrl: `${origin}/fiddy-embed.png`,
    imageAlt: 'The Fiddy mascot on a dark card.',
    type: 'website',
    buttonTitle: 'Open this feed in fiddy',
  });
  return renderPageHtml(shell, tags, {
    crawlerHtml,
    crawlerStyle: '<style>#shell-skeleton{display:none}</style>',
  });
};
