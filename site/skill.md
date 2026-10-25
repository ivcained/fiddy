# Set up a Fiddy node + client (instructions for an AI agent)

Source of truth: the repository README and `fiddy --help`. If this file and the
code disagree, the code wins; tell the person.

## What they get

Their own Farcaster node (Snapchain) on their own compute, and the Fiddy client
reading and writing through it. No API keys from anyone. The node stores the
whole network (~560 GB today) and needs ~2 TB of disk, 4 vCPU and 16 GB RAM.

## Tell it as a story

**A node of their own wakes up.** A full copy of Farcaster streams into their
machine — that download is the slow part (hours on a fast disk, overnight on a
slow one) and it is normal. The node API refuses to answer until the snapshot
loads; that is expected, not broken. They check progress with `fiddy node status`
and the dashboard with `fiddy node dashboard`.

## The steps

### 1. Compute

Ask which path before touching anything that costs money:

- **Their own machine** (free): needs ~2 TB free disk. Skip to step 2 with `--local`.
- **AWS** (default cloud, ~$285/mo): CloudShell one-liner or `fiddy provision --aws`
  from a machine with the AWS CLI. New AWS accounts: CloudShell can be locked up to
  2 days during account verification — the same one-liner works from any terminal
  after `aws configure`.
- **GCP** (tested by the authors, ~$350/mo, $300 new-user credit): the one-click
  button at https://fiddy.fun/client or `fiddy provision --gcp`.
- **Hetzner** (~€120/mo, cheapest): `fiddy provision --hetzner` — new accounts are
  capped at 1024 GB volumes until support raises the quota; say so.
- **A server they already have**: `fiddy provision --ssh user@host`, or if they are
  SSH'd into it already, skip provision entirely (step 2 with `--local`).

If they created an instance by hand in a cloud console and SSH'd in, the move is
step 2 on that machine — NEVER `fiddy provision` from the server itself.

### 2. The node

```sh
curl -fsSL https://fiddy.fun/client/install.sh | bash
```

or by hand: `git clone https://github.com/ivcained/fiddy && cd fiddy`, then
`export PATH="$PWD/bin:$PATH"` (the CLI is `bin/fiddy`), then `fiddy node up`
(remote target) or `fiddy node up --local` (this machine). The installer detects
an SSH session: inside a server it follows Way 2 and installs a missing local
node; on a laptop it follows Way 1 and leaves the 2 TB node remote. Set
`FIDDY_INSTALL_NODE=1` to force a local node install. It also installs Herdr,
Ovis, and `plugins/fiddy-console`: open Ovis with Cmd/Ctrl+Shift+K, type Fiddy,
and use the node buttons. The Grafana button embeds the real dashboard beside
the terminal through a loopback-only tunnel/proxy; no AI key is needed.
The CLI installs
Docker itself, checks the machine can hold a node, and says so plainly if not.

### 3. The client

`fiddy client up` (add `--tunnel` when the node API is not public). It installs
Node.js and pnpm itself when missing. It prints a localhost URL — open it for
them (`open`/`xdg-open`/`start` by `uname`), or give them the link if you're not
on their machine.

### 4. Sign in

Prefer delegated approval (their Farcaster phone app approves an app key) over
seed import. A seed phrase is `rm -rf` for an account: **never ask for one in
chat, never suggest pasting one into anything networked**, and tell them to use
a test account with storage paid if they use the Advanced seed-phrase path at all.

## If something breaks

- `fiddy doctor` — machine + network check with the fix spelled out.
- `fiddy: command not found` → `export PATH="$PWD/bin:$PATH"` in the repo, or
  `bin/fiddy install` once.
- Node API not answering during first hours → snapshot bootstrap; `fiddy node status`.
- Still stuck: https://github.com/ivcained/fiddy/issues with the command, the last
  ~30 lines of output, and the OS. Never include tokens, keys or seed phrases.

Docs: https://fiddy.fun/client (also 中文: /client/zh/) · repo: https://github.com/ivcained/fiddy
