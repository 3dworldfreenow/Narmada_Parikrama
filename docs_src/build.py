"""Rebuild docs/index.html (the GitHub Pages version) from data/stops.json.

    python docs_src/build.py
"""
import json
import os

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
rows = json.load(open(os.path.join(BASE, "data", "stops.json"), encoding="utf-8"))
keep = ("st", "n", "v", "vm", "d", "cum", "sp", "acc", "ti", "te", "sa", "gh", "br", "rt", "fd", "sd", "h", "lat", "lng")
data = [{k: r[k] for k in keep if k in r} for r in rows]
tpl = open(os.path.join(BASE, "docs_src", "template.html"), encoding="utf-8").read()
out = tpl.replace("__DATA__", json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/"))
os.makedirs(os.path.join(BASE, "docs"), exist_ok=True)
open(os.path.join(BASE, "docs", "index.html"), "w", encoding="utf-8").write(out)
print(f"docs/index.html written: {len(data)} stops, {sum(1 for d in data if 'lat' in d)} with map locations")
