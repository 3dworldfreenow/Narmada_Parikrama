"""Put the parikrama stops on the map using OpenStreetMap place names.

Step 1 (needs internet, ~20 minutes, run once):  python geocode.py fetch
    Searches every stop's English and Marathi name with Photon (an
    OpenStreetMap search service, https://photon.komoot.io), steered to the
    stop's estimated position (data/geocode_queries.json). Results are saved
    in data/osm_candidates.json.

Step 2 (offline):  python geocode.py match
    Picks the right result for each stop by comparing names, and by checking
    that consecutive stops are about as far apart as the guide's distances
    say (there are many "Hirapur"s). Writes lat/lng into data/stops.json.
    Stops that can't be matched confidently are left without a location.

Step 3:  flask --app app apply-locations
    Copies the locations into the live database. A location confirmed by a
    pilgrim's GPS visit is never overwritten.

Search data © OpenStreetMap contributors (ODbL), via Photon by Komoot.
"""
import difflib
import json
import math
import os
import re
import sys
import time
import unicodedata

BASE = os.path.dirname(os.path.abspath(__file__))
STOPS = os.path.join(BASE, "data", "stops.json")
QUERIES = os.path.join(BASE, "data", "geocode_queries.json")
CANDS = os.path.join(BASE, "data", "osm_candidates.json")


def _clean(s):
    s = re.sub(r"\(.*?\)", " ", s or "")
    return re.sub(r"\s+", " ", re.sub(r"\s+-\s+", " ", s)).strip()


def _photon(q, lat, lon):
    import urllib.parse
    import urllib.request
    url = "https://photon.komoot.io/api/?" + urllib.parse.urlencode(
        {"q": q, "lat": lat, "lon": lon, "limit": 6, "bbox": "72.3,21.1,82.2,23.7"})
    req = urllib.request.Request(url, headers={"User-Agent": "NarmadaParikramaGuide/1.0 (github.com/3dworldfreenow/Narmada_Parikrama)"})
    with urllib.request.urlopen(req, timeout=30) as r:
        j = json.load(r)
    return [[round(f["geometry"]["coordinates"][1], 5), round(f["geometry"]["coordinates"][0], 5),
             f["properties"].get("name", ""), f["properties"].get("osm_key", "") + ":" + f["properties"].get("osm_value", ""),
             f["properties"].get("state", "")] for f in j["features"]]


def fetch():
    import urllib.error
    queries = json.load(open(QUERIES, encoding="utf-8"))
    out = json.load(open(CANDS, encoding="utf-8")) if os.path.exists(CANDS) else {}
    todo = [q for q in queries if str(q[0]) not in out]
    print(f"{len(todo)} stops to search (about {len(todo) * 2.5 / 60:.0f} minutes). Ctrl+C is safe; run again to resume.")
    wait = 1.2
    for n, (i, en, mr, lat, lon) in enumerate(todo, 1):
        res = {}
        for key, name in (("e", _clean(en)), ("m", _clean(mr))):
            if len(name) < (3 if key == "e" else 2):
                continue
            for attempt in range(6):
                try:
                    res[key] = _photon(name, lat, lon)
                    break
                except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                    pause = 30 * (attempt + 1)
                    print(f"  server busy ({e}); waiting {pause}s")
                    time.sleep(pause)
                    wait = min(wait * 1.5, 5)
            time.sleep(wait)
        out[str(i)] = res
        if n % 20 == 0 or n == len(todo):
            json.dump(out, open(CANDS, "w", encoding="utf-8"), ensure_ascii=False)
            print(f"{n} / {len(todo)}")
    json.dump(out, open(CANDS, "w", encoding="utf-8"), ensure_ascii=False)
    print("Saved", CANDS, "- now run: python geocode.py match")


# ------------------------------------------------------------------ name normalising
GENERIC = r"\b(ghat|gav|gaon|gam|kalan|khurd|bujurg|bujurga|buzurg|phata|tola|sangam|road|rod|kuti|hut|dham)\b"


def norm_latin(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    # common village-name endings spelled many ways
    s = re.sub(r"(gaon|gaun|gav|gao|gam)\b", "gav", s)
    s = re.sub(r"(pura|puram|pur)\b", "pur", s)
    s = re.sub(r"(khedi|kheda|khera|kheri)\b", "kher", s)
    s = re.sub(r"(wada|wadi|vada|vadi|vad)\b", "vad", s)
    s = re.sub(r"\(.*?\)", " ", s)
    s = re.sub(GENERIC, " ", s)
    s = re.sub(r"[^a-z]", "", s)
    for a, b in [("ph", "f"), ("w", "v"), ("z", "j"), ("q", "k"), ("ksh", "x"), ("sh", "s"), ("chh", "c"),
                 ("ch", "c"), ("th", "t"), ("dh", "d"), ("bh", "b"), ("gh", "g"), ("kh", "k"), ("jh", "j"),
                 ("ee", "i"), ("oo", "u"), ("aa", "a"), ("ou", "u"), ("y", "i"), ("ri", "r"), ("ru", "r")]:
        s = s.replace(a, b)
    s = re.sub(r"(.)\1+", r"\1", s)
    s = re.sub(r"[aeiou]$", "", s)      # final vowel (Bakava / Bakwa)
    return s


DEV_MAP = str.maketrans({"ळ": "ल", "ण": "न", "ष": "श", "ी": "ि", "ू": "ु", "ं": "", "ँ": "", "़": "",
                         "ॉ": "ो", "ॅ": "े", "ै": "े", "ौ": "ो", "्": "", "व": "ब", "ङ": "न", "ञ": "न"})
GENERIC_DEV = r"(घाट|गाव|गांव|गाँव|कलां|खुर्द|बुजुर्ग|फाटा|टोला|संगम|रोड|कुटि)"


def norm_dev(s):
    s = re.sub(r"\(.*?\)", " ", s)
    s = re.sub(GENERIC_DEV, " ", s)
    s = re.sub(r"[^ऀ-ॿ]", "", s).translate(DEV_MAP)
    s = re.sub(r"[ािुेो]$", "", s)
    return s


def sim(a, b):
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def haversine(a, b):
    r = 6371.0
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


# ------------------------------------------------------------------ matching
GOOD_TYPES = ("place:", "boundary:administrative", "railway:station", "railway:halt", "waterway:", "natural:",
              "tourism:", "amenity:place_of_worship", "historic:", "landuse:residential")


PRIOR_KM = 60   # how far a match may be from the stop's estimated position


def candidates(stop, raw, est=None):
    """Search results whose name looks like this stop's name, best first.
    est = (lat, lng) estimated from the guide's distances between known towns."""
    en = norm_latin(stop["v"] or "")
    mr = norm_dev(stop["vm"] or "")
    seen, out = set(), []
    for lat, lng, name, typ, _state in (raw.get("e") or []) + (raw.get("m") or []):
        if not typ.startswith(GOOD_TYPES):
            continue
        key = (round(lat, 3), round(lng, 3))
        if key in seen:
            continue
        seen.add(key)
        s_lat = sim(en, norm_latin(name)) if len(en) >= 3 else 0
        s_dev = sim(mr, norm_dev(name)) if len(mr) >= 2 else 0
        score = max(s_lat, s_dev)
        if typ.startswith("place:"):
            score += 0.02
        if est:
            d = haversine(est, (lat, lng))
            if d > PRIOR_KM:
                continue
            score -= d / 400          # nearer the expected spot is slightly better
        if score >= 0.8:
            out.append((min(score, 1.0), (lat, lng, name, typ)))
    out.sort(key=lambda x: -x[0])
    return out


def choose(stops, cands):
    """Pick one candidate per stop using the route order.

    Anchors are stops whose best match is strong and unambiguous. Every other
    stop takes the candidate that best fits the distance (from the guide's
    running-total km) to the nearest anchors before and after it.
    """
    n = len(stops)
    chosen = [None] * n

    def cum(i):
        try:
            return float(stops[i]["cum"])
        except (TypeError, ValueError):
            return None

    # 1. anchors: one strong candidate, or the top one is much better than the rest
    for i, c in enumerate(cands):
        if not c:
            continue
        top = c[0]
        others = [x for x in c[1:] if haversine((x[1][0], x[1][1]), (top[1][0], top[1][1])) > 3]
        if top[0] >= 0.92 and (not others or others[0][0] < top[0] - 0.04):
            chosen[i] = (top[1][0], top[1][1], top[0])

    # drop anchors that jump wildly from their anchored neighbours (wrong same-name place)
    for _ in range(2):
        idx = [i for i in range(n) if chosen[i]]
        for k, i in enumerate(idx):
            nb = [j for j in (idx[k - 1] if k else None, idx[k + 1] if k + 1 < len(idx) else None) if j is not None]
            bad = 0
            for j in nb:
                if not chosen[j] or not chosen[i]:
                    continue
                ci, cj = cum(i), cum(j)
                route = abs(ci - cj) if ci is not None and cj is not None else 15 * abs(i - j)
                if haversine(chosen[i][:2], chosen[j][:2]) > route * 1.3 + 12:
                    bad += 1
            if nb and bad == len(nb):
                chosen[i] = None

    # 2. fill the rest using neighbouring anchors
    for _ in range(3):
        for i, c in enumerate(cands):
            if chosen[i] or not c:
                continue
            prev = next((j for j in range(i - 1, -1, -1) if chosen[j]), None)
            nxt = next((j for j in range(i + 1, n) if chosen[j]), None)
            best, best_cost = None, None
            for score, p in c:
                cost, ok = 0.0, True
                for j in (prev, nxt):
                    if j is None:
                        continue
                    ci, cj = cum(i), cum(j)
                    route = abs(ci - cj) if ci is not None and cj is not None else 4 * abs(i - j)
                    d = haversine((p[0], p[1]), chosen[j][:2])
                    if d > route * 1.3 + 6:
                        ok = False
                    cost += abs(d - route * 0.8)
                if prev is None and nxt is None:
                    ok = False
                if ok:
                    cost -= score * 5
                    if best_cost is None or cost < best_cost:
                        best, best_cost = (p[0], p[1], score), cost
            if best:
                chosen[i] = best
    return chosen


def match():
    stops = json.load(open(STOPS, encoding="utf-8"))
    raw = json.load(open(CANDS, encoding="utf-8"))
    est = {q[0]: (q[3], q[4]) for q in json.load(open(QUERIES, encoding="utf-8"))}
    total = 0
    for st in (1, 2, 3):
        idx = [i for i, s in enumerate(stops) if s["st"] == st]
        group = [stops[i] for i in idx]
        cands = [candidates(stops[i], raw.get(str(i), {}), est.get(i)) for i in idx]
        chosen = choose(group, cands)
        for i, c in zip(idx, chosen):
            if c:
                stops[i]["lat"], stops[i]["lng"], stops[i]["geo"] = c[0], c[1], round(c[2], 2)
                total += 1
            else:
                for k in ("lat", "lng", "geo"):
                    stops[i].pop(k, None)
        print(f"Stage {st}: {sum(1 for c in chosen if c)} of {len(group)} placed")
    json.dump(stops, open(STOPS, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print(f"Total: {total} of {len(stops)} stops placed. Saved to {STOPS}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "fetch":
        fetch()
    elif cmd == "match":
        match()
    else:
        print(__doc__)
