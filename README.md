# Narmada Parikrama – Village-by-Village Route Guide

An English, searchable guide to the full Narmada Parikrama (about 2,934 km, 805 villages and stops in 3 stages). Pilgrims can create an account and suggest updates. The admin approves them, and trusted "super users" can update without approval.

## Features

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
pip install -r requirements.txt
python app.py
```

Open http://127.0.0.1:5000. The database is created automatically in `instance/narmada.db` and filled from `data/stops.json`.

## Put it online

GitHub stores the code, but it cannot run a Python/Flask app. Use one of these:

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

## Settings (environment variables)

| Variable | Purpose |
|---|---|
| `SECRET_KEY` | **Required in production.** A long random string that keeps logins secure. |
| `DATABASE_PATH` | Where the SQLite file lives (default `instance/narmada.db`). |
| `ADMIN_EMAILS` | Optional. Emails that become admin when they register. |
| `UPLOAD_DIR` | Where photos and videos are stored (default `instance/uploads`). |
| `GPS_RADIUS_KM` | How close a user must be to a stop with a confirmed location (default `3`). |
| `OSM_RADIUS_KM` | Distance from an approximate OpenStreetMap pin beyond which the admin is warned (default `5`). |
| `GPS_MAX_ACCURACY_M` | Reject GPS readings less accurate than this (default `1000`). |
| `REQUIRE_GPS` | Set to `0` to turn the location check off. |

**GPS needs HTTPS.** Phones only share location with `https://` sites. PythonAnywhere and Render give you HTTPS automatically. Admins can update without GPS. GPS can be faked by a determined person, so the admin approval step still matters.

**Storage.** Videos take space: 100 one-minute videos can use 3–5 GB. PythonAnywhere's free plan has 512 MB, so you may need a paid plan or a lower `MAX_VIDEO_MB` in `app.py` as uploads grow.

Make an existing account admin from the command line with `flask --app app make-admin`.

## Credit and source

The route data comes from a Marathi village-wise Narmada Parikrama table in three stages. The PDF was created in January 2014 in CorelDRAW, and its author field says "Swayam". It does not name a publisher. All credit for the route, distances and facility details goes to its original compilers. The legacy-font Marathi was converted to Unicode and translated into English. Village and temple names are transliterated, and the Marathi name is kept for checking.

The data dates from 2014, so please confirm locally. Community updates are how it stays current.

नर्मदे हर 🙏
