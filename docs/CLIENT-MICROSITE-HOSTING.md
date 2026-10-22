# fiddy.fun/client — microsite hosting (static, no backend)

Status as of 2026-10-22 (IST). The quickstart + tutorial microsite from
`site/index.html` is live at **https://fiddy.fun/client** — the target README,
`docs/SPEC.md` and `bin/fiddy` all link to. Verified state below; everything in
the "How verified" column was actually run.

Two things changed here on 2026-10-22, both because a card finally measured what
this surface was serving (card t_5890479d):

- **the deploy has a script and a gate.** It used to be a hand-typed `ssh` pipe
  onto `/var/www/fiddy-client/`, with nothing between the repo and the live host
  — no size check, no colour check, and nothing that ever looked *inside* a
  picture. `scripts/deploy-microsite.sh` now freezes the tree at a sha, runs
  `scripts/check-microsite-assets.mjs` over it, uploads, reads every file back
  off the box, fetches every file back from the origin, and runs the same gate
  over what the host answers. The gate also runs in CI on every pull request.
- **the "Deploy a Node" mini app's splash was replaced.** It shipped a 512×512
  picture on a cream ground with its drawing 28px right of centre — and the
  drawing was the *sibling FSSC app's* judge-baby, not Fiddy's mark. It is now
  a 200×200 Fiddy splash on `#161715` with its mark centred, drawn by the same
  generator as the client listing's splash. *The splash* below has the numbers.

## Live facts

| Fact | Value | How verified |
| --- | --- | --- |
| URL | https://fiddy.fun/client | `curl -o /dev/null -w '%{http_code}'` → **200** (also `/client/`, `?x=1`) |
| Canonical | `<link rel="canonical" href="https://fiddy.fun/client">`, `og:url` same | served HTML |
| Origin file | `/var/www/fiddy-client/index.html` (outside the release symlink tree) | `ls -l`, `md5sum` |
| Deployed content | `md5 30d6c9588967272d44d3ab8a96068428` = `site/index.html` at repo HEAD | `md5sum` on the VPS vs `md5 -q site/index.html` locally, equal (re-measured 2026-10-22) |
| Deploy path | `scripts/deploy-microsite.sh [sha]` — frozen tree, gate, upload, read its own bytes back off the box, fetch them from the origin, gate the served copy. `--gate-only` runs the gate and uploads nothing | the script, run 2026-10-22 |
| The gate | `scripts/check-microsite-assets.mjs` (`node scripts/check-microsite-assets.mjs [site dir]`) — every page's `fc:miniapp`, its splash's size/ground/placement, its card and its launch URL; also a CI job (`microsite (site/)`) on every pull request | run on the frozen tree, on the served mirror of the live host, and on seven negative trees — all seven refused by name (see *What holds the shape*) |
| The mini app's splash | `/client/assets/fiddy-splash.png` — 200×200, ground `#161715`, mark 100×96 centred at (99.5,99.5); drawn by `apps/farcaster-web/scripts/render-share-card.mjs splash-deploy`, a file this repo owns | live bytes measured 2026-10-22, see *The splash* |
| Served bytes | byte-identical to the repo file | `diff <(curl -sS https://fiddy.fun/client) site/index.html` → empty |
| Host | srv1569292 (LC VPS, 100.111.203.78 / public 187.127.148.194), Cloudflare-proxied | `hostname`, `curl -4 ifconfig.me`, `dig fiddy.fun` |
| Redirects | `http → 308 https://fiddy.fun/client`; `www → 308 https://fiddy.fun/client` | `curl -w '%{redirect_url}'` |
| Neighbours unchanged | `/start` 200, `/FSSC/` 200, `/release.json` 200 (`revision 9047c21`), mate.legitclub.com `/api/health` 200 | `curl` |

## How it is served

`/etc/nginx/sites-available/fiddy.fun` (backup: `/root/nginx-backups/fiddy.fun.<ts>.bak`):

```nginx
location = /client {                 # the README/SPEC/bin-fiddy link target: 200, no redirect
    alias /var/www/fiddy-client/index.html;
    default_type text/html;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'" always;
    add_header Cache-Control "public, max-age=300" always;
}
location ^~ /client/ {               # directory form kept for any future assets
    alias /var/www/fiddy-client/;
    index index.html;
    try_files $uri $uri/ =404;
    # same headers
}
```

No backend, no proxy, no service unit: the page is one self-contained HTML file (inline CSS +
one inline script for the copy buttons), so `/client` and `/client/` can both answer 200.

## Deploy (or update)

```bash
cd ~/Projects/fiddy
scripts/deploy-microsite.sh                 # origin/main: freeze, gate, upload, verify served
scripts/deploy-microsite.sh <sha>           # a specific commit
scripts/deploy-microsite.sh --gate-only     # gate the working tree, upload nothing
```

What it does, and why each step is not optional:

1. **Frozen tree.** `git archive <sha> site` into a per-run stage directory — the
   microsite's own rule is to pin the content hash, not the branch, because other
   workers commit to this checkout concurrently.
2. **Local gate** over that tree (`scripts/check-microsite-assets.mjs`): the page's
   `fc:miniapp` must name pictures this tree really carries, at the sizes the spec
   asks, with the splash's ground matching the colour the page declares and its
   drawing centred in its own square. A tree that fails it is never uploaded — the
   frozen tree at origin/main *before* this card fails it with
   `the splash is 512x512; the spec asks 200x200`, which is the defect it was written to catch.
3. **Upload** by tar over `ssh` into `/var/www/fiddy-client/`, **additive**: this
   directory is not the whole of `site/` — the page's own `fiddy-59s.mp4` and
   `.vtt` live there and are not in the repo — so nothing is deleted. The one file
   deliberately not uploaded is `site/ui-policy.json`, which is lintapple's input
   for the page, not a served asset.
4. **Disk gate on the box.** Every uploaded file's sha256 is read back from the
   VPS and compared with the frozen tree — not the upload command's exit code.
5. **Served gate against the origin.** Every file is fetched back from the host
   **by IP** (`--resolve fiddy.fun:443:187.127.148.194`, the CDN out of the path)
   into a mirror of the tree, byte-compared with the frozen tree, and then
   `check-microsite-assets.mjs` is run over *that mirror* — so what is checked is
   what the host answers, live page and live pixels. The splash's size is printed
   from the live PNG's own IHDR, and the edge's copy is fetched cache-busted (a
   gate) and plainly (reported, never judged: the edge's copy of a URL whose name
   never changes is a TTL, not a broken deploy).

A single file can still be piped by hand, and this is the shape it should take —
pin the sha, and read the hash back from the box:

```bash
cd ~/Projects/fiddy
SHA=<sha>; REL=assets/fiddy-splash.png
git show $SHA:site/$REL | ssh root@100.111.203.78 \
  "cat > /var/www/fiddy-client/$REL && chmod 0644 /var/www/fiddy-client/$REL && sha256sum /var/www/fiddy-client/$REL"
git show $SHA:site/$REL | shasum -a 256     # must match
```

## The splash

The "Deploy a Node" mini app (`site/deploy/index.html`) is a second mini app this
repo owns: a cast announces it with `fc:miniapp`, the button launches
`https://fiddy.fun/client/deploy/`, and the host paints
`splashImageUrl` over `splashBackgroundColor` while that page loads. Measured
2026-10-22 (card t_5890479d), on the repo copy and the live copy (both sha256
`b80920cb…`, 85,496 bytes, served 200 `image/png`), that splash was wrong in
three ways and the visible one was not the size:

```
512x512 RGBA                       the spec asks 200x200 (the client listing's
                                   splash was fixed to that by card t_8654d91e)
ground #f8f7f0 (light)             while the page declares splashBackgroundColor
                                   #161715 — the launch shows a pale rectangle
                                   inside a dark square
drawing box (125,113)-(443,398)    centre (284.0,255.5) against the canvas centre
                                   (256,256) — 28px to the RIGHT
```

and the drawing was not Fiddy's mark at all: it is the **sibling FSSC app's
judge-baby** (`site/assets/deploy-card.png` beside it is on-brand chartreuse —
only the splash carried the other product's art). It is the same class of leak
card t_90a2eee2 found in the app-list icon and the embed card, and this one had
been shipping since the file was added, because nothing on this surface could see
inside a picture.

The fix is a fourth variant of the client's own generator:

```bash
cd apps/farcaster-web && node scripts/render-share-card.mjs splash-deploy
#   mark 100x96 at (50,52) — centre (99.5,99.5) on a 200x200 canvas
#   wrote .../site/assets/fiddy-splash.png (200x200)
```

It is the same composition as the client's splash (`splash`): Fiddy's mascot
cropped to its own drawing, 100px of a 200px square — the share the app icon
gives its own mark — on `#161715`, no wordmark, no glow, no address. The two
copies are separate entries in one generator because they are shipped by two
different deploys (the client release carries `public/`, this one carries
`site/`), so neither release can overwrite the other's file and the art can never
drift between them. The client's own splash and embed re-render byte-identical
under this change (`4175fcbf…` and `1f01e3ba…`), which is how the refactor was
proved not to have moved anything it should not have.

## What holds the shape

- `scripts/check-microsite-assets.mjs` — the gate, and it replaces nothing that
  existed: this surface had none. It reads each page's `fc:miniapp`, resolves the
  URLs it names through this tree's mount point (`/client/<rest>` →
  `site/<rest>`, a trailing slash being `index.html` — the answer nginx's
  `try_files $uri $uri/` gives), and then:
  - reads every named picture's size from the **PNG's own IHDR**, so a mis-sized
    asset cannot pass on its name;
  - for the splash, decodes the pixels with the client gate's own reader
    (`apps/farcaster-web/scripts/lib/png.mjs`, shared, not copied) and refuses a
    ground that is not the colour the page paints, a drawing whose box is not
    centred on the canvas within 2px, and a drawing that fills under 30% or over
    80% of the square;
  - refuses a launch URL that names no page in the tree, a card whose `og:image`
    disagrees with the mini app's `imageUrl`, and a tree where no page declares
    `fc:miniapp` at all.
- `.github/workflows/ci.yml`, job `microsite (site/)` — the same gate on every
  push to main and every pull request. Node's own modules and the repo's reader:
  no install, no browser, seconds.
- `scripts/deploy-microsite.sh` — the gate, and then the served copy gated again.

It was proved against seven negative trees, each a copy of `site/` with one
defect, and each refused by name:

| Tree | What was wrong | What the gate said |
| --- | --- | --- |
| `before` | the file that was live (sha256 `b80920cb…`) | `the splash is 512x512; the spec asks 200x200` |
| `oversized` | 512×512, ground right, mark centred | same |
| `light-ground` | 200×200, cream ground `#f8f7f0` | `… is drawn on #f8f7f0 while the page paints #161715 behind it` |
| `offcentre` | 200×200, `#161715`, mark 100×100 pushed to x=150 | `the splash's art is off-centre: its drawing occupies (150,50)-(150,149), centre (150,99.5) … 50px away` |
| `offcentre-real` | the client listing's *pre-fix* splash (sha256 `0e502753…`, what card t_28b3612c replaced) | `… centre (73.5,72.5) on a 200x200 canvas whose centre is (100,100), 27.5px away` — the same 27.5px that card measured by hand |
| `speck` | 200×200, `#161715`, mark 10×10 centred | `the splash's drawing fills 5% of the square; a mark takes about half of it` |
| `no-tag` | the `fc:miniapp` line removed from the page | `no page in this tree declares an fc:miniapp — the Deploy a Node mini app would launch with no splash, no card and no button` |
| `missing-splash` | the splash deleted | `the tree carries no …/assets/fiddy-splash.png for the splash it asks for` |

## Verified on the live host (2026-10-22 — the splash fix)

Deployed as `57a99a0` (PR #30, still open at the time of writing; live is that
commit's `site/` tree, byte for byte). Every row was measured, and measured
again independently of the deploy script's own output.

| Check | Result |
| --- | --- |
| The deploy's own ritual | all four gates passed: the frozen tree's gate, the disk gate (**7 files**, sha256 read back off the box), the served gate (every file fetched from the ORIGIN by IP), and the gate run over the **served mirror** |
| `/client/assets/fiddy-splash.png` at the CDN | 200 `image/png`, `content-length 8226`, sha256 `4175fcbf…` |
| … at the ORIGIN (`--resolve fiddy.fun:443:187.127.148.194`) | 200 `image/png`, `content-length 8226`, sha256 `4175fcbf…` — the same bytes |
| … the same bytes as the repo file | `site/assets/fiddy-splash.png` sha256 `4175fcbf…` |
| The size, read from the PNG's own IHDR | **200×200** (`readUInt32BE(16/20)` on the live bytes), against 512×512 before |
| The drawing's box, measured on the LIVE bytes with `apps/farcaster-web/scripts/lib/png.mjs` | mark 100×96 at (50,52), centre **(99.5,99.5)** on a canvas whose centre is (100,100) — **0.5px off**, fills 48% of the square |
| The ground, against the page's own declaration | live PNG ground `#161715` = the `splashBackgroundColor` the live `/client/deploy/` declares; before it was `#f8f7f0` |
| `/client/deploy/` | 200 `text/html`, byte-identical at the CDN and at the origin, and byte-identical to `site/deploy/index.html` (sha256 `f8f5aedf…`); its `fc:miniapp` still names `splashImageUrl /client/assets/fiddy-splash.png`, `imageUrl /client/assets/deploy-card.png`, launch url `/client/deploy/`, name `Deploy a Node` |
| The other six files in the tree | already byte-identical live before the deploy (`git show` copies vs `sha256sum` on the box), so this deploy changed **one file**: the splash |
| The edge's copy after the cut-over | the plain CDN fetch returns the NEW bytes (the file's name never changes, so this was the risk): `cf-cache-status: EXPIRED` → Cloudflare revalidated from the origin and served them |
| What did NOT change | `/client`, `/client/`, `/client/zh/`, `/client/assets/deploy-card.png`, `…/miniapp-sdk.min.js`, `…/open-in-cloud-shell.svg` — same sha256 live as before; `fiddy-59s.mp4`/`.vtt` still on the host (the upload is additive) |

**Not verified**: the launch transition inside a real Farcaster host, for the same
reason card t_28b3612c could not verify it — that needs a client with the mini app
open, and what a host does with a 200×200 `splashImageUrl` over
`splashBackgroundColor` is the host's code. What is verified is everything the host
reads: the page's declaration, the bytes at the URL it names, the picture's own
size, its ground, and where its drawing sits.

## Verification performed (2026-10-18)

| Check | Result |
| --- | --- |
| `lintapple https://fiddy.fun/client` run from `site/` (390 / 768 / 1440, dark) | **exit 0, 0 findings** |
| Hero renders live | h1 visible 1440×740 / 390×350 box, wordmark, lede, 3-command quickstart card with 3 lime badges; pixel check confirms lime + ink paint in the hero band at both widths |
| Copy buttons | click → label `copied`, clipboard = `fiddy provision --aws` |
| Mobile 390 / tablet 768 / desktop 1440 | no horizontal overflow, no clipped text, no page errors |
| `#safety` anchor (README's second link) | lands with the seed-phrase note in the viewport at 390 / 768 / 1440 |
| Console (live, Playwright) | no page errors; only Cloudflare's own Web Analytics beacon is CSP-blocked (`script-src` does not allow `static.cloudflareinsights.com`) — zone-level setting, harmless, not page code |

`site/ui-policy.json` is the lint policy for this page, generated from its real type system
(measured computed sizes, dark scheme, three viewports). Run the lint from `site/`:

```bash
cd site && lintapple https://fiddy.fun/client        # exit 0 = no UI findings
```

## Pitfalls (learned live)

- **Cloudflare Scrape Shield rewrites literal email addresses** in served HTML into a
  `__cf_email__` span whose decoder script lives at `fiddy.fun/cdn-cgi/...`. This page's CSP is
  `script-src 'unsafe-inline'`, so the decoder is blocked and the Step 0 command rendered as
  `fiddy provision --ssh [email protected]` for every visitor. The `@` is written as `&#64;`
  in `site/index.html`; do not "tidy" it back to a literal `@`.
- Both `/client` and `/client/` answer 200 (the exact-match location serves the file, the
  prefix location serves the directory). `rel=canonical` pins the slashless form that README uses.
- `site/index.html` is the only deployed artifact — a `site/` change needs the deploy
  command above; pushing to `main` does not deploy it. CI runs the gate, never the
  deploy: `microsite (site/)` refuses a bad tree, and only a human running
  `scripts/deploy-microsite.sh` puts it on the host.