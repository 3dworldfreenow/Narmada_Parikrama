#!/usr/bin/env bash
# Download the map of the Narmada Parikrama region onto this server, so the
# app shows maps from your own server (no OpenStreetMap tile servers, no API key).
#
#   sudo bash /opt/narmada/deploy/download-map.sh            # zoom up to 14 (default)
#   sudo MAXZOOM=13 bash /opt/narmada/deploy/download-map.sh # smaller file, less detail
#   sudo MAXZOOM=15 bash /opt/narmada/deploy/download-map.sh # more detail, bigger file
#
# How it works: Protomaps publishes a free daily map of the whole world built
# from OpenStreetMap data (https://maps.protomaps.com/builds). The `pmtiles`
# tool cuts out just our region (Amarkantak → Gulf of Khambhat, ±25 km) and
# saves it as ONE file. The app then draws the map from that file.
# Re-run any time (e.g. monthly) to refresh the map data.
#
# Map data © OpenStreetMap contributors (ODbL). Basemap © Protomaps.
set -euo pipefail

MAXZOOM="${MAXZOOM:-14}"
BBOX="${BBOX:-72.4,21.0,82.0,23.7}"          # west,south,east,north – the whole parikrama
DATA_DIR="${DATA_DIR:-/var/lib/narmada}"
OUT_DIR="$DATA_DIR/tiles"
OUT="$OUT_DIR/narmada.pmtiles"
ENV_FILE=/etc/narmada.env
BIN=/usr/local/bin/pmtiles
say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "Please run as root (sudo)."; exit 1; }

# ---------------------------------------------------------------- 1. pmtiles tool
if [ ! -x "$BIN" ]; then
  say "Installing the pmtiles tool"
  case "$(uname -m)" in
    x86_64) ARCH=x86_64 ;; aarch64|arm64) ARCH=arm64 ;; *) echo "Unsupported CPU: $(uname -m)"; exit 1 ;;
  esac
  VER=$(curl -fsSL https://api.github.com/repos/protomaps/go-pmtiles/releases/latest \
        | grep -m1 '"tag_name"' | sed -E 's/.*"v?([^"]+)".*/\1/')
  [ -n "$VER" ] || { echo "Could not find the latest pmtiles version on GitHub."; exit 1; }
  TMP=$(mktemp -d)
  curl -fsSL "https://github.com/protomaps/go-pmtiles/releases/download/v${VER}/go-pmtiles_${VER}_Linux_${ARCH}.tar.gz" \
    | tar -xz -C "$TMP"
  install -m 755 "$TMP/pmtiles" "$BIN"
  rm -rf "$TMP"
fi
"$BIN" version 2>/dev/null || true

# ---------------------------------------------------------------- 2. latest daily build
say "Finding the latest Protomaps daily map build"
SRC=""
for i in $(seq 0 14); do
  D=$(date -u -d "-$i day" +%Y%m%d)
  if curl -fsI "https://build.protomaps.com/$D.pmtiles" >/dev/null 2>&1; then
    SRC="https://build.protomaps.com/$D.pmtiles"; break
  fi
done
[ -n "$SRC" ] || { echo "No recent build found at build.protomaps.com – try again later."; exit 1; }
echo "Using $SRC"

# ---------------------------------------------------------------- 3. cut out our region
say "Downloading the Narmada region (zoom 0–$MAXZOOM). This can take 5–30 minutes."
mkdir -p "$OUT_DIR"
"$BIN" extract "$SRC" "$OUT.part" --bbox="$BBOX" --maxzoom="$MAXZOOM" --download-threads=4
mv -f "$OUT.part" "$OUT"
id narmada >/dev/null 2>&1 && chown -R narmada:narmada "$OUT_DIR"
command -v getenforce >/dev/null && [ "$(getenforce)" != "Disabled" ] && chcon -R -t httpd_sys_content_t "$OUT_DIR" 2>/dev/null || true
echo "Saved $OUT ($(du -h "$OUT" | cut -f1))"

# ---------------------------------------------------------------- 4. tell the app to use it
if [ -f "$ENV_FILE" ]; then
  grep -q '^MAP_PMTILES=' "$ENV_FILE" && sed -i "s|^MAP_PMTILES=.*|MAP_PMTILES=$OUT|" "$ENV_FILE" || echo "MAP_PMTILES=$OUT" >> "$ENV_FILE"
  grep -q '^MAP_MAXZOOM=' "$ENV_FILE" && sed -i "s|^MAP_MAXZOOM=.*|MAP_MAXZOOM=$MAXZOOM|" "$ENV_FILE" || echo "MAP_MAXZOOM=$MAXZOOM" >> "$ENV_FILE"
  systemctl restart narmada 2>/dev/null || true
  say "Done. The app now uses the map stored on this server."
else
  say "Done. Set MAP_PMTILES=$OUT and MAP_MAXZOOM=$MAXZOOM for the app, then restart it."
fi
echo "To go back to online OpenStreetMap tiles: remove the MAP_PMTILES line from $ENV_FILE and restart narmada."
