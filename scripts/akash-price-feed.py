#!/usr/bin/env python3
"""Fetch real Akash bids for the Fiddy node SDL and publish them as JSON.

Creating a deployment and reading bids costs nothing; only accepting a bid
spends. This script never accepts a lease, and always closes the deployment
it created (even on failure). Key comes from /etc/fiddy/akash.env (mode 600).
Output: /var/www/fiddy-client/akash/prices.json (public, no secrets).
"""
import json
import os
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone

API = "https://console-api.akash.network"
SDL_PATH = "/var/www/fiddy-client/akash/sdl.yaml"
OUT_PATH = "/var/www/fiddy-client/akash/prices.json"
BLOCK_SECONDS = 6.0
SECONDS_PER_MONTH = 30 * 24 * 3600


def load_key():
    try:
        for line in open("/etc/fiddy/akash.env"):
            if line.startswith("AKASH_API_KEY="):
                return line.strip().split("=", 1)[1]
    except FileNotFoundError:
        pass
    raise SystemExit(0)  # no key yet: cron stays quiet until the owner adds one


def call(key, method, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(API + path, data=data, method=method,
        headers={"x-api-key": key, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as response:
        body = response.read().decode()
    return json.loads(body) if body else {}


def akt_usd():
    try:
        with urllib.request.urlopen(
            "https://api.coingecko.com/api/v3/simple/price?ids=akash-network&vs_currencies=usd",
            timeout=15) as response:
            return json.load(response)["akash-network"]["usd"]
    except Exception:
        return None


def monthly_usd(uakt, price):
    akt = uakt * (SECONDS_PER_MONTH / BLOCK_SECONDS) / 1_000_000
    return akt * price if price else None


def main():
    key = load_key()
    sdl = open(SDL_PATH).read()
    dseq = None
    bids = []
    try:
        created = call(key, "POST", "/v1/deployments", {"data": {"sdl": sdl}})
        dseq = created["data"]["dseq"]
        deadline = time.time() + 75
        while time.time() < deadline:
            time.sleep(12)
            try:
                result = call(key, "GET", "/v1/bids?dseq=%s" % dseq)
                bids = result.get("data") or result.get("bids") or []
            except (urllib.error.URLError, ValueError):
                bids = []
            if bids:
                break
    finally:
        if dseq is not None:
            try:
                call(key, "DELETE", "/v1/deployments/%s" % dseq)
            except Exception:
                pass  # never leaves a lease behind: no bid was ever accepted

    price = akt_usd()
    rows = []
    for bid in bids:
        amount = None
        for path in (("price", "amount"), ("price", "uakt"), ("uakt",), ("amount",)):
            cursor = bid
            try:
                for part in path:
                    cursor = cursor[part]
                amount = float(cursor)
                break
            except (KeyError, TypeError, ValueError):
                continue
        if amount is not None:
            rows.append({"uakt_per_block": amount, "usd_per_month": monthly_usd(amount, price)})
    rows.sort(key=lambda r: r["uakt_per_block"])
    out = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "akt_usd": price,
        "bid_count": len(rows),
        "note": "Real provider bids for the Fiddy node SDL. No lease was accepted; the deployment was closed.",
        "cheapest": rows[0] if rows else None,
        "median": rows[len(rows) // 2] if rows else None,
    }
    tmp = OUT_PATH + ".tmp"
    with open(tmp, "w") as handle:
        json.dump(out, handle, indent=2)
    os.replace(tmp, OUT_PATH)
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
