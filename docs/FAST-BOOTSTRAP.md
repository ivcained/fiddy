# Fast bootstrap: hand out the synced state instead of the download

A Snapchain mainnet read node spends its first hours building a database that is
nearly identical for everybody: ~470 GB of gzipped chunks from Farcaster's
public bucket, staged and unpacked to ~600 GB (peak ~1.66 TB with the chunks
still on disk), which on HDD-class disks is an **overnight** wait before the
node's API answers at all (`docs/NODE-REQUIREMENTS.md` has the measurements).

fiddy keeps **one** copy of a fully synced node and hands it out:

| Who | What they get | How |
| --- | --- | --- |
| AWS, same account (or shared) | an **AMI registered from** an EBS snapshot of the node's volume | `scripts/aws-deploy.sh` / `fiddy provision --aws` launch that AMI |
| AWS, anyone else | the **public snapshot** itself: a volume built from it | the deploy scripts attach it as a data disk, mount it, and point `~/snapchain` at it |
| Everyone else | a `tar`+`zstd` tarball in object storage (R2 by default: no egress fees) | `fiddy node up` streams it into the data dir before installing anything |

Both are pinned in `config/fast-bootstrap.json` with the date they were taken.

## The trust note (carry this with every surface that offers it)

> **The pre-synced copy is a convenience, not a trust root.**
>
> It only saves the download. Everything you read from your node is still
> re-validated as it arrives over gossip, and the node syncs forward from the
> network tip the moment it starts: the copy is a starting point, never a source
> of truth. If you would rather not use ours at all, bootstrap from Farcaster's
> public chunks instead, which is exactly what happens when nothing is pinned
> (`FIDDY_AWS_FAST_BOOTSTRAP=0` on AWS, or an empty `config/fast-bootstrap.json`).

### The two AWS artifacts, and why there are two

EC2 will not point a launch at a bare snapshot ("snapshotId cannot be modified on
root device"), so a launchable copy has to be an **AMI registered from** that
snapshot. `publish` registers one and tries to make it public, which surfaces the
account-level reality:

* `imageBlockPublicAccess` is **`block-new-sharing` by default** and cannot be
  overridden with IAM permissions. On an account with that setting, an AMI cannot
  be made public; `publish` says so, prints both ways forward, and carries on.
* `snapshotBlockPublicAccess` is a **separate** switch, and snapshots are the
  universally usable artifact: **any account can create a volume from a public
  snapshot.** That is why the pin carries both ids, and why `aws-deploy.sh`
  checks what *this* account can actually use (`fb_ami_usable` /
  `fb_snapshot_usable`) instead of assuming:

  | | AMI launchable here | snapshot usable here | what the box does |
  | --- | --- | --- | --- |
  | our account | yes | yes | boots the AMI: the DB is already on the root disk |
  | shared account | yes (with `--share-with`) | yes | same |
  | any other account | no | yes | creates a volume from the snapshot, attaches it, mounts it, `~/snapchain` -> the node data on it, starts the node |
  | nothing pinned | - | - | the cold bootstrap, exactly as before |

  To make the AMI itself public you have two deliberate options, both printed by
  `publish`: share with specific accounts (`publish --share-with 123456789012`) or
  allow public AMIs account-wide (`aws ec2 disable-image-block-public-access
  --image-block-public-access-state unblocked`, an account-wide security change).

Two practical consequences worth saying out loud:

* A public EBS snapshot is readable by anyone who knows its id: build a volume
  from it, and you see a copy of the volume. It holds **public Farcaster data plus the
  source box's OS** — no private keys (a read node has none by design), and the
  launcher's first boot **replaces** `.ssh/authorized_keys` with your own key, so
  an instance you boot never trusts ours. Keep any node box that gets snapshotted
  free of secrets anyway: don't put API keys, wallets or credentials on it.
* Anyone can verify the copy rather than trust it: the pin's date is displayed
  everywhere the fast path is used, and `scripts/fast-bootstrap-verify.sh` boots
  a throwaway box from the snapshot and measures it.

## The pin — `config/fast-bootstrap.json`

```json
{
  "version": 1,
  "maxAgeDays": 14,
  "aws": {
    "amiId": "ami-…",              "snapshotId": "snap-…",
    "region": "us-east-1",         "createdAt": "2026-10-24T…Z",
    "volumeGb": 2050,              "volumeId": "vol-…",
    "storageGb": 600,              "usedGb": 600,
    "nodeVersion": "0.14.3",       "heights": { "maxHeight": 1234, "blockDelay": 3 }
  },
  "mirror": {
    "url": "https://mirror.example.com/fast-bootstrap/node-2026-10-24.tar.zst",
    "bytes": 502511173632, "sha256": "…", "createdAt": "2026-10-24T…Z"
  }
}
```

Empty values mean "nothing pinned": every consumer then behaves exactly as it did
before this existed. The file is written by `scripts/node-snapshot.sh publish`;
nothing else should edit it.

## Publishing (the script is the proof it can be reproduced)

```bash
# from any machine with the AWS CLI and SSH to the node
scripts/node-snapshot.sh publish --ssh ubuntu@<node-ip> --volume vol-xxxxxxxx \
  --mirror --wait-for-sync --json /tmp/fast-bootstrap.json
```

`publish` does, in order:

1. reads the node's live state over SSH (`/v1/info`, data-dir size, whether
   `.rocks.snapshot/chunk_*.bin` are still arriving). It **refuses to publish a
   node that has not finished loading** unless you pass `--allow-unsynced`, and
   `--wait-for-sync` blocks until it is ready.
2. **quiesces**: stops the node container with a 180 s grace period so RocksDB
   closes cleanly (not a SIGKILL race), confirms the container is gone, `sync`s
   the filesystem.
3. creates the EBS snapshot of the volume, waits for `completed`, then
   `modify-snapshot-attribute … --group-names all` and **verifies** the
   permission actually landed.
4. **registers an AMI from that snapshot** (`register-image`) and makes it
   public too. This is not decoration: EC2 refuses to point a launch at a bare
   snapshot ("snapshotId cannot be modified on root device"), so the AMI is the
   launchable artifact and the snapshot is what it is made of. `register-ami` is
   exposed as its own subcommand for the case where you own the snapshot and
   only need the AMI.
5. optionally streams `tar … | zstd -T0 | rclone rcat` of `.rocks` +
   `.onchain-config` to object storage, computing a sha256 and reading the
   uploaded object's size back.
6. writes the pin, then **restarts the node** so it keeps syncing.

Nothing in it is special to our box: point it at any synced node running the
standard installer and it produces the same artifact. That is what makes it a
reproduction of the copy rather than a magic artifact we once made.

Cost, printed by `node-snapshot.sh status`: EBS snapshot storage is
~$0.05/GB-month for the blocks actually used (~600 GB of a 2 TB volume), so
~$30/month at list. The AMI itself adds nothing (it is its snapshot). The R2 mirror is ~$0.015/GB-month (~$8/month) with no
egress fee, which is why non-AWS hosts use it.

## Refreshing (`scripts/fast-bootstrap-refresh.sh`)

The pin has to stay young: an old copy means a long catch-up, and `maxAgeDays`
is 14. One run publishes, optionally verifies, and optionally commits the pin:

```bash
scripts/fast-bootstrap-refresh.sh --ssh ubuntu@<node-ip> --volume vol-xxxxxxxx \
  --mirror --wait-for-sync --verify --push
```

* `--verify` runs `scripts/fast-bootstrap-verify.sh`, which **boots a fresh box
  from the new snapshot** and measures it (see below). A pin that fails
  verification should never be advertised; the refresh exits non-zero instead.
* `prune-old --keep N` deregisters the AMIs first and then deletes the snapshots
  they were built from (a snapshot an AMI points at cannot be deleted).
* `--check-age` is the cheap monitor form: exit 1 when the pin is older than
  `maxAgeDays`.
* `--cron-line` prints the weekly crontab line **and** a launchd plist.
  Publishing needs AWS credentials (and R2 keys for the mirror), and the node box
  itself deliberately holds no AWS credentials, so today the cadence runs from
  the operator's machine or from any host where those credentials live. If the
  box is the only always-on machine, either give it a scoped IAM user for
  `ec2:CreateSnapshot`/`ModifySnapshotAttribute` or accept a Mac that must be
  awake.

## Verification (the acceptance test)

```bash
scripts/fast-bootstrap-verify.sh            # reads the pin
```

It: confirms the snapshot is public and `completed` and that the pinned AMI is
public and `available` (launch permissions propagate for a few seconds after
publication, so it retries); launches an instance from that AMI with a root
volume at least as large as the snapshot's; waits for `http://<ip>:3381/v1/info`; reports **boot → answer** in minutes and
seconds and the shard heights/`blockDelay` it saw; then runs the CLI's own
acceptance checks (`fiddy node verify 3`) against that box; then tears the box
down unless `--keep` was passed. A 15-minute run of an `m5.xlarge` costs cents;
the volume dies with the instance.

The number it prints is the only number any surface is allowed to quote.

## What the fresh box does on first boot

* **AWS**: the pinned AMI boots (its root device is the public snapshot, so the
  UBUNTU family and boot mode are inherited at registration); user-data installs
  Docker (idempotent), replaces
  `~ubuntu/.ssh/authorized_keys` with the launcher's key, and starts the node's
  containers from `~/snapchain` (the snapshot was taken with them stopped). The
  node finds a non-empty `.rocks`, so it **skips the snapshot download entirely**
  (`SnapchainReadNode` only downloads when the DB is empty) and syncs from the
  copy's tip.
* **everything else**: `fiddy node up` streams the mirror tarball into
  `~/snapchain` and only then installs/starts Snapchain; same skip applies.

Peak disk for the mirror route is the compressed tarball plus the unpacked
database (~2.3× the tarball), which the CLI checks before downloading: if the
target has no room, or the URL 404s, or `zstd` is missing, or the data dir
already holds a database, it silently falls back to the upstream bootstrap.

## Where the honesty lives

* `node-snapshot.sh status`, `fiddy node status`, the AWS script and the tutorial
  all print the same line: *synced state as of &lt;date&gt;, N day(s) old*.
* Nothing claims a time we have not measured. The verification script's number is
  what the tutorial may quote, and it is re-measured on every refresh.
* `tests/fast-bootstrap.test.sh` covers the plumbing for real: a tarball is
  built, served over HTTP, streamed back through the CLI's own function and
  compared byte for byte; a wrong checksum is rejected; an unreachable mirror
  falls back; every branch of the decision rule is exercised; the pin readers are
  run against real, missing, malformed and jq-less environments.

## Environment reference

Publishing / mirror (all optional except the AWS side):

```
FIDDY_AWS_REGION                     region of the volume + snapshots (us-east-1)
AWS_PROFILE / FIDDY_AWS_PROFILE      AWS credentials to use
FB_MIRROR_S3_BUCKET                  bucket to upload the tarball into
FB_MIRROR_KEY                        object key (default fast-bootstrap/node-<date>.tar.zst)
FB_MIRROR_PUBLIC_BASE                public base URL the pin advertises to clients
R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY     Cloudflare R2
FB_MIRROR_S3_ENDPOINT / _ACCESS_KEY / _SECRET_KEY / _PROVIDER   any S3-compatible store
FB_MIRROR_UPLOADER=remote|local      upload from the node (default) or from here
FB_MAX_WAIT_SNAPSHOT_S               how long publish waits for a snapshot (7200)
FB_MAX_WAIT_SYNC_S                   how long --wait-for-sync waits (43200)
```

Consuming:

```
FIDDY_AWS_FAST_BOOTSTRAP=0           ignore the pin, bootstrap from Farcaster
FIDDY_FAST_BOOTSTRAP_PIN=/path.json  use a different pin (tests, private pins)
FIDDY_FAST_BOOTSTRAP_PIN_URL=…       where a piped aws-deploy.sh fetches the pin
FIDDY_VERIFY_KEY_FILE                key aws-deploy/verify should authorise
```