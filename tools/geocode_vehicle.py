#!/usr/bin/env python3
"""Find map positions for the bike/car route stops (data/vehicle_route_src.json → data/vehicle_route.json).

Runs in GitHub Actions (tools/…/geocode-vehicle.yml). Uses OpenStreetMap Nominatim, max 1 request
per second as its usage policy asks. Each place found is checked against the route: the straight
distance from the previous placed stop must fit the km given in the list, so a same-named village
far away is never picked. Stops already placed in the walking guide (data/stops.json) are reused.
"""
import json, math, os, sys, time, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
UA = "NarmadaParikramaGuide/1.0 (https://github.com/3dworldfreenow/Narmada_Parikrama)"
STATE = {"MP": "Madhya Pradesh", "MH": "Maharashtra", "GJ": "Gujarat"}
VIEWBOX = "72.3,24.4,82.4,20.6"           # west,north,east,south – the whole parikrama region
SETTLE = {"city", "town", "village", "hamlet", "suburb", "neighbourhood", "locality", "isolated_dwelling", "quarter"}


def km(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 12742 * math.asin(math.sqrt(h))


_last = [0.0]


def search(q):
    wait = 1.1 - (time.time() - _last[0])
    if wait > 0:
        time.sleep(wait)
    _last[0] = time.time()
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
        {"q": q, "format": "jsonv2", "limit": 15, "countrycodes": "in", "viewbox": VIEWBOX, "bounded": 1, "accept-language": "en"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=40) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001
            print("   retry:", e); time.sleep(5 * (attempt + 1))
    return []


def main():
    src = json.load(open(os.path.join(DATA, "vehicle_route_src.json"), encoding="utf-8"))
    guide = {}
    for o in json.load(open(os.path.join(DATA, "stops.json"), encoding="utf-8")):
        if o.get("lat") is not None and o.get("v"):
            guide.setdefault(o["v"].strip().lower(), []).append((o["lat"], o["lng"]))
    found = total = 0
    for part in src["parts"]:
        prev, prev_cum = None, 0
        for s in part["stops"]:
            total += 1
            exp = s["cum"] - prev_cum                      # road km since the last placed stop
            cands = []
            for p in guide.get(s["n"].lower(), []) + guide.get(s["q"].lower(), []):
                cands.append({"lat": p[0], "lng": p[1], "src": "guide", "name": s["n"], "type": "village"})
            if not cands:
                for q in (f'{s["q"]}, {STATE[s["state"]]}', s["q"]):
                    res = search(q)
                    cands = [{"lat": float(r["lat"]), "lng": float(r["lon"]), "src": "osm", "name": r.get("display_name", "")[:90],
                              "type": r.get("addresstype") or r.get("type")} for r in res]
                    if cands:
                        break
            best, why = None, "not found"
            for c in cands:
                d = km((prev["lat"], prev["lng"]), (c["lat"], c["lng"])) if prev else 0
                if prev and d > exp * 1.0 + 8:            # straight line can't be longer than the road
                    continue
                score = (abs(d - 0.72 * exp) if prev else 0) + (0 if c["type"] in SETTLE or c["src"] == "guide" else 6)
                if best is None or score < best[0]:
                    best = (score, c, d)
            if cands and not best:
                why = f"{len(cands)} found, none fits {exp} km"
            if best:
                c = best[1]
                s.update(lat=round(c["lat"], 5), lng=round(c["lng"], 5), geo=c["src"])
                prev, prev_cum = s, s["cum"]; found += 1
                print(f'  ok  P{part["id"]} {s["n"]:<28} {c["src"]:5} {best[2]:6.1f} km straight / {exp} road · {c["name"][:60]}')
            else:
                s.update(lat=None, lng=None, geo=None)
                print(f'  --  P{part["id"]} {s["n"]:<28} {why}')
    json.dump(src, open(os.path.join(DATA, "vehicle_route.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"Placed {found} of {total} stops.")


if __name__ == "__main__":
    sys.exit(main())
