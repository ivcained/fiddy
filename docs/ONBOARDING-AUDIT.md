# Onboarding audit — a clean-room run of the three commands

Task `t_ae3ddad3`: independently reproduce the cold-start experience a voucher
gets from `https://github.com/ivcained/fiddy` + `https://fiddy.fun/client`, on
a machine with no prior fiddy state, following only what those two surfaces say,
and remove the friction that would eat a voucher's goodwill.

Run date: **2026-10-18**. Base: `main` @ `b51ab97`. Everything below is
observed output, not recollection — the raw logs are listed in
[Evidence](#evidence) and were produced by `evidence/cleanroom/run.sh` in the
bounty workspace.

---

## Method

| | |
| --- | --- |
| Environment | macOS 27.0.1 / arm64; **brand-new `$HOME`** (`~/.fiddy` absent, no config); fresh `git clone` from GitHub; `fiddy` **not** on `PATH`; no AWS CLI; no Docker; no container runtime (macOS + no Docker Desktop) |
| Bash under test | both `/bin/bash` **3.2.57** (what macOS ships) and Homebrew **5.3.20** |
| Not executed | the remote install itself. `fiddy node up` installs Docker and pulls the ~200 GB mainnet snapshot on the target; the only reachable real server is a 4 vCPU / 16 GB / **55 GB-free** production box, and running it there would fill its disk and take a live stack down. Those steps ran against a **stub `ssh`** (`evidence/cleanroom/stub-ssh`) that records every remote command and answers with that real box's numbers. The `fiddy` code itself was unmodified |
| Timed | every step, by the harness (`python3 subprocess` wall clock) |

**The honest limit.** No machine available to this audit can hold a read node:
the published requirement is 1.5–2 TB free and nothing here has it (the Mac has
650 GB; the VPS 55 GB). So the run reaches: sizing gate → install path (stub) →
client boot, and the *node API itself* is verified against a live public read
node (`https://haatz.quilibrium.com`). A true end-to-end "my own 2 TB box,
synced" run needs the 2 TB box — that is `t_fa420e09`'s real-compute card, and
the reason `fiddy node up` now refuses an undersized box *before* spending
three hours finding out.

---

## The run

| # | Step, exactly as a newcomer meets it | Time | Observed |
| --- | --- | --- | --- |
| 0 | `git clone https://github.com/ivcained/fiddy && cd fiddy` | **7.0 s** | 30 MB `.git`. Fine. |
| 0a | README quickstart, verbatim: `fiddy provision` | 0.1 s | **`/bin/sh: fiddy: command not found` (exit 127)** — the README's first code block cannot run as written; the `PATH` / `bash bin/fiddy` note is *below* it |
| 0b | `bash bin/fiddy doctor` (with macOS bash 3.2) | 0.4 s | "ready" — while `aws` and `docker` are missing, disk is 650 GB (a read node needs 1.5–2 TB), and it never says which bash you are on |
| 0d | `fiddy provision` (no arguments) | 0.4 s | prints **"~$100/mo"** and **"200 GB SSD"** — both wrong for a read node (see `docs/VOUCHER-CAMPAIGN.md` P0/P1) |
| 0e | `fiddy provision --aws` | 0.3 s | `! missing dependency: aws — install: …` — good error, but nothing earlier warned that the AWS route needs a paid CLI |
| 0f | `fiddy provision --ssh root@…` (real server) | 1.4 s (bash 5) / **0.1 s (bash 3.2)** | bash 5: registers the target, says "Next: fiddy node up". **bash 3.2: `cli/provision.sh: line 52: mapfile: command not found`, exit 127** |
| 1a | `fiddy node up` | 90 s cap (bash 5) / **0.1 s (bash 3.2)** | bash 5: docker check → bootstrap → start → `waiting for node… attempt 18/120` → killed by the harness. **No disk, RAM or CPU check anywhere** — on the 55 GB box this is where the disk fills and the run dies. bash 3.2: `mapfile: command not found`, exit 127, *before* any of that |
| 1b | `fiddy node status` | 0.1 s | `curl: (7) Failed to connect … port 3381` then `! node not answering — try: fiddy node logs`. No hint that a locked-down security group or a missing tunnel gives the same message |
| 1c | `fiddy node logs` | 0.1 s (bash 5) / **127 (bash 3.2)** | same `mapfile` failure on 3.2 |
| 2 | `fiddy client up` (node preset to a public read node so the wait passes) | **~4 min install + boot**, then the dev server ran 13 min while audited | `.env.local` written with `VITE_SNAPCHAIN_HTTP_URL`; `pnpm install` ~4.4 GB; Vite serves **HTTPS** on `[::1]:5173` — `http://localhost:5173` answers *nothing* |
| 2b | the served module `src/constants/api.ts` | — | `baseApiUrl = "https://farcaster.xyz/~api"` in dev. `import.meta.env` carries `VITE_SNAPCHAIN_HTTP_URL`; **no file under `apps/` or `packages/` reads it** |

### The one that matters most

`fiddy client up` is documented — README, microsite step 2, and the CLI's own
banner — as *"the Fiddy web client, reading YOUR node"*. It is not: the CLI
writes a `VITE_SNAPCHAIN_HTTP_URL` that nothing consumes, and the app's API base
is either `https://farcaster.xyz/~api` (dev) or same-origin `/~api` (prod). A
newcomer who completes command 2 sees a working Farcaster feed and has no way to
know it is not coming from the node they just built. Fixing the read path is a
feature (`t_7ae8be28`, in flight); **the misleading claim is fixed here**: the
CLI now prints which API the client reads from, and the README has a Status
section. The check is a `grep` for the variable, so it flips to the success line
by itself the moment the wiring lands.

---

## Findings

Severity: **P0** blocks a newcomer, **P1** wastes hours or misleads, **P2** friction, **P3** cosmetic.

| # | Step | Problem | Sev | Status |
| --- | --- | --- | --- | --- |
| F1 | 0f, 1a, 1c, 2-tunnel | Every remote command dies on a Mac: `cli/*.sh` used bash 4+'s `mapfile`, and macOS's `/bin/bash` is 3.2 → `mapfile: command not found`, exit 127, for `provision --ssh`, `node up/status/logs` and the client tunnel. The CLI is advertised for laptops, and `doctor` says "ready" | **P0** | **Fixed** — `ssh_opts_fill` (bash 3.2 + 5 verified), `fiddy doctor` prints the bash version, `bash_ok` guard rejects `sh bin/fiddy` |
| F2 | 1a | Nothing checked the box could hold a read node before installing: straight to Docker + the ~200 GB snapshot, failure ~10 min later as `node did not come up in time`. A voucher's first real command would burn hours | **P0** | **Fixed** — vCPU/RAM/free-disk preflight on `node up` (refuses in <1 s, prints found-vs-required and three fixes), sizing report in `provision --ssh` and `doctor`, `FIDDY_ALLOW_UNDERSIZED=1` escape hatch |
| F3 | 1b, 2 | No success criteria anywhere: `node status` dumped raw `/v1/info` JSON and the tutorial never says what a healthy node looks like | **P1** | **Fixed in CLI + README** ("Verify it works", with a real known-good sample); microsite copy queued (F12) |
| F4 | 0a | README's first code block cannot run verbatim (bare `fiddy`, PATH note below it) | **P0** | **Fixed** — `export PATH="$PWD/bin:$PATH"` inside the quickstart block |
| F5 | 0d | CLI help sold "~$100/mo" and "200 GB SSD" for a 1.5–2 TB box (~$285/mo on AWS list) | **P0** | **Fixed** in `cli/provision.sh` copy; page copy already fixed in `41b6046` |
| F6 | 2 | Client does not read from the user's node (above) | **P0** | **Docs/CLI made honest** (warn + README Status). The wiring itself is **queued → `t_7ae8be28`** |
| F7 | 2 | Dev server is HTTPS with a self-signed cert; `http://localhost:5173` silently answers nothing and nothing said so | **P1** | **Fixed** in CLI output + README; microsite copy queued (F12) |
| F8 | web quickstart | README told you to `git clone git@github.com:YOUR_ACCOUNT/farcaster-wallet-client.git` (a repo that is not this one) and to `corepack enable` (absent from Node ≥25 — verified `command not found` on Node 26.10.0) | **P1** | **Fixed** — clone line, pnpm note, workspace size |
| F9 | 0b | `doctor` said "ready" with no signal about bash version or whether `--local` is even possible on this machine | **P2** | **Fixed** — bash line + local sizing line |
| F10 | any | `FIDDY_TARGET=…` in the environment is silently ignored once `~/.fiddy/config` exists (`config_load` sources the file over the env) — scripted/batch runs appear to work and hit the wrong box | **P3** | **Queued → `t_2e6fcb98`** (change is small but touches config semantics; two cards are editing `cli/` now) |
| F11 | 1a | On a node that installs but never answers, the wait is 600 s before the only message, `node did not come up in time` | **P3** | **Queued → `t_2e6fcb98`** (F2 covers the common cause; suggest one `snapchain.sh logs | tail` before giving up) |
| F12 | microsite | The tutorial has no "did it work?" step, no HTTPS/self-signed warning, and its step 2 still promises reads from your node; `--local` is undocumented | **P1** | **Queued → `t_2e6fcb98`**, ready-to-paste copy in [Microsite copy](#microsite-copy-proposed). `site/index.html` is a declared hotspot with one owner — do not add a third editor to it |
| F13 | 1a | With the published minimums there is no zero-cost way to see the stack work; a newcomer must buy a 2 TB box first | **P2** | **Partially fixed** — README's verify section now names the live public read node (`https://haatz.quilibrium.com/v1/info`, read-node API v0.13.5, 3 shards, 914 M messages) as the reference a local node is compared against |
| F14 | whole task | Acceptance cannot be fully met on this hardware: a *working, synced* read node needs 1.5–2 TB that no machine here has, and the client's node-backed read path is not written yet | — | **Open by design** — node-on-real-compute is `t_fa420e09`; read path is `t_7ae8be28` |
| F15 | 2 | `pnpm install` in the workspace pulls ~4.4 GB and takes ~4 minutes with no progress estimate; `client up` says "a few minutes" only *after* the preflight | P3 | **Accepted** — README now states the size; not worth engineering around |

### URLs

`evidence/url-check.sh` extracts every `http(s)` URL and root-relative `href`
from `README.md`, `site/index.html`, `site/zh/index.html` and
`apps/farcaster-web/README.md`, fetches each one following redirects, and
writes the table to `evidence/url-check.md`.

**Result: 12 published URLs fetch 200; 15 are documented placeholders
(`YOUR_PROJECT`, `your-*-rpc.example`, …); 2 are API bases where a bare `GET` is
expected to 404 (`https://farcaster.xyz/~api`, `https://haatz.quilibrium.com` —
the latter serves `/v1/info`).** No broken links, no stale screenshots (the
microsite has none), and `https://fiddy.fun/client#safety` — which used to land
nowhere — resolves to the safety pane. Re-run after any page edit:

```bash
evidence/url-check.sh /path/to/fiddy /path/to/out.md
```

---

## Microsite copy (proposed)

For whoever owns `site/index.html` next (currently the only editor is the
deploy/quickstart card; `t_2e6fcb98` should batch these with any page fix):
three inserts, no restructuring.

**Step 0, after the requirements paragraph** — say you will be told, not
surprised:

> `fiddy node up` reads your server's CPU, RAM and free disk before it installs
> anything, and stops with what it found if the box cannot hold a read node.
> Meant for the wrong box: a 1.5 TB attach is cheaper than a failed sync.

**Step 1, at the end** — the missing "did it work?" step:

> ```bash
> fiddy node status     # the API answers, version, shards, max height
> ```
>
> A healthy node prints `✓ the node API is answering` with a version, a shard
> count and a max height. Run it a minute apart: a **rising** max height means
> sync is live. Nothing to compare against? The same command pointed at a
> public read node — `FIDDY_NODE_HTTP=https://haatz.quilibrium.com fiddy node status` —
> prints what a working read node looks like before you have one.

**Step 2, next to the `fiddy client up --tunnel` block**:

> The client starts on `https://localhost:5173/` — **HTTPS with a self-signed
> certificate**: accept the browser warning, or the page looks broken (the
> `http://` form of that address answers nothing). Today the client's reads come
> from the public Farcaster API; reading from *your* node is the next thing on
> the roadmap and `fiddy client up` prints which of the two you are on.

---

## Evidence

In the audit workspace (`~/.hermes/kanban/workspaces/t_b05919fc/evidence/`):

- `cleanroom/run.sh` — the harness: clean `$HOME`, stub-first `PATH`, timed steps, `BASH_BIN` + `LOG_TAG` switches
- `cleanroom/stub-ssh` — records every remote command, answers with the real box's numbers
- `cleanroom/run.prefix-b51ab97-bash3.stage1.log` — **pre-fix repro on macOS bash 3.2** (`mapfile: command not found` at 0f/1a/1c)
- `cleanroom/run.prefix-b51ab97-bash5.stage1.log` — pre-fix on bash 5: `node up` installs with no sizing check, then polls for 20 s
- `cleanroom/run.system-bash3.2.stage1.log` and `run.brew-bash5.stage1.log` — **post-fix pass on both bashes** (no `mapfile` failure; `node up` refuses the undersized box in 0.8 s)
- `cleanroom/prefix-b51ab97-bash5.stage2.log` + `cleanroom/client-postfix.log` — the client, before and after (post-fix shows the read-source warning and the HTTPS note)
- `cleanroom/client-postfix-runner.sh` — how that run was captured and stopped
- `cleanroom/ssh-commands.log` — the exact remote commands fiddy sent, in order
- `cleanroom/served/constants-api.ts.txt`, `served/initFarcasterApi.ts.txt` — the served modules proving `baseApiUrl` and that `import.meta.env` carries the node URL nobody reads
- `url-check.md` + `url-check.sh` — every URL, status, and where it is published

Re-verify the fixes without any hardware:

```bash
CR=<workspace>/evidence/cleanroom
BASH_BIN=/bin/bash $CR/run.sh stage1      # must not print "mapfile: command not found"
FIDDY_NODE_HTTP=https://haatz.quilibrium.com /bin/bash bin/fiddy node status
```

---

## hot spot

`cli/` — three cards are editing it in the same clone (`t_fa420e09` AWS volume
+ end-to-end run, `t_7ae8be28` client read path, this audit). The mapfile
portability fix touches `provision.sh`/`client.sh`/`lib/common.sh`; if your
branch already moved those lines, take the four changed lines and drop the rest.
`site/index.html` stays a one-owner file: the copy above is text for that owner
to paste, not a competing edit.