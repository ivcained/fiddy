import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(__dirname, '../..');
const publicRoot = path.join(webRoot, 'public');
const aboutPath = path.join(publicRoot, 'about.html');

const metaContent = (
  html: string,
  attribute: 'property' | 'name',
  key: string,
) => {
  const tag = new RegExp(
    `<meta\\s+${attribute}="${key}"\\s+content="([^"]*)"`,
  ).exec(html);
  return tag?.[1];
};

describe('the crawler-readable About page', () => {
  it('explains public browsing, permission-first help, and honest fallbacks', () => {
    const about = readFileSync(aboutPath, 'utf8');

    expect(about).toContain('Look around first');
    expect(about).toContain('without an account');
    expect(about).toContain('asks before it acts');
    expect(about).toContain('service you choose');
    expect(about).toContain('says so in place');
    for (const href of [
      'href="/"',
      'href="/feed"',
      'href="/explore"',
      'href="https://github.com/ivcained/fiddy"',
      'href="/privacy"',
      'href="/terms"',
      'href="/delete"',
      'href="/safety"',
    ]) {
      expect(about).toContain(href);
    }
  });

  it('ships no app JavaScript or remote assets', () => {
    const about = readFileSync(aboutPath, 'utf8');
    expect(about).not.toMatch(/<script\b/i);
    expect(about).not.toContain('/assets/index-');
    expect(about).not.toMatch(/<img[^>]+src="https:\/\//i);
    expect(about).not.toMatch(/<link rel="stylesheet" href="https:\/\//i);
    expect(about).not.toMatch(/<script[^>]+src="https:\/\//i);
  });

  it('is a static document with its own canonical and social metadata', () => {
    expect(existsSync(aboutPath)).toBe(true);
    const about = readFileSync(aboutPath, 'utf8');

    expect(about).toContain(
      '<link rel="canonical" href="https://fiddy.fun/about" />',
    );
    expect(metaContent(about, 'property', 'og:type')).toBe('website');
    expect(metaContent(about, 'property', 'og:url')).toBe(
      'https://fiddy.fun/about',
    );
    expect(metaContent(about, 'property', 'og:image')).toBe(
      'https://fiddy.fun/fiddy-share-card.png',
    );
    expect(metaContent(about, 'name', 'twitter:card')).toBe(
      'summary_large_image',
    );
    expect(metaContent(about, 'name', 'twitter:image')).toBe(
      'https://fiddy.fun/fiddy-share-card.png',
    );
  });
});

describe('the llms discovery document', () => {
  it('uses Fiddy facts, plain language, and real discovery links', () => {
    const file = path.join(publicRoot, 'llms.txt');
    expect(existsSync(file)).toBe(true);
    const llms = readFileSync(file, 'utf8');

    expect(llms).toContain('# fiddy');
    expect(llms).toContain('without an account');
    expect(llms).toContain('asks before it acts');
    expect(llms).toContain('service you choose');
    expect(llms).toContain('says so in place');
    expect(llms).toContain('https://fiddy.fun/about');
    expect(llms).toContain('https://fiddy.fun/feed');
    expect(llms).toContain('https://fiddy.fun/explore');
    expect(llms).toContain('https://github.com/ivcained/fiddy');
    expect(llms).not.toContain('quilcast.com');
    expect(llms).not.toContain('recovery phrase');
    expect(llms).not.toContain('keys stay in the browser');
    expect(llms).not.toContain('no server');
  });
});

describe('robots discovery policy', () => {
  it('keeps private app and API surfaces out while naming the Fiddy sitemap', () => {
    const robots = readFileSync(path.join(publicRoot, 'robots.txt'), 'utf8');
    expect(robots).toContain('User-agent: *');
    expect(robots).toContain('Disallow: /api/');
    expect(robots).toContain('Disallow: /start');
    expect(robots).toContain('Disallow: /~/');
    expect(robots).toContain('Allow: /~/conversations/');
    expect(robots).toContain('Allow: /~/profiles/');
    expect(robots).toContain('Sitemap: https://fiddy.fun/sitemap.xml');
    expect(robots).not.toContain('farcaster.xyz');
  });
});

describe('the canonical public sitemap', () => {
  it('lists only real Fiddy public routes on fiddy.fun', () => {
    const sitemap = readFileSync(path.join(publicRoot, 'sitemap.xml'), 'utf8');
    const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
      (match) => match[1],
    );
    expect(locations).toEqual([
      'https://fiddy.fun/',
      'https://fiddy.fun/feed',
      'https://fiddy.fun/explore',
      'https://fiddy.fun/about',
    ]);
    expect(sitemap).toContain('<urlset');
    expect(sitemap).not.toContain('farcaster.xyz');
  });
});

describe('runtime sitemap metadata', () => {
  it('points PageMeta at the Fiddy sitemap', () => {
    const pageMeta = readFileSync(
      path.join(webRoot, 'src/components/page/PageMeta.tsx'),
      'utf8',
    );
    expect(pageMeta).toContain('https://fiddy.fun/sitemap.xml');
    expect(pageMeta).not.toContain('https://farcaster.xyz/sitemap.xml');
  });
});

describe('sitemap build validation', () => {
  const validator = path.join(webRoot, 'scripts/validateSitemaps.mjs');
  const validate = (directory: string) =>
    spawnSync(process.execPath, [validator, directory], {
      encoding: 'utf8',
    });

  it('accepts the real sitemap and refuses wrong hosts, routes, and missing pages', () => {
    expect(validate(publicRoot).status).toBe(0);

    const fixture = (xml: string) => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'fiddy-sitemap-'));
      writeFileSync(path.join(directory, 'sitemap.xml'), xml);
      return directory;
    };
    const urlset = (paths: string[]) =>
      `<urlset>${paths.map((each) => `<url><loc>https://fiddy.fun${each}</loc></url>`).join('')}</urlset>`;

    const wrongHost = fixture(
      '<urlset><url><loc>https://farcaster.xyz/about</loc></url></urlset>',
    );
    expect(validate(wrongHost).status).toBe(1);

    const privateRoute = fixture(
      urlset(['/', '/feed', '/explore', '/about', '/~/compose']),
    );
    expect(validate(privateRoute).status).toBe(1);

    const missingAbout = fixture(urlset(['/', '/feed', '/explore']));
    expect(validate(missingAbout).status).toBe(1);

    const missingLegalPage = fixture(
      urlset(['/', '/feed', '/explore', '/about', '/privacy']),
    );
    expect(validate(missingLegalPage).status).toBe(1);
    writeFileSync(
      path.join(missingLegalPage, 'privacy.html'),
      '<h1>Privacy</h1>',
    );
    writeFileSync(path.join(missingLegalPage, 'about.html'), '<h1>About</h1>');
    expect(validate(missingLegalPage).status).toBe(0);
  });
});

describe('release and route handling', () => {
  const repoRoot = path.resolve(webRoot, '../..');
  const release = readFileSync(
    path.join(repoRoot, 'scripts/release-client.sh'),
    'utf8',
  );
  const nginx = readFileSync(
    path.join(repoRoot, 'scripts/fiddy-unfurl.nginx.conf'),
    'utf8',
  );

  it('serves extensionless About as its static document, never the SPA shell', () => {
    expect(nginx).toContain(
      'location = /about { try_files /about.html =404; }',
    );
  });

  it('preserves discovery files and checks the served bytes', () => {
    expect(release).not.toMatch(/printf[^\n]*robots\.txt/);
    expect(release).toContain('validateSitemaps.mjs" "$APP"');
    expect(release).toContain('cmp -s "$APP/robots.txt" "$WEB/robots.txt"');
    for (const route of [
      '/about',
      '/robots.txt',
      '/sitemap.xml',
      '/llms.txt',
    ]) {
      expect(release).toContain(`origin_get "${route}"`);
    }
    expect(release).toContain('origin-about.html');
    expect(release).toContain('origin-robots.txt');
    expect(release).toContain('origin-sitemap.xml');
    expect(release).toContain('origin-llms.txt');
  });
});

describe('crawler facts in the app shell', () => {
  const shell = readFileSync(path.join(webRoot, 'index.html'), 'utf8');

  it('publishes a Fiddy-owned WebApplication as valid JSON-LD', () => {
    const blocks = [
      ...shell.matchAll(
        /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,
      ),
    ];
    expect(blocks).toHaveLength(1);
    const data = JSON.parse(blocks[0][1]) as Record<string, unknown>;
    expect(data['@context']).toBe('https://schema.org');
    expect(data['@type']).toBe('WebApplication');
    expect(data.name).toBe('fiddy');
    expect(data.url).toBe('https://fiddy.fun/');
    expect(data.description).toContain('asks before it acts');
    expect(data.applicationCategory).toBe('SocialNetworkingApplication');
    expect(data.image).toBe('https://fiddy.fun/fiddy-share-card.png');
    expect(data).not.toHaveProperty('author');
    expect(data).not.toHaveProperty('offers');
    expect(data).not.toHaveProperty('operatingSystem');
  });

  it('links the no-JavaScript fallback to About and public browsing', () => {
    const fallback = /<noscript>([\s\S]*?)<\/noscript>/.exec(shell)?.[1];
    expect(fallback).toBeTruthy();
    expect(fallback).toContain('href="/about"');
    expect(fallback).toContain('href="/feed"');
    expect(fallback).toContain('href="/explore"');
    expect(fallback).toContain('#shell-skeleton');
    expect(fallback).toContain('display: none');
  });

  it('keeps the CSP guard while allowing data-only JSON-LD', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'fiddy-jsonld-'));
    const checker = path.join(
      webRoot,
      'scripts/check-shell-has-no-inline-script.mjs',
    );
    const check = (name: string, body: string) => {
      const file = path.join(directory, name);
      writeFileSync(file, body);
      return spawnSync(process.execPath, [checker, file]).status;
    };

    expect(
      check(
        'data.html',
        '<script type="application/ld+json">{"@type":"WebApplication"}</script>',
      ),
    ).toBe(0);
    expect(check('code.html', '<script>alert(1)</script>')).toBe(1);
    expect(check('handler.html', '<img src="x" onerror="alert(1)" />')).toBe(1);
  });
});
