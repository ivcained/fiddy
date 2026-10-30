# Fiddy voucher friction log

The single place a voucher's blockers get written down. **One consumer:** the fix task (`t_2e6fcb98`), which must
be able to fix every entry here without interviewing anyone again.

Rule: an entry is worth nothing if it paraphrases. Copy the command and the output exactly as they appeared.

## 1. How entries get in here

Two intakes; the voucher never fills in a form.

1. **Live pairing** (screen-share, call, or a DM thread while they run it): whoever is with them pastes the
   terminal output into the template below, immediately — not from memory afterwards.
2. **Self-report DM.** Send the voucher this block once at the start and ask for it back when they stop:

```
When something breaks, send me back these six lines and nothing else:
1. step: provision / node up / client up / first read / first post
2. the exact command you ran (copy-paste, whole line)
3. the exact output or error (copy-paste, including the few lines above it)
4. what you had already done in that step (e.g. "ran it once before", "changed the disk size")
5. how long you were stuck before you asked
6. what you tried before asking
```

Also capture the environment once, per voucher, not per entry: OS, host/provider, vCPU/RAM/disk, region, and
whether the box was fresh.

## 2. Entry template

```
### F-<n> — <one-line symptom, in the voucher's words>
- step: <0 prereqs | 1 provision | 2 node up | 3 client up | 4 first read | 5 first post>
- voucher: @<handle> (fid <n>)   reporter: <agent | owner>   date: <YYYY-MM-DDTHH:MMZ>
- environment: <OS, host, vCPU/RAM/disk, region, fresh or reused>
- command: `<exact command, verbatim>`
- output: `<exact output/error, verbatim, including the line before it>`
- time_to_symptom: <how long after starting the step this appeared>
- time_to_unblock: <how long the voucher was stuck>
- workaround: <exact steps that got them past it, or "none — run stopped here">
- severity: P0 <run stopped> | P1 <cost >15 min, or produced a wrong result> | P2 <annoying> | P3 <cosmetic>
- status: open | fixed <commit> | verified-by-voucher <date>
```

Severity is about the voucher's run, not about how hard the fix is. A wrong `200 GB` disk number is P0 for the
voucher even though it is a one-line fix.

## 3. Live entries

Populated 2026-10-24 with entries that are verbatim-quoted from the network, not paraphrased. These three are
**campaign-side** blockers (they stopped the recruitment, not a voucher's run); the first **run-side** entry
still waits on a voucher's own terminal output.


| # | date | voucher | step | command | exact output | stuck | severity | status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F-1 | 2026-10-24 | @chriscocreated (fid 5701, 66k followers) | 3 client up | *none: he asked before starting* | "can I try the client without setting up a node etc?" (2026-10-24T05:50:13Z, `0x4a42eb4b0178…`); answered 2026-10-24T07:07:21Z by @ivc with "Client is not really prod ready yet, will keep you posted! <3" | n/a | P1 (a 66k-follower volunteer who had already said "probs up for the experiment :)" was told to wait, on the last day of the campaign) | open |
| F-2 | 2026-10-24 | n/a (campaign) | 6 outreach | `GET /v2/farcaster/message`, `/message/send`, `/dm`, `/conversation`, `/v2/farcaster/signer` | `/v2/farcaster/message*` → `404 {"code":"NotFound","message":"Route GET /v2/farcaster/message not found"}`; `signer` → `{"signer_uuid":"6129…","status":"approved","fid":3356372}`, i.e. the only signer posts as @fiddy-one, **not** @ivc (191554) | n/a | P1 (13 DMs impossible; the ask went out as public replies instead, and the DM half is still unsent) | open |
| F-3 | 2026-10-23 | @webthe3rd.eth (fid 374565) | 5 vouch | *vouch cast* | "I just completed @ivc's quick and easy submission to the Farcaster client bounty: https://github.com/ivcained/fiddy#quickstart" (2026-10-23T17:57:05Z, `0x1118d48034a70ceff4993325c31dfff446b2982e`), a public completion statement with **no vouch wording, no node/client detail and no microsite link**, so the entry still has no vouch URL to hand the judge | ~1 day (submission blocked on it) | P0 for the submission (deadline 2026-10-24T14:47:30Z) | open |

### F-1, "can I try the client without setting up a node etc?"
- step: 3 client up
- voucher: @chriscocreated (fid 5701, 66k followers)   reporter: agent   date: 2026-10-24T05:50:13Z
- environment: not stated; he never started
- command: `<none: question asked before starting>`
- output: `can I try the client without setting up a node etc?`
- time_to_symptom: pre-flight
- time_to_unblock: unresolved at 2026-10-24T10:35Z
- workaround: none, he was told the client is not production ready yet
- severity: P1
- status: open

### F-3, the completion cast that is not a vouch
- step: 5 vouch
- voucher: @webthe3rd.eth   reporter: agent   date: 2026-10-23T17:57:05Z
- environment: he runs his own Snapchain node and did a full restore on a 1 TB Hetzner volume the same day
- command: `<cast>`
- output: `I just completed @ivc's quick and easy submission to the Farcaster client bounty: https://github.com/ivcained/fiddy#quickstart`
- time_to_symptom: the deadline is the symptom
- time_to_unblock: open
- workaround: ask him for a dedicated vouch cast naming the node, the client and the microsite; alternatively
  treat this cast as the vouch URL and accept the risk that a judge reads it as a review, not a voucher post
- severity: P0
- status: open

## 4. Pre-seeded candidates — what to watch for, verbatim

These are already known from the campaign's trip-point log (`docs/VOUCHER-CAMPAIGN.md` §5) and the microsite
re-check. When a voucher hits one, the entry above gets the voucher's own command and output — that is what turns
"we think this is a problem" into "a human was stopped by this at 14:32".

| # | Trip point | State before the voucher | Watch for |
| --- | --- | --- | --- |
| P0 | Tutorial and `provision.sh` said **"200 GB SSD"**; the protocol needs **1.5 TB** (repo README) / **2 TB** (snapchain docs) free, and 200 GB is only the snapshot download | **fixed before any voucher ran** — the live page now reads `4 vCPU, 16 GB RAM, 1.5–2 TB free disk` and "The mainnet snapshot is ~200 GB" (`8374eed`, re-checked live 2026-10-18). If a voucher still reports a 200 GB requirement, it is a regression on a different surface and gets an entry | the exact `df -h` line and how far the snapshot got |
| P1 | Menu quoted **~$100/mo** AWS; the real figure at 2 TB is **~$285/mo** | **fixed before any voucher ran** — the page now quotes `$285/month (instance ~$121 + 2 TB gp3 ~$164)` and `$50–80/month` for the cheaper 2 TB hosts (`8374eed`). Watch for a voucher who priced it from an older mirror or a cached page | their reaction in the DM; quitting over cost is a `dropped` row, not a friction entry |
| P2 | The brief's stale claims (read nodes "do not accept writes", app keys cost "one small Optimism transaction") | open by design — the tutorial states the brief's assumption and then shows the current behaviour, with citations | which text they trusted and what they typed |
| P3 | Block pruning is read-nodes-only and **off by default**, so the disk does not shrink by itself | open | their disk growth over time |
| P4 | **No Farcaster write credential exists on this machine**, so DMs and casts are owner-only | open — recruitment stalls until the owner sends | not a voucher entry; tracked in `docs/VOUCHER-OUTREACH.md` §1 |
| — | Cloudflare rewrote the sample `--ssh ubuntu@…` command on the live page | fixed 2026-10-18 (`358111f`); the page serves `ubuntu&#64;203.0.113.10` and no `__cf_email__` remains | a voucher reporting a broken sample command is a regression: log it |

## 5. Closing the loop

- Every entry gets a fix commit or a written, justified deferral in the fix task's closing status.
- After a fix, the same voucher is asked to retry **only that step** and confirm; the entry's status becomes
  `verified-by-voucher <date>` with the voucher's own one-line confirmation.
- Entries never get deleted. If an entry turns out to be a misdiagnosis, add a line saying so and who checked.