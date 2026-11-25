#!/usr/bin/env python3
"""Download the Narmada Parikrama offline map without root.

Started by the admin page (Admin → Offline map) as a separate background process.
Needs only Python's standard library and internet access to github.com and
build.protomaps.com. Writes progress to <tiles dir>/download.json and
download.log, and the map to <tiles dir>/narmada.pmtiles (+ narmada.json).

    python3 tools/map_download.py /var/lib/narmada/tiles/narmada.pmtiles 14

Map data © OpenStreetMap contributors (ODbL). Basemap © Protomaps.
"""
import datetime as dt
import io
import json
import os
import platform
import shutil
import ssl
import subprocess
import sys
import tarfile
import time
import urllib.request

BBOX = os.environ.get("BBOX", "72.4,21.0,82.0,23.7")      # west,south,east,north – the whole parikrama
UA = {"User-Agent": "narmada-parikrama-map-download"}


def _ssl_context():
    """uv's standalone Python may not find CentOS's certificates on its own, so look for them."""
    ctx = ssl.create_default_context()
    if ctx.get_ca_certs():
        return ctx
    for f in ("/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/certs/ca-certificates.crt", "/etc/ssl/cert.pem"):
        if os.path.isfile(f):
            return ssl.create_default_context(cafile=f)
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ctx


CTX = _ssl_context()


def fetch(url, method="GET", timeout=60):
    return urllib.request.urlopen(urllib.request.Request(url, method=method, headers=UA), timeout=timeout, context=CTX)


def main(out, maxzoom):
    tiles = os.path.dirname(out)
    os.makedirs(tiles, exist_ok=True)
    status_f, log_f = os.path.join(tiles, "download.json"), os.path.join(tiles, "download.log")
    st = {"state": "running", "step": "Starting", "pid": os.getpid(), "maxzoom": maxzoom,
          "started": time.time(), "finished": None, "error": None, "out": out}

    def save(**kw):
        st.update(kw)
        tmp = status_f + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(st, fh)
        os.replace(tmp, status_f)

    log = open(log_f, "w", buffering=1)
    say = lambda m: log.write(time.strftime("%H:%M:%S ") + m + "\n")
    try:
        # 1. the pmtiles tool: use one already installed, else fetch it into the tiles folder
        save(step="Getting the pmtiles tool")
        tool = shutil.which("pmtiles") or ("/usr/local/bin/pmtiles" if os.access("/usr/local/bin/pmtiles", os.X_OK) else None)
        mine = os.path.join(tiles, "bin", "pmtiles")
        if not tool and os.access(mine, os.X_OK):
            tool = mine
        if not tool:
            arch = {"x86_64": "x86_64", "amd64": "x86_64", "aarch64": "arm64", "arm64": "arm64"}.get(platform.machine().lower())
            if not arch:
                raise RuntimeError("Unsupported CPU: " + platform.machine())
            rel = json.load(fetch("https://api.github.com/repos/protomaps/go-pmtiles/releases/latest"))
            url = next(a["browser_download_url"] for a in rel["assets"] if a["name"].endswith(f"_Linux_{arch}.tar.gz"))
            say("Downloading " + url)
            data = fetch(url, timeout=300).read()
            with tarfile.open(fileobj=io.BytesIO(data)) as tf:
                member = next(m for m in tf.getmembers() if os.path.basename(m.name) == "pmtiles" and m.isfile())
                os.makedirs(os.path.dirname(mine), exist_ok=True)
                with tf.extractfile(member) as src, open(mine, "wb") as dst:
                    shutil.copyfileobj(src, dst)
            os.chmod(mine, 0o755)
            tool = mine
        say("Using " + tool)

        # 2. latest daily world map build
        save(step="Finding the latest map build")
        src = os.environ.get("MAP_SOURCE")            # optional: a fixed build URL
        for i in ([] if src else range(15)):
            d = (dt.datetime.utcnow() - dt.timedelta(days=i)).strftime("%Y%m%d")
            u = f"https://build.protomaps.com/{d}.pmtiles"
            try:
                fetch(u, method="HEAD", timeout=30)
                src = u
                break
            except Exception:
                continue
        if not src:
            raise RuntimeError("No recent map build found at build.protomaps.com – try again later.")
        say("Using " + src)

        # 3. cut out the Narmada region
        save(step=f"Downloading the Narmada region (zoom 0–{maxzoom})", source=src)
        part = out + ".part"
        p = subprocess.Popen([tool, "extract", src, part, f"--bbox={BBOX}", f"--maxzoom={maxzoom}", "--download-threads=4"],
                             stdout=log, stderr=subprocess.STDOUT)
        save(tool_pid=p.pid)
        while p.poll() is None:
            time.sleep(3)
            save(part_bytes=os.path.getsize(part) if os.path.exists(part) else 0)
        if p.returncode != 0:
            raise RuntimeError(f"pmtiles extract failed (code {p.returncode}) – see the log below.")
        os.replace(part, out)
        meta = {"maxzoom": maxzoom, "source": src, "downloaded": time.time(), "bytes": os.path.getsize(out), "bbox": BBOX}
        with open(os.path.join(tiles, "narmada.json"), "w") as fh:
            json.dump(meta, fh)
        say(f"Saved {out} ({meta['bytes'] / 1e6:.0f} MB)")
        save(state="done", step="Finished", finished=time.time(), bytes=meta["bytes"])
    except Exception as e:  # noqa: BLE001 – report anything to the admin page
        say("ERROR: " + str(e))
        save(state="error", step="Failed", error=str(e), finished=time.time())
    finally:
        log.close()


if __name__ == "__main__":
    main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 14)
