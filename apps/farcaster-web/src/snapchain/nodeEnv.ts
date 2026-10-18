/**
 * Environment and configuration for connecting to a Snapchain node.
 *
 * The browser cannot call a plain HTTP node directly because:
 * 1. The dev server is HTTPS but the node sets Access-Control-Allow-Origin: *
 *    without answering CORS preflight
 * 2. POST /v1/submitMessage with application/octet-stream is blocked as a
 *    cross-origin request
 *
 * Therefore the app talks to the node through a same-origin relay path
 * `/snapchain-api`, which the Vite dev/preview server proxies to the node's
 * real URL.
 */

/** The relay path the browser uses — same-origin, so no CORS issues. */
export const NODE_PROXY_PATH = '/snapchain-api';

/** Default fallback when no environment is configured. */
export const DEFAULT_NODE_URL = 'http://127.0.0.1:3381';

/**
 * Resolve the base URL the browser client should use.
 *
 * When VITE_SNAPCHAIN_HTTP_URL is set and non-empty, use it directly.
 * Otherwise fall back to the proxy path (same-origin request).
 *
 * @param env - The import.meta.env object (allows test injection)
 */
export const resolveNodeBaseUrl = (
  env: Record<string, unknown> = import.meta.env,
): string => {
  const directUrl = env.VITE_SNAPCHAIN_HTTP_URL as string | undefined;
  if (directUrl && directUrl.trim().length > 0) {
    return directUrl.trim();
  }
  return NODE_PROXY_PATH;
};

/**
 * Resolve the target URL for the Vite proxy configuration.
 *
 * This determines where `/snapchain-api` requests get forwarded to.
 * Priority: SNAPCHAIN_HTTP_URL (server-side) > VITE_SNAPCHAIN_HTTP_URL (client-side)
 * > default localhost.
 *
 * @param env - The loadEnv result object
 */
export const resolveNodeProxyTarget = (
  env: Record<string, string | undefined> = process.env as Record<
    string,
    string | undefined
  >,
): string => {
  const serverUrl = env.SNAPCHAIN_HTTP_URL;
  const clientUrl = env.VITE_SNAPCHAIN_HTTP_URL;

  // Only use a value if it's set and non-empty after trimming
  if (serverUrl && serverUrl.trim().length > 0) {
    return serverUrl.trim();
  }
  if (clientUrl && clientUrl.trim().length > 0) {
    return clientUrl.trim();
  }
  return DEFAULT_NODE_URL;
};
