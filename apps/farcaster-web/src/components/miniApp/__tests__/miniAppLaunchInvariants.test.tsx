// @vitest-environment jsdom
/**
 * What a launched miniapp is allowed to reach for, held in one place.
 *
 * Three things this client tells a reader, and the code has to keep true:
 *   1. the launch iframe asks for no camera and no microphone — the document
 *      already denies both (`permissions-policy: camera=(), microphone=()` on
 *      fiddy.fun), and per the Permissions-Policy spec a child frame cannot be
 *      granted a feature its parent denies, so those tokens only read as a
 *      capability the shell advertises and cannot keep;
 *   2. the `sandbox` list is the control that contains somebody else's page,
 *      and the escape hatches stay off;
 *   3. the Mini App settings page says the camera/microphone denial out loud,
 *      because a denied capability should be readable where a reader looks.
 *
 * The call-site props are read from `MiniApp.tsx` first (a unit test that only
 * renders a component cannot notice an attribute on a call site nobody
 * re-renders), then rendered through the real `IFrameLoader`, and asserted on
 * the iframe that actually lands in the DOM.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { IFrameLoader } from '~/components/iframes/IFrameLoader';

const webRoot = path.resolve(__dirname, '../../../..');

const read = (relative: string) =>
  readFileSync(path.join(webRoot, relative), 'utf8');

const miniAppSource = read('src/components/miniApp/MiniApp.tsx');

/** The launch iframe — the `<IFrameLoader>` element that carries `src={url}`. */
const launchTag = (() => {
  // `<IFrameLoader` also appears inside `useRef<IFrameLoaderRef>` and a
  // `forwardRef<IFrameLoaderRef, …>` type, so match the element (a tag whose
  // name ends and whose attributes start on the next line), not those.
  const start = miniAppSource.search(/<IFrameLoader\s*\n/);
  const end = miniAppSource.indexOf('</IFrameLoader>', start);
  return miniAppSource.slice(start, end);
})();

const launchAttribute = (name: string) => {
  const match = launchTag.match(new RegExp(`\\s${name}="([^"]*)"`));
  expect(match, `${name} on the launch iframe`).not.toBeNull();
  return match![1];
};

const launchAllow = launchAttribute('allow');
const launchSandbox = launchAttribute('sandbox');

const permissions = launchAllow
  .split(/[;,]/)
  .map((token) => token.trim())
  .filter(Boolean);

const sandboxTokens = launchSandbox.split(/\s+/).filter(Boolean);

const renderedIFrame = () => {
  const { container } = render(
    <IFrameLoader
      src="https://example.com/miniapp"
      allow={launchAllow}
      sandbox={launchSandbox}
    />,
  );
  const iframe = container.querySelector('iframe');
  expect(iframe).not.toBeNull();
  return iframe!;
};

describe('miniapp launch invariants', () => {
  it('reads the launch iframe, not some other element', () => {
    expect(launchTag).toContain('src={url}');
    expect(launchTag).toContain('sandbox=');
  });

  it('asks for clipboard-write and no media permission', () => {
    expect(permissions).toEqual(['clipboard-write']);
    expect(launchAllow).not.toMatch(/camera/i);
    expect(launchAllow).not.toMatch(/microphone/i);
  });

  it('renders that allow list onto the real iframe', () => {
    const iframe = renderedIFrame();
    expect(iframe.getAttribute('allow')).toBe('clipboard-write');
    expect(iframe.getAttribute('allow')).not.toMatch(/camera|microphone/i);
  });

  it('advertises no camera or microphone capability either', () => {
    // The parent frames are already refused by the document, so the SDK's own
    // answer has to agree with the iframe's ask.
    expect(miniAppSource).toContain('cameraAndMicrophoneAccess: false');
  });

  it('keeps the sandbox list exact, with the escape hatches off', () => {
    expect(sandboxTokens).toEqual([
      'allow-forms',
      'allow-scripts',
      'allow-same-origin',
      'allow-popups',
    ]);
    expect(renderedIFrame().getAttribute('sandbox')).toBe(launchSandbox);
    for (const escapeHatch of [
      'allow-popups-to-escape-sandbox',
      'allow-top-navigation',
      'allow-top-navigation-by-user-activation',
      'allow-modals',
      'allow-downloads',
      'allow-presentation',
      'allow-pointer-lock',
    ]) {
      expect(sandboxTokens).not.toContain(escapeHatch);
    }
  });

  it('says the denial out loud on the Mini App settings page', () => {
    const settingsCopy = read(
      'src/pages/settingsMiniApps/SettingsMiniAppsPage.tsx',
    );
    expect(settingsCopy).toMatch(/camera/i);
    expect(settingsCopy).toMatch(/microphone/i);
    expect(settingsCopy).toMatch(/sandbox/i);
    expect(settingsCopy).toMatch(/cannot|can't/i);
  });
});
