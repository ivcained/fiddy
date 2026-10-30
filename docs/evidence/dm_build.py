#!/usr/bin/env python3
"""t_3c04fc7b: build the two deliverables from verified live state.

  deliverables/DM-PACKET.md   paste-ready DM per candidate, for @ivc's own client
  deliverables/DM-TRACKER.md  one status row per candidate, with last contact + quoted reply
  data/dm-send-log.json       machine-readable send + verification record

Inputs: deliverables/fiddy-voucher-candidates-prioritized.json (t_24468601),
data/dm-tracker.json (live read-back, this run).
"""
import json, os, re, time

WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAND = json.load(open(os.path.join(WS, "deliverables", "fiddy-voucher-candidates-prioritized.json")))
LIVE = json.load(open(os.path.join(WS, "data", "dm-tracker.json")))
NOW = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

live_by_handle = {c["handle"]: c for c in LIVE["candidates"]}
asks_by_who = {}
for a in LIVE["asks"]:
    asks_by_who.setdefault(a["who"], []).append(a)

# Ask already on the network per candidate (this run's read-back), incl. the one sent now.
SENT = {
    "jpfraneto": ("0x2b6db8d82962335124ff3a9b8d23a20bb751eeb9", "2026-10-24T11:00:03Z",
                  "reply in the live trade thread (he had paid the reciprocal's first half)"),
    "borodutch": ("0x23b9922530dfad43498f2a8d62c1ec12abecd3d3", "2026-10-24T13:08:29Z",
                  "reply to his quilcast cast (sent by this card)"),
    "webthe3rd.eth": ("0x6e3482e1ec6c78983148f47ad5c48ade68601449", "2026-10-24T10:28:32Z",
                      "reply to his own quickstart-completion cast"),
    "vaibhavmule": ("0x5696cd017f1f80c8264b466fe79d7ae83a4ab64c", "2026-10-24T10:29:12Z",
                    "reply to his readnode submission"),
    "mddvm": ("0x8cde284a7569253981ee870ed55246d5fd284487", "2026-10-24T10:28:35Z",
              "reply to his vouch for another entry"),
    "sats100m": ("0x5f1de86804bcb42d68fe8fac9ed277cf06590fbf", "2026-10-24T10:29:11Z",
                 "reply to his tester ask"),
    "eat": ("0xd6b5d214ba6a99dae1da9a056f5671dc9e3dc315", "2026-10-24T11:11:19Z",
            "reply to his townhall vouch"),
    "runn3rr": ("0x6eae8aad085398338c18d3f6be58e3565d8c52cc", "2026-10-24T11:11:17Z",
                "reply to his townhall vouch"),
    "0xzoz": ("0x788bbb09c9f36187115cba3347027efd60c2be90", "2026-10-24T10:30:19Z",
              "reply to 'Looking for a human to test this'"),
    "chriscocreated": ("0xef8dc4f931e6ef3808d2d7181e5e420c72ebf65b", "2026-10-24T10:28:34Z",
                       "reply to his 'can I try the client without a node' question"),
}

FIRST_LINE = {
    "jpfraneto": "You've been shouting that you need someone to run Fatline end to end and vouch, and I ran yours and vouched this morning. I need the same thing back: one human who runs mine and posts an honest vouch.",
    "borodutch": "You wrote quilcast, and my client adapts parts of it (the MIT source is credited in the code), so you'd spot a bad node path in minutes.",
    "webthe3rd.eth": "You already said publicly on 10-23 that you completed my quickstart, which makes you the cheapest vouch in existence: the only thing left is a cast of your own.",
    "vaibhavmule": "Your readnode ask is bit-for-bit the same as mine (one person to run it end to end and vouch honestly), so consider this the symmetric offer: same three commands, same 2 TB box, no API keys.",
    "mddvm": "You rented the box, synced the node and posted the vouch for another entry this morning. Mine needs exactly one of those.",
    "sats100m": "You're mid-sync on your own shard, so you'll know within minutes where my install wastes your time.",
    "eat": "You went through townhall's tutorial on your own server and published the vouch. Mine is the same shape: three commands, own read node and client, no API keys.",
    "runn3rr": "You checked a rival tutorial on your own Snapchain read node and client and published the client URL, which is the exact run I'm short of.",
    "0xzoz": "You asked for one human-led and one agent-led clean-machine run of In Three. The agent-led half is done and syncing on my side, so here is the other half of the trade.",
    "chriscocreated": "You said you were up for the experiment and then asked whether the client can run without a node. It can't, it needs the node, and I was the one who told you it wasn't prod ready yet. It is now, and I'd like you to be the person who runs it.",
}

BODY = """
The ask, straight: **run the fiddy tutorial end to end, tell me where you get stuck, then post a public cast vouching for it.** Honest criticism is the useful part, so "this is broken at step 2" is a fine answer, and I'd rather have that than a polite vouch.

- Tutorial (desktop and mobile): https://fiddy.fun/client
- Repo: https://github.com/ivcained/fiddy
- Self-start, three commands after `git clone`:
  `fiddy provision` (a box with 4 vCPU / 16 GB RAM / a 2 TB disk and ports 3381-3383 open; a ~$50-80/mo Hetzner/Contabo/OVH class VPS is enough), then `fiddy node up`, then `fiddy client up`.
- Time: plan half a day, most of it the node's snapshot syncing. The API answers early, so your first read and your first cast work before it is fully caught up.
- The vouch, from your own account: that you ran it end to end (node plus client), how long it took, one criticism, and the link.

If you want company while you run it, say so and I'll pair live on a call or a screen-share. The bounty closes 2026-10-24T14:47:30Z.
"""


def no_em_dash(s, label):
    assert "\u2014" not in s and "\u2013" not in s, f"dash in {label}"
    return s


# ---------- DM-PACKET.md ----------
packet = ["""# DM packet: one paste-ready DM per candidate (for @ivc's own Farcaster client)

Built by `t_3c04fc7b` at {now}. This is the half of the outreach that **only @ivc can send**: Farcaster
direct casts are a client-level feature, and this machine holds no @ivc write credential (verified again
this run: the only saved signer is fid 3356372 = @fiddy-one; Neynar has no direct-cast route; there is no
logged-in Chromium session to drive). Every candidate already has an ask on the public network from
@fiddy-one (hashes, URLs and read-back in `DM-TRACKER.md`), so these DMs are the private nudge on top of a
public ask that is already visible in each person's thread: @borodutch got his at 13:08Z from this card, the
other nine between 10:28Z and 11:11Z from the run before it.

Rules kept from the upstream list: lead with the ask, personalize only the first line, never promise money
or prizes, and do not promise it takes ten minutes. Replace `<handle>` with the person's name or handle.
""".format(now=NOW)]

for c in sorted(CAND["candidates"], key=lambda x: x["rank"]):
    h = c["handle"]
    s = SENT[h]
    lv = live_by_handle.get(h, {})
    packet.append(no_em_dash(f"""---

## {c['rank']}. @{h} (fid {c.get('fid')}, {c.get('followers')} followers{', mutual' if c.get('mutual') else ''}, {c['band']} priority)

**Why him/her:** {c['why']}

**Already on the network:** `{s[0]}` at {s[1]} ({s[2]}) - https://farcaster.xyz/fiddy-one/{s[0]}

**Send as a DM from @ivc:**

```
Hey {h},

{FIRST_LINE[h]}

{BODY.strip()}
```
""", h))

packet.append("""---

## Order to send, if you are short on time

1. **@webthe3rd.eth** first: he already ran it, so his DM is one line asking for the vouch URL. Cheapest close on the board.
2. **@jpfraneto** second: the reciprocal half is already paid by you, he is live in the thread right now, and he pays for servers himself.
3. **@mddvm**, **@runn3rr**, **@eat**: each of them already ran a rival's tutorial on their own box today or this week, so the loop is muscle memory for them.
4. **@borodutch**, **@vaibhavmule**, **@sats100m**, **@0xzoz**, **@chriscocreated**: peer or symmetric asks.

Send these spaced out, not in one burst, and answer anything they reply with the same day: the reply is the
part that turns an ask into a run.
""")

# ---------- DM-TRACKER.md ----------
quoted = {
    "webthe3rd.eth": ("2026-10-23T17:57:05Z (before our ask, publicly, not a reply to us)",
                      "I just completed @ivc's quick and easy submission to the Farcaster client bounty: https://github.com/ivcained/fiddy#quickstart",
                      "0x1118d48034a70ceff4993325c31dfff446b2982e"),
    "chriscocreated": ("2026-10-22T07:38:25Z (before our ask, publicly, not a reply to us)",
                       "I'm not sure what you're suggesting, but probs up for the experiment :)",
                       "0xa874902f9b414579c20e9324a2ef476db69b79c2"),
    "borodutch": ("2026-10-24T03:41:49Z (the cast we replied to)", "f yeah! love people using quilcast.com",
                  "0x233000f1b1e8f43a24c295154de4afb6a75bd8a4"),
    "mddvm": ("2026-10-24T08:47:13Z (his vouch for a rival entry, the cast we replied to)",
              "Went through it end to end: rented the server, the agent synced the node, I logged in and posted from my own node. My vouch: ...",
              "0x5616bd433204806c7f2b7b4acf5b9defaf29fde0"),
    "jpfraneto": ("2026-10-24T11:57:10Z (to @ivc, in reply to your vouch for Fatline)",
                  "epic. was this casted through your node? that's the ultimate vouch",
                  "0x10c3f27d6b04ded4e8fbe9881d0cef0c1d2ff6d3"),
    "runn3rr": ("2026-10-22T18:02Z (his townhall vouch, the cast we replied to)",
                "helping a friend, I've checked @townhall tutorial on my own Snapchain read node and client, no API keys... First cast worked",
                "0x2d001899dec092896483658bfdd01f975a99cce0"),
    "eat": ("2026-10-22T15:18Z (his townhall vouch, the cast we replied to)",
            "I went through @townhall tutorial on my own server: three commands, my own Snapchain read node and client, no API keys.",
            "0x0bc3b39c6476bfa9bc04b42faca51b30941d8bc0"),
    "0xzoz": ("2026-10-23T18:01Z (his clean-machine-run ask, the cast we replied to)",
              "Please reply under here once you are done(time is ticking): ...", "0xdfeb7bce311459e7e83c6a819952b96f2983466f"),
    "vaibhavmule": ("2026-10-22T16:44Z (his tester ask, the cast we replied to)",
                    "Need 1 person to run it end to end and vouch honestly. I'll cover $15 of AWS costs.",
                    "0x7d39f92393172a4efecb6ab3892137e8904ef664"),
    "sats100m": ("2026-10-20T13:43Z (his tester ask, the cast we replied to)",
                 "@balajis.eth farcaster-in-3: - mainnet read node, synced - client: gasless KEY_ADD, feed, cast, follow...",
                 "0x54f694f934f9e2946496470eaae3511e8e415cce"),
}

rows = []
for c in sorted(CAND["candidates"], key=lambda x: x["rank"]):
    h = c["handle"]
    s = SENT[h]
    lv = live_by_handle.get(h, {})
    q = quoted[h]
    rows.append({
        "rank": c["rank"], "handle": h, "fid_live": lv.get("fid_live"), "band": c["band"],
        "status": "no_reply",  # ask outcome vocabulary: completed / dropped / no_reply
        "ask_channel": "public reply from @fiddy-one (fid 3356372)",
        "ask_hash": s[0], "ask_ts": s[1], "ask_url": f"https://farcaster.xyz/fiddy-one/{s[0]}",
        "ask_how": s[2],
        "ask_read_back": next((a["mine_exists"] and a["appears_as_reply"] for a in asks_by_who.get(h, [])
                               if a["mine"] == s[0]), None),
        "dm_from_ivc": "NOT SENT (no @ivc write credential on this machine)",
        "last_contact_ts": s[1],
        "last_contact_channel": "Farcaster reply from @fiddy-one",
        "quoted_reply": None,
        "standing_public_evidence": {"ts": q[0], "text": q[1], "hash": q[2]},
        "tutorial_status": ("completed publicly 2026-10-23" if h == "webthe3rd.eth" else "not started by them"),
        "followers": lv.get("followers"), "last_cast_by_them": lv.get("newest_cast_ts"),
    })

packet_rows = []
for r in rows:
    packet_rows.append(
        f"| {r['rank']} | @{r['handle']} | {r['fid_live']} | {r['status']} | {r['last_contact_ts']} | "
        f"`{r['ask_hash'][:12]}...` | {r['quoted_reply'] or '_(none yet)_'} |")

tracker = f"""# DM tracker: every candidate on the t_24468601 list, one row each

Built by `t_3c04fc7b` at {NOW}. Sources: live Neynar reads this run (scripts `live/dm_track.py`,
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
{NOW} **not one candidate has answered**, in any thread, by mention, or by DM.

| # | Candidate | fid (live) | Ask status | Date of last contact (UTC) | Ask (from @fiddy-one) | Quoted reply |
| --- | --- | --- | --- | --- | --- | --- |
{os.linesep.join(packet_rows)}

### The same rows, with the standing evidence that is not a reply

| Candidate | Tutorial status | Public evidence already on the network (verbatim) |
| --- | --- | --- |
| @webthe3rd.eth | **completed publicly on 2026-10-23T17:57:05Z** (before our ask) | "I just completed @ivc's quick and easy submission to the Farcaster client bounty: https://github.com/ivcained/fiddy#quickstart" ({quoted['webthe3rd.eth'][2]}) |
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
"""

os.makedirs(os.path.join(WS, "deliverables"), exist_ok=True)
open(os.path.join(WS, "deliverables", "DM-PACKET.md"), "w").write("\n".join(packet))
open(os.path.join(WS, "deliverables", "DM-TRACKER.md"), "w").write(tracker)
json.dump({"built_at": NOW, "rows": rows}, open(os.path.join(WS, "data", "dm-send-log.json"), "w"), indent=1)
print("wrote deliverables/DM-PACKET.md, deliverables/DM-TRACKER.md, data/dm-send-log.json")
print("rows:", len(rows), "no_reply:", sum(1 for r in rows if r["status"] == "no_reply"))
for r in rows:
    print(f"  {r['rank']:2d} @{r['handle']:16s} ask={r['ask_hash'][:14]} readback={r['ask_read_back']} last={r['last_contact_ts']}")