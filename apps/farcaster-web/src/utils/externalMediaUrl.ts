export type MediaPageLocation = Pick<Location, 'hostname' | 'protocol'>;

const isLocalMediaHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase();
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\./);
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === '0.0.0.0' ||
    host === '[::1]' ||
    host.startsWith('[fc') ||
    host.startsWith('[fd') ||
    host.startsWith('[fe80:') ||
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    host.startsWith('169.254.') ||
    (ipv4?.[1] === '172' && Number(ipv4[2]) >= 16 && Number(ipv4[2]) <= 31)
  );
};

/**
 * External HTTP media on an HTTPS page is requested over HTTPS explicitly.
 * The original host, path, query, and fragment stay untouched; local and
 * self-hosted development URLs keep working as they did before.
 */
export const secureExternalMediaUrl = (
  url: string,
  page: MediaPageLocation | undefined = typeof window === 'undefined'
    ? undefined
    : window.location,
): string => {
  if (page?.protocol !== 'https:' || !/^http:\/\//i.test(url)) {
    return url;
  }
  try {
    const parsed = new URL(url);
    if (
      parsed.hostname.toLowerCase() === page.hostname.toLowerCase() ||
      isLocalMediaHost(parsed.hostname)
    ) {
      return url;
    }
    return `https://${url.slice(url.indexOf('://') + 3)}`;
  } catch {
    return url;
  }
};
