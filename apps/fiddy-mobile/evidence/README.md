# Evidence — Fiddy iOS v1

Screenshots from the iOS 27 simulator (`xcrun simctl io <udid> screenshot`), with
the text read back by local OCR (Vision framework) rather than by eye, so the
transcripts below are what the screen actually said. Full method and the raw
output: `../VERIFICATION.md`.

| File | What it shows | OCR transcript (excerpt) |
| --- | --- | --- |
| `feed.png` | The Feed tab, Debug build, reading the live network | `• Fiddy` / `• served by your node` / `YOUR FEED  fid 3` / `60 casts from 34.101.47.167:3381` / `Greg @greg now — oh so we're time traveling now?` / `:grin: @grin 5h — Marrakech goes hard, in ~/channel/grin` / `Darryl Yeo @darrylyeo 6h — Lanna was epic!` / `adrienne @adrienne 10h — Which community will I be seeing you at next??` |
| `release-standalone.png` | The same app as a **Release** build with the JS bundle embedded and Metro stopped — the configuration a real install runs | `• served by your node` / `60 casts from 34.101.47.167:3381` / `Nounish Prof @nounishprof 4h — why do we have to pick a side? only one of those "sides" is pushing us to do so` / `Greg @greg now` |
| `agent-not-hatched.png` | The Agent tab: the NOT-HATCHED surface, with the hatch URL and the honest soon-tags | `NOT HATCHED  this device` / `No Fiddy has hatched here yet.` / `Hatch your Fiddy` / `opens fiddy.fun/start in your browser — this app's session is not shared with the page` / `RUNS AGAINST http://34.101.47.167:3381` / `Answering in 588ms • version 0.14.3 • 3 shards` |
| `node-not-answering.png` | The honest failure state, captured before the ATS fix — this is what the pill and the feed do when the node does not answer | `your node is not answering` / `READ FAILED  fid 3` / `34.101.47.167:3381 is not answering — nothing below is cached` / `Your node did not answer` / `Could not reach the Snapchain node at http://34.101.47.167:3381 (Network request failed)` |
| `feed-live-390.png` | The new-posts work, 390 pt (iPhone 16e, iOS 27.0), Release build reading a reachable read node: the feed at the top | `• served by your node` / `YOUR FEED  fid 3` / `60 casts from crackle.farcaster.xyz:3381` / `Greg @greg now — oh so we're time traveling now?` |
| `new-posts-at-top-390.png` | A real poll found a real new cast while the reader was at the top, and the cast went straight on top with no pill | `Njal @cryptonjal 3m — Happy Fork Day!` at the top, no floating pill anywhere on screen |
| `new-posts-pill-390.png` | The pill over a scrolled feed: `↑`, two author faces, the diff's own count | `↑ (faces) 2 new posts` near the bottom, clear of the header and the tab area |


Not in here: a physical-device install, and any gesture. The simulator has no
`Simulator.app` window and no touch injection, so the scroll behind the pill
screenshot was driven by a temporary effect that was removed before the commit;
the tap itself was not driven by a finger. `xcodebuild` refuses with
`iPhone needs to be unlocked to enable development services` until the phone is
unlocked; the Release build and the install command are ready.