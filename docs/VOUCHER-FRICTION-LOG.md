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

| # | date | voucher | step | command | exact output | stuck | severity | status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| — | — | — | — | — | *no voucher has started yet (2026-10-18)* | — | — | — |

## 4. Pre-seeded candidates — what to watch for, verbatim

These are already known from the campaign's trip-point log (`docs/VOUCHER-CAMPAIGN.md` §5) and the microsite
re-check. When a voucher hits one, the entry above gets the voucher's own command and output — that is what turns
"we think this is a problem" into "a human was stopped by this at 14:32".

| # | Predicted trip point | Why it is predicted | Watch for |
| --- | --- | --- | --- |
| P0 | Tutorial and `provision.sh` still say **"200 GB SSD"**; the protocol needs **1.5 TB** (repo README) / **2 TB** (snapchain docs) free, and the 200 GB figure is only the snapshot download | a voucher provisioning 200 GB fills the disk during or after sync | the disk-full error, the exact `df -h` line, and how far the snapshot got |
| P1 | Menu quotes **~$100/mo** AWS; the real figure at 2 TB is **~$285/mo** | a voucher who priced it out may walk away before starting | their reaction in the DM; if they quit here, that is a `dropped` row, not a friction entry |
| P2 | The brief's stale claims (read nodes "do not accept writes", app keys cost "one small Optimism transaction") | a voucher may follow the brief and doubt the tutorial, or vice versa | which text they trusted and what they typed |
| P3 | Block pruning is read-nodes-only and **off by default**, so the disk does not shrink by itself | a voucher may expect the disk to free up | their disk growth over time |
| P4 | **No Farcaster write credential exists on this machine**, so DMs and casts are owner-only | recruitment itself stalls if the owner is not in the loop | not a voucher entry — a campaign blocker, tracked in `docs/VOUCHER-OUTREACH.md` |
| — | Fixed 2026-10-18: Cloudflare rewrote the sample `--ssh ubuntu@…` command on the live page | anyone copy-pasting failed instantly | if a voucher still reports a broken sample command, it is a regression: log it |

## 5. Closing the loop

- Every entry gets a fix commit or a written, justified deferral in the fix task's closing status.
- After a fix, the same voucher is asked to retry **only that step** and confirm; the entry's status becomes
  `verified-by-voucher <date>` with the voucher's own one-line confirmation.
- Entries never get deleted. If an entry turns out to be a misdiagnosis, add a line saying so and who checked.