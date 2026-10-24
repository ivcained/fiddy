# Voucher start kit: what a "yes" turns into in the next ten minutes

Written 2026-10-24T10:50Z, because the bounty deadline is 2026-10-24T14:47:30Z and the tutorial's long pole is the
node sync. Everything here exists so that a person who says "ok, I'll run it" gets one paste-ready message and can
be finished (first cast posted from their own node) inside a couple of hours, with the sync still finishing behind
them.

## 1. The one message to send a would-be voucher

```
Ok. Four things and you're running.

1. Box: 4 vCPU / 16 GB RAM / 1.5-2 TB free disk, Ubuntu 22.04+, ports 3381-3383 open on TCP *and* UDP.
   A ~$50-80/mo 2 TB VPS is fine (Hetzner/Contabo/OVH class); `fiddy provision --ssh` drives it. The AWS
   scripted path works too but at 2 TB it is ~$285/mo, which is why the cheaper hosts exist.
2. A test Farcaster account's seed phrase (not your main). Nothing is created onchain.
3. Then three commands: `fiddy provision`, `fiddy node up`, `fiddy client up`.
   Full tutorial, desktop and mobile: https://fiddy.fun/client
4. Time: plan a half day. Most of it is the ~200 GB snapshot downloading. The API answers early, so your first
   read and your first cast work before the node is fully caught up.

When anything breaks, send me six lines and nothing else:
  1. step: provision / node up / client up / first read / first post
  2. the exact command you ran (copy-paste, whole line)
  3. the exact output or error, including the few lines above it
  4. what you had already done in that step
  5. how long you were stuck before you asked
  6. what you tried before asking

And when it works, the vouch is just your honest review: that you ran it end to end (node + client), how long it
took, one criticism, and the link. Public cast, your own account.
```

## 2. The five checkpoints, so the run is provable step by step

| # | Checkpoint | What "done" looks like | What to capture |
| --- | --- | --- | --- |
| 1 | provision | a box with 1.5-2 TB free | `df -h /` line |
| 2 | node up | process up, RPC answering on 3381/3383 | `curl -s localhost:3381/v1/info` output |
| 3 | first read | feed served by their own node, not a hosted API | the client's read path / screenshot |
| 4 | client up | gasless app key registered, seed phrase never left the machine | the KEY_ADD result |
| 5 | first post + vouch | a cast on their own account | the cast permalink |

## 3. The vouch cast template (from the voucher's own account)

```
I just stood up my own Farcaster client + read node with Fiddy's tutorial.

Three commands, no API keys from anyone, my own Snapchain node serving my feed:
- fiddy provision --ssh <box>   (2 TB disk, ports 3381-3383)
- fiddy node up
- fiddy client up

Took me <X> hours, mostly the node syncing. The tutorial explained what a read node actually is and why gasless
app keys changed (no Optimism tx). <One honest criticism.>

https://fiddy.fun/client
```

## 4. Why speed matters today

The submission is a reply to the bounty cast with three URLs, and one of them must be a human voucher's public
cast. The deadline is 2026-10-24T14:47:30Z. A voucher who starts now can post the first cast from their own node
inside two hours (the sync lags behind it), so a same-day vouch is still possible, but only for someone who starts
immediately.

The two people who are already past the long pole: **@webthe3rd.eth** publicly said he completed the quickstart on
2026-10-23T17:57:05Z (he needs one more cast to turn that into the vouch URL), and **@mddvm** ran a rival entry end
to end and posted its vouch at 2026-10-24T08:47:13Z (so the whole loop takes him half a day, not a week).

## 5. The one DM that converts a proven runner into a voucher

The highest-conversion message left is not to a stranger, it is to one of the people who already ran a rival's
tutorial on their own box and posted a public vouch: @runn3rr, @eat, @mddvm, @otterly. They have the rig, the
habit and the box already running. Send this from @ivc's own account (DMs need the owner's client):

```
Hey <handle>, you ran <entry> end to end on your own box and posted the honest notes, which is exactly what I'm
looking for.

I'm one short of a human vouch on mine: https://fiddy.fun/client, three commands, own Snapchain read node plus a
client, no API keys, same 2 TB disk and ports 3381-3383 as yours. The bounty closes 14:47Z today. If you can run
it and post your honest vouch, I'll take whatever it says, including the parts that are wrong, and I'll pair live
while you do it if that helps.
```

The same message to @webthe3rd.eth needs one line changed: he already ran it, so ask for the vouch cast rather than
the run.