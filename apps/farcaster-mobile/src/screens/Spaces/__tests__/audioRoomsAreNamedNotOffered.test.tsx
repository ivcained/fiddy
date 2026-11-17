/**
 * The mobile create sheet must not offer an audio room it cannot make.
 *
 * Web parity: commit 5c6d3f10 (card t_6b38802b) deleted web `CreateSpaceModal`
 * and told the truth on the audio-rooms page. Mobile's create sheet was the
 * same bug, still alive: `CreateSpaceBottomSheet` fired `useStartAudioRoom` —
 * `POST /v1/audio-rooms` — the exact 501 a node-backed client cannot carry
 * ("Fiddy can't do POST /v1/audio-rooms yet"). The app is unreleased, so
 * nothing leaked; this sheet now keeps its own name and offers nothing it
 * cannot do.
 *
 * Pinned here, in the order the bug reads:
 *   1. mounting the create hook at all was the bug — any call to
 *      `useStartAudioRoom` trips the counter, and it must stay at zero;
 *   2. the sheet says its own name and the honest sentence, and offers no
 *      start/schedule/record affordance (none have a Together equivalent);
 *   3. the only action it takes is closing, and closing fires nothing.
 */

import { fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';

import { AudioRoomsUnavailableSheet } from '../AudioRoomsUnavailableSheet';

const state = {
  createRequests: 0,
};

// If the sheet ever mounts the create hook again, the counter trips.
jest.mock('farcaster-client-hooks', () => ({
  useStartAudioRoom:
    () =>
    (..._args: unknown[]) => {
      state.createRequests += 1;
      return Promise.reject(new Error('createAudioRoom 501'));
    },
}));

jest.mock('@expo/vector-icons', () => {
  const { Text } = require('react-native');
  return {
    Octicons: ({ name, size }: { name: string; size: number }) => (
      <Text>{`Octicons-${name}-${size}`}</Text>
    ),
  };
});

// The sheet's Text comes from farcaster-expo, whose index pulls in crypto
// chains (e.g. @solana/web3.js) that break under jest. The sheet only needs a
// plain text node here.
jest.mock('farcaster-expo', () => {
  const { Text } = require('react-native');
  return {
    Text: ({
      children,
      style,
    }: {
      children: React.ReactNode;
      style?: unknown;
    }) => <Text style={style}>{children}</Text>,
  };
});

describe('the mobile audio-rooms create sheet', () => {
  beforeEach(() => {
    state.createRequests = 0;
  });

  it('offers no way to start or schedule a room, and asks for no create', () => {
    render(<AudioRoomsUnavailableSheet open onClose={jest.fn()} />);

    // It says its own name, and says plainly that it cannot carry one yet.
    expect(screen.getByText('Audio rooms')).toBeTruthy();
    expect(screen.getByText(/aren.t in Fiddy yet/)).toBeTruthy();

    // No start, schedule, or recording affordance — nothing to press that
    // would create anything.
    expect(screen.queryByText('Start now')).toBeNull();
    expect(screen.queryByText(/Schedule/)).toBeNull();
    expect(screen.queryByText('Record this Space')).toBeNull();
    expect(state.createRequests).toBe(0);
  });

  it('closes without firing any request', () => {
    const onClose = jest.fn();
    render(<AudioRoomsUnavailableSheet open onClose={onClose} />);

    fireEvent.press(screen.getByText('Got it'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(state.createRequests).toBe(0);
  });
});
