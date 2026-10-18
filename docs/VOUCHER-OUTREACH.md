# Fiddy voucher outreach — verified candidate list and paste-ready asks

Written 2026-10-18T15:57Z by the recruit-and-onboard task (`t_7fff0bb5`).
Companion files: `docs/VOUCHER-CAMPAIGN.md` (campaign + submission plan), `docs/VOUCHER-FRICTION-LOG.md`
(where a voucher's blockers get recorded verbatim).

**Status: the candidate list is built from live network data and the asks are ready to paste. Nothing has been
sent, because no Farcaster write credential exists on this machine — the DMs and the cast have to go out from
@ivc (fid 191554).** One owner action unblocks the whole card.

## 1. Channel status (checked 2026-10-18, not assumed)

| Check | Result | How |
| --- | --- | --- |
| Farcaster write credentials on this machine | **none** | `~/.hermes/.env` has no `FARCASTER_*`/`NEYNAR_*` key; `grep -ci neynar /etc/fiddy-auth/app.env` on the VPS = 0 |
| Can we read the network? | **yes, unauthenticated** | public hub `https://haatz.quilibrium.com` answers `/v1/castsByFid`, `/v1/castsByParent`, `/v1/linksByFid`, `/v1/userDataByFid`; `api.warpcast.com/v2/user?fid=` also answers without a token (`/v2/recent-casts` needs auth, 401) |
| Owner identity used for targeting | **@ivc, fid 191554** | Warpcast API: followerCount 1402, followingCount 429; profile URL `github.com/ivcained` |
| Recruitment cast already posted? | **no** | read @ivc's last 50 casts — the only Fiddy cast is the Network Court early-list one |

Consequence: recruiting is an owner action (DM from the Farcaster client, or one public cast). Everything else —
targeting, copy, prerequisites, the honest cost numbers, the friction capture — is done and in this repo.

## 2. Candidate list — who, ranked, and why them

Built from: the 37 replies to the bounty cast (`farcaster.xyz/balajis.eth/0x50184b62`), the 429 accounts @ivc
follows, the 2 805 follow links pointing at @ivc, plus last-cast recency and follower counts for each candidate.
Scores, bios, last-cast text and dates are in the task's `candidates_enriched.json` attachment.

**Tier A — other bounty submitters who are also hunting a voucher (mutual-vouch trade).** Each of these has
already said in public that they need someone to run and vouch for their submission, and each is already running
a node. Highest conversion of any group: the ask is symmetric.

| Handle | fid | followers | last cast | Why them |
| --- | --- | --- | --- | --- |
| @mobeen02 | 440212 | 2 428 | today | posted a submission and publicly asked for a voucher (`Need a voucher for Balaji's $2048…`, 10-17) |
| @vaibhavmule | 1356870 | 3 318 | 1 d | "I'm in. 3 commands, my own read node, no API keys. Looking for a builder to test it and vouch. Who's up?" |
| @webthe3rd.eth | 374565 | 220 | today | "Any devs willing to test and vouch for it later this week?" — actively soliciting |
| @sats100m | 3355244 | 0 | today | posting progress on `farcaster-in-3`: "shard 0 of my node was 570 days behind" — node is up |
| @0xzoz | 1918 | 13 134 | today | submission "In Three"; also engaged in the thread |
| @10xchris.eth | 1129138 | 1 373 | today | ran a Farcaster-client bounty last month, cost-modelled this one (A$103/mo) — will judge the tutorial on the numbers |

Caveat to state honestly when asking: their vouch counts less than an independent one, and a judge may read a
ring of mutual vouches as noise. Ask them to vouch only if the tutorial actually worked, and ask them to name
one thing that broke.

**Tier B — warm accounts @ivc follows, capable of running the box, no bounty conflict.** These are the vouches a
judge will weight most.

| Handle | fid | followers | last cast | Why them |
| --- | --- | --- | --- | --- |
| @manan | 191 | 38 281 | 2.7 d | "Building (and sometimes breaking) farcaster" — will read the protocol claims critically |
| @darrylyeo | 3854 | 7 894 | today | dev, `/frontend` + decentralized-data wrangler, replied in the bounty thread |
| @borodutch | 1356 | 38 398 | 0.7 d | "sr staff agentic engineer" — runs infra for a living |
| @mvr | 230238 | 11 864 | 0.2 d | builds a Farcaster client (Vibeshift); thread comment shows he knows the read-node write path |
| @macbudkowski | 1048 | 29 544 | 2.2 d | miniapp builder who writes a newsletter — a vouch with reach |
| @jvaleska.eth | 13505 | 16 581 | 0.1 d | Ethereum dev, "Farcaster Framer" |
| @linda | 12 | 87 946 | 1.6 d | previously dev-eco at Farcaster — heaviest credibility, lowest availability |

**Tier C — thread participants who showed node curiosity.**

| Handle | fid | followers | last cast | Why them |
| --- | --- | --- | --- | --- |
| @vaipraonde | 847902 | 155 | 0.7 d | "a client is super easy. a node is not. we would like to setup a NODE." |
| @cashlessman.eth | 268438 | 10 303 | 0.4 d | dev, "open for opportunities", "will see if i can do this" |
| @nashrad | 3326491 | 1 | today | "I'm a crypto/farcaster noob. But I'm attempting this" + "My first cast on a local node" — highest doc-value vouch, highest risk of stalling |
| @bugster | 3332919 | 21 | 0.4 d | playful, replied to the bounty with a node joke, follows the bounty closely |

Send 8–10 of these, not one. Ask for a run, not for kind words.

## 3. DM copy (paste, then replace the bracketed first line)

**Variant A — Tier B/C (the straight ask).**

```
[per-person line, see below]

I wrote Fiddy — a Farcaster client + Snapchain read node that you stand up on your own box. Microsite:
https://fiddy.fun/client, repo: https://github.com/ivcained/fiddy

The honest ask: run it end to end and say publicly whether it worked. What it needs: a VPS with 4 vCPU / 16 GB
RAM / 2 TB free disk and ports 3381-3383 open on TCP and UDP, a test account's seed phrase (not your main), and
about half a day where most of it is the node syncing (~200 GB snapshot). No API keys, nothing created onchain,
no cost to you beyond the box.

If you hit anything broken I want the exact error — I'll fix it and log it. If it works, the vouch is just your
honest review plus the link.
```

**Variant B — Tier A (mutual vouch).**

```
You're asking for a voucher and so am I — want to trade?

I'll run your tutorial this week and post an honest cast about it; you run mine (https://fiddy.fun/client) and do
the same. Mine needs a box with 4 vCPU / 16 GB RAM / 2 TB free disk, ports 3381-3383 open, and a test account's
seed phrase. Same shape as yours.

Deal only if you actually complete it — and say what broke, in public. That's worth more than a compliment.
```

**Variant C — one line per person to paste at the top of A or B.**

- @manan — "you break farcaster professionally, so you'll catch whatever's wrong with my read-node claims"
- @darrylyeo — "you replied in balajis's thread and you actually read protocol code"
- @borodutch — "you already run agent infra; this is one box and three commands"
- @mvr — "your point in the thread about clients reading from a Snapchain node is exactly what the tutorial implements"
- @macbudkowski — "you write up what you build, which is what I'm asking for"
- @jvaleska.eth — "you build on Ethereum and 3381-3383 is the whole ops surface here"
- @linda — "you ran dev eco at Farcaster, so your read of this is the one I'd trust most"
- @vaipraonde — "you said a node is the hard part — I want you to be the one who says whether it still is"
- @cashlessman.eth — "you said you'd see if you could do this; that's all I'm asking for"

Do **not** promise prizes, money, or that it takes ten minutes.

## 4. One action instead of ten: the public ask cast

Post from @ivc. This doubles as marketing for the tutorial and reaches @ivc's 1 402 followers.

```
Three commands to your own Farcaster client on your own read node:

  fiddy provision   # your compute (AWS scripted, or any VPS over SSH)
  fiddy node up     # Snapchain read node, no API keys from anyone
  fiddy client up   # client reading YOUR node

https://fiddy.fun/client — full tutorial, mobile + desktop, protocol concepts explained as you go.

Looking for one person who'll actually run it end to end and say publicly whether it worked. Reply here or DM me.
```

## 5. Optional public channel you already own: a repo issue

`gh` is authenticated as `ivcained`, so this is a one-liner once you approve the text:

```
gh issue create --repo ivcained/fiddy --title "Looking for one person to run the tutorial end to end and vouch publicly" --body "<the cast text above + prerequisites section 4 of VOUCHER-CAMPAIGN.md>"
```

It costs nothing and leaves a permanent, linkable recruiting post.

## 6. Decision needed from the owner

1. **Send the DMs** (Tier A + Tier B first, 8–10 people) or **post the ask cast** — or both.
2. **May the ask offer to cover the voucher's VPS?** This is the single biggest conversion lever: the tutorial's
   real prerequisite is a 2 TB disk (≈ $50–80/mo on Hetzner/Contabo/OVH class hosts, ≈ $285/mo on AWS). Offering
   it is a money decision, so it is not in the copy above; say the word and the copy gets one line.
3. **Who casts the vouch is the voucher's account, not @ivc** — nothing to decide, just do not accept a vouch
   posted from the owner's account.

## 7. Outreach outcome log

Every candidate above is logged here with an outcome, so nobody has to re-derive who was asked or what happened.
Update this table as replies land. It is the evidence for the card's "outreach outcome for every candidate
recorded" criterion.

| Handle | tier | channel | asked (UTC) | outcome | note |
| --- | --- | --- | --- | --- | --- |
| @mobeen02 | A | Farcaster DM | not yet | not_contacted | |
| @vaibhavmule | A | Farcaster DM | not yet | not_contacted | |
| @webthe3rd.eth | A | Farcaster DM | not yet | not_contacted | |
| @sats100m | A | Farcaster DM | not yet | not_contacted | |
| @0xzoz | A | Farcaster DM | not yet | not_contacted | |
| @10xchris.eth | A | Farcaster DM | not yet | not_contacted | |
| @manan | B | Farcaster DM | not yet | not_contacted | |
| @darrylyeo | B | Farcaster DM | not yet | not_contacted | |
| @borodutch | B | Farcaster DM | not yet | not_contacted | |
| @mvr | B | Farcaster DM | not yet | not_contacted | |
| @macbudkowski | B | Farcaster DM | not yet | not_contacted | |
| @jvaleska.eth | B | Farcaster DM | not yet | not_contacted | |
| @linda | B | Farcaster DM | not yet | not_contacted | |
| @vaipraonde | C | Farcaster DM | not yet | not_contacted | |
| @cashlessman.eth | C | Farcaster DM | not yet | not_contacted | |
| @nashrad | C | Farcaster DM | not yet | not_contacted | |
| @bugster | C | Farcaster DM | not yet | not_contacted | |

Outcome vocabulary: `not_contacted` → `asked` → `running` → `completed` (with the cast URL) / `dropped` (with the
step they died on) / `no_reply` (after 48 h). A `dropped` row must name the friction-log entry it produced.

## 8. While they run it

Record blockers in `docs/VOUCHER-FRICTION-LOG.md` as they happen — exact command, exact output, time stuck. That
file is what the fix task consumes; it must never need a follow-up interview.