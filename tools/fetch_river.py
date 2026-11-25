"""Download the course of the Narmada river from OpenStreetMap (Overpass API),
simplify it and save data/narmada_river.json. Used for the "don't cross the river"
parikrama rule in directions.   python tools/fetch_river.py
Map data © OpenStreetMap contributors (ODbL)."""
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "narmada_river.json")
QUERY = """[out:json][timeout:180];
(
  way["waterway"="river"]["name"~"Narmada|नर्मदा|Rewa|Reva",i](21.3,72.4,23.3,82.0);
  way["waterway"="river"]["name:en"~"Narmada",i](21.3,72.4,23.3,82.0);
);
out geom;"""
SERVERS = ["https://overpass-api.de/api/interpreter",
           "https://overpass.kumi.systems/api/interpreter",
           "https://overpass.private.coffee/api/interpreter"]


def fetch():
    data = urllib.parse.urlencode({"data": QUERY}).encode()
    for url in SERVERS:
        for attempt in range(3):
            try:
                req = urllib.request.Request(url, data=data, headers={
                    "User-Agent": "NarmadaParikramaGuide/1.0 (https://github.com/3dworldfreenow/Narmada_Parikrama)",
                    "Accept": "application/json"})
                with urllib.request.urlopen(req, timeout=240) as r:
                    j = json.load(r)
                print(f"{url}: {len(j.get('elements', []))} ways")
                if j.get("elements"):
                    return j
            except Exception as e:
                print(f"{url} attempt {attempt + 1}: {e}")
                time.sleep(10 * (attempt + 1))
    sys.exit("Could not download the river from any Overpass server.")


def perp_m(p, a, b):
    """Distance in metres from p to segment a-b (local flat approximation)."""
    k = 111320.0
    cos = math.cos(math.radians(p[0]))
    ax, ay, bx, by, px, py = a[1] * k * cos, a[0] * k, b[1] * k * cos, b[0] * k, p[1] * k * cos, p[0] * k
    dx, dy = bx - ax, by - ay
    if dx == dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)


def simplify(pts, tol):
    """Ramer–Douglas–Peucker (iterative)."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        best, idx = 0, None
        for k in range(i + 1, j):
            d = perp_m(pts[k], pts[i], pts[j])
            if d > best:
                best, idx = d, k
        if idx is not None and best > tol:
            keep[idx] = True
            stack += [(i, idx), (idx, j)]
    return [p for p, k in zip(pts, keep) if k]


def main():
    j = fetch()
    lines, raw = [], 0
    for el in j["elements"]:
        geom = el.get("geometry") or []
        pts = [[round(g["lat"], 5), round(g["lon"], 5)] for g in geom]
        raw += len(pts)
        if len(pts) >= 2:
            lines.append(simplify(pts, 25))     # 25 m tolerance keeps the bends
    kept = sum(len(l) for l in lines)
    out = {"name": "Narmada", "source": "OpenStreetMap contributors (ODbL), via Overpass API",
           "fetched": datetime.now(timezone.utc).strftime("%Y-%m-%d"), "lines": lines}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(out, open(OUT, "w"), separators=(",", ":"))
    print(f"{len(lines)} river lines, {raw} points -> {kept} after simplifying; saved {OUT} ({os.path.getsize(OUT)//1024} KB)")


if __name__ == "__main__":
    main()
