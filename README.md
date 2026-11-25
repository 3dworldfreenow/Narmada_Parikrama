# Narmada Parikrama – Village-by-Village Route Guide

An English, searchable guide to the full Narmada Parikrama (about 2,934 km, 805 villages and stops in 3 stages). Pilgrims can create an account and suggest updates. The admin approves them, and trusted "super users" can update without approval.

## Features

- **Map-first app.** The whole screen is a map (standard OpenStreetMap tiles – free, no API key), with a search bar, a stops list with filters and a stop detail panel. On phones the panel is a bottom sheet.
- **Login and location required.** Every visitor must log in with a **username** and share their GPS location before using the app. Location is asked for again after 12 hours (`LOCATION_MAX_AGE_H`). Admins can skip the location step from a desktop.
- **Online pilgrims.** An "Online" tab and live map pins show users active in the last 5 minutes (`ONLINE_MINUTES`). Only usernames are shown, and positions are rounded to about 1 km. Anyone can hide themselves under **Settings**.
- **Search like Google Maps.** The search box finds parikrama stops *and* any village, ghat, temple or town near the Narmada on OpenStreetMap (via Photon, free, no key). Tap anywhere on the map to drop a pin.
- **Directions.** 🚗 Car, 🏍 Bike or 🚶 Paidal, from your location, any searched place, a stop or a pin on the map. Shows distance, time, other routes in grey, turn-by-turn steps, and warnings for path reports along the way. "Start in Google Maps" opens live navigation. Routing is OSRM on OpenStreetMap data (routing.openstreetmap.de, free fair-use service).
- **Path reports.** Pilgrims can mark a spot as road closed, muddy, flooded, bridge/boat problem, danger, drinking water, food, rest place, good path or other, optionally only for walkers, bikes or cars. The sender must be within 5 km (`REPORT_RADIUS_KM`). A user's reports wait for admin approval; a super user's go live at once. Reports fade after 45 days (`REPORT_DAYS`).
- **My timeline.** Like Google Timeline: each user's own journey is saved privately while the app is open (a point every ~100 m or 15 min). The timeline page shows each day's route, distance, times and the parikrama stops passed. Only the user can see it, not other users or admins. They can pause it in Settings and delete a day or everything. Web pages can't record while the phone is locked or the app is closed.
- **Shared yatra paths (opt-in).** Under Settings (website) or ☰ Menu (app), a pilgrim can turn on **Share my yatra path publicly**. Their GPS timeline then appears in the **🚶 Paths** tab for everyone, shown on the map **one path at a time** with ◀ ▶. Lines are thinned and split where the GPS jumped (bus, phone off), and only walked km are counted. Off by default.
- **Live location (opt-in).** **Share my live location** shows a pilgrim's exact position with a red LIVE badge, updated about every 20 seconds while they are online. Everyone else stays at the ~1 km approximate area, or hidden.
- **📷 Geotagged camera photos (app).** The green camera button opens the phone camera. Each photo is stamped on its lower part with the nearest stop, GPS coordinates and accuracy, the phone's date and time, and @username. It is saved to the phone gallery (Pictures › Narmada Parikrama) and to the user's timeline. A **Public / Only me** switch decides where it goes:
  - **Public** photos are sent to the server (or queued while offline) and appear as photo pins for everyone when zoomed in to street level (zoom 12+), on the app and the website.
  - **Private** photos never leave the phone.
  - The owner can make a photo public or private later, or delete it. The admin can remove any public photo.

- **Search and filters.** Search by village, temple or ashram in English, or by Marathi village name. Filter by stage, cooked food, sadavrat (rations), place to stay, built ghat, bridge or special note.
- **Accounts.** Users register with name, email, mobile number and password. Mobile and email are visible only to the admin.
- **Community updates.** Any logged-in user can suggest changes to any stop, as many times as they like. Each update records who made it, when, and an optional "how do you know?" note.
- **Map.** A route map (`/map`) and a small map on every stop page, using OpenStreetMap.
- **Must be at the place (GPS).** Updates can only be sent from the stop itself, using the phone's GPS. How strict this is depends on how the stop's location is known:
  - **Confirmed by a visit:** the user must be within 3 km. This is strict.
  - **Approximate (found by name on OpenStreetMap):** the user is never blocked, because the name match may be wrong. If they are far from the pin, the admin sees a warning in the queue.
  - **No location yet:** anyone can send. Approving the update sets the location.
  - The first approved update sent with GPS turns an approximate or missing location into a confirmed one. The admin sees the sender's position on Google Maps, and can clear a wrong location.
- **Photos, video and links.** Users can attach up to 6 photos (resized to 1920 px; EXIF data, including phone GPS, is removed), one video of **max 60 seconds** (checked in the browser and again on the server for MP4/MOV), and up to 3 YouTube or other links. YouTube links play inside the page. Photos and videos stay private until the update is approved, then show in the stop's gallery with "by NAME".
- **Approval.** Updates from normal users wait in the admin's **Approvals** queue. The admin sees the old value and the new value side by side, then approves or rejects with a note to the user.
- **Super users.** On the **Users** page the admin can make anyone a *super user*, whose updates go live at once. The admin can also tick "make super user" while approving an update.
- **Credit for updates.** Every stop shows "Updated by NAME · date", and has a full update history.
- **My updates.** Each user can see their own updates and their status: pending, approved or rejected.

## Roles

| Role | What they can do |
|---|---|
| Visitor | Browse and search |
| User | Suggest updates (need approval) |
| Super user | Updates go live immediately |
| Admin | Approve or reject updates, change anyone's role |

**The first account created becomes the admin.** Create your own account first, right after deploying. To fix the admin email in advance instead, set `ADMIN_EMAILS=you@example.com` (comma-separated for more than one).

## Run on your computer

```bash
uv run app.py            # with uv (installs Python + packages automatically)
# or: pip install -r requirements.txt && python app.py
```

Open http://127.0.0.1:5000. The database is created automatically in `instance/narmada.db` and filled from `data/stops.json`.

## Put it online

GitHub stores the code, but it cannot run a Python/Flask app. Use one of these:

### Option 0 – Your own CentOS 7 server (uv + gunicorn + nginx)

One script installs everything. It sets up uv with Python 3.12, gunicorn under systemd, nginx, firewall and SELinux settings, and optionally free HTTPS:

```bash
yum install -y git      # if not installed
git clone https://github.com/3dworldfreenow/Narmada_Parikrama.git /opt/narmada
sudo DOMAIN=parikrama.example.com EMAIL=you@example.com bash /opt/narmada/deploy/centos7/install.sh
```

- Point your domain's DNS **A record** at the server before running, so HTTPS can be issued. Without `DOMAIN`/`EMAIL` the site runs on `http://SERVER-IP`, but phones won't share GPS without HTTPS.
- Data lives in `/var/lib/narmada` (database and uploads). Settings, including the secret key, are in `/etc/narmada.env`.
- **Apache already running?** If the server already hosts websites with Apache (httpd), the installer adds the site to Apache instead of starting nginx, using `deploy/centos7/setup-apache.sh`. Other sites are not touched.
- **Update later:** `sudo bash /opt/narmada/deploy/centos7/update.sh`
- **Daily backup:** add `15 2 * * * bash /opt/narmada/deploy/centos7/backup.sh` to root's crontab.
- **Logs:** `journalctl -u narmada -f`
- CentOS 7 reached end of life in June 2024 and no longer gets security updates. The script points yum at `vault.centos.org` so packages still install. Plan a move to Rocky/AlmaLinux 9 when you can; the same steps work there with small changes.

### Option A – PythonAnywhere (free, recommended)

PythonAnywhere keeps your SQLite database safe between restarts.

1. Sign up at pythonanywhere.com, then open a **Bash console**.
2. Run: `git clone https://github.com/3dworldfreenow/Narmada_Parikrama.git`
3. Run: `pip install --user flask pillow`
4. In the **Web** tab, choose **Add a new web app → Manual configuration → Python 3.x**.
5. Set the source code folder to `/home/YOURNAME/Narmada_Parikrama`.
6. In the WSGI file, replace the contents with:
   ```python
   import os, sys
   sys.path.insert(0, "/home/YOURNAME/Narmada_Parikrama")
   os.environ["SECRET_KEY"] = "put-a-long-random-text-here"
   from app import app as application
   ```
7. Add a static files mapping: URL `/static/` → `/home/YOURNAME/Narmada_Parikrama/static`.
8. Click **Reload**, open your site, and create your admin account first.

### Option B – Render / Railway

1. Connect this repo.
2. Use start command `gunicorn app:app`.
3. Set the environment variable `SECRET_KEY` to a long random string.
4. ⚠️ Add a persistent disk, and set `DATABASE_PATH` to a file on it (for example `/var/data/narmada.db`). Without a persistent disk, all accounts and updates are lost on every redeploy.

### Updating the code later

On PythonAnywhere: `cd Narmada_Parikrama && git pull`, then click **Reload**. Your database (`instance/`) is not touched.

### Read-only version (GitHub Pages)

`docs/index.html` is a single-file version without accounts, with a List/Map switch. Rebuild it after changing the data with `python docs_src/build.py`. To publish it, go to **Settings → Pages → Branch: main, folder: /docs**.

## Putting the villages on the map (one-time)

The original guide has no coordinates, so `geocode.py` finds them by name on OpenStreetMap. It uses Photon, a free OpenStreetMap search service, and steers each search to where the village should be, based on the guide's distances between known towns. Run it on your own computer. It takes about 30–40 minutes, and you can stop it and resume later.

```bash
python geocode.py fetch     # searches all 805 names, saves data/osm_candidates.json
python geocode.py match     # picks the right match for each stop, writes lat/lng into data/stops.json
git add data && git commit -m "Add map locations" && git push
```

Then on the server: `git pull`, then `flask --app app apply-locations`, then Reload. A new install loads the locations automatically.

**Already done:** 268 of 805 stops have map locations in `data/stops.json` (searched Nov 2026; 4 clearly wrong matches removed by hand). The rest weren't found on OpenStreetMap under any spelling, so they will get locations from pilgrims' GPS visits.

Matching uses both the English and Marathi names, and checks that neighbouring stops are about as far apart as the guide says. In tests with made-up data, about 9 in 10 placed pins were right. Some villages aren't in OpenStreetMap and will stay unplaced. Pilgrims' GPS visits fix both cases over time.

Search data © OpenStreetMap contributors (ODbL), via Photon by Komoot.

## Map stored on your own server (optional, recommended)

By default the app shows map images from OpenStreetMap's free tile servers, which only allow light use and forbid bulk downloading. To serve the map from your own server instead (no outside tile server, no API key), download the Narmada region once:

**Easiest: from the website.** Log in as admin → avatar menu → **🗺 Offline map** → choose the detail level → **Download map**. It runs in the background (5–30 minutes), shows progress and a log, and the website and app start using the map as soon as it finishes, with no restart. Use **Update map** monthly for fresh data, or delete it to go back to online tiles. Restarting the app during a download stops it; just start it again.

**Or from the command line:**

```bash
sudo bash /opt/narmada/deploy/download-map.sh             # zoom up to 14
sudo MAXZOOM=13 bash /opt/narmada/deploy/download-map.sh  # smaller file
```

This cuts the region (Amarkantak to the Gulf of Khambhat) out of the free daily [Protomaps](https://maps.protomaps.com/builds) world map built from OpenStreetMap, using the `pmtiles` tool. It saves one file to `/var/lib/narmada/tiles/narmada.pmtiles` and switches the app over to it. The script prints the file size; each extra zoom level roughly doubles it. Re-run it monthly to refresh the map. To go back to online tiles, remove `MAP_PMTILES` from `/etc/narmada.env` and restart.

## Android app (APK)

GitHub builds the app automatically on every push that touches `android/`, and publishes it under **Releases** as `NarmadaParikrama-1.0.N.apk`.

**Install:** open the latest release on the phone, download the `.apk`, open it, and allow "Install unknown apps" when Android asks. Play Protect may warn because the app isn't from the Play Store; choose "Install anyway". New versions install over old ones and keep your data.

**What works without internet:**
- the map, once the offline map is downloaded (☰ Menu → Offline map → Download, Wi-Fi recommended; needs `deploy/download-map.sh` on the server first)
- all 805 stops, search among them, "Near me", and the last downloaded path reports
- your location on the map, and **journey recording** for My timeline, even with the screen off (shown as a notification)
- **path reports and stop updates with photos**, saved on the phone and sent automatically when back online ("Offline · N waiting to send")

**Needs internet:** the first login, road directions (offline shows a straight line and distance), searching places outside the stop list, online pilgrims, and the photo gallery.

The app talks to `https://narmada.opirsys.com` by default. Change it on the login screen under "Server". Plain `http://` also works, but use HTTPS when you can.

**Signing:** APKs are signed with `android/narmada-debug.keystore` so every build installs over the previous one. For a private key, add repository secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`. Phones then need to uninstall the old app once.

## App API (`/api/v1`)

A JSON API with token login, used by the Android app; see the top of `api_v1.py` for every endpoint. Log in with `POST /api/v1/auth/login` (`login`, `password`), then send `Authorization: Bearer <token>`. The same rules as the website apply: GPS checks, admin approval for normal users, and super users publish directly.

## Settings (environment variables)

| Variable | Purpose |
|---|---|
| `SECRET_KEY` | **Required in production.** A long random string that keeps logins secure. |
| `DATABASE_PATH` | Where the SQLite file lives (default `instance/narmada.db`). |
| `ADMIN_EMAILS` | Optional. Emails that become admin when they register. |
| `MAP_PMTILES` / `MAP_MAXZOOM` | Set by `download-map.sh`: the map file on this server and its highest zoom level. |
| `UPLOAD_DIR` | Where photos and videos are stored (default `instance/uploads`). |
| `GPS_RADIUS_KM` | How close a user must be to a stop with a confirmed location (default `3`). |
| `OSM_RADIUS_KM` | Distance from an approximate OpenStreetMap pin beyond which the admin is warned (default `5`). |
| `GPS_MAX_ACCURACY_M` | Reject GPS readings less accurate than this (default `1000`). |
| `REQUIRE_GPS` | Set to `0` to turn the location check off. |
| `PATH_HIDE_MIN` | Hide the newest N minutes of shared yatra paths from others, for safety (default `0`, show everything). |

**GPS needs HTTPS.** Phones only share location with `https://` sites. PythonAnywhere and Render give you HTTPS automatically. Admins can update without GPS. GPS can be faked by a determined person, so the admin approval step still matters.

**Storage.** Videos take space: 100 one-minute videos can use 3–5 GB. PythonAnywhere's free plan has 512 MB, so you may need a paid plan or a lower `MAX_VIDEO_MB` in `app.py` as uploads grow.

### Managing accounts from the command line (on the server)

```bash
sudo bash /opt/narmada/deploy/admin.sh create              # create a new admin (asks name, email, mobile, password)
sudo bash /opt/narmada/deploy/admin.sh promote ram_bhakt   # make an existing user admin (username or email)
sudo bash /opt/narmada/deploy/admin.sh list                # list all accounts and roles
sudo bash /opt/narmada/deploy/admin.sh password ram_bhakt  # set a new password for someone
```

## Credit and source

The route data comes from a Marathi village-wise Narmada Parikrama table in three stages. The PDF was created in January 2014 in CorelDRAW, and its author field says "Swayam". It does not name a publisher. All credit for the route, distances and facility details goes to its original compilers. The legacy-font Marathi was converted to Unicode and translated into English. Village and temple names are transliterated, and the Marathi name is kept for checking.

The data dates from 2014, so please confirm locally. Community updates are how it stays current.

नर्मदे हर 🙏
