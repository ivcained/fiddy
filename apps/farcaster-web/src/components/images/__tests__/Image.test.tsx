// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://fiddy.fun/~/feed"}

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { Image } from '~/components/images/Image';

afterEach(cleanup);

describe('external images on Fiddy', () => {
  it('renders the same HTTPS URL the media probe asks for', () => {
    render(
      <Image alt="A shared photo" src="http://media.example/photo/original" />,
    );

    expect(screen.getByRole('img').getAttribute('src')).toBe(
      'https://media.example/photo/original',
    );
  });

  it('keeps the existing fallback when the upgraded image fails', () => {
    render(
      <Image
        alt="A shared photo"
        fallback="https://media.example/photo-fallback.png"
        src="http://media.example/photo.png"
      />,
    );

    fireEvent.error(screen.getByRole('img'));

    expect(screen.getByRole('img').getAttribute('src')).toBe(
      'https://media.example/photo-fallback.png',
    );
  });
});
