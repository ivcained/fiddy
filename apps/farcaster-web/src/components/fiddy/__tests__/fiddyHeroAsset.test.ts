// @vitest-environment node
/**
 * The hero's two files, held to the contract the code that loads them assumes.
 *
 * These are the things that fail silently and only on somebody else's phone:
 *
 *   * `fiddy-hero.glb` names `EXT_texture_webp` in `extensionsRequired`, which
 *     is a hard requirement — a loader that does not know the extension is
 *     entitled to refuse the whole file. three.js registers it unconditionally
 *     as of r150, the app is on a version well past that, and the browser half
 *     (WebP decoding) is iOS 14+ and every engine since. The day someone swaps
 *     in a Draco- or KTX2-compressed export, or drops three back a major, this
 *     test is what says so — instead of a poster that never moves on Safari.
 *
 *   * `fiddy-hero-poster.png` is the whole hero on a browser with no WebGL and
 *     the whole hero under reduced motion. A hero whose fallback is missing is a
 *     hole in the page, so its existence, its transparency and its size are part
 *     of the contract, not a detail of the render.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** `apps/farcaster-web`, from `src/components/fiddy/__tests__`. */
const APP = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);
const GLB = path.join(APP, 'public', 'fiddy-hero.glb');
const POSTER = path.join(APP, 'public', 'fiddy-hero-poster.png');

/** The JSON chunk of a GLB, which is where a glTF keeps its promises. */
const gltfJson = (file: string) => {
  const buffer = fs.readFileSync(file);
  expect(buffer.subarray(0, 4).toString('latin1')).toBe('glTF');
  const length = buffer.readUInt32LE(12);
  const type = buffer.subarray(16, 20).toString('latin1');
  expect(type).toBe('JSON');
  return JSON.parse(buffer.subarray(20, 20 + length).toString('utf8'));
};

const threeVersion = () =>
  JSON.parse(
    fs.readFileSync(
      path.join(APP, 'node_modules', 'three', 'package.json'),
      'utf8',
    ),
  ).version as string;

describe('fiddy-hero.glb', () => {
  it('is a binary glTF the app can actually parse', () => {
    const json = gltfJson(GLB);
    expect(json.asset.version).toBe('2.0');
    expect(json.meshes).toHaveLength(1);
    expect(json.animations ?? []).toHaveLength(0);
  });

  it("requires only EXT_texture_webp, and the app's three.js knows it", () => {
    const required: string[] = gltfJson(GLB).extensionsRequired ?? [];
    expect(required).toEqual(['EXT_texture_webp']);

    const [major, minor] = threeVersion().split('.').map(Number);
    // r150 added the extension; anything at or past it is fine. The app is on a
    // 0.1xx release, where the loader registers it unconditionally.
    expect(major * 1000 + minor).toBeGreaterThanOrEqual(150);
    expect(
      fs.readFileSync(
        path.join(
          APP,
          'node_modules',
          'three',
          'examples',
          'jsm',
          'loaders',
          'GLTFLoader.js',
        ),
        'utf8',
      ),
    ).toContain('EXT_TEXTURE_WEBP');
  });
});

describe('fiddy-hero-poster.png', () => {
  it('is a real picture with transparency, big enough for a 232px stage at 2x', () => {
    const buffer = fs.readFileSync(POSTER);
    expect(buffer.subarray(1, 4).toString('latin1')).toBe('PNG');
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    const colourType = buffer[25];
    // 4 = greyscale+alpha, 6 = truecolour+alpha: a poster with no alpha channel
    // would paint a rectangle over the page instead of a Fiddy on it.
    expect([4, 6]).toContain(colourType);
    expect(width).toBe(height);
    expect(width).toBeGreaterThanOrEqual(232 * 2);
  });

  it('is not merely an empty box', () => {
    // A 232px square of nothing compresses to a few hundred bytes; the poster
    // has a figure in it.
    expect(fs.statSync(POSTER).size).toBeGreaterThan(20_000);
  });
});
