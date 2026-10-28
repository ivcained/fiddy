import { describe, expect, it } from 'vitest';

import { secureExternalMediaUrl } from '~/utils/externalMediaUrl';

const securePage = { protocol: 'https:', hostname: 'fiddy.fun' } as const;

describe('external media on a secure page', () => {
  it('asks an external HTTP image host over HTTPS without changing the rest', () => {
    expect(
      secureExternalMediaUrl(
        'http://media.example/photo?id=1&size=large#preview',
        securePage,
      ),
    ).toBe('https://media.example/photo?id=1&size=large#preview');
  });

  it('leaves HTTPS URLs byte-identical', () => {
    const url = 'https://media.example/Photo%20One?id=1&size=large';
    expect(secureExternalMediaUrl(url, securePage)).toBe(url);
  });

  it('leaves ordinary HTTP pages alone', () => {
    const url = 'http://media.example/photo.png';
    expect(
      secureExternalMediaUrl(url, {
        protocol: 'http:',
        hostname: 'fiddy.fun',
      }),
    ).toBe(url);
  });

  it('preserves self-hosted, relative, and non-HTTP media URLs', () => {
    for (const url of [
      'http://fiddy.fun/photo.png',
      '/photo.png',
      '../photo.png',
      'data:image/png;base64,AAAA',
      'blob:https://fiddy.fun/photo',
    ]) {
      expect(secureExternalMediaUrl(url, securePage)).toBe(url);
    }
  });

  it('does not rewrite loopback, LAN, or local development hosts', () => {
    for (const hostname of [
      'localhost',
      'media.localhost',
      'printer.local',
      '127.0.0.1',
      '0.0.0.0',
      '10.0.0.4',
      '192.168.1.4',
      '172.16.0.2',
      '172.31.255.254',
      '169.254.1.1',
      '[::1]',
      '[fd00::1]',
      '[fe80::1]',
    ]) {
      const url = `http://${hostname}/photo.png`;
      expect(secureExternalMediaUrl(url, securePage)).toBe(url);
    }
  });
});
