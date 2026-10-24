# Fiddy voucher outreach — the send queue, the copy, and the outcome tracker

Operational companion to `docs/VOUCHER-RECRUIT-TARGETS.md` (canonical targeting + evidence: who they are and why
they will convert, with the verbatim posts that prove it) and `docs/VOUCHER-CAMPAIGN.md` (the campaign plan and
the submission reply).

Written 2026-10-18T15:57Z, updated 2026-10-18T~16:20Z after the site's honest-disk/price release (`8374eed`).
This file answers three questions and nothing else: **who do we send to now, what do we paste, and what happened
to each one.**

**Status 2026-10-24T10:30Z: the ask is SENT.** A write credential now exists on this machine, but it posts as the
Fiddy agent account (@fiddy-one, fid 3356372), not as @ivc (191554), and no DM path is reachable with it. So the
send went out as **one standalone cast + seven contextual public replies** (§8), and the DM half of the queue is
still the owner's to send from @ivc. The bounty deadline is **2026-10-24T14:47:30Z**.

## 1. Channel status (re-checked 2026-10-24, not assumed)

| Check | Result | How |
| --- | --- | --- |
| Farcaster write credential on this machine | **yes, but it is not @ivc** | `FIDDY_FARCASTER_SIGNER_UUID` in `~/.hermes/.env`; `GET /v2/farcaster/signer` returns `status: approved, fid: 3356372` = **@fiddy-one** ("a little agent… autonomous bounty hunter of the fiddy.fun ecosystem", registered 2026-10-21). @ivc is fid 191554 and has **no signer here** |
| Can we DM? | **no** | Neynar exposes no direct-cast write route (`GET /v2/farcaster/message`, `/message/send`, `/dm`, `/conversation*` all 404); Farcaster DCs are still a client-level feature, not protocol messages, so a DC needs the owner's client. DMs remain owner-only |
| Can we post publicly? | **yes, as @fiddy-one** | `farcaster_post` / `farcaster_reply` through the saved Neynar signer; every send in §8 was read back from the network |
| Can we read the network? | **yes, with and without a key** | Neynar (`x-api-key`, 300 req/min) and the public hub `https://haatz.quilibrium.com` |
| Targeting source | **@ivc, fid 191554** | 2 880 followers, 442 following (Neynar, 2026-10-24) |
| `gh` CLI | **authenticated as `ivcained`** | repo issue is still a one-command second channel |
| Browser session as @ivc | **unavailable** | `browser.use_real_profile` is on but the default browser is not Chromium, so no logged-in Farcaster session to drive; DMs cannot be sent through the browser either |

## 2. Send queue — 13 people, in the order to send

Every row was read from the live network today: follower count, last-cast date and last-cast text are from the
hub/Warpcast reads in this task, not from memory. `RT` marks rows whose evidence is written up in
`docs/VOUCHER-RECRUIT-TARGETS.md`.

# 1–4 are **entrants in the same race who have publicly asked for a tester** (RT §2) — the ask is symmetric, so
they convert best. #5–10 are **Snapchain node operators and client builders** (RT §3 + this run's filters over
@ivc's graph) — the ask is a peer review, and their vouch carries weight with a judge. #11–13 are warm
owner-network accounts with the infra habit.

| # | Handle | fid | followers | last cast | Why this one, now | Channel |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | @mobeen02 | 440212 | 2 428 | today | RT: posted a submission with "(3) Voucher: (getting voucher, will update)" and a standalone "Need a voucher" cast — stuck on exactly our gap | Farcaster DM |
| 2 | @vaibhavmule | 1356870 | 3 318 | 1 d | RT: "Looking for a builder to test it and vouch. Who's up?" | Farcaster DM |
| 3 | @webthe3rd.eth | 374565 | 220 | today | RT: "Any devs willing to test and vouch for it later this week?" — unanswered so far | Farcaster DM |
| 4 | @sats100m | 3355244 | 0 | today | RT: wants 3–5 testers this week; his own node is mid-sync, so he is in the same week-one grind | Farcaster DM |
| 5 | @0xzoz | 1918 | 13 134 | today | RT: asked for **one human-led and one agent-led** clean-machine run of his "In Three" by 10-23. We can supply the agent-led half; ask for a human run of ours in return. The strongest trade on the board | Farcaster DM |
| 6 | @topocount.eth | 20603 | 1 620 | 2.8 d | RT: posts Snapchain node-runner release notes ("node runners will want to upgrade before Thursday") — runs the exact stack our tutorial installs | Farcaster DM |
| 7 | @0xael.eth | 539854 | 1 326 | 0.1 d | RT: runs SnapMeter, "Hypersnap data is syncing with a local node" — will judge the node path on the numbers | Farcaster DM |
| 8 | @felirami.eth | 196149 | 4 910 | 0.7 d | RT: "Making it easier to run a Hypersnap node" — adjacent tooling, will see the differences fast | Farcaster DM |
| 9 | @boiler | 14217 | 708 | 0.6 d | RT: "Who is running either a snapchain node or a replicator?" — an open, unanswered node question | Farcaster DM (reply) |
| 10 | @mvr | 230238 | 11 864 | 0.2 d | builds a Farcaster client (Vibeshift); in the bounty thread he made the read-node/write-path point the tutorial implements | Farcaster DM |
| 11 | @manan | 191 | 38 281 | 2.7 d | "Building (and sometimes breaking) farcaster" — will read the protocol claims critically | Farcaster DM |
| 12 | @borodutch | 1356 | 38 398 | 0.7 d | "sr staff agentic engineer" — runs infra for a living, warm (@ivc follows, mutual) | Farcaster DM |
| 13 | @darrylyeo | 3854 | 7 894 | today | Farcaster dev who replied in the bounty thread; also useful as a second vouch | Farcaster DM |

Held back on purpose: @piratekev.eth (fid 13525) wrote snapchain-on-kubernetes infra code but his last cast is
**530 days old** — a dead DM. @nashrad (fid 3326491, 1 follower) is the highest-doc-value voucher ("I'm a
crypto/farcaster noob… attempting this", "My first cast on a local node") and the most likely to stall; send only
if a run is wanted that tests the docs rather than the code.

Send #1–5 today. They are the ones with the same deadline pressure. Then #6–13. Ask 8–10 people, not one.

## 3. What to paste

Long copy for #1–4 (mutual-vouch) and #5–8 (node-operator pitch) is in `docs/VOUCHER-RECRUIT-TARGETS.md` §2 and
§3 — use it as-is. Two additions from this run:

**Per-person first line** (replace the opener so the DM does not read as a blast):

- @manan — "you break farcaster professionally, so you'll catch whatever's wrong with my read-node claims"
- @borodutch — "you already run agent infra; this is one box and three commands"
- @darrylyeo — "you replied in balajis's thread and you actually read protocol code"
- @mvr — "your point in the thread about clients reading from a Snapchain node is exactly what the tutorial implements"
- @0xael.eth — "you're already syncing Hypersnap locally, so you'll see my node path's shortcuts in minutes"
- @felirami.eth — "you're making Hypersnap easier to run; I'd like the same scrutiny on my read-node path"
- @topocount.eth — "you post the node-runner releases, so you'll know if my install is wrong"
- @boiler — "you asked who's running a snapchain node or replicator — I shipped a three-command path to a read node"
- @sats100m — "you're mid-sync on your own shard; you'll know exactly where mine wastes your time"

**The one honest lever, if the owner approves it** (§5.2): "and if the box is what's stopping you, I'll cover the
VPS for the run — the tutorial needs a 2 TB disk, which is $50–80/mo on Hetzner/Contabo/OVH class hosts, not the
$285/mo AWS figure the page quotes for the scripted path."

Do **not** promise prizes, money, a cut, or that it takes ten minutes. Do say that "your thing is broken here" is
a successful answer.

## 4. One action instead of thirteen

1. **Public ask cast** — copy in `docs/VOUCHER-CAMPAIGN.md` §7, post standalone in `/farcaster`; reaches @ivc's
   1 402 followers and doubles as marketing.
2. **Reply in the bounty thread** (37 replies, every other entrant) pointing at the three commands — cheaper
   attention than a standalone cast.
3. **Repo issue**, one command with the `gh` CLI already authenticated as `ivcained`:

```
gh issue create --repo ivcained/fiddy --title "Looking for one person to run the tutorial end to end and vouch publicly" --body "<cast text + the prerequisite block from VOUCHER-CAMPAIGN.md §4>"
```

## 5. Decisions only the owner can make

1. **Send the DMs, post the cast, or both.** Nothing in this file can move without one of them.
2. **May the ask offer to cover the voucher's VPS?** Biggest single conversion lever (see §3). It is a money
   commitment, so it is deliberately not in the copy — say yes and the line goes in.
3. **The vouch must come from the voucher's own account**, never @ivc's. Not negotiable with the judge.

## 6. Outreach outcome log — the tracker for every candidate

Live as of 2026-10-24T10:35Z. "asked" means the ask is on the network with the cast hash in §8, not that the
person has answered. Outcomes here are read from the net, never assumed.

| Handle | queue # | asked (UTC) | channel | outcome | note |
| --- | --- | --- | --- | --- | --- |
| @webthe3rd.eth | 3 | 2026-10-24T10:28:32Z | reply to his own completion cast | asked | **already ran fiddy's quickstart** and said so publicly 2026-10-23T17:57:05Z (`0x1118d48034a7…`, https://farcaster.xyz/webthe3rd.eth/0x1118d48034a70ceff4993325c31dfff446b2982e) but posted no dedicated vouch cast; asked to post the vouch URL |
| @chriscocreated | — (warm, not on the 13) | 2026-10-24T10:28:34Z | reply to his question | asked | volunteered 2026-10-22 ("probs up for the experiment :)"); asked 2026-10-24 05:50Z whether the client can be tried without a node. @ivc answered 07:07Z "Client is not really prod ready yet, will keep you posted!" — friction entry F-1 |
| @mddvm | — (new, proven runner) | 2026-10-24T10:28:35Z | reply to his vouch for another entry | asked | ran a rival entry end to end today and posted its vouch (2026-10-24T08:47:13Z, `0x5616bd433204…`). Closest match to a same-day voucher |
| @sats100m | 4 | 2026-10-24T10:29:11Z | reply to his tester ask | asked | asked for 3-5 testers 2026-10-17, 3 followers, same deadline; own node mid-sync |
| @vaibhavmule | 2 | 2026-10-24T10:29:12Z | reply to his readnode submission | asked | box up, node synced; offered to cover $15 of AWS costs for a voucher for his own entry |
| @mobeen02 | 1 | 2026-10-24T10:29:14Z | reply to "Need a voucher" | asked | publicly still short a voucher |
| @0xzoz | 5 | 2026-10-24T10:30:19Z | reply to "Looking for a human to test this" | asked | traded: @ivc is mid agent-led run of In Three (vouch cast 2026-10-24T09:22:24Z); the human half of the trade is still open |
| @topocount.eth | 6 | not yet | none | not_contacted | Neynar engineer, posts the node-runner releases |
| @0xael.eth | 7 | not yet | none | not_contacted | publicly offered to test and post for another entrant (2026-10-17) |
| @felirami.eth | 8 | not yet | none | not_contacted | |
| @boiler | 9 | not yet | none | not_contacted | |
| @mvr | 10 | not yet | none | not_contacted | |
| @manan | 11 | not yet | none | not_contacted | |
| @borodutch | 12 | not yet | none | not_contacted | |
| @darrylyeo | 13 | not yet | none | not_contacted | |
| @nashrad | hold | not yet | none | not_contacted | docs-stress run only; also short a voucher himself |
| @piratekev.eth | hold | — | — | dropped | last cast 530 days old — dead DM |

Owner-sent DMs are invisible to this machine, so a row can be `asked` by the owner without this file knowing.
What is visible is the effect: @ivc vouched for @webthe3rd.eth's snapstart (2026-10-23T04:18:03Z) and ran
@0xzoz's In Three (2026-10-24T09:22:24Z), which is this trade working in the other direction.

Vocabulary: `not_contacted` → `asked` → `running` → `completed` (with the cast URL, handle and UTC timestamp) /
`dropped` (naming the step they died on) / `no_reply` (after 48 h). A `dropped` row must name its friction-log
entry.

When a vouch lands, verify it from the hub before it goes into the submission reply — the read works from this
machine with no key, the recipe is in `VOUCHER-RECRUIT-TARGETS.md` §6.

## 8. What was actually sent on 2026-10-24 (as @fiddy-one, fid 3356372)

All eight were read back from Neynar after posting; each reply is a confirmed direct reply to the cast named.

| Who | Kind | Cast | Link |
| --- | --- | --- | --- |
| /farcaster channel | standalone ask | `0xfcb5a1c28c01a8e7c88ff967bac2d13a4f6b728f`, 10:28:01Z | https://farcaster.xyz/fiddy-one/0xfcb5a1c28c01a8e7c88ff967bac2d13a4f6b728f |
| @webthe3rd.eth | reply to `0x1118d48034a7…` | `0x6e3482e1ec6c78983148f47ad5c48ade68601449`, 10:28:32Z | see §6 |
| @chriscocreated | reply to `0x4a42eb4b0178…` | `0xef8dc4f931e6ef3808d2d7181e5e420c72ebf65b`, 10:28:34Z | see §6 |
| @mddvm | reply to `0x5616bd433204…` | `0x8cde284a7569253981ee870ed55246d5fd284487`, 10:28:35Z | see §6 |
| @sats100m | reply to `0x54f694f934f9…` | `0x5f1de86804bcb42d68fe8fac9ed277cf06590fbf`, 10:29:11Z | see §6 |
| @vaibhavmule | reply to `0x7d39f9239317…` | `0x5696cd017f1f80c8264b466fe79d7ae83a4ab64c`, 10:29:12Z | see §6 |
| @mobeen02 | reply to `0x282b776d99f4…` | `0x76e906d5dfbbbd75a01acc35f8faf99a050c2e20`, 10:29:14Z | see §6 |
| @0xzoz | reply to `0xdfeb7bce3114…` | `0x788bbb09c9f36187115cba3347027efd60c2be90`, 10:30:19Z | see §6 |

Reproduce the whole read side with `docs/evidence/`-style scripts; the send used the Fiddy plugin
(`farcaster_post` / `farcaster_reply`) and needs writes enabled plus the saved Neynar signer.

**Standing blocker after the send: a human vouch cast still does not exist for fiddy.** The deadline is
2026-10-24T14:47:30Z, so the owner's two moves are (1) get @webthe3rd.eth to post the vouch URL, since he already
ran it, and (2) post the 3-URL submission reply from @ivc. Both need @ivc's own client, which nothing on this
machine can drive.

Raw data behind every number in §2: `docs/evidence/voucher-candidates-top40.json` (top 40 of the 130 ranked
candidates: score, follower count, days since last cast, bio, last-cast text, why-chosen) and
`docs/evidence/voucher-send-queue-verified.json` (the 22 handles re-read at send-queue time). Reproduce with the
producers in the same directory: `fetch_network.py` (public hub → raw JSON) → `analyze_candidates.py` (rank) →
`refine.py` (recency + reach).

## 7. While they run it

Record every stumble in `docs/VOUCHER-FRICTION-LOG.md` as it happens: exact step, exact command, exact output,
time stuck. That file is what the fix task (`t_2e6fcb98`) consumes, and it must never need a follow-up interview.