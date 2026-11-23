import * as Octicons from '@primer/octicons-react';
import cn from 'classnames';
import { AnalyticsEvent } from 'farcaster-analytics';
import { memo, Suspense, useCallback, useState } from 'react';

import { BorderedMainContent } from '~/components/BorderedMainContent';
import { DefaultButton } from '~/components/forms/buttons/DefaultButton';
import { TextInput } from '~/components/forms/TextInput';
import { Page } from '~/components/page/Page';
import { PageHeader } from '~/components/page/PageHeader';
import { PageTitle } from '~/components/page/PageTitle';
import { SettingsPageContent } from '~/components/page/SettingsPageContent';
import { useAnalytics } from '~/contexts/AnalyticsProvider';
import { useCachedCurrentUser } from '~/hooks/data/useCachedCurrentUser';
import { SettingsNav } from '~/layouts/SettingsNav';
import {
  liftMute,
  MUTE_SPANS,
  MUTE_WORD_MAX_LENGTH,
  setMute,
  untilText,
} from '~/snapchain/mutePreferences';
import { useMutePreferences } from '~/snapchain/useMutePreferences';
import { trackError } from '~/utils/errorUtils';
import { toast } from '~/utils/toast';

/**
 * Words you don't want to see.
 *
 * This list is the reader's own, kept in this browser per account and consulted
 * by the read seam while it assembles a page (`~/snapchain/mutePreferences`) —
 * which is not a shortcut. Farcaster carries no muted words and a read node
 * holds none, so a list the read path actually reads is the only thing that can
 * make a muted word true of a node-backed feed.
 *
 * The hosted endpoint this page used to call (`/v2/get-muted-keywords`) is
 * refused by a node-backed build in its own words — "muted words are kept in
 * your Farcaster account on Warpcast's servers" — and nothing in the feed path
 * ever consulted it, so a word added there never hid anything here.
 *
 * A muted word can also name a site (`site.com`, matched against a cast's link
 * hostnames, media CDNs excluded) and reaches the casts a post quotes, both
 * borrowed from quilcast 0.107.5 (`mutePreferences`, MIT). The whole matcher
 * stays dependency-free on purpose, so this page — and the read seam that
 * consults the same list — never pay a bundle or a network probe for the
 * feature.
 */
const SettingsMutedKeywordsPage = memo(() => {
  const { trackEvent } = useAnalytics();
  const fid = useCachedCurrentUser()?.fid;
  const mutes = useMutePreferences(fid);

  const [draft, setDraft] = useState('');
  /**
   * How long the word hides for. The last choice carries no `ms` at all, which
   * is "until I lift it" — the only one that needs no clock to stay true, and so
   * the one this starts on.
   */
  const [spanIndex, setSpanIndex] = useState(MUTE_SPANS.length - 1);
  const [busy, setBusy] = useState(false);

  const words = mutes?.words ?? [];
  const span = MUTE_SPANS[spanIndex]!;
  const word = draft.trim();

  const addWord = useCallback(async () => {
    if (fid === undefined || word.length === 0) {
      return;
    }
    setBusy(true);
    try {
      await setMute({
        fid,
        kind: 'words',
        value: word,
        ...(span.ms === undefined ? {} : { until: Date.now() + span.ms }),
      });
      trackEvent(AnalyticsEvent.MuteKeyword, { keyword: word });
      toast({ message: `${word} muted`, position: 'bottom-center' });
      setDraft('');
    } catch (error) {
      trackError(error);
      toast({
        message: `Unable to mute ${word}`,
        type: 'error',
        position: 'bottom-center',
      });
    } finally {
      setBusy(false);
    }
  }, [fid, span.ms, trackEvent, word]);

  const removeWord = useCallback(
    async (mutedWord: string) => {
      if (fid === undefined) {
        return;
      }
      try {
        await liftMute({ fid, kind: 'words', value: mutedWord });
        trackEvent(AnalyticsEvent.UnmuteKeyword, { keyword: mutedWord });
        toast({ message: `Unmuted ${mutedWord}`, position: 'bottom-center' });
      } catch (error) {
        trackError(error);
      }
    },
    [fid, trackEvent],
  );

  return (
    <Page meta={{ title: 'Muted words / Farcaster' }}>
      <Suspense>
        <div className="border-default sm:border-x">
          <PageHeader hideCastButton>
            <PageTitle>Settings</PageTitle>
          </PageHeader>
        </div>
        <BorderedMainContent className="flex flex-row">
          <SettingsNav />
          <SettingsPageContent>
            <div className="mb-4 flex flex-col">
              <span className="mb-2 font-semibold">
                Words you don&#39;t want to see
              </span>
              <div className="-mx-4 mb-2 space-y-2 border-b px-4 pb-4 text-muted border-default">
                <p className="">
                  A muted word hides any post that carries it, in your feed and
                  in your notifications. Whole words only, so muting $based
                  leaves $basedgod alone.
                </p>
                <p className="">
                  Mute a site by its address — enter{' '}
                  <span className="font-mono">site.com</span> and every post
                  that links that site is hidden too, without you naming the
                  words people use there. A post quoting another that carries a
                  word you muted is hidden as well; a quote of your own post
                  never is.
                </p>
                <TextInput
                  value={draft}
                  placeholder="Enter word, phrase or site.com..."
                  maxLength={MUTE_WORD_MAX_LENGTH}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <div
                  className="flex flex-wrap gap-[6px]"
                  role="group"
                  aria-label="How long"
                >
                  {MUTE_SPANS.map((choice, index) => (
                    <button
                      key={choice.label}
                      type="button"
                      onClick={() => setSpanIndex(index)}
                      aria-pressed={index === spanIndex}
                      data-fiddy={`muted-word-duration-${index}`}
                      className={cn(
                        'rounded-full border px-3 py-1 text-sm',
                        index === spanIndex
                          ? 'bg-overlay-faint border-default text-default'
                          : 'border-transparent text-faint hover:text-default',
                      )}
                    >
                      {choice.label}
                    </button>
                  ))}
                </div>
                <DefaultButton
                  className="w-full"
                  onClick={addWord}
                  disabled={busy || word.length === 0}
                >
                  Mute this word
                </DefaultButton>
              </div>
              <div className="-mx-4 flex flex-col space-y-2">
                {words.length === 0 ? (
                  <div className="w-full text-center text-faint">
                    No words muted yet
                  </div>
                ) : (
                  words.map(({ v: mutedWord, until }) => (
                    <div
                      key={mutedWord}
                      data-fiddy="muted-word-row"
                      className="flex flex-row items-center px-4 py-2 hover:bg-overlay-faint"
                    >
                      <div className="justify-left flex w-full flex-row items-center">
                        <span className="w-auto overflow-hidden text-ellipsis sm:max-w-40 lg:max-w-none">
                          {mutedWord}
                        </span>
                        {untilText(until) !== '' && (
                          <span
                            className="ml-2 text-sm text-faint"
                            data-fiddy="muted-word-until"
                          >
                            {untilText(until)}
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        aria-label={`Unmute ${mutedWord}`}
                        className="cursor-pointer text-faint hover:text-default"
                        onClick={() => void removeWord(mutedWord)}
                      >
                        <Octicons.XIcon size={18} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </SettingsPageContent>
        </BorderedMainContent>
      </Suspense>
    </Page>
  );
});

SettingsMutedKeywordsPage.displayName = 'SettingsMutedKeywordsPage';

export { SettingsMutedKeywordsPage };
