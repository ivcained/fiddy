#!/usr/bin/env python3
"""Put the per-page-unfurl locations into the fiddy.fun vhost, once.

    python3 scripts/insert-unfurl-nginx-locations.py <vhost> <snippet>

Run by `scripts/install-fiddy-unfurl-service.sh` on the host, which also takes a
copy of the vhost first (`<vhost>.before-unfurl`). It refuses rather than guesses:

  * a vhost that already carries the locations is left alone (idempotent);
  * a vhost with no `location / {` — the SPA fallback these are inserted before —
    is an error, because inserting anywhere else would change which requests the
    app sees;
  * the file is written only after nginx itself has been asked to validate it
    (`nginx -t` is the caller's next step, and it fails loudly if this went
    wrong).
"""

import sys

vhost, snippet = sys.argv[1], sys.argv[2]
text = open(vhost).read()
block = open(snippet).read()

if "location ^~ /unfurl/" in text:
    print("  vhost already routes /unfurl/ and the page routes: left alone")
    sys.exit(0)

marker = "    location / {\n"
if text.count(marker) != 1:
    raise SystemExit(f"expected exactly one `location / {{` in {vhost}, found {text.count(marker)}")

open(vhost, "w").write(text.replace(marker, block + marker, 1))
print("  vhost: inserted the page routes, the card route and the shell fallback")