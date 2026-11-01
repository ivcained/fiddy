/**
 * Adapted from quilcast (MIT), https://github.com/backmeupplz/quilcast
 * (src/shared.ts at 0.44.0, commit 62b05d2a4402: LINK_RE, safeUrl, urlsOf).
 *
 * Some clients leave a link in a cast's text without hoisting it into the
 * protocol embeds, so a cast whose message has no embeds at all still gets a
 * link preview: its first typed http(s) link stands in as one link embed and
 * flows through the same classify/card chain a real embed gets. Embeds
 * always win — a cast whose message carries embeds (even blank ones) is
 * never second-guessed from its text — and at most one link is recovered.
 *
 * A typed link is untrusted text: only a string that really parses as a URL,
 * speaks http(s), carries no credentials and names no local or private host
 * is recovered — never a `javascript:` string, a protocol-relative `//host`,
 * or text that merely looks like a link.
 */

import type { NodeCastAddBody } from 'farcaster-node-client';

// Links as people write them: with a scheme, or a bare domain on a common
// TLD ("quilcast.com/x"). Only the schemed form is ever recovered here; the
// bare-domain half of the pattern stays so the match keeps agreeing with
// quilcast's exactly.
const TLDS =
  'com|org|net|xyz|io|app|dev|ai|co|me|gg|so|sh|fm|tv|art|fun|lol|wtf|info|page|site|tech|link|to|us|uk|de|fr|eu|ca|ly|cc|club|blog|news|social|world|live|studio|games|finance|money|cash|network|systems|build|tools';
const LINK_RE = new RegExp(
  `https?:\\/\\/[^\\s<>"]+[^\\s<>".,;:!?)\\]'"]|(?<![@\\w.\\/-])(?:[a-z0-9-]+\\.)+(?:${TLDS})\\b(?:\\/[^\\s<>"]*[^\\s<>".,;:!?)\\]'"])?`,
  'gi',
);

// URLs typed into a cast are untrusted: the protocol only checks their
// length, so a "link" can be javascript:… or point at the reader's own
// network. Only public http(s) gets through.
const LOCAL_HOST =
  /^(localhost|.*\.localhost|.*\.local|0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\[)/i;

/**
 * A typed link, kept only when it is a public http(s) URL: parses for real,
 * speaks http or https, carries no username or password, and names no local
 * or private host. Anything else is undefined, never a best effort.
 */
export const publicHttpUrlOf = (
  text: string | undefined | null,
): string | undefined => {
  if (typeof text !== 'string') {
    return undefined;
  }
  try {
    const url = new URL(text);
    if (
      /^https?:$/.test(url.protocol) &&
      !url.username &&
      !url.password &&
      !LOCAL_HOST.test(url.hostname)
    ) {
      return url.href;
    }
  } catch {
    // Not a URL at all.
  }
  return undefined;
};

/**
 * The first public http(s) link typed into a cast's text, or undefined.
 *
 * Scheme first (quilcast's `/^https?:\/\//i` filter), then the safety parse;
 * the first candidate that survives both is the one. At most one link is
 * ever recovered — quilcast's `slice(0, 1)` rule.
 */
export const firstTypedLinkOf = (
  text: string | undefined,
): string | undefined => {
  if (!text) {
    return undefined;
  }
  for (const match of text.match(LINK_RE) ?? []) {
    if (!/^https?:\/\//i.test(match)) {
      continue;
    }
    const url = publicHttpUrlOf(match);
    if (url !== undefined) {
      return url;
    }
  }
  return undefined;
};

/**
 * The link a cast recovers from its own text: the first typed public http(s)
 * link when the protocol message carries no embeds at all, undefined
 * otherwise. Embeds always win — even a blank embed object means the client
 * that wrote the cast already made its choice.
 */
export const recoveredTextLinkOf = (
  body: NodeCastAddBody | undefined,
): string | undefined => {
  if (body === undefined || body.embeds.length > 0) {
    return undefined;
  }
  return firstTypedLinkOf(body.text);
};
