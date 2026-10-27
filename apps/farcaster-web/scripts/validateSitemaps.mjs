import { log } from 'node:console';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const SITEMAP_HOST = 'fiddy.fun';
const MAX_URLS = 50_000;
const MAX_SITEMAP_BYTES = 50 * 1024 * 1024;
const REQUIRED_ROUTES = ['/', '/feed', '/explore', '/about'];
const STATIC_PAGES = new Map([
  ['/about', 'about.html'],
  ['/privacy', 'privacy.html'],
  ['/terms', 'terms.html'],
  ['/delete', 'delete.html'],
  ['/safety', 'safety.html'],
]);
const PUBLIC_ROUTES = new Set([
  ...REQUIRED_ROUTES,
  '/privacy',
  '/terms',
  '/delete',
  '/safety',
]);

const appDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const publicDirectory = path.resolve(
  process.argv[2] ?? path.join(appDirectory, 'public'),
);
const sitemapPath = path.join(publicDirectory, 'sitemap.xml');

const fail = (message) => {
  throw new Error(`Invalid sitemap: ${message}`);
};

if (!fs.existsSync(sitemapPath)) {
  fail('sitemap.xml is missing');
}
if (fs.statSync(sitemapPath).size > MAX_SITEMAP_BYTES) {
  fail('sitemap.xml exceeds 50 MiB');
}

const xml = fs.readFileSync(sitemapPath, 'utf8');
if (!xml.includes('<urlset')) {
  fail('sitemap.xml must contain a URL set, not the inherited sitemap index');
}

const locations = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
  (match) => match[1],
);
if (locations.length === 0) {
  fail('sitemap.xml has no page URLs');
}
if (locations.length > MAX_URLS) {
  fail('sitemap.xml exceeds 50,000 URLs');
}
if (new Set(locations).size !== locations.length) {
  fail('sitemap.xml contains a duplicate page URL');
}

const paths = new Set();
for (const location of locations) {
  let url;
  try {
    url = new URL(location);
  } catch {
    fail(`invalid page URL: ${location}`);
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== SITEMAP_HOST ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    fail(
      `page URL must be a canonical https://${SITEMAP_HOST} URL: ${location}`,
    );
  }
  if (url.pathname !== decodeURIComponent(url.pathname)) {
    fail(`page URL must use a plain, unescaped path: ${location}`);
  }
  if (!PUBLIC_ROUTES.has(url.pathname)) {
    fail(`not a canonical public Fiddy route: ${location}`);
  }

  const staticPage = STATIC_PAGES.get(url.pathname);
  if (staticPage && !fs.existsSync(path.join(publicDirectory, staticPage))) {
    fail(`page URL has no static document (${staticPage}): ${location}`);
  }
  paths.add(url.pathname);
}

for (const route of REQUIRED_ROUTES) {
  if (!paths.has(route)) {
    fail(`required public route is missing: ${route}`);
  }
}
for (const [route, file] of STATIC_PAGES) {
  if (fs.existsSync(path.join(publicDirectory, file)) && !paths.has(route)) {
    fail(`static public page is missing from the sitemap: ${route}`);
  }
}

log(`Validated ${locations.length} canonical public URLs on ${SITEMAP_HOST}.`);
