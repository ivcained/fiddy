import { ApiConnectedAccount } from 'farcaster-client-data';
import React from 'react';

import { ExternalLink } from '~/components/links/ExternalLink';

/**
 * One account linked to a Farcaster account, drawn the same everywhere.
 *
 * WHY ONE COMPONENT. The linked accounts are read from one source (an index
 * that mirrors that account state — `~/snapchain/providers/neynarMap`) and shown
 * on more than one surface (the profile header, and “Your own setup”). Two
 * renderings would drift: one would grow a platform the other did not know, or
 * point at a different address for the same handle. So the vocabulary — the
 * platforms, their names, and where each account lives — is here, once.
 *
 * WHAT IT REFUSES
 *
 *   - Nothing is offered that cannot work. Adding a link is the holding
 *     service's own sign-in and removing one happens where the link is held, so
 *     neither is a button here: the row says what IS linked.
 *   - A handle is never rewritten, and an address is never guessed: a platform
 *     whose profile address this client cannot build from a handle alone renders
 *     the row without an href rather than pointing somewhere wrong.
 */
const PLATFORM_ROWS: Record<
  ApiConnectedAccount['platform'],
  { label: string; profileUrl: (username: string) => string | undefined }
> = {
  x: { label: 'X', profileUrl: (username) => `https://x.com/${username}` },
  gh: {
    label: 'GitHub',
    profileUrl: (username) => `https://github.com/${username}`,
  },
  meta: { label: 'Meta', profileUrl: () => undefined },
  discord: { label: 'Discord', profileUrl: () => undefined },
  linkedin: {
    label: 'LinkedIn',
    profileUrl: (username) => `https://www.linkedin.com/in/${username}`,
  },
};

/** The X glyph the fork's own row used. */
const XGlyph: React.FC = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 14 14"
    fill="none"
    className="text-muted"
  >
    <path
      d="M10.6489 1.33008H12.5761L8.34476 6.14791L13.2883 12.6834H9.40887L6.37154 8.71184L2.89432 12.6834H0.967186L5.44987 7.53042L0.71582 1.33008H4.69158L7.43565 4.95812L10.6489 1.33008ZM9.97444 11.5523H11.0427L4.1302 2.41933H2.9823L9.97444 11.5523Z"
      className="fill-current"
    />
  </svg>
);

/** What a platform calls itself in a row, given a handle. */
export const linkedAccountLabel = (account: ApiConnectedAccount): string =>
  `${PLATFORM_ROWS[account.platform].label} · @${account.username}`;

/** Where a linked account lives, or undefined when this client cannot tell. */
export const linkedAccountUrl = (
  account: ApiConnectedAccount,
): string | undefined =>
  PLATFORM_ROWS[account.platform].profileUrl(account.username);

const LinkedAccountRow: React.FC<{
  account: ApiConnectedAccount;
  onPress?: () => void;
}> = ({ account, onPress }) => {
  const href = linkedAccountUrl(account);
  const body = (
    <>
      {account.platform === 'x' ? <XGlyph /> : null}
      <div>{linkedAccountLabel(account)}</div>
    </>
  );
  const className =
    'flex w-max select-none flex-row items-center space-x-1 py-[3px] text-sm text-muted';

  if (typeof href === 'undefined') {
    return <div className={className}>{body}</div>;
  }

  return (
    <ExternalLink
      className={`${className} hover:cursor-pointer`}
      {...(onPress ? { onClick: onPress } : {})}
      href={href}
      title={href}
    >
      {body}
    </ExternalLink>
  );
};

LinkedAccountRow.displayName = 'LinkedAccountRow';

export { LinkedAccountRow };
