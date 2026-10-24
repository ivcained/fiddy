#!/usr/bin/env python3
"""t_3c04fc7b: live state of every candidate on the DM list + every ask we know of.

Read-only. Writes data/dm-tracker.json and prints a compact table.
Sources: api.neynar.com (key from ~/.hermes/.env), public hub as fallback.
"""
import json, os, re, sys, time, urllib.parse, urllib.request

WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY = None
for line in open(os.path.expanduser("~/.hermes/.env")):
    m = re.match(r"\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$", line)
    if m and m.group(1).endswith("NEYNAR_API_KEY"):
        KEY = m.group(2).strip().strip('"').strip("'")
assert KEY, "no Neynar key"

HITS = {"n": 0}


def get(path, **p):
    url = "https://api.neynar.com" + path + ("?" + urllib.parse.urlencode(p) if p else "")
    r = urllib.request.Request(url, headers={"x-api-key": KEY})
    HITS["n"] += 1
    if HITS["n"] % 25 == 0:
        time.sleep(1.0)
    for _ in range(3):
        try:
            return json.loads(urllib.request.urlopen(r, timeout=25).read().decode())
        except Exception as e:
            last = str(e)
            time.sleep(2)
    return {"_error": last}


# candidate list from t_24468601 (handle, fid, band) - fids as published there
CANDIDATES = [
    ("jpfraneto", 16098, "high"),
    ("borodutch", 1356, "high"),
    ("webthe3rd.eth", 374565, "high"),
    ("vaibhavmule", 1356870, "high"),
    ("mddvm", 2611706, "high"),
    ("sats100m", 3355244, "medium"),
    ("eat", 18850, "medium"),
    ("runn3rr", 18763, "medium"),
    ("0xzoz", 1918, "medium"),
    ("chriscocreated", 5701, "medium"),
]

# asks already on the network (from t_7fff0bb5 docs/VOUCHER-OUTREACH.md section 8), as @fiddy-one
ASKS = [
    ("jpfraneto", "0x2b6db8d82962335124ff3a9b8d23a20bb751eeb9", "0x85e6d962ad9160a436b941790a2ea451023c7399"),
    ("jpfraneto", "0xd6c8ca10aeb9278596551b5ac1617e6e63cce968", None),
    ("webthe3rd.eth", "0x6e3482e1ec6c78983148f47ad5c48ade68601449", "0x1118d48034a70ceff4993325c31dfff446b2982e"),
    ("vaibhavmule", "0x5696cd017f1f80c8264b466fe79d7ae83a4ab64c", "0x7d39f92393172a4efecb6ab3892137e8904ef664"),
    ("mddvm", "0x8cde284a7569253981ee870ed55246d5fd284487", "0x5616bd433204806c7f2b7b4acf5b9defaf29fde0"),
    ("sats100m", "0x5f1de86804bcb42d68fe8fac9ed277cf06590fbf", "0x54f694f934f9e2946496470eaae3511e8e415cce"),
    ("eat", "0xd6b5d214ba6a99dae1da9a056f5671dc9e3dc315", "0x0bc3b39c6476bfa9bc04b42faca51b30941d8bc0"),
    ("runn3rr", "0x6eae8aad085398338c18d3f6be58e3565d8c52cc", "0x2d001899dec092896483658bfdd01f975a99cce0"),
    ("0xzoz", "0x788bbb09c9f36187115cba3347027efd60c2be90", "0xdfeb7bce311459e7e83c6a819952b96f2983466f"),
    ("chriscocreated", "0xef8dc4f931e6ef3808d2d7181e5e420c72ebf65b", "0x4a42eb4b01784e4fa5436f88a3a5aa54c6c6f536"),
]
STANDALONE = "0xfcb5a1c28c01a8e7c88ff967bac2d13a4f6b728f"

NOW = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
out = {"built_at": NOW, "candidates": [], "asks": [], "replies": [], "ivc_mentions": [], "fiddy_search": []}

# --- 1. candidate profiles, resolved live by fid (catches the wrong-fid risk) ---
fids = ",".join(str(f) for _, f, _ in CANDIDATES) + ",17223"
bulk = get("/v2/farcaster/user/bulk", fids=fids)
by_fid = {u["fid"]: u for u in (bulk.get("users") or [])}
for handle, fid, band in CANDIDATES:
    u = by_fid.get(fid) or {}
    # newest casts for this fid
    fc = get("/v2/farcaster/feed/user/casts", fid=fid, limit=5)
    casts = fc.get("casts") or []
    out["candidates"].append({
        "handle": handle,
        "fid_listed": fid,
        "fid_live": u.get("fid"),
        "username_live": u.get("username"),
        "display_name": u.get("display_name"),
        "followers": u.get("follower_count"),
        "following": u.get("following_count"),
        "fid_matches_handle": (u.get("username") == handle) if u else None,
        "newest_cast_ts": (casts[0].get("timestamp") if casts else None),
        "newest_cast_text": ((casts[0].get("text") or "")[:300] if casts else None),
        "newest_casts": [
            {"ts": c.get("timestamp"), "hash": c.get("hash"), "text": (c.get("text") or "")[:300]}
            for c in casts[:5]
        ],
    })
    time.sleep(0.2)
out["alt_fid_17223"] = {k: (by_fid.get(17223, {}) or {}).get(k) for k in ("username", "fid")}

# --- 2. every ask cast: does it exist, when, and is it really a reply to that parent ---
for who, mine, parent in ASKS:
    c = (get("/v2/farcaster/cast", identifier=mine, type="hash").get("cast") or {})
    p = (get("/v2/farcaster/cast", identifier=parent, type="hash").get("cast") or {}) if parent else {}
    conv = get("/v2/farcaster/cast/conversation", identifier=parent, type="hash", reply_depth=1, limit=50) if parent else {}
    direct = ((conv.get("conversation") or {}).get("cast") or {}).get("direct_replies") or []
    out["asks"].append({
        "who": who,
        "mine": mine,
        "mine_exists": bool(c),
        "mine_ts": c.get("timestamp"),
        "mine_text": (c.get("text") or "")[:400],
        "mine_author": (c.get("author") or {}).get("username"),
        "mine_url": f"https://farcaster.xyz/fiddy-one/{mine}",
        "parent": parent,
        "parent_ts": p.get("timestamp"),
        "parent_text": (p.get("text") or "")[:200],
        "appears_as_reply": any(r.get("hash") == mine for r in direct),
        "visible_in_thread": len(direct),
    })
    time.sleep(0.2)

sc = (get("/v2/farcaster/cast", identifier=STANDALONE, type="hash").get("cast") or {})
out["standalone_ask"] = {"hash": STANDALONE, "exists": bool(sc), "ts": sc.get("timestamp"),
                         "text": (sc.get("text") or "")[:400],
                         "url": f"https://farcaster.xyz/fiddy-one/{STANDALONE}"}

# --- 3. did anyone answer anything? replies under every ask + both notification feeds ---
asked_hashes = [a[1] for a in ASKS] + [STANDALONE] + [a[2] for a in ASKS if a[2]]
for h in asked_hashes:
    d = get("/v2/farcaster/cast/conversation", identifier=h, type="hash", reply_depth=2, limit=50)
    cast = ((d.get("conversation") or {}).get("cast") or {})
    for r in (cast.get("direct_replies") or []):
        au = (r.get("author") or {})
        if au.get("fid") == 3356372:
            continue
        out["replies"].append({"under": h, "ts": r.get("timestamp"), "handle": au.get("username"),
                               "fid": au.get("fid"), "hash": r.get("hash"),
                               "text": (r.get("text") or "")[:600]})
    time.sleep(0.2)

for name, fid in (("ivc", 191554), ("fiddy-one", 3356372)):
    d = get("/v2/farcaster/notifications", fid=fid, limit=50)
    for n in (d.get("notifications") or []):
        c = n.get("cast")
        if not c:
            continue
        au = c.get("author") or {}
        out["ivc_mentions"].append({"inbox": name, "type": n.get("type"), "ts": c.get("timestamp"),
                                    "handle": au.get("username"), "fid": au.get("fid"),
                                    "hash": c.get("hash"), "text": (c.get("text") or "")[:400]})
    time.sleep(0.3)

for q in ("fiddy", "fiddy.fun"):
    d = get("/v2/farcaster/cast/search", q=q, mode="literal", limit=25, sort_type="desc_chron")
    for c in ((d.get("result") or {}).get("casts") or []):
        out["fiddy_search"].append({"q": q, "ts": c.get("timestamp"),
                                    "handle": (c.get("author") or {}).get("username"),
                                    "fid": (c.get("author") or {}).get("fid"),
                                    "hash": c.get("hash"), "text": (c.get("text") or "")[:400]})
    time.sleep(0.3)

json.dump(out, open(os.path.join(WS, "data", "dm-tracker.json"), "w"), indent=1)

print(f"== profiles ({NOW}) ==")
for c in out["candidates"]:
    print(f"{c['handle']:16s} listed_fid={c['fid_listed']:<8} live={c['username_live']!s:14s} "
          f"match={c['fid_matches_handle']} followers={c['followers']} last={str(c['newest_cast_ts'])[:19]}")
print("alt_fid_17223:", out["alt_fid_17223"])
print("\n== asks ==")
for a in out["asks"]:
    print(f"{a['who']:16s} exists={a['mine_exists']} ts={str(a['mine_ts'])[:19]} reply={a['appears_as_reply']} "
          f"thread_replies={a['visible_in_thread']} author={a['mine_author']}")
print("standalone:", out["standalone_ask"]["exists"], out["standalone_ask"]["ts"])
print(f"\n== non-agent replies under our asks: {len(out['replies'])} ==")
for r in out["replies"]:
    print(f"[{str(r['ts'])[:19]}] @{r['handle']} under {r['under'][:14]}: {r['text'][:200]}")
print(f"\n== mentions (ivc/fiddy-one inboxes): {len(out['ivc_mentions'])} ==")
for m in out["ivc_mentions"][:25]:
    print(f"[{str(m['ts'])[:19]}] {m['inbox']} {m['type']} @{m['handle']}: {m['text'][:180]}")
print(f"\n== fresh network posts mentioning fiddy: {len(out['fiddy_search'])} ==")
for s in out["fiddy_search"][:25]:
    print(f"[{str(s['ts'])[:19]}] @{s['handle']}: {s['text'][:180]}")
print(f"\nrequests={HITS['n']}")