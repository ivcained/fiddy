#!/usr/bin/env python3
"""t_3c04fc7b: re-read just the 10 candidate asks and print any reply that is not from @fiddy-one.

Read-only. Refreshes data/dm-tracker.json["asks"] (adds the borodutch ask sent by this card) and
appends a "verifications" list so the tracker's read-back claim is reproducible.
"""
import json, os, re, time, urllib.parse, urllib.request

WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY = [m.group(2).strip().strip('"').strip("'")
       for m in (re.match(r"\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$", l) for l in open(os.path.expanduser("~/.hermes/.env")))
       if m and m.group(1).endswith("NEYNAR_API_KEY")][0]


def get(path, **kw):
    u = "https://api.neynar.com" + path + ("?" + urllib.parse.urlencode(kw) if kw else "")
    r = urllib.request.Request(u, headers={"x-api-key": KEY})
    for _ in range(3):
        try:
            return json.loads(urllib.request.urlopen(r, timeout=25).read().decode())
        except Exception:
            time.sleep(2)
    return {}


ASKS = {
    "jpfraneto": ("0x2b6db8d82962335124ff3a9b8d23a20bb751eeb9", "0x85e6d962ad9160a436b941790a2ea451023c7399"),
    "borodutch": ("0x23b9922530dfad43498f2a8d62c1ec12abecd3d3", "0x233000f1b1e8f43a24c295154de4afb6a75bd8a4"),
    "webthe3rd.eth": ("0x6e3482e1ec6c78983148f47ad5c48ade68601449", "0x1118d48034a70ceff4993325c31dfff446b2982e"),
    "vaibhavmule": ("0x5696cd017f1f80c8264b466fe79d7ae83a4ab64c", "0x7d39f92393172a4efecb6ab3892137e8904ef664"),
    "mddvm": ("0x8cde284a7569253981ee870ed55246d5fd284487", "0x5616bd433204806c7f2b7b4acf5b9defaf29fde0"),
    "sats100m": ("0x5f1de86804bcb42d68fe8fac9ed277cf06590fbf", "0x54f694f934f9e2946496470eaae3511e8e415cce"),
    "eat": ("0xd6b5d214ba6a99dae1da9a056f5671dc9e3dc315", "0x0bc3b39c6476bfa9bc04b42faca51b30941d8bc0"),
    "runn3rr": ("0x6eae8aad085398338c18d3f6be58e3565d8c52cc", "0x2d001899dec092896483658bfdd01f975a99cce0"),
    "0xzoz": ("0x788bbb09c9f36187115cba3347027efd60c2be90", "0xdfeb7bce311459e7e83c6a819952b96f2983466f"),
    "chriscocreated": ("0xef8dc4f931e6ef3808d2d7181e5e420c72ebf65b", "0x4a42eb4b01784e4fa5436f88a3a5aa54c6c6f536"),
}

NOW = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
path = os.path.join(WS, "data", "dm-tracker.json")
doc = json.load(open(path))
by_hash = {a["mine"]: a for a in doc["asks"]}
fresh, replies = [], []
for who, (mine, parent) in ASKS.items():
    c = (get("/v2/farcaster/cast", identifier=mine, type="hash").get("cast") or {})
    conv = get("/v2/farcaster/cast/conversation", identifier=parent, type="hash", reply_depth=1, limit=50)
    direct = ((conv.get("conversation") or {}).get("cast") or {}).get("direct_replies") or []
    rec = {
        "who": who, "mine": mine, "parent": parent, "mine_exists": bool(c),
        "mine_ts": c.get("timestamp"), "mine_author": (c.get("author") or {}).get("username"),
        "appears_as_reply": any(r.get("hash") == mine for r in direct),
        "visible_in_thread": len(direct), "mine_text": (c.get("text") or "")[:400],
        "mine_url": f"https://farcaster.xyz/fiddy-one/{mine}",
        "parent_text": ((get('/v2/farcaster/cast', identifier=parent, type='hash').get('cast') or {}).get('text') or "")[:200],
    }
    by_hash[mine] = rec
    fresh.append(rec)
    for r in direct:
        au = r.get("author") or {}
        if au.get("fid") != 3356372:
            replies.append({"under_ask_for": who, "ts": r.get("timestamp"), "handle": au.get("username"),
                            "text": (r.get("text") or "")[:600]})
    time.sleep(0.2)

doc["asks"] = list(by_hash.values())
doc.setdefault("verifications", []).append({"at": NOW, "asks_rechecked": len(fresh),
                                            "all_exist": all(a["mine_exists"] for a in fresh),
                                            "all_appear_as_reply": all(a["appears_as_reply"] for a in fresh),
                                            "non_agent_replies": replies})
json.dump(doc, open(path, "w"), indent=1)

print(f"re-checked {len(fresh)} asks at {NOW}")
for a in fresh:
    print(f"  {a['who']:16s} exists={a['mine_exists']} reply_in_thread={a['appears_as_reply']} "
          f"ts={str(a['mine_ts'])[:19]} author={a['mine_author']} url={a['mine_url']}")
print(f"non-agent replies found: {len(replies)}")
for r in replies:
    print(f"  [{str(r['ts'])[:19]}] @{r['handle']} ({r['under_ask_for']}): {r['text'][:300]}")