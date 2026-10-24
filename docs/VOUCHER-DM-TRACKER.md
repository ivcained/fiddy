# DM tracker: every candidate on the t_24468601 list, one row each

Built by `t_3c04fc7b` at 2026-10-24T13:17:51Z. Sources: live Neynar reads this run (scripts `live/dm_track.py`,
`live/dm_verify.py`), the send record from `t_7fff0bb5` (`wt/docs/VOUCHER-OUTREACH.md` section 8), and the
candidate list from `t_24468601`. Nothing in the table is recalled; every hash was fetched back.

## The channel truth first, because it decides the shape of the deliverable

| Question | Answer, verified this run |
| --- | --- |
| Can this machine send a DM as @ivc (fid 191554)? | **No.** The only saved signer is `61290252-...`, which `GET /v2/farcaster/signer` reports as `status: approved, fid: 3356372`, i.e. **@fiddy-one**, a 1-follower agent account. No @ivc signer exists here. |
| Does Neynar expose a direct-cast write route? | **No.** `/v2/farcaster/message`, `/v2/farcaster/dm/*`, `/v2/farcaster/direct_cast` all 404 with the saved key. |
| Is there a logged-in Farcaster session to drive in a browser? | **No.** `browser.use_real_profile` is on but the default browser is not Chromium, so the browser session is fresh and `farcaster.xyz` shows the logged-out landing page. |
| So what did this card send? | One ask per candidate, as a **public reply from @fiddy-one**, each read back from the network and confirmed to appear in the target cast's thread. That is the only write path that exists here. The DM half is @ivc's own action: the paste-ready copy is `DM-PACKET.md`. |

## Status table (one row per candidate)

Status vocabulary is the card's: `completed` / `dropped` / `no_reply`. Every row is `no_reply`: as of
2026-10-24T13:17:51Z **not one candidate has answered**, in any thread, by mention, or by DM.

| # | Candidate | fid (live) | Ask status | Date of last contact (UTC) | Ask (from @fiddy-one) | Quoted reply |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | @jpfraneto | 16098 | no_reply | 2026-10-24T11:00:03Z | `0x2b6db8d829...` | _(none yet)_ |
| 2 | @borodutch | 1356 | no_reply | 2026-10-24T13:08:29Z | `0x23b9922530...` | _(none yet)_ |
| 3 | @webthe3rd.eth | 374565 | no_reply | 2026-10-24T10:28:32Z | `0x6e3482e1ec...` | _(none yet)_ |
| 4 | @vaibhavmule | 1356870 | no_reply | 2026-10-24T10:29:12Z | `0x5696cd017f...` | _(none yet)_ |
| 5 | @mddvm | 2611706 | no_reply | 2026-10-24T10:28:35Z | `0x8cde284a75...` | _(none yet)_ |
| 6 | @sats100m | 3355244 | no_reply | 2026-10-24T10:29:11Z | `0x5f1de86804...` | _(none yet)_ |
| 7 | @eat | 18850 | no_reply | 2026-10-24T11:11:19Z | `0xd6b5d214ba...` | _(none yet)_ |
| 8 | @runn3rr | 18763 | no_reply | 2026-10-24T11:11:17Z | `0x6eae8aad08...` | _(none yet)_ |
| 9 | @0xzoz | 1918 | no_reply | 2026-10-24T10:30:19Z | `0x788bbb09c9...` | _(none yet)_ |
| 10 | @chriscocreated | 5701 | no_reply | 2026-10-24T10:28:34Z | `0xef8dc4f931...` | _(none yet)_ |

### The same rows, with the standing evidence that is not a reply

| Candidate | Tutorial status | Public evidence already on the network (verbatim) |
| --- | --- | --- |
| @webthe3rd.eth | **completed publicly on 2026-10-23T17:57:05Z** (before our ask) | "I just completed @ivc's quick and easy submission to the Farcaster client bounty: https://github.com/ivcained/fiddy#quickstart" (0x1118d48034a70ceff4993325c31dfff446b2982e) |
| @chriscocreated | not started; publicly volunteered | "probs up for the experiment :)" (2026-10-22) |
| @mddvm | ran a **rival** entry end to end today | "Went through it end to end: rented the server, the agent synced the node, I logged in and posted from my own node." (2026-10-24T08:47:13Z) |
| @runn3rr | ran a **rival** tutorial on his own node | "I've checked @townhall tutorial on my own Snapchain read node and client, no API keys... First cast worked" (2026-10-22T18:02Z) |
| @eat | ran a **rival** tutorial on his own server | "I went through @townhall tutorial on my own server: three commands, my own Snapchain read node and client, no API keys." (2026-10-22T15:18Z) |
| @jpfraneto | asked us for a run; we ran and vouched his Fatline 2026-10-24T11:52:35Z | "epic. was this casted through your node? that's the ultimate vouch" (2026-10-24T11:57:10Z) |

## Acceptance criteria for `t_3c04fc7b`, honestly

| Criterion | State |
| --- | --- |
| a DM sent to every candidate on the list | **Unmet as a DM.** All 10 have an ask on the public network from @fiddy-one (10/10 verified, hashes above). A DM from @ivc is impossible from this machine and is the owner's one action; copy is ready in `DM-PACKET.md`. |
| a status row per candidate (completed / dropped / no reply) in the shared note | **Met.** The table above, plus `data/dm-send-log.json` and this card's comment. |
| at least one candidate has agreed to attempt the tutorial | **No post-ask reply yet.** The closest standing evidence: @webthe3rd.eth publicly completed the quickstart on 2026-10-23 and @chriscocreated publicly volunteered on 2026-10-22. Neither has answered the ask. |

## How to re-verify in one command

```
python3 live/dm_track.py     # profiles, every ask read back, replies under each ask, both inboxes, fiddy search
python3 live/dm_verify.py    # re-read just the 10 asks and print any reply that is not from fid 3356372
```

## What a reply means for the pipeline

Any candidate who replies turns into `t_dc39421f` (onboard end to end, record every stumble verbatim).
The pairing script a "yes" needs is `wt/docs/VOUCHER-START-KIT.md` section 1, and the friction log it feeds
is `wt/docs/VOUCHER-FRICTION-LOG.md` section 3.
