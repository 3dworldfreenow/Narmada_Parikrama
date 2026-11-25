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
LANDMARK = ("statue", "falls", "ghat", "kund", "samadhi", "park", "mahadev", "dam", "tekri", "ashram")


def is_landmark(name):
    return any(w in name.lower() for w in LANDMARK)


def variants(name):
    """Other ways the same village is spelt in English."""
    import re
    base = re.sub(r"\(.*?\)", "", name).replace("–", " ").strip()
    out = [base]
    for a, b in (("w", "v"), ("v", "w"), ("ee", "i"), ("i", "ee"), ("oo", "u"), ("z", "j"), ("aa", "a"), ("kh", "k"),
                 ("dh", "d"), ("bh", "b"), ("ia", "iya"), ("iya", "ia"), ("ai", "ei"), ("ou", "au"), ("uzurg", "ujurg"),
                 ("kheda", "khera"), ("khedi", "kheri"), ("wada", "wara"), ("gaon", "gaon khurd"), ("pura", "pur")):
        if a in base.lower():
            v = re.sub(a, b, base, flags=re.I)
            if v not in out:
                out.append(v)
    return out[:6]


def photon(q, near, box):
    wait = 1.1 - (time.time() - _last[0])
    if wait > 0:
        time.sleep(wait)
    _last[0] = time.time()
    url = "https://photon.komoot.io/api/?" + urllib.parse.urlencode(
        {"q": q, "limit": 15, "lang": "en", "lat": near[0], "lon": near[1], "bbox": ",".join(f"{x:.3f}" for x in box)})
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=40) as r:
            fs = json.load(r).get("features", [])
    except Exception as e:  # noqa: BLE001
        print("   photon:", e); return []
    return [{"lat": f["geometry"]["coordinates"][1], "lng": f["geometry"]["coordinates"][0], "src": "osm",
             "name": ", ".join(x for x in (f["properties"].get("name"), f["properties"].get("county"), f["properties"].get("state")) if x),
             "type": f["properties"].get("osm_value")} for f in fs if f["properties"].get("countrycode", "IN").upper() == "IN"]


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
            if not is_landmark(s["n"]):                # a village, not a canal or a forest area
                cands = [c for c in cands if c["type"] in SETTLE or c["src"] == "guide"]
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
    print(f"Pass 1: placed {found} of {total} stops.")
    found += second_pass(src)
    json.dump(src, open(os.path.join(DATA, "vehicle_route.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"Placed {found} of {total} stops.")


def second_pass(src):
    """For each stop still missing: look between the placed stops before and after it. A place must fit
    the road km to both, and should lie near where the km put it on the line between them."""
    added = 0
    for part in src["parts"]:
        st = part["stops"]
        for i, s in enumerate(st):
            if s.get("lat") is not None:
                continue
            a = next((st[j] for j in range(i - 1, -1, -1) if st[j].get("lat") is not None), None)
            b = next((st[j] for j in range(i + 1, len(st)) if st[j].get("lat") is not None), None)
            if not a and not b:
                continue
            ea = s["cum"] - a["cum"] if a else None
            eb = b["cum"] - s["cum"] if b else None
            if a and b:
                f = ea / max(1, ea + eb)
                guess = (a["lat"] + (b["lat"] - a["lat"]) * f, a["lng"] + (b["lng"] - a["lng"]) * f)
            else:
                guess = (a or b)["lat"], (a or b)["lng"]
            pts = [p for p in (a, b) if p]
            m = 0.25 + max(ea or 0, eb or 0) / 111
            box = (min(p["lng"] for p in pts) - m, min(p["lat"] for p in pts) - m, max(p["lng"] for p in pts) + m, max(p["lat"] for p in pts) + m)
            best = None
            for v in variants(s["q"]) + ([s["n"]] if s["n"] != s["q"] else []):
                cands = photon(v, guess, box)
                if not is_landmark(s["n"]):
                    cands = [c for c in cands if c["type"] in SETTLE]
                for c in cands:
                    p = (c["lat"], c["lng"])
                    if a and km((a["lat"], a["lng"]), p) > ea + 8:
                        continue
                    if b and km(p, (b["lat"], b["lng"])) > eb + 8:
                        continue
                    score = km(p, guess)
                    if best is None or score < best[0]:
                        best = (score, c, v)
                if best and best[0] < 15:
                    break
            if best:
                c = best[1]
                s.update(lat=round(c["lat"], 5), lng=round(c["lng"], 5), geo="osm2")
                added += 1
                print(f'  ok2 P{part["id"]} {s["n"]:<28} "{best[2]}" {best[0]:5.1f} km from the expected spot · {c["name"][:60]}')
            else:
                print(f'  --2 P{part["id"]} {s["n"]:<28} not found between {a["n"] if a else "-"} and {b["n"] if b else "-"}')
    return added


if __name__ == "__main__":
    sys.exit(main())
