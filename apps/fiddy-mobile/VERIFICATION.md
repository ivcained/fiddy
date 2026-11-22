# Fiddy iOS v1 — what was verified, on what, and how

Every claim below is from a command that ran, not from a design intention. Where
something was **not** verified it says so.

## 1. The app launches on the iOS 27 simulator

```
cd apps/fiddy-mobile/ios
xcodebuild -workspace Fiddy.xcworkspace -scheme Fiddy -configuration Debug \
  -destination "platform=iOS Simulator,id=4975AB8E-EC9C-412E-9072-876BBE7A21CB" \
  -derivedDataPath ../build-ios-sim CODE_SIGNING_ALLOWED=NO build
xcrun simctl install <udid> build-ios-sim/Build/Products/Debug-iphonesimulator/Fiddy.app
xcrun simctl launch <udid> fun.fiddy.app
```

**BUILD SUCCEEDED**; app installed and launched. Two launch crashes were found
and fixed on the way (both real, both reproducible):

| What broke | Why | Fix |
| --- | --- | --- |
| `EXC_BREAKPOINT` at launch, `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption` | Apps built with the iOS 27 SDK must adopt the scene-based life cycle (TN3187). Expo SDK 55's template still starts React Native from `didFinishLaunchingWithOptions` and has no `UIApplicationSceneManifest`. | `SceneDelegate` + `UIApplicationSceneManifest`, encoded as `plugins/withSceneLifecycle.js` so `expo prebuild` reproduces it. |
| "Network request failed" against every node | The generated `NSAppTransportSecurity` had **both** `NSAllowsArbitraryLoads` and `NSAllowsLocalNetworking`. When the local-networking key is present, ATS ignores arbitrary loads, so cleartext HTTP to the node's IP was blocked. | Dropped `NSAllowsLocalNetworking`, added an explicit `NSExceptionDomains` entry for the node host. |

## 2. The Feed reads the user's own node — verified on device, by text

Screenshots were OCR'd locally (Vision framework, `tools/ocr.py`) rather than
eyeballed, so the text below is what the screen actually said:

```
• Fiddy
• served by your node          ← the node pill, healthy
Feed   Agent
YOUR FEED                                  fid 3
60 casts from 34.101.47.167:3381
Greg @greg now                             oh so we're time traveling now?
:grin: @grin 5h                            Marrakech goes hard      in ~/channel/grin
Darryl Yeo @darrylyeo 6h                   Lanna was epic!
adrienne @adrienne 10h                     Which community will I be seeing you at next??
```

That output is the whole read path working on Hermes: `GET /v1/linksByFid`
(follow graph) → 79 `GET /v1/castsByFid` (one per follow, concurrency 6) → merge
on the Farcaster timestamp, plus `GET /v1/userDataByFid` for display names. Live
timestamps ("now", "5h", "10h") are the proof the data is current, not cached.

**A bug this exposed and fixed:** the node pages *oldest first* unless asked
otherwise, so the first working build showed casts from July. Measured directly:

```
$ curl "…/v1/castsByFid?fid=3&pageSize=3"           → timestamps 60212418 (2022-era)
$ curl "…/v1/castsByFid?fid=3&pageSize=3&reverse=true" → timestamps 182745002 (now)
```

`packages/farcaster-node-client/src/feed.ts` now sends `reverse: true` for
`fetchCastsByFid` and `fetchFollowing`; `pnpm --filter farcaster-node-client test`
→ **73 passed, 9 skipped** after the change.

## 3. On-device compatibility checks (the card asked for these explicitly)

`src/dev/selfTest.ts` runs on the device; `App.tsx` prints the results to the
Metro console on every dev launch. Copied verbatim from the device's own output:

```
[fiddy self-test] PASS Buffer: utf8+base64+hex ok (deadbeef)
[fiddy self-test] PASS TextEncoder/Decoder: 21 bytes round-tripped (shim)
[fiddy self-test] PASS CSPRNG: 16 bytes from the OS per call, uuid 0ec93dd9…
[fiddy self-test] PASS Farcaster time: epoch ok, round-trip drift 49ms
[fiddy self-test] PASS Noble Ed25519: 64B signature matches the Node-computed key 79b5562e8fe654f94078…, tamper rejected
[fiddy self-test] PASS Cast build+sign: 238B protobuf, 64B sig, hash 9f9c91ee8518… (not submitted)
[fiddy self-test] PASS Node read: 5 casts decoded from fid 3 in 570ms · From your POV, what's:
```

Notes on what those mean, because "PASS" is not self-explanatory:

- **TextEncoder/Decoder says "shim"** — RN 0.83 on Hermes has no native text
  codec, and `@farcaster/core` constructs one at module scope. Without
  `src/polyfills.ts` this is an immediate launch failure. Assumed-broken would
  have been wrong in the other direction too: the shim round-trips multi-byte
  text correctly (checked with `Fiddy · 🥚 é 𝟘`).
- **Ed25519 is cross-checked against Node.** The same seed produces
  `79b5562e8fe654f94078…` in both runtimes, so Hermes' pure-JS curve code is
  bit-identical, and a tampered hash is rejected.
- **Cast build+sign** is the full write path (`makeCastAdd` → blake3 hash →
  Ed25519 → protobuf encode → decode) minus the network. `selfTest.ts` contains
  no `submitMessage` call; the signing seed is bytes 1..32, a public test vector.
- **CSPRNG** comes from `expo-crypto` (the OS RNG). This was the third launch
  crash: something in the import graph requests randomness during startup, and a
  JS fallback would have been a silent key compromise. Now it is the real OS RNG,
  checked for non-trivial output and for two calls differing.

## 4. Brand

`simctl` screenshot of the home screen shows the app as **Fiddy** with the
charteuse Fiddy mark (`assets/icon.png`, 1024×1024 from the brand set); the
in-app splash is `assets/splash.png` on `#161715`; no Warpcast/Farcaster marks
anywhere in the app, and the word "Farcaster" appears only where the protocol is
named (Farcaster time, Farcaster timestamp).

## 5. NOT verified in this session

- **Physical-device install.** `xcodebuild -destination id=00008150-…` refused
  with `iPhone needs to be unlocked to enable development services`. The build,
  the free-team setup (`DEVELOPMENT_TEAM=VQ2W66RM8Z`, automatic signing) and the
  install command are ready; the phone has to be unlocked and awake first.
- **Tapping through the UI.** The simulator here is headless (no `Simulator.app`
  window, no AppleScript UI control), so screenshots were taken after launching
  and the Agent tab was captured by temporarily defaulting the tab, then
  reverting. Every interactive control compiled and rendered; none was tapped.
- **Android, desktop, posting, hatching.** v2 by the card's own scope.

## 6. Reproducing

```
pnpm install
pnpm --filter farcaster-node-client build
cd apps/fiddy-mobile
pnpm ios                      # simulator
npx expo prebuild --clean -p ios   # regenerates ios/ including the scene-lifecycle plugin
```

`tools/ocr.py` is the OCR helper used above:
`uv run --no-project --with pyobjc-framework-Vision python tools/ocr.py shot.png`

## 7. "N new posts", 2026-11-13 (t_cba10fa2)

The feed now polls the head of the follow graph and offers what arrived in a
floating pill (quilcast #640 port). What follows is what ran, on this machine,
and what could not.

**Ran, and passed** (all on Node 20.19.5, the version `.npmrc` pins; the
measurement script uses `module.register()` with a loader file so it runs on the
pinned Node too, not just on a newer one):

| Command | Result |
| --- | --- |
| `pnpm --filter fiddy-mobile test` | **59 tests pass** (22 for the diff, 17 for the pill's words, 9 for the poll gate, 7 for the poll schedule with a fake clock, plus the node-client head read) |
| `pnpm --filter farcaster-node-client test` | 93 passed, 9 skipped (5 new: head read, request count, unread authors, cancellation, a remove at the top) |
| `pnpm --filter fiddy-mobile typecheck` | clean |
| `pnpm --filter farcaster-node-client lint` | 14 prettier errors, every one on a line `origin/main` already fails (`http.ts`, `http.test.ts`, `feedPagination.test.ts`, `clientFilter.test.ts`, `feed.ts:46/68`); none in this change |
| `node scripts/measure-feed-head.mjs https://crackle.farcaster.xyz:3381 3` | **79 requests, 3.4-3.7 s**, 79 follows (see §7.1) |
| `expo export --platform ios` | 3,650 modules, `main.jsbundle` 10,366,498 → **10,387,003 bytes** (+20,505, +0.20%), both sides exported from a clean worktree |
| `xcodebuild … -configuration Release -destination "platform=iOS Simulator,id=59B83F72…"` | **BUILD SUCCEEDED**, installed and launched on a booted iPhone 16e (iOS 27.0) — see §7.3 |

No dependency was added: `pnpm-lock.yaml` is untouched, and the production
bundle is grepped for the new strings (`new posts` present; the `__DEV__` cost
log absent, as it should be).

### 7.1 What one poll costs, measured, and the cadence it bought

`scripts/measure-feed-head.mjs` could not run at all before this round: it
`require`d `dist/index.js`, which is TypeScript's ESM output with extensionless
relative imports (`export * from './appKey'`), so Node refused it with
`ERR_MODULE_NOT_FOUND .../dist/appKey`. It now registers a resolve hook
(`scripts/esm-extensionless-loader.mjs`, via `module.register()`, which exists on
the pinned Node 20.19.5 as well as 22+) that appends `.js` the way the app's
bundler does, and it runs:

```
$ node scripts/measure-feed-head.mjs https://crackle.farcaster.xyz:3381 3
follow graph: 1675ms
follows: 79
head read (one small page per author): 3663ms
{ "authors": 80, "requests": 79, "unread": 0, "casts": 155, "newest": … }
second head read: 3434ms
second read: 79 requests, 155 casts
```

Requests are `follows + 1` and cannot be fewer: a read node answers
`castsByFid` per author, so a head read is one small page per follow. Bytes,
sampled over 30 real responses: ~1.6 KB each, so **~131 KB per poll**.

At upstream's 60 s that is **~5,000 requests and ~7.9 MB per hour** of screen
time on the reader's own node — the same order as re-running the whole feed read
every minute, which is exactly what the card says not to do. So the card's
fallback applies and is what shipped: **the poller exists all the time, runs
immediately when the app returns to the foreground or the Feed tab comes back
(after an interval away), and reads every five minutes while the reader stays on
the feed** (~1,000 requests and ~1.6 MB per hour). Pull-to-refresh is unchanged.
`EXPO_PUBLIC_FIDDY_POLL_MS` overrides the cadence for verification builds.

### 7.2 A live-data bug the port needed: a cast dated 2061

Running the shipped diff against the real graph (not a fixture) returned
`null` on every poll, forever:

```
poll 0: req 79 page 155 unread 0 anchor 0 raw 0 gap false -> null
top five keys: 0x8ae98f90…:347 @2061-09-12   ← the top of the feed
               0x464361c5…:1325 @2026-11-13T06:09:38Z
```

The node really serves a cast timestamped **2061** (its text: "oh so we're time
traveling now?"), and the feed sorts on the timestamp, so it sits on top
forever. Upstream's rule ("take what is above the first top-five entry") then
has nothing above it, so nothing is ever new. `newOnTop` now keeps
future-dated entries (`timestampMs > now + 60 s`) out of the *anchor* set while
still showing them and still treating a genuinely unseen future cast as new.
Five tests cover it (`newOnTop, a future-dated cast on top`).

### 7.3 The simulator does run: a live run at 390 pt

The previous version of this section blamed CoreSimulator. That was wrong for
this machine at review time: `xcrun simctl list devices` answers, and a device
boots.

- `xcrun simctl create "Fiddy 16e" com.apple.CoreSimulator.SimDeviceType.iPhone-16e com.apple.CoreSimulator.SimRuntime.iOS-27-0`
  → a **1170×2532 @3x screenshot = 390×844 pt**, the width the card asks for.
- Release build + `simctl install` + `simctl launch`, with the session pointed at
  a reachable read node (`EXPO_PUBLIC_FIDDY_NODE_URL=https://crackle.farcaster.xyz:3381`,
  `EXPO_PUBLIC_FIDDY_FID=1325` for a busier graph, `EXPO_PUBLIC_FIDDY_POLL_MS=20000`
  so a verification run does not take five minutes a step).
- The feed rendered live data from that node ("60 casts from
  crackle.farcaster.xyz:3381", relative times counting up).

**At-top insert, verified on that run.** With the list at the top, a real poll
found a real new cast and put it straight on top, no pill, which is the
behaviour the card asks for:

```
[watch] 06:50:25 poll 9: FOUND 1 (count 1)
[watch]   0x3dfcc5fc fid 352276 2026-11-13T06:50:07.000Z
```

and the next screenshot of the running app showed `Njal @cryptonjal 3m · Happy
Fork Day!` as the first cast with no pill on screen.

**The pill, on that same run, over a scrolled feed.** A second later cast from the
same graph (`0x300aa697 fid 1116896 07:19:52Z`) arrived while the list was
scrolled, and the app held it:

> screenshot `pill-390.png`: `↑` + two overlapping author faces + `2 new posts`,
> chartreuse pill, horizontally centred near the bottom of a 390 pt screen,
> above the feed and well clear of the header and the tab area.

The scroll that got the list there was driven by a **temporary three-line
effect** (`listRef.current?.scrollToOffset({ offset: 700 })` after 25 s), because
this simulator cannot be touched; it was removed before the commit, so what the
screenshot proves is the pill's layout, faces, count and position — not the
gesture. The count (2, not 1) is the poll's own diff: a second cast landed
between two polls.

**Not verified, and why:** the tap, and the scroll gesture. `Simulator.app` is
not installed in this Xcode (`/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app`
does not exist), so the simulator is headless: `simctl io … screenshot` works,
but there is no window to click and no touch or scroll injection (`idb` is not
installed, and `brew` has no formula for it). So "tap inserts them and scrolls
up" is covered by the at-top insert above (same `show()` path minus the
`scrollToOffset` call, which is plain RN) and by the unit tests, but it was not
driven by a finger.

### 7.4 The node that ships with the build

`http://34.101.47.167:3381` still times out from this machine (8 s, no
response), and `docs/CLIENT-PARITY.md:184` records the same unreachability from
weeks earlier. Every live claim above was therefore made against
`https://crackle.farcaster.xyz:3381`, a public read node, which is what the
`EXPO_PUBLIC_FIDDY_NODE_URL` override exists for; nothing in the app was
changed to make that work.