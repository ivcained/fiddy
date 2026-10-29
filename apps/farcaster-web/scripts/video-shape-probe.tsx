import '~/index.css';

import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';

import { VideoAttachment } from '~/components/attachments/VideoAttachment';
import { VideoPlayStatusProvider } from '~/contexts/VideoPlayStatusProvider';

const media = {
  tall: { url: '/media/tall.mp4', poster: '/media/tall.jpg' },
  square: { url: '/media/square.mp4', poster: '/media/square.jpg' },
  wide: { url: '/media/wide.mp4', poster: '/media/wide.jpg' },
};

const ProbeVideo = ({
  name,
  value,
  strip = false,
}: {
  name: string;
  value: { url: string; poster: string };
  strip?: boolean;
}) => (
  <div data-probe={name} style={{ width: strip ? 260 : 530 }}>
    <VideoAttachment
      url={value.url}
      videoWidth={0}
      videoHeight={0}
      thumbnailUrl={value.poster}
      mode="cast"
      autoPlay={false}
      maxWidth={strip ? 260 : 530}
      maxHeight={strip ? 240 : 400}
      renderWidth={strip ? undefined : 530}
      renderHeight={strip ? undefined : 400}
      tileHeight={strip ? 240 : undefined}
    />
  </div>
);

const App = () => {
  const [first, setFirst] = useState(media.tall);
  const [mounted, setMounted] = useState(true);
  return (
    <VideoPlayStatusProvider>
      <main style={{ padding: 16 }}>
        <button
          type="button"
          data-probe-action="swap"
          onClick={() =>
            setFirst(first === media.tall ? media.wide : media.tall)
          }
        >
          Swap URL
        </button>
        <button
          type="button"
          data-probe-action="remount"
          onClick={() => setMounted((value) => !value)}
        >
          Unmount or remount
        </button>
        <section
          data-probe-layout="standalone"
          style={{ display: 'grid', gap: 16 }}
        >
          {mounted ? <ProbeVideo name="first" value={first} /> : null}
          <ProbeVideo name="square" value={media.square} />
          <ProbeVideo name="wide" value={media.wide} />
        </section>
        <section
          data-probe-layout="strip"
          style={{ display: 'flex', gap: 12, marginTop: 24 }}
        >
          <ProbeVideo name="strip-tall" value={media.tall} strip />
          <ProbeVideo name="strip-square" value={media.square} strip />
        </section>
      </main>
    </VideoPlayStatusProvider>
  );
};

createRoot(document.getElementById('root')!).render(<App />);
