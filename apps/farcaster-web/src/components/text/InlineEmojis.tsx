import React from 'react';

interface InlineEmojisProps {
  text: string;
  emojis?: Map<string, string>;
}

/**
 * Renders `text` with the inline custom emojis of a cast (FIP draft "Inline
 * Custom Emoji"): each `:label:` that names an entry in `emojis` becomes an
 * inline <img class="md-emoji"> at the text's height; any other `:label:` stays
 * text (the FIP fallback). With `emojis` undefined (or empty) the text renders
 * unchanged. This is the renderer both the cast body (`LinkifiedText`) and a
 * quoted cast's text use, so the two agree on what an emoji looks like.
 */
const InlineEmojis = React.memo(function InlineEmojis({
  text,
  emojis,
}: InlineEmojisProps) {
  if (!emojis || emojis.size === 0) {
    return <>{text}</>;
  }

  // `text.split` with a capturing group interleaves the captured labels at the
  // odd indices: ["before", "label", "after", "label", "after", …].
  const re = new RegExp(
    `:(${[...emojis.keys()]
      .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|')}):`,
    'g',
  );
  const parts = text.split(re);
  const out: React.ReactNode[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const url = emojis.get(parts[i]);
      out.push(
        url ? (
          <img
            key={`md-emoji-${i}`}
            className="md-emoji"
            src={url}
            alt={`:${parts[i]}:`}
            title={`:${parts[i]}:`}
            height={20}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
          />
        ) : (
          `:${parts[i]}:`
        ),
      );
    } else {
      out.push(parts[i]);
    }
  }
  return <>{out}</>;
});

export { InlineEmojis };
