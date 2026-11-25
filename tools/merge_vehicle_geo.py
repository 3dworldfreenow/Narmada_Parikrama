#!/usr/bin/env python3
"""Combine two geocoding runs of the bike/car route and drop positions that don't fit the route.
Usage: merge_vehicle_geo.py run1.json run2.json run1.log > data/vehicle_route.json"""
import json, math, re, sys

def km(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    return 12742 * math.asin(math.sqrt(math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2))

r1, r2 = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
rough = set()                                    # run-1 matches that were an area, not the place itself
for line in open(sys.argv[3], errors="replace"):
    m = re.search(r"ok  P(\d) (.+?)\s{2,}(guide|osm)\s.*· (.*)$", line)
    if m and re.match(r"^([\w ]+ Tahsil|.*Wildlife Sanctuary|.*Branch Canal)", m.group(4)):
        rough.add((int(m.group(1)), m.group(2).strip()))
log = []
for p1, p2 in zip(r1["parts"], r2["parts"]):
    for s1, s2 in zip(p1["stops"], p2["stops"]):
        if s2.get("lat") is None and s1.get("lat") is not None and (p1["id"], s1["n"]) not in rough:
            s2.update(lat=s1["lat"], lng=s1["lng"], geo=s1["geo"])
            log.append(f"from run 1: P{p1['id']} {s1['n']}")
    # consistency: a stop that is too far from BOTH its placed neighbours is wrong; remove it and repeat
    while True:
        placed = [s for s in p2["stops"] if s.get("lat") is not None]
        bad = None
        for i, s in enumerate(placed):
            def fits(o):
                return km((s["lat"], s["lng"]), (o["lat"], o["lng"])) <= abs(s["cum"] - o["cum"]) + 10
            nb = [placed[j] for j in (i - 1, i + 1) if 0 <= j < len(placed)]
            if nb and not any(fits(o) for o in nb) and s["geo"] != "guide":
                bad = s; break
        if not bad:
            break
        log.append(f"dropped (doesn't fit the route km): P{p2['id']} {bad['n']}")
        bad.update(lat=None, lng=None, geo=None)
n = sum(s.get("lat") is not None for p in r2["parts"] for s in p["stops"]); t = sum(len(p["stops"]) for p in r2["parts"])
print("\n".join(log), f"\nPlaced {n} of {t}", file=sys.stderr)
json.dump(r2, sys.stdout, ensure_ascii=False, indent=1)
