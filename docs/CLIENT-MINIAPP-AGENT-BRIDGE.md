# A mini app asking the reader's agent: the ask, the consent, and the refusal

Status 2026-10-22. Design of record for card `t_3c494ad9`, the follow-up the
mini app host audit (`docs/CLIENT-MINIAPP-HOST-SPEC.md` §8.2) carded instead of
building: **what a third-party mini app may ask the reader's agent for, where the
reader approves it, and what the app is told when it cannot have it.**

Nothing in this file is implemented. It is the decision the implementation slices
build against, and every slice card is listed in §8 with the decisions it needs
already made here. The one rule the card set, kept everywhere below: **no mini
app gets a capability that spends the device's posting key without a visible
approval.**

Every claim says which kind it is: **measured** (a command ran and this is its
output), **read** (this is what the committed source or the installed package
says, with file and line), or **not verified** (it follows from the other two and
has not been watched happen).

---

## 1. The decision, in one table

Three asks are allowed, each ending in the reader's own hands and never in the
app's. Everything else is refused by name.

| ask | what the app gets back | where the reader decides | what the agent actually does |
| --- | --- | --- | --- |
| `draft` — "draft a cast about this" | `drafted` (the words stay in Fiddy) | one ask card in the mini app window, then the shell's own composer | one chat message to the paired agent; its answer becomes a draft in the composer |
| `post` — "ask my agent to post this" | `posted` / `unknown` / `failed` / `declined` | the ask card **plus** the shell's own composer, **plus** the existing posting-key approval if this device holds no key | nothing until the reader has read the final words in Fiddy's own composer and pressed Cast; the write then goes through the same seam every other write uses |
| `remind` — "tell my agent to remind me" | `asked` (the agent's answer stays with its owner) | the ask card, and the record the agent surface already keeps | one chat message, in the same words the Scheduled tasks tab already uses |
| `read-answer` — "read my agent's last answer" | `not_permitted` | nowhere: it is not offered | — |
| anything else | `invalid` | nowhere | — |

Two shapes are ruled out on purpose, and the reasons are the interesting half:

- **Nothing is echoed.** The app is told a state word and, when it might be
  useful, one sentence. It never receives the agent's words, a cast hash, an
  answer, or anything else the reader did not type into the app themselves. The
  agent's answer is a window onto the reader's own feed and conversations, and a
  third-party page has no claim on it.
- **No text is signed that the reader has not read in Fiddy's own UI.** The
  app's own words are untrusted input; a route that carried them straight to the
  write seam would let somebody else's web page post a phishing cast under the
  reader's name. So even `post` passes through the composer the reader already
  knows, where the words are Fiddy's chrome, not the app's.

---

## 2. What a mini app can already do, before any bridge

This is the surface the bridge has to fit into, and it was read rather than
remembered.

**The wire is a closed switch.** READ: `@farcaster/miniapp-host@0.3.0`
`dist/comlink/comlink.js:99-164` — the host answers a message only if
`path.length === 1 && typeof path[0] === 'string'`, and then only through a
`switch (path[0])` listing the spec's own members; anything else throws
`Unsupported APPLY for <path>`. READ: `dist/helpers/endpoint.js` — the SDK this
client exposes is `Comlink.expose(sdk, endpoint, [miniAppOrigin])`, and this
client passes `miniAppOrigin: '*'` (`MiniApp.tsx:1335-1342`).

**So the bridge cannot be a new host member** without patching a third-party
package that sits on the whole mini app wire. That is rejected here (see §3),
and it is why the bridge is a channel of our own.

**The precedents the bridge copies.**

| precedent | where | what it settles |
| --- | --- | --- |
| an ask that ends in the reader's own composer | `MiniApp.tsx:679-719` (`composeCast`) and `:1425-1435` (`ComposeCastModal`) | An app may already suggest a cast: the shell opens **its own** composer over the mini app window, the reader presses Cast, and the app gets the posted cast or `null`. Consent already lives in shell chrome inside the mini app window. |
| an ask with a budget, refused in a typed envelope | `MiniApp.tsx:567-633`, `:592-596` (`addPromptCountRef.current >= 3` → `{error:{type:'rejected_by_user'}}`) | The host already caps how often one app may interrupt the reader (three times), and already refuses with a *reason*, not a silent no. |
| the reader's approval, one at a time, with a deadline, in place | `src/snapchain/accounts/postingKeyApproval.ts` + `src/components/session/SignerApprovalGate.tsx` | The exact store shape for "something wants the reader's decision": one ask in front of the person, a second ask **joins** the decision already being made, five minutes of silence ends the wait, and the honest refusal is the outcome. It is React-free so the writer's tests drive it with no browser. |
| the full-screen approval that already exists | `components/fiddy/accounts/ConnectSheet.tsx`, mounted by `SignerApprovalGate.tsx:104` at `fixed inset-0 z-50` | The only approval that hands over a posting key is one screen, and nothing else in the client implements a second one. |
| a mini app asking for a *different* mini app | `contexts/MiniAppProvider.tsx:187-203` | Chained launches already raise a shell-owned `ConfirmationModal` naming both apps. The bridge keys its own state to the window's current origin for the same reason. |
| refusing by name, in place | `src/snapchain/nodeApi/nodeCannotAnswer.ts` + `hostedRoutes.ts` | The house habit: a sentence the person can read, never a fake and never an empty result. |

**The agent, as this client holds it.** READ: `src/lib/agentService.ts` — a
*paired session* (`{baseUrl, token}`) in this browser, a list of agents
(`AgentSummary = {id, name, status, template?, url?, created?}`), and one chat
route: `POST /api/agents/instances/:id/chat` with `{message}` answering
`{result:{output_text}}` (`agentService.ts:375-397`). READ:
`src/pages/agent/AgentPage.tsx:468-551` — a chat send and a scheduled-task
request are the same call; the schedule path sends
`"Schedule this recurring task for me, then confirm it in one line: <prompt>"`.
READ: `components/agent/AgentRailPanel.tsx` — the agent is a separate account on
the network with its own profile, and **this client holds no agent FID**: the
summary carries an id and a name, nothing that authenticates anybody.

**Where the rail is, and is not.** READ: `layouts/AuthedRightSideBar.tsx:42` —
`{routeName === 'homeFeed' && <AgentRailPanel />}`, and
`components/MinimizableWindowHost.tsx` is rendered by the same layout as a
`fixed bottom-4 z-10` window. So on the home feed the agent rail and the mini app
window are siblings in one column; **on every other route the rail does not exist
at all** (search, notifications, a channel header, a cast embed), and on a phone
the window covers most of the screen. That single fact decides §5: the approval
cannot live in the agent rail.

---

## 3. What a mini app may ask an agent for

### 3.1 The channel

The ask is a versioned envelope on `postMessage`, because the spec wire is
closed (§2) and the spec itself has no slot for it. MEASURED/READ:
`miniapps.farcaster.xyz/docs/specification` (fetched 2026-10-22) lists
`context`, `addMiniApp`, `close`, `composeCast`, `ready`, `signIn`, `openUrl`,
`viewProfile`, `viewCast` (plus wallet actions) and says of the message passing
format: *"At this time there is no formal specification… Hosts and Apps should
use the open-source NPM packages."* There is no agent action, and no extension
registry to put one in.

App → shell (the app posts to `window.parent`; the target origin it picks is its
own business, because **our** validation does not trust it):

```js
{ type: 'fiddy:agent-ask', v: 1, id: '<string, 1..64 chars, unique per window>',
  ask: 'draft' | 'post' | 'remind',
  text: '<plain text, ≤ 500 chars>',        // required for draft/post
  embeds: ['https://…']                      // optional, ≤ 2, https only, draft only
}
```

Shell → app (posted to the mini app window with `targetOrigin` = that window's
own origin, exactly as `createIframeEndpoint` already does for `emit`):

```js
{ type: 'fiddy:agent-ask-result', v: 1, id, state: '<one of the words below>',
  message: '<one sentence, safe to show>' }
```

The channel is accepted **only** when all of these hold: `event.source ===
iframe.contentWindow`; `event.origin` is the origin of the URL the window was
launched with; the envelope validates; and the id has not been used in this
window. Anything else is dropped without an answer. (Not verified in a browser:
the checks are the design's requirement on code that does not exist yet. The
reason they are phrased this way is measured — see §7.5.)

The bridge also declares itself in `getCapabilities` as `fiddy.agent.ask`, so a
well-behaved app can find out before asking, and so the capability list keeps
meaning "every string here is backed by something real".

**The patch route, rejected.** Patching `@farcaster/miniapp-host`'s comlink
switch to carry a `fiddyAgentAsk` member would let an app call it through the
standard SDK's own `miniAppHost` proxy. It is rejected: it puts a patched
third-party file on the critical path of every mini app (the exact wire that
wallet, sign-in and compose all travel), for one non-standard feature, and this
repo's own rule is the honest opposite — see the `501` seam, and the "AGPL
sources → patterns only, clean-room" rule in the product spec. A Fiddy-only
extension gets a Fiddy-only channel.

### 3.2 `draft`

**What the agent does.** The shell composes exactly one chat message and sends
it, only after the reader's approval:

```
Someone's app at <domain> asks you for a draft cast about this:
"<the app's text, ≤ 500 chars, quoted, labelled as untrusted>"
Write the draft. Do not post anything.
```

**What the reader sees.** The ask card (§5), then — on approval — their own
composer open over the mini app window, prefilled with the draft, exactly where
`composeCast` already puts a suggestion (`ComposeCastModal`). Casting is still
the reader's press. If the agent is unreachable, the composer is not opened, one
sentence says so, and the app is told `failed`.

**Where consent lives.** The ask card, once per app per window. After a first
approval, later `draft` asks inside the budget run without a second card —
because a draft reaches nothing but the reader's own composer, where the reader
still decides.

**What the app gets.** `drafted`. Never the text. The draft is user content
(and the agent's answer may quote the reader's own feed); handing it to somebody
else's page is exfiltration by design. An app that wants the words can ask for
them through a future ask with its own consent — and the cost of not having it
now is one less way to leak a feed.

### 3.3 `post`

**What the agent does.** Nothing direct. `post` is not an agent route at all:
the shell opens its own composer prefilled with the app's words (approved in the
ask card, where they are quoted and inert), and the reader presses Cast. The
write then goes to the write seam every other write uses —
`src/snapchain/nodeApi/nodeWrites.ts` — signed by the posting key this device
holds, or, if it holds none, held in front of the reader by
`askForPostingKey` → `postingKeyApproval` → `SignerApprovalGate`'s full-screen
phone approval, and carried only if the service really confirms the key exists
(`docs/CLIENT-INLINE-APPROVAL.md`).

**Why not "the agent posts it as you" in one step.** Two reasons, both
product-level: the app's words must pass under the reader's eyes in Fiddy's own
chrome before anything is signed (a stolen or compromised page asking for a
"helpful" post is the phishing cast), and Fiddy already has exactly one way to
post as the reader — the composer, over one approval. A second route into the
seam would be a second chance to get it wrong.

**What the app gets.** `posted` only when the seam's own evidence says the
message landed and the node reads it back — the same proof every other write
reports. A write the node accepted but does not yet show is `unknown`, with the
sentence the client already uses for that case. An attempt that was approved and
then did not land is `failed`; a reader who said no is `declined`. Two states,
because "the person refused" and "it did not land" are different facts, and an
app deciding whether to offer a retry needs to know which one it got.

**Decided against, and worth naming:** the app does not learn the cast's hash.
`composeCast` does hand a hash back today, so this is a deliberate asymmetry —
the hash is a handle the app could use to read the cast's thread through its own
backend and, with a reader's other data, to correlate. If a real app needs
attribution, that is a later ask with its own line in this table, not a v1
default.

### 3.4 `remind`

**What the agent does.** One chat message, in the words the Scheduled tasks tab
already sends (`AgentPage.tsx:545-548`), labelled with the app's domain:

```
Someone's app at <domain> asks me to be reminded: "<text>"
Schedule this recurring task for me, then confirm it in one line: <text>
```

**What the reader sees.** The ask card (naming the app and quoting the text),
then the record the agent surface already keeps (`src/lib/agentSchedules.ts`,
per-agent, `requested → answered / failed`) — the honest half of a feature whose
scheduling is the agent's own machine's job (`CLIENT-AGENT-SURFACE.md` §2: a
request log is not a scheduler, and the copy says `sent · waiting`, never
`running`).

**What the app gets.** `asked`, or `failed` if the message could not be sent. The
agent's answer is the reader's (it may name
channels, people, times, or judgement calls), and a reminder is a small effect:
one message on the reader's agent, one line in a log the reader owns.

### 3.5 `read-answer`, refused

A mini app may never read what the agent said. The state is `not_permitted` and
the sentence is the one in §6. The reasoning is not squeamishness, it is the
only position that survives §7: the agent's answers are built from the reader's
feed, mentions, and — for a paired agent with channel access — conversations in
channels it was approved for. An app that could ask "what did your agent say
about me?" would have a query interface to the reader's private context, through
the reader's own wallet of trust. If a reader wants to share an answer, they
paste it: the app's own text box is right there.

### 3.6 Everything else, refused

An ask is refused as `invalid` — with no hint of which part failed — when it asks
for a wallet, a token, an amount, a recipient, a signature, a key, a file, a
secret, a "don't tell them", a person's FID or a specific agent, or when it names
a route the shell does not have. Refusing without diagnosing is deliberate: an
error message that says *why* is a specification for the next attempt.

---

## 4. Where the approval lives

**In the mini app window, drawn by the shell, over the app's own frame.** Not in
the agent rail, and not in a corner toast.

- The agent rail is not on screen where asks happen: it renders only on the home
  feed (`AuthedRightSideBar.tsx:42`), while a mini app opens from the feed, from
  search, from a channel header, from a notification, and from a cast embed
  (`MiniApp.tsx:266`, `CLIENT-MINIAPP-HOST-SPEC.md` §1). An approval that only
  exists on one route is an approval that silently fails on four.
- A corner card is worse than it looks here: `SignerApprovalGate`'s card is
  `fixed bottom-20 right-4 z-40` (`SignerApprovalGate.tsx:69`) and the mini app
  window is `fixed bottom-4` (`MinimizableWindowHost.tsx:56`) — the same corner.
  The card would land on top of the app that asked.
- The precedent is already in the window: `ComposeCastModal` renders inside the
  mini app window's own tree (`MiniApp.tsx:1425`), so shell chrome over the frame
  is a pattern this client ships.

The card itself, in the shell's words and with the shell's controls:

```
┌─────────────────────────────────────────────────────────┐
│  beep.works asks Fiddy to draft a cast                  │
│                                                         │
│  “ask me anything for $0.05”            ← quoted, inert  │
│                                                         │
│  [ Ask Fiddy ]   [ Not now ]                            │
│  Don't let beep.works ask again in this window          │
└─────────────────────────────────────────────────────────┘
```

Rules for it: the heading names the **origin the window was launched with**, and
the app's own manifest name only as an aside (`beep.works` is what the shell can
actually verify; a name is text the app chose). The app's words are rendered
inside a quoted, non-interactive block, never as a heading, a button, or
anything that could pass for shell chrome. The copy says what happens next
("the draft opens in your composer" / "you approve the post next" / "your agent
will get this as a message"). Both controls are the shell's, and the third is
the mute.

**One ask at a time.** The store shape from `postingKeyApproval`: a second ask
that arrives while the reader is deciding **joins** the decision instead of
stacking a second card (it is one decision to the person), and the card's
dismissal is a decline for everything waiting. Five minutes of silence ends the
wait, and the answer to everyone waiting is the honest refusal.

**Muting.** "Don't let <domain> ask again in this window" is remembered for the
window's lifetime (session storage, keyed by origin), answered `muted` to the
app, and shown in the card's footer on every later ask: *"beep.works is muted in
this window · allow asking again"*. It is the reader's ceiling, and it is the
only durable thing the bridge stores about an app.

**What the app sees on refusal.** The typed envelope in §3.1, never a silent
nothing: a promise that never resolves is the worst answer for app authors, and
"refuse by name" is what this repo does everywhere else. Sentences (§6) obey the
product's ELI5 ban — no "signer", no "agent", no protocol words the reader has
not met.

**What stops a flood.** Four things, in order: the id is one-shot (a replayed id
is dropped); an identical ask text from the same window inside 30 s is answered
from the last answer rather than raising anything again; the budget is **three
asks per origin per window**, mirroring the three `addMiniApp` already allows
(`MiniApp.tsx:592-596`); and after that the answer is `budget` for the life of
the window. Reopening the app gives a new window and a new budget — which is
fine, because it also gives the reader a new chance to mute, and muting outlives
the window only in the reader's hands, not in the app's.

---

## 5. The honest bridge identity

**Which FID or agent is a mini app talking about? None it names, and none it is
told.** The shell decides everything about identity, from its own session:

- the reader is whoever this browser is signed in as
  (`currentUser.fid`, `MiniApp.tsx:929-934`) — an ask carries no fid, and one
  that contains a number is `invalid`;
- the agent is whichever agent this browser's paired session has selected (the
  rail's own subject, `AgentSummary.id`); the app cannot name, choose, or
  influence it;
- the reply carries no fid, no agent id, no name, no token, no signature —
  only a state word and a sentence. There is nothing in the envelope worth
  forging, which is the point.

**Why `sdk.context` is not authentication.** An app can already read
`sdk.context.user.fid` — the shell hands it over at `MiniApp.tsx:927-947` — and
it is worth writing down, in this repo, why that is context and not a credential:

1. **It is our assertion about the reader, not a proof the app can check.** There
   is no signature, no shared secret, and no callback: the app's only evidence is
   that the host said so.
2. **Anyone who can reach the host window can say so too.** READ:
   `Comlink.expose(sdk, endpoint, [miniAppOrigin])` is called with
   `miniAppOrigin: '*'` (`MiniApp.tsx:1335-1342`), the listener lives on the
   host's own window (`Comlink.windowEndpoint(iframe.contentWindow)`,
   `@farcaster/miniapp-host/dist/iframe.js:6-30`), and comlink's expose checks
   the origin against that list and never checks `event.source`
   (`dist/comlink/comlink.js:70-93`; measured: no `.source` read anywhere in
   that file). A frame that is *not* the mini app can
   therefore drive the exposed members (it cannot read the replies: those are
   posted to the mini app's own window). `context` is handed out over that same
   channel, so "the host told me this fid" is exactly as strong as "somebody
   posted a message into the host window". §7.5 and card S4.
3. **We already document this lesson from the other side.** READ:
   `docs/CLIENT-MINIAPP-AUTOLOGIN.md` — when *this client* is the mini app, a
   host signature proves an address signed a message for this host with this
   nonce, "not that the address controls the fid", and the fid↔address binding
   is recorded there as still unchecked. The mirror is true: our host's context
   proves we made a claim, not that the reader is who the claim says.
4. **The app's own page is untrusted by construction.** It is somebody else's
   origin, shipped whenever they like; the sandbox keeps it out of our storage
   (`CLIENT-MINIAPP-FEED.md` §4) and nothing about its content should ever be
   allowed to speak *as* the reader. An ask that claims to be "fid 191554's app"
   would be a claim by a web page about a person who never spoke.

So the bridge's identity model is: **the ask belongs to the window it came from,
the window belongs to the session it was launched in, and the session belongs to
the reader.** No party in the chain gets to assert any of that; only the shell
knows it, and it stays in the shell.

---

## 6. The refusal, in the app's own hands

When there is no agent in this session, and for every other honest no, the app
gets the envelope of §3.1 with one of these. They are shown to readers through
app UI, so they keep the product's jargon ban, and each one is a fact, not a
shrug:

| state | sentence the app gets |
| --- | --- |
| `no_agent` | `No agent is paired in this browser, so there is nobody to ask.` |
| `declined` | `The person said not now.` |
| `muted` | `The person using Fiddy told this app to stop asking.` |
| `budget` | `This app has asked Fiddy as often as it may in this window.` |
| `not_permitted` | `Fiddy does not hand what your agent says to an app.` |
| `unavailable` | `Fiddy cannot do that here yet.` |
| `invalid` | `That ask was not something Fiddy can do.` |
| `drafted` | `A draft is open in the composer.` |
| `posted` | `Fiddy's owner approved it, and Fiddy's own node shows the cast.` |
| `unknown` | `Fiddy's owner approved it, but nothing on the network shows it yet, so Fiddy will not say it went out.` |
| `asked` | `Your agent was asked; the answer stays with its owner.` |
| `failed` | `Fiddy tried, and could not — the person using Fiddy has been told.` |

`no_agent` is the one the card asked about by name, and it is a *state*, not an
error: the app asked something real and there is no agent in this browser to
answer for it. The app may show the sentence, or ignore it, or ask again when the
reader has a session — and it will be told the same thing until then.

**One order decides which sentence wins**, so the same ask never gets two
different answers from two code paths:

```
invalid  →  no_agent  →  muted  →  budget  →  unavailable  →  the ask itself
```

Validation first (a malformed ask is refused before anything else is even
considered), then the environment (`no_agent` is about the session, not about the
app), then the app's own standing with this reader (mute outranks budget: a muted
app is not told how many asks it has left), then the ceiling, and only then the
ask's own route. `unavailable` is what a well-formed ask gets from a shell that
has no path for it — today that is every effectful ask, since the slices below
land one at a time, and it is the state that keeps a half-built bridge honest
instead of pretending.

The app is also told the truth when Fiddy is signed out entirely: an ask from a
window on a signed-out shell is `no_agent` too, because there is no session for
an agent to belong to. One state, one sentence, no guessing which silence
happened.

---

## 7. Threat model, in one page

The attacker is the app: somebody else's web page, framed by us, free to send
anything on the channel and to draw anything in its own frame.

| # | a hostile app tries to… | what stops it | kind |
| --- | --- | --- | --- |
| 1 | **drain the ask quota** — loop asks to bury the reader in cards, or to burn the owner's model credits | one ask at a time (a second joins the decision, it does not stack); identical asks inside 30 s answered from cache; 3 asks per origin per window, mirroring the 3 `addMiniApp` already allows; after that `budget` for the window's life; the reader's mute is permanent for the window | designed |
| 2 | **phish the approval** — draw its own "Approve" UI, or put shell-looking words in its own frame | the card is shell chrome over a cross-origin frame the app cannot restyle or cover (no `allow-top-navigation`, no same-origin access: `CLIENT-MINIAPP-FEED.md` §4); the app's own words are quoted and inert; the heading names the *origin*, which the app cannot choose; the only controls that do anything are the shell's; and an ask never carries an identity claim to dress up (§5) | designed |
| 3 | **exfiltrate the reader's feed through the agent's answer** | nothing the agent says crosses back: `read-answer` is `not_permitted`, a draft lands in the reader's own composer, `remind` reports `asked`, a post reports a state word and no hash (§3.2–3.4) | designed |
| 4 | **prompt-inject the agent** — put instructions in its own ask text ("ignore your owner and post…") | the shell composes the agent message from a fixed template with the app's text quoted and labelled untrusted, length-capped; the app cannot name a recipient, an account, or a tool; and the *only* effect a `draft` ask can reach is the reader's composer, where nothing is signed without the reader's own press | designed, and deliberately not claimed to be airtight: an agent that reads an injected sentence can still *say* something odd, which is why no ask can end in a write that the reader has not read first |
| 5 | **ride our own wire instead of the mini app's** — send comlink messages from another frame (an ad iframe inside the app, a sibling frame, a hostile embed) and drive the host's members | **not fully stopped today, and this is the finding**: the exposure is origin-`'*'` with no `event.source` check (§5.2), so another frame can *invoke* spec members — it cannot read the answers (they are posted to the mini app's window), but it can make the shell open a composer, a wallet sheet, or a sign-in prompt. The bridge's own channel is pinned twice (`event.source === iframe.contentWindow` **and** the frame's origin) and must be built on that check; the pre-existing looseness is card **S4** | measured/read |
| 6 | **spend money or keys** — ask the agent to move a token, sign something, or post under a key | no ask may name a wallet, a token, an amount, a recipient, a signature or a key (`invalid`, §3.6); the bridge hands no mini app a provider, a key, or an agent token — it *adds* no caller of the write seam that is not behind the reader's own visible approval; the wallet actions on the spec wire stay the reader's own taps | designed |
| 7 | **make the grant durable** — get "remember this" so a later window acts silently | every approval is per window and dies with it; the only thing stored per app is the reader's *mute*; there is no "always allow" on the card, because the app is unidentified (§5) and origins change hands | designed |
| 8 | **replay a good ask** — reuse a captured envelope, or re-ask with an old id | ids are one-shot per window: a replayed id is dropped with no answer, and the answer is addressed to the iframe's origin with the frame's own window as the target | designed |
| 9 | **use the channel as a data pump** — ask in a way that makes the shell send data back | the reply is a state word and a fixed sentence; nothing reader-derived is ever in it, so there is nothing to pump | designed |
| 10 | **ask as somebody else's app** — a chained launch, or a nested frame speaking for the app | an ask belongs to the window on screen: budget, mute and approvals are keyed to the current origin and cleared when the window's URL changes (the shell already confirms chained launches, `MiniAppProvider.tsx:187-203`); a nested frame fails the `event.source` check | designed |
| 11 | **learn the surface by probing errors** | `invalid` carries no reason; the message never says which field or which route was wrong | designed |

The one row that is not "designed" is row 5, because it is a fact about the
shipped host rather than a decision about the bridge. It is recorded here so the
bridge cannot be built on top of it quietly.

---

## 8. Carded, not built

Four slices, chained so that one worker owns this repo at a time (this repo's
`lint-staged` hook stashes unstaged work on every commit — two workers in one
tree destroy each other's work, so slices run in sequence, each from a worktree).
The landing order is **S1 → S4 → S2 → S3**: the refusals can be honest first, the
wire the approval will sit on gets pinned before an approval exists on it, and
the two effectful asks come last. Each block below is the decision set its card
must carry; none of them re-opens a question settled in this file.

Cards: S1 `t_d2d97be5`, S4 `t_c39bf6da`, S2 `t_f02bb238`, S3 `t_f0cfd22c` — each
gated on the one before it, so one worker owns this repo at a time.

**S1 — the channel and the refusals.** `apps/farcaster-web/src/components/miniApp/agentAskChannel.ts`
(a pure module: envelope validation, the one-shot ids, the 30 s dedupe, the
3-ask budget, the session mute, the sentences of §6, all testable with no
browser), wired into `MiniApp.tsx` with a real `window` listener pinned to the
iframe's `event.source` + origin; `fiddy.agent.ask` added to `getCapabilities`;
and the ~30-line app-facing shim an app author drops in (`public/fiddy-agent-ask.js`)
so a real app can exercise it. **It raises no UI and has no agent parity**: every
ask an app can send is answered honestly and in the order of §6 (`no_agent` when
nothing is paired, `unavailable` for a well-formed effectful ask, `invalid` for
anything outside §3.6, `budget` and `muted` for the app that earned them) and
nothing is spent — which is exactly the safety half landing before the effectful
half. Unit tests only; no browser probe required to call it done.

**S2 — the ask card, `draft`, and `post`.** The store
(`postingKeyApproval`'s shape: one decision in front of the reader, joins, five
minutes, honest end), the card of §4 rendered inside the mini app window as shell
chrome, the mute affordance, and the two effectful asks that end in the composer:
`draft` (one chat message → the draft in `ComposeCastModal`'s own route; the app
gets `drafted`) and `post` (the same composer, then the write seam, then the
existing posting-key approval if this device holds no key; the app gets `posted`
/ `unknown` / `failed` / `declined`, never a hash). Depends on S1 and S4 — it is
an approval surface, so the wire it sits on is pinned first.

**S3 — `remind`.** The third ask: the ask card's words, one chat message in
`AgentPage.tsx:545-548`'s own phrasing, the record in `lib/agentSchedules.ts`,
and `asked` back. Depends on S2 (the card and the store).

**S4 — pin the host's own wire.** The measured looseness in §7.5: stop exposing
the whole SDK to any origin, by wrapping the exposed object so every member is
gated on `event.source === iframe.contentWindow` + the frame's origin (or by
pinning `miniAppOrigin` to `new URL(url).origin` and adding the source check
where the endpoint is built), with tests proving a second frame's call is
refused and a real mini app's call still works. This is not the bridge, it is the
wire the bridge would otherwise inherit; it touches `MiniApp.tsx` and so must run
after the slices that touch the same file. Depends on S1.

---

## 9. What this file is not

- **Not implemented, by the card's own order.** No code, no card for "just add
  the listener".
- **Not a conformance change.** Nothing here is proposed to the mini app
  specification; the bridge is a Fiddy extension reached through its own
  envelope, and the spec's own docs say the message-passing format is
  unspecified anyway (§3.1).
- **Not a second agent surface.** Chat, scheduling, channels and lifecycle stay
  `docs/CLIENT-AGENT-SURFACE.md`'s; the bridge only adds three ways for a
  *foreign page* to place one of those requests, each behind the reader.
- **Not touching** `docs/CLIENT-PARITY.md` or `docs/CLIENT-MINIAPP-HOST-SPEC.md`
  (other cards own those rows), the in-feed card itself, the per-page unfurl
  cards (`t_1efd7e2e`), or the manifest tidy-up (`t_8654d91e`).

---

## 10. How this file's claims were checked

READ, in the worktree this file was written in (based on `origin/main` at
`c4cf85d`):

- `apps/farcaster-web/src/components/miniApp/MiniApp.tsx` — the host's members,
  `getCapabilities`, the `'*'` exposure, the 3-ask `addMiniApp` budget, the
  composer route, the window's own DOM.
- `apps/farcaster-web/src/snapchain/accounts/postingKeyApproval.ts` and
  `src/components/session/SignerApprovalGate.tsx` — the approval store and its
  screen, whose shape the bridge's store must copy.
- `apps/farcaster-web/src/lib/agentService.ts`,
  `src/pages/agent/AgentPage.tsx`, `src/components/agent/AgentRailPanel.tsx`,
  `src/hooks/agent/useAgentSession.ts`, `src/lib/agentSchedules.ts` — what an
  agent session is, what a chat message is, and what the client does *not* know
  about an agent's identity.
- `layouts/AuthedRightSideBar.tsx`, `components/MinimizableWindowHost.tsx`,
  `contexts/MiniAppProvider.tsx` — where the rail exists, where the window sits,
  and how a chained launch already asks.
- `src/snapchain/nodeApi/nodeCannotAnswer.ts`, `hostedRoutes.ts` — the
  refuse-by-name habit and the `501`/`502` semantics the bridge's `unknown`
  state borrows.
- `docs/CLIENT-MINIAPP-HOST-SPEC.md`, `docs/CLIENT-AGENT-SURFACE.md`,
  `docs/CLIENT-INLINE-APPROVAL.md`, `docs/CLIENT-MINIAPP-AUTOLOGIN.md` — the
  surface, the agent, the approval, and the mirror-image lesson about host
  context. (`docs/CLIENT-MINIAPP-FEED.md`, whose §4 is the mini app policy this
  file builds on, is written on branch `t_a3e3605b-miniapp-probe` and is **not on
  `main`** as of this doc — a loose end worth an operator's eye, since two
  committed docs now cite it.)
- `@farcaster/miniapp-host@0.3.0` (`dist/comlink/comlink.js`,
  `dist/iframe.js`, `dist/helpers/endpoint.js`, `dist/helpers/sdk.js`) and
  `@farcaster/miniapp-core@0.6.0` (`src/types.ts`) from the installed packages —
  the closed switch, the origin handling, and the host interface.

MEASURED: the specification page fetched 2026-10-22 (no agent action, and the
message-passing format described as unspecified).

NOT VERIFIED: nothing in this design has been run. The wire, the card, the
budget and the mute are requirements on code that does not exist yet, and the
browser behaviour of the pinned listenership (§7.5's second half) is a
requirement on S4 rather than a measurement of today's build.