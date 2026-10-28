"""Generate parity fixtures for the TypeScript port of phunk's score().

The score() below is copied VERBATIM from phunk-client/src/phunk/recommend.py
(only the imports are inlined), so any output here is the real Python
output. Random cases + hand cases are written as JSON for
recommend.test.ts to assert the TS port against.
"""
import json
import random
import sys
from dataclasses import dataclass, field

CHANNEL_POINTS = 2


@dataclass
class Suggestion:
    fid: int
    score: int
    followed_by: list[int] = field(default_factory=list)
    channels: list[str] = field(default_factory=list)


def score(me, following, their_follows, channel_authors, *, min_followed_by=2,
          exclude=frozenset(), limit=None):
    skip = set(following) | {me} | set(exclude)
    by: dict[int, list[int]] = {}
    for friend, targets in their_follows.items():
        for t in targets:
            if t not in skip:
                by.setdefault(t, []).append(friend)
    chans: dict[int, list[str]] = {}
    posts: dict[int, int] = {}
    for url, authors in channel_authors.items():
        for fid, n in authors.items():
            if fid not in skip:
                chans.setdefault(fid, []).append(url)
                posts[fid] = posts.get(fid, 0) + n
    out = []
    for fid in set(by) | set(chans):
        fb, ch = sorted(by.get(fid, [])), sorted(chans.get(fid, []))
        if len(fb) < min_followed_by and not ch:
            continue
        out.append(Suggestion(fid, len(fb) + CHANNEL_POINTS * len(ch), fb, ch))
    out.sort(key=lambda s: (-s.score, -len(s.followed_by), -posts.get(s.fid, 0), s.fid))
    return out if limit is None else out[:limit]


def case_to_json(case_id, me, following, their_follows, channel_authors, kwargs):
    result = score(me, following, their_follows, channel_authors, **kwargs)
    return {
        "id": case_id,
        "me": me,
        "following": sorted(following),
        "theirFollows": {str(k): sorted(v) for k, v in their_follows.items()},
        "channelAuthors": {k: {str(fk): n for fk, n in v.items()}
                           for k, v in channel_authors.items()},
        "kwargs": {k: (sorted(v) if isinstance(v, (set, frozenset)) else v)
                   for k, v in kwargs.items()},
        "expected": [{"fid": s.fid, "score": s.score,
                      "followedBy": s.followed_by, "channels": s.channels}
                     for s in result],
    }


cases = []

# --- hand cases: the rules the card names ---
# min_followed_by: one mutual is not enough without a channel
cases.append(case_to_json(
    "single-mutual-excluded", 1, {2}, {2: {3}}, {}, {}))
# one mutual + a shared channel is enough
cases.append(case_to_json(
    "single-mutual-plus-channel", 1, {2}, {2: {3}},
    {"https://farcaster.xyz/~/channel/founders": {3: 4}}, {}))
# channel-only candidate
cases.append(case_to_json(
    "channel-only", 1, {2}, {2: {3}},
    {"https://warpcast.com/~/channel/dev": {9: 2, 10: 1}}, {}))
# already-followed and self are never suggested
cases.append(case_to_json(
    "skip-following-and-me", 1, {2, 3}, {2: {1, 3, 4}, 3: {1, 2, 4}}, {}, {}))
# exclude
cases.append(case_to_json(
    "exclude", 1, {2, 3}, {2: {4, 5}, 3: {4, 5}}, {},
    {"exclude": {5}}))
# limit
cases.append(case_to_json(
    "limit", 1, {2, 3, 6}, {2: {4, 5}, 3: {4, 5}, 6: {5, 7}}, {},
    {"limit": 2}))
# tie-break: same score -> more followed_by first
#   4: followed by 2 and 3 (score 2); 5: one channel, no mutuals (score 2).
#   4 ranks first (2 mutuals beats 0 mutuals at the same score).
cases.append(case_to_json(
    "tie-more-mutuals", 1, {2, 3}, {2: {4}, 3: {4}},
    {"https://warpcast.com/~/channel/x": {5: 1}}, {}))
# tie-break: same score AND same mutual count -> more channel posts first
cases.append(case_to_json(
    "tie-more-channel-posts", 1, {2, 3}, {2: {4}, 3: {5}},
    {"https://warpcast.com/~/channel/x": {4: 1, 5: 7}}, {}))
# tie-break: everything equal -> older account (lower fid) first
cases.append(case_to_json(
    "tie-older-account", 1, {2, 3}, {2: {40, 41}, 3: {40, 41}}, {}, {}))
# CHANNEL_POINTS arithmetic: 1 mutual + 1 channel (3) beats 2 mutuals (2)...
# no wait: score(1 mutual)=1, +2 channel = 3 vs 2 mutuals = 2.
cases.append(case_to_json(
    "channel-points-beat-mutuals", 1, {2, 3},
    {2: {4}, 3: {5, 6}},
    {"https://warpcast.com/~/channel/x": {4: 2}}, {}))
# posts counter accumulates across channels
cases.append(case_to_json(
    "posts-accumulate", 1, {2}, {2: {3}},
    {"https://warpcast.com/~/channel/a": {5: 1},
     "https://warpcast.com/~/channel/b": {5: 2, 6: 9}}, {}))

# --- random cases ---
rng = random.Random(20261028)
for i in range(60):
    me = rng.randint(1, 5)
    world = list(range(1, 61))
    following = set(rng.sample(world, rng.randint(0, 12)))
    their_follows = {
        f: set(rng.sample(world, rng.randint(0, 15)))
        for f in rng.sample(world, rng.randint(0, 10))
    }
    channel_authors = {
        f"https://warpcast.com/~/channel/c{c}": {
            f: rng.randint(1, 9)
            for f in rng.sample(world, rng.randint(0, 12))
        }
        for c in range(rng.randint(0, 3))
    }
    kwargs = {}
    if rng.random() < 0.4:
        kwargs["min_followed_by"] = rng.randint(1, 3)
    if rng.random() < 0.3:
        kwargs["exclude"] = set(rng.sample(world, rng.randint(0, 4)))
    if rng.random() < 0.5:
        kwargs["limit"] = rng.randint(0, 8)
    cases.append(case_to_json(f"random-{i}", me, following,
                              their_follows, channel_authors, kwargs))

out = sys.argv[1] if len(sys.argv) > 1 else "score-parity.json"
with open(out, "w") as f:
    json.dump(cases, f, indent=1)
print(f"{len(cases)} cases -> {out}")
