"""Narmada Parikrama – community-updated village-by-village route guide.

Flask + SQLite. Anyone can browse. Registered users (name, email, mobile,
password) can suggest updates to any stop. Updates from normal users wait
for admin approval; updates from "super users" (trusted) go live at once.

Every update must be sent from the place itself: the browser's GPS position
is checked against the stop's location. Updates can carry photos, one short
video (max 60 s) and links (YouTube etc.).
"""
import json

import click
import math
import struct
import sys
import uuid
import os
import re
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from functools import wraps

from flask import (Flask, abort, flash, g, redirect, render_template, request,
                   send_from_directory, session, url_for)
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATABASE = os.environ.get("DATABASE_PATH", os.path.join(BASE_DIR, "instance", "narmada.db"))
SEED_FILE = os.path.join(BASE_DIR, "data", "stops.json")
UPLOAD_DIR = os.environ.get("UPLOAD_DIR", os.path.join(BASE_DIR, "instance", "uploads"))
# How close (km) a user must be to a stop to update it. Villages along the
# river are a few km apart, so the default is generous.
GPS_RADIUS_KM = float(os.environ.get("GPS_RADIUS_KM", "3"))
# Locations found from OpenStreetMap by name are approximate, so allow more room.
OSM_RADIUS_KM = float(os.environ.get("OSM_RADIUS_KM", "5"))
GPS_MAX_ACCURACY_M = float(os.environ.get("GPS_MAX_ACCURACY_M", "1000"))
REQUIRE_GPS = os.environ.get("REQUIRE_GPS", "1") != "0"
ONLINE_MINUTES = int(os.environ.get("ONLINE_MINUTES", "5"))      # "online" = seen in the last N minutes
LOCATION_MAX_AGE_H = float(os.environ.get("LOCATION_MAX_AGE_H", "12"))  # ask for location again after N hours
# Optional: map file downloaded by deploy/download-map.sh (served from this server).
MAP_PMTILES = os.environ.get("MAP_PMTILES", "")
MAP_MAXZOOM = int(os.environ.get("MAP_MAXZOOM", "14"))
# Path reports: what pilgrims can say about a road / footpath at a spot on the map.
REPORT_KINDS = {
    "good": "✅ Good path", "closed": "⛔ Road/path closed", "mud": "🟤 Muddy / slippery",
    "water_high": "🌊 Flooded / water high", "bridge": "🌉 Bridge or boat problem",
    "danger": "⚠️ Danger (animals, theft…)", "water": "💧 Drinking water here",
    "food": "🍲 Food / chai here", "rest": "🛖 Rest place / shade", "other": "📝 Other",
}
REPORT_RADIUS_KM = float(os.environ.get("REPORT_RADIUS_KM", "5"))     # sender must be this close
REPORT_DAYS = int(os.environ.get("REPORT_DAYS", "45"))                # reports fade after N days
# Timeline: a point is saved when the user moved TIMELINE_MIN_M metres or TIMELINE_MIN_S seconds passed.
TIMELINE_MIN_M = float(os.environ.get("TIMELINE_MIN_M", "100"))
TIMELINE_MIN_S = float(os.environ.get("TIMELINE_MIN_S", "900"))
TIMELINE_MAX_ACC_M = float(os.environ.get("TIMELINE_MAX_ACC_M", "250"))   # skip very rough GPS fixes
TIMELINE_DAYS = int(os.environ.get("TIMELINE_DAYS", "400"))               # keep history this long
MAX_PHOTOS = 6
MAX_PHOTO_MB = 10
MAX_VIDEO_MB = 60
MAX_VIDEO_SECONDS = 60
MAX_LINKS = 3
PHOTO_EXT = {"jpg", "jpeg", "png", "webp", "heic"}
VIDEO_EXT = {"mp4", "mov", "m4v", "webm", "3gp"}
ADMIN_EMAILS = {e.strip().lower() for e in os.environ.get("ADMIN_EMAILS", "").split(",") if e.strip()}

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY") or secrets.token_hex(32)
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
if os.environ.get("BEHIND_PROXY") == "1":
    # Running behind nginx: trust its X-Forwarded-* headers for client IP and https.
    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
if os.environ.get("HTTPS") == "1":
    app.config["SESSION_COOKIE_SECURE"] = True
app.config["MAX_CONTENT_LENGTH"] = (MAX_PHOTOS * MAX_PHOTO_MB + MAX_VIDEO_MB + 5) * 1024 * 1024

STAGES = {
    1: {"name": "Stage 1", "bank": "South bank", "km": 633,
        "route": "Omkareshwar (Mamleshwar) → Ratnasagar (Kathpor)"},
    2: {"name": "Stage 2", "bank": "North bank", "km": 1418,
        "route": "Mithi Talai (Reva–Sagar confluence) → Mai ki Bagiya (Amarkantak)"},
    3: {"name": "Stage 3", "bank": "South bank", "km": 883,
        "route": "Mai ki Bagiya (Amarkantak) → Omkareshwar"},
}

# Editable fields: (db column, label, kind). kind "yesno" shows a Yes/No select.
FIELDS = [
    ("village", "Village / stop name (English)", "text"),
    ("village_mr", "Village name (Marathi)", "text"),
    ("dist", "Km from previous stop", "text"),
    ("cum", "Running total km", "text"),
    ("special", "Special note", "textarea"),
    ("stay", "Place to stay (ashram, dharamshala…)", "textarea"),
    ("temples", "Temples", "textarea"),
    ("tirth", "Tirth", "text"),
    ("sangam", "Sangam (river joining here)", "text"),
    ("ghat", "Built ghat", "text"),
    ("bridge", "Bridge", "text"),
    ("path", "Path to next stop", "text"),
    ("food", "Cooked food available", "yesno"),
    ("rations", "Sadavrat (rations) available", "yesno"),
    ("halt", "Halt days", "text"),
]
FIELD_NAMES = [f[0] for f in FIELDS]
FIELD_LABELS = {f[0]: f[1] for f in FIELDS}

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    mobile TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',          -- user | super | admin
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stage INTEGER NOT NULL,
    serial TEXT, village TEXT, village_mr TEXT, dist TEXT, cum TEXT,
    special TEXT, stay TEXT, temples TEXT, tirth TEXT, sangam TEXT,
    ghat TEXT, bridge TEXT, path TEXT, food TEXT, rations TEXT, halt TEXT,
    updated_by INTEGER REFERENCES users(id),
    updated_at TEXT
);
CREATE TABLE IF NOT EXISTS edits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stop_id INTEGER NOT NULL REFERENCES stops(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    changes TEXT NOT NULL,                      -- JSON {field: [old, new]}
    note TEXT,
    status TEXT NOT NULL DEFAULT 'pending',     -- pending | approved | rejected
    created_at TEXT NOT NULL,
    reviewed_by INTEGER REFERENCES users(id),
    reviewed_at TEXT,
    review_note TEXT
);
CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    edit_id INTEGER NOT NULL REFERENCES edits(id),
    stop_id INTEGER NOT NULL REFERENCES stops(id),
    kind TEXT NOT NULL,                         -- photo | video | link
    path TEXT NOT NULL,                         -- file name in UPLOAD_DIR, or URL for links
    duration REAL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_stop ON media(stop_id);
CREATE TABLE IF NOT EXISTS path_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    lat REAL NOT NULL, lng REAL NOT NULL,       -- the spot being reported
    kind TEXT NOT NULL,                         -- see REPORT_KINDS
    note TEXT,
    mode TEXT,                                  -- walk | bike | car | all
    sender_lat REAL, sender_lng REAL, sender_acc REAL, distance_km REAL,
    status TEXT NOT NULL DEFAULT 'pending',     -- pending | approved | rejected
    created_at TEXT NOT NULL, created_ts REAL NOT NULL,
    reviewed_by INTEGER, reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON path_reports(status);
CREATE TABLE IF NOT EXISTS location_points (      -- each user's private journey ("timeline")
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    lat REAL NOT NULL, lng REAL NOT NULL, acc REAL,
    ts REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_points_user_ts ON location_points(user_id, ts);
CREATE TABLE IF NOT EXISTS api_tokens (          -- logins of the Android app
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL, last_used TEXT
);
CREATE INDEX IF NOT EXISTS idx_edits_status ON edits(status);
CREATE INDEX IF NOT EXISTS idx_edits_stop ON edits(stop_id);
"""


IST = timezone(timedelta(hours=5, minutes=30))


def now():
    return datetime.now(IST).strftime("%d %b %Y, %I:%M %p IST")


# ---------------------------------------------------------------- database
def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DATABASE)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    os.makedirs(os.path.dirname(DATABASE), exist_ok=True)
    db = sqlite3.connect(DATABASE)
    db.executescript(SCHEMA)
    # Columns added after the first release (safe on old databases).
    for table, col, typ in [("stops", "lat", "REAL"), ("stops", "lng", "REAL"),
                            ("stops", "located_by", "INTEGER"), ("stops", "loc_src", "TEXT"),
                            ("edits", "lat", "REAL"), ("edits", "lng", "REAL"),
                            ("edits", "accuracy", "REAL"), ("edits", "distance_km", "REAL"),
                            ("users", "username", "TEXT"), ("users", "last_seen", "TEXT"),
                            ("users", "last_seen_ts", "REAL"), ("users", "last_lat", "REAL"),
                            ("users", "last_lng", "REAL"), ("users", "last_acc", "REAL"),
                            ("users", "show_on_map", "INTEGER DEFAULT 1"),
                            ("users", "save_timeline", "INTEGER DEFAULT 1")]:
        cols = [r[1] for r in db.execute(f"PRAGMA table_info({table})")]
        if col not in cols:
            db.execute(f"ALTER TABLE {table} ADD COLUMN {col} {typ}")
    db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE)")
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    if db.execute("SELECT COUNT(*) FROM stops").fetchone()[0] == 0:
        with open(SEED_FILE, encoding="utf-8") as fh:
            rows = json.load(fh)
        db.executemany(
            """INSERT INTO stops (stage, serial, village, village_mr, dist, cum, special, stay,
               temples, tirth, sangam, ghat, bridge, path, food, rations, halt)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            [(r["st"], str(r["n"]), r["v"], r["vm"], r["d"], r["cum"], r["sp"], r["acc"],
              r["te"], r["ti"], r["sa"], r["gh"], r["br"], r["rt"], r["fd"], r["sd"], r["h"])
             for r in rows])
        db.commit()
        _apply_osm_locations(db, rows)
    db.commit()
    db.close()


@app.cli.command("init-db")
def init_db_command():
    """Create tables and load the seed data (safe to run twice)."""
    init_db()
    print("Database ready:", DATABASE)


def _apply_osm_locations(db, rows):
    """Copy lat/lng found from OpenStreetMap (data/stops.json) into the stops
    table. Locations confirmed by a pilgrim's visit are never overwritten."""
    n = 0
    for i, r in enumerate(rows, start=1):
        if r.get("lat") is None:
            continue
        cur = db.execute("""UPDATE stops SET lat=?, lng=?, loc_src='osm'
                            WHERE id=? AND stage=? AND (loc_src IS NULL OR loc_src='osm')""",
                         (r["lat"], r["lng"], i, r["st"]))
        n += cur.rowcount
    return n


@app.cli.command("apply-locations")
def apply_locations_command():
    """Load OpenStreetMap locations from data/stops.json into the database."""
    db = sqlite3.connect(DATABASE)
    with open(SEED_FILE, encoding="utf-8") as fh:
        n = _apply_osm_locations(db, json.load(fh))
    db.commit()
    print(f"{n} stops now have an OpenStreetMap location.")


@app.cli.command("create-admin")
@click.option("--username", prompt="Username (3-20: a-z 0-9 _ .)")
@click.option("--name", prompt="Full name")
@click.option("--email", prompt="Email")
@click.option("--mobile", prompt="Mobile (10 digits)")
@click.option("--password", prompt="Password (min 6)", hide_input=True, confirmation_prompt=True)
def create_admin_command(username, name, email, mobile, password):
    """Create a new admin account from the command line."""
    username, email, mobile = username.strip().lower().lstrip("@"), email.strip().lower(), mobile.replace(" ", "")
    errors = []
    if not USERNAME_RE.match(username):
        errors.append("Username must be 3-20 characters: small letters, numbers, _ or .")
    if len(name.strip()) < 2:
        errors.append("Please give a full name.")
    if not EMAIL_RE.match(email):
        errors.append("Email is not valid.")
    if not MOBILE_RE.match(mobile):
        errors.append("Mobile must be a valid 10-digit Indian number.")
    if len(password) < 6:
        errors.append("Password must be at least 6 characters.")
    db = sqlite3.connect(DATABASE)
    if db.execute("SELECT 1 FROM users WHERE username=? COLLATE NOCASE", (username,)).fetchone():
        errors.append(f"Username @{username} is taken. To make that user admin: flask --app app make-admin {username}")
    if db.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone():
        errors.append(f"Email {email} already has an account. To make it admin: flask --app app make-admin {email}")
    if errors:
        for e in errors:
            click.echo("✗ " + e, err=True)
        raise SystemExit(1)
    db.execute("""INSERT INTO users (username, name, email, mobile, password_hash, role, created_at)
                  VALUES (?,?,?,?,?,'admin',?)""",
               (username, name.strip(), email, mobile, generate_password_hash(password), now()))
    db.commit()
    click.echo(f"✓ Admin @{username} created. Log in with {username} or {email}.")


@app.cli.command("make-admin")
@click.argument("who", required=False)
def make_admin_command(who):
    """Make an existing account admin:  flask --app app make-admin USERNAME_OR_EMAIL"""
    who = (who or click.prompt("Username or email of the account")).strip().lower().lstrip("@")
    db = sqlite3.connect(DATABASE)
    cur = db.execute("UPDATE users SET role='admin' WHERE email=? OR username=? COLLATE NOCASE", (who, who))
    db.commit()
    click.echo(f"✓ {who} is now an admin." if cur.rowcount else f"✗ No account found for {who}.")


@app.cli.command("list-users")
def list_users_command():
    """Show all accounts and their roles."""
    db = sqlite3.connect(DATABASE)
    rows = db.execute("SELECT username, name, email, mobile, role FROM users ORDER BY id").fetchall()
    for u in rows:
        click.echo(f"@{u[0] or '-':20} {u[4]:6} {u[1]:25} {u[2]:30} {u[3]}")
    click.echo(f"{len(rows)} account(s)")


@app.cli.command("reset-password")
@click.argument("who")
@click.option("--password", prompt="New password (min 6)", hide_input=True, confirmation_prompt=True)
def reset_password_command(who, password):
    """Set a new password for an account:  flask --app app reset-password USERNAME_OR_EMAIL"""
    if len(password) < 6:
        click.echo("✗ Password must be at least 6 characters.", err=True)
        raise SystemExit(1)
    who = who.strip().lower().lstrip("@")
    db = sqlite3.connect(DATABASE)
    cur = db.execute("UPDATE users SET password_hash=? WHERE email=? OR username=? COLLATE NOCASE",
                     (generate_password_hash(password), who, who))
    db.commit()
    click.echo(f"✓ Password changed for {who}." if cur.rowcount else f"✗ No account found for {who}.")


# ---------------------------------------------------------------- auth helpers
def current_user():
    if "user" not in g:            # (the app API sets g.user from its token)
        uid = session.get("uid")
        g.user = get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone() if uid else None
    return g.user


@app.context_processor
def inject_globals():
    user = current_user()
    pending = 0
    if user and user["role"] == "admin":
        pending = get_db().execute("SELECT COUNT(*) FROM edits WHERE status='pending'").fetchone()[0] + \
            get_db().execute("SELECT COUNT(*) FROM path_reports WHERE status='pending'").fetchone()[0]
    return {"user": user, "pending_count": pending, "csrf_token": csrf_token, "STAGES": STAGES,
            "labels": FIELD_LABELS, "GPS_RADIUS_KM": GPS_RADIUS_KM, "OSM_RADIUS_KM": OSM_RADIUS_KM, "stop_radius": stop_radius, "GPS_MAX_ACCURACY_M": GPS_MAX_ACCURACY_M, "REQUIRE_GPS": REQUIRE_GPS,
            "MAX_PHOTOS": MAX_PHOTOS, "MAX_PHOTO_MB": MAX_PHOTO_MB, "MAX_VIDEO_MB": MAX_VIDEO_MB,
            "MAX_VIDEO_SECONDS": MAX_VIDEO_SECONDS, "MAX_LINKS": MAX_LINKS, "youtube_id": youtube_id}


def login_required(view):
    @wraps(view)
    def wrapped(*a, **kw):
        if not current_user():
            flash("Please log in first.", "info")
            return redirect(url_for("login", next=request.path))
        return view(*a, **kw)
    return wrapped


def admin_required(view):
    @wraps(view)
    def wrapped(*a, **kw):
        user = current_user()
        if not user or user["role"] != "admin":
            abort(403)
        return view(*a, **kw)
    return wrapped


def csrf_token():
    if "_csrf" not in session:
        session["_csrf"] = secrets.token_hex(16)
    return session["_csrf"]


@app.before_request
def check_csrf():
    if request.method == "POST" and not request.path.startswith("/api/v1/"):   # the app API uses tokens
        token = request.form.get("_csrf") or request.headers.get("X-CSRF-Token")
        if not token or token != session.get("_csrf"):
            abort(400, "Form expired. Go back, refresh the page and try again.")


# Pages anyone may open without logging in / sharing location.
OPEN_ENDPOINTS = {"login", "register", "static", "logout", "choose_username", "locate", "api_location"}


@app.before_request
def require_login_and_location():
    """The app is for registered pilgrims: log in, pick a username, share location."""
    ep = request.endpoint or ""
    if ep in OPEN_ENDPOINTS or ep.startswith("api_v1.") or request.path.startswith("/api/v1/") or app.config.get("OPEN_ACCESS"):
        return None
    user = current_user()
    if not user:
        if ep.startswith("api_"):
            return {"error": "login required"}, 401
        return redirect(url_for("login", next=request.full_path if request.query_string else request.path))
    if not user["username"]:
        return redirect(url_for("choose_username", next=request.path))
    fresh = session.get("loc_at") and (datetime.now(timezone.utc).timestamp() - session["loc_at"]) < LOCATION_MAX_AGE_H * 3600
    if not fresh and not session.get("loc_skip"):
        if ep.startswith("api_"):
            return {"error": "location required"}, 428
        return redirect(url_for("locate", next=request.path))
    return None


USERNAME_RE = re.compile(r"^[a-z0-9_.]{3,20}$")


def username_error(name, exclude_id=None):
    if not USERNAME_RE.match(name):
        return "Username must be 3–20 characters: small letters, numbers, _ or . (no spaces)."
    row = get_db().execute("SELECT id FROM users WHERE username=? COLLATE NOCASE", (name,)).fetchone()
    if row and row["id"] != exclude_id:
        return "That username is taken. Please choose another."
    return None


EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MOBILE_RE = re.compile(r"^(\+?91[\s-]?)?[6-9]\d{9}$")


# ---------------------------------------------------------------- location & media helpers
def stop_radius(stop):
    return GPS_RADIUS_KM if stop["loc_src"] == "visit" else OSM_RADIUS_KM


def haversine_km(lat1, lng1, lat2, lng2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def parse_float(v, lo, hi):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if lo <= f <= hi and not math.isnan(f) else None


def mp4_duration(fh):
    """Read the duration (seconds) from an MP4/MOV 'mvhd' box. None if not found."""
    def walk(start, end, depth=0):
        fh.seek(start)
        pos = start
        while pos + 8 <= end and depth < 4:
            fh.seek(pos)
            hdr = fh.read(8)
            if len(hdr) < 8:
                return None
            size, typ = struct.unpack(">I4s", hdr)
            hlen = 8
            if size == 1:
                size = struct.unpack(">Q", fh.read(8))[0]
                hlen = 16
            elif size == 0:
                size = end - pos
            if size < hlen:
                return None
            if typ == b"moov":
                return walk(pos + hlen, pos + size, depth + 1)
            if typ == b"mvhd":
                version = fh.read(1)[0]
                fh.read(3)
                if version == 1:
                    fh.read(16)
                    scale, dur = struct.unpack(">IQ", fh.read(12))
                else:
                    fh.read(8)
                    scale, dur = struct.unpack(">II", fh.read(8))
                return dur / scale if scale else None
            pos += size
        return None
    fh.seek(0, os.SEEK_END)
    end = fh.tell()
    try:
        return walk(0, end)
    except (struct.error, IndexError):
        return None
    finally:
        fh.seek(0)


def ext_of(filename):
    return filename.rsplit(".", 1)[-1].lower() if "." in filename else ""


def file_size(fs):
    fs.stream.seek(0, os.SEEK_END)
    n = fs.stream.tell()
    fs.stream.seek(0)
    return n


def looks_like_image(head):
    return (head.startswith(b"\xff\xd8\xff") or head.startswith(b"\x89PNG") or
            (head[:4] == b"RIFF" and head[8:12] == b"WEBP") or head[4:12] in (b"ftypheic", b"ftypheix", b"ftypmif1"))


def save_photo(fs):
    """Save an uploaded photo, shrinking big ones when Pillow is available."""
    ext = ext_of(fs.filename)
    name = f"{uuid.uuid4().hex}.{ 'jpg' if ext == 'jpeg' else ext }"
    dest = os.path.join(UPLOAD_DIR, name)
    try:
        from PIL import Image, ImageOps
        img = Image.open(fs.stream)
        img = ImageOps.exif_transpose(img)
        img.thumbnail((1920, 1920))
        name = f"{uuid.uuid4().hex}.jpg"
        dest = os.path.join(UPLOAD_DIR, name)
        img.convert("RGB").save(dest, "JPEG", quality=85)   # also drops EXIF (phone GPS, etc.)
    except Exception:
        fs.stream.seek(0)
        fs.save(dest)
    return name


YOUTUBE_RE = re.compile(r"(?:youtube\.com/(?:watch\?(?:.*&)?v=|shorts/|embed/|live/)|youtu\.be/)([A-Za-z0-9_-]{11})")


def youtube_id(url):
    m = YOUTUBE_RE.search(url or "")
    return m.group(1) if m else None


def media_for(where, args):
    rows = get_db().execute(f"SELECT * FROM media WHERE {where} ORDER BY id", args).fetchall()
    out = {}
    for m in rows:
        out.setdefault(m["edit_id"], []).append(dict(m))
    return out


# ---------------------------------------------------------------- public pages
@app.route("/")
def index():
    db = get_db()
    rows = db.execute(
        """SELECT s.*, COALESCE(u.username, u.name) AS updated_by_name FROM stops s
           LEFT JOIN users u ON u.id = s.updated_by ORDER BY s.stage, s.id""").fetchall()
    photo_counts = dict(db.execute(
        """SELECT m.stop_id, COUNT(*) FROM media m JOIN edits e ON e.id=m.edit_id
           WHERE e.status='approved' GROUP BY m.stop_id""").fetchall())
    data = [{
        "id": r["id"], "st": r["stage"], "n": r["serial"], "v": r["village"], "vm": r["village_mr"],
        "d": r["dist"], "cum": r["cum"], "sp": r["special"], "acc": r["stay"], "te": r["temples"],
        "ti": r["tirth"], "sa": r["sangam"], "gh": r["ghat"], "br": r["bridge"], "rt": r["path"],
        "fd": r["food"], "sd": r["rations"], "h": r["halt"],
        "ub": r["updated_by_name"], "ua": r["updated_at"],
        "lat": r["lat"], "lng": r["lng"], "ls": r["loc_src"], "pm": photo_counts.get(r["id"], 0),
    } for r in rows]
    recent = db.execute(
        """SELECT e.*, COALESCE(u.username, u.name) AS user_name, s.village, s.stage FROM edits e
           JOIN users u ON u.id=e.user_id JOIN stops s ON s.id=e.stop_id
           WHERE e.status='approved' ORDER BY e.reviewed_at DESC, e.id DESC LIMIT 8""").fetchall()
    local_map = bool(MAP_PMTILES and os.path.isfile(MAP_PMTILES))
    return render_template("app.html", data=data, recent=recent, local_map=local_map, map_maxzoom=MAP_MAXZOOM,
                           report_kinds=REPORT_KINDS, report_radius=REPORT_RADIUS_KM)


@app.route("/map")
def map_view():
    return redirect(url_for("index"))


@app.route("/stop/<int:stop_id>")
def stop_detail(stop_id):
    db = get_db()
    stop = db.execute("""SELECT s.*, COALESCE(u.username, u.name) AS updated_by_name FROM stops s
                         LEFT JOIN users u ON u.id=s.updated_by WHERE s.id=?""", (stop_id,)).fetchone()
    if not stop:
        abort(404)
    history = db.execute(
        """SELECT e.*, COALESCE(u.username, u.name) AS user_name FROM edits e JOIN users u ON u.id=e.user_id
           WHERE e.stop_id=? AND e.status='approved' ORDER BY e.id DESC""", (stop_id,)).fetchall()
    mine = []
    if current_user():
        mine = db.execute("""SELECT * FROM edits WHERE stop_id=? AND user_id=? AND status='pending'
                             ORDER BY id DESC""", (stop_id, current_user()["id"])).fetchall()
    gallery = db.execute(
        """SELECT m.*, COALESCE(u.username, u.name) AS user_name, e.created_at AS edit_date FROM media m
           JOIN edits e ON e.id=m.edit_id JOIN users u ON u.id=e.user_id
           WHERE m.stop_id=? AND e.status='approved' ORDER BY m.id DESC""", (stop_id,)).fetchall()
    mine_media = media_for("edit_id IN (%s)" % ",".join("?" * len(mine)), [e["id"] for e in mine]) if mine else {}
    return render_template("stop.html", stop=stop, fields=FIELDS, history=decode(history),
                           mine=decode(mine), gallery=gallery, mine_media=mine_media)


RIVER_FILE = os.path.join(BASE_DIR, "data", "narmada_river.json")


@app.route("/river-data.js")
def river_data():
    """The Narmada's course (from OpenStreetMap) for the 'don't cross the river' rule."""
    try:
        with open(RIVER_FILE, encoding="utf-8") as fh:
            body = "window.RIVER=" + fh.read().strip() + ";"
    except OSError:
        body = "window.RIVER=null;"
    resp = app.response_class(body, mimetype="application/javascript")
    resp.headers["Cache-Control"] = "private, max-age=86400"
    return resp


@app.route("/tiles/narmada.pmtiles")
def map_tiles():
    """The offline map file. Browsers read small pieces of it (HTTP Range requests)."""
    if not (MAP_PMTILES and os.path.isfile(MAP_PMTILES)):
        abort(404)
    from flask import send_file
    resp = send_file(MAP_PMTILES, mimetype="application/octet-stream", conditional=True, max_age=86400)
    resp.headers["Accept-Ranges"] = "bytes"
    return resp


@app.route("/media/<int:media_id>")
def media_file(media_id):
    db = get_db()
    m = db.execute("""SELECT m.*, e.status, e.user_id FROM media m JOIN edits e ON e.id=m.edit_id
                      WHERE m.id=? AND m.kind IN ('photo','video')""", (media_id,)).fetchone()
    if not m:
        abort(404)
    user = current_user()
    if m["status"] != "approved" and not (user and (user["role"] == "admin" or user["id"] == m["user_id"])):
        abort(404)
    return send_from_directory(UPLOAD_DIR, m["path"], max_age=86400)


def decode(rows):
    out = []
    for r in rows:
        d = dict(r)
        d["changes"] = json.loads(r["changes"])
        out.append(d)
    return out


# ---------------------------------------------------------------- accounts
@app.route("/register", methods=["GET", "POST"])
def register():
    if current_user():
        return redirect(url_for("index"))
    form = {"username": "", "name": "", "email": "", "mobile": ""}
    if request.method == "POST":
        form = {k: request.form.get(k, "").strip() for k in ("username", "name", "email", "mobile")}
        form["email"] = form["email"].lower()
        form["username"] = form["username"].lower().lstrip("@")
        password = request.form.get("password", "")
        confirm = request.form.get("confirm", "")
        errors = []
        uerr = username_error(form["username"])
        if uerr:
            errors.append(uerr)
        if len(form["name"]) < 2:
            errors.append("Please enter your full name.")
        if not EMAIL_RE.match(form["email"]):
            errors.append("Please enter a valid email address.")
        if not MOBILE_RE.match(form["mobile"].replace(" ", "")):
            errors.append("Please enter a valid 10-digit Indian mobile number.")
        if len(password) < 6:
            errors.append("Password must be at least 6 characters.")
        if password != confirm:
            errors.append("The two passwords do not match.")
        db = get_db()
        if not errors and db.execute("SELECT 1 FROM users WHERE email=?", (form["email"],)).fetchone():
            errors.append("An account with this email already exists. Please log in.")
        if errors:
            for e in errors:
                flash(e, "error")
        else:
            first_user = db.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
            role = "admin" if (first_user and not ADMIN_EMAILS) or form["email"] in ADMIN_EMAILS else "user"
            cur = db.execute(
                "INSERT INTO users (username, name, email, mobile, password_hash, role, created_at) VALUES (?,?,?,?,?,?,?)",
                (form["username"], form["name"], form["email"], form["mobile"].replace(" ", ""),
                 generate_password_hash(password), role, now()))
            db.commit()
            session.clear()
            session["uid"] = cur.lastrowid
            flash("Welcome! Your account is ready." + (" You are the admin." if role == "admin" else ""), "ok")
            return redirect(url_for("locate"))
    return render_template("register.html", form=form)


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        login_id = request.form.get("login", request.form.get("email", "")).strip().lower().lstrip("@")
        user = get_db().execute("SELECT * FROM users WHERE email=? OR username=? COLLATE NOCASE",
                                (login_id, login_id)).fetchone()
        if user and check_password_hash(user["password_hash"], request.form.get("password", "")):
            session.clear()
            session["uid"] = user["id"]
            nxt = request.args.get("next", "")
            nxt = nxt if nxt.startswith("/") and not nxt.startswith("//") else url_for("index")
            return redirect(url_for("locate", next=nxt))
        flash("Wrong username/email or password.", "error")
    return render_template("login.html")


@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return redirect(url_for("index"))


def safe_next(default="index"):
    nxt = request.args.get("next", "")
    return nxt if nxt.startswith("/") and not nxt.startswith("//") else url_for(default)


@app.route("/choose-username", methods=["GET", "POST"])
def choose_username():
    user = current_user()
    if not user:
        return redirect(url_for("login"))
    if request.method == "POST":
        name = request.form.get("username", "").strip().lower().lstrip("@")
        err = username_error(name, user["id"])
        if err:
            flash(err, "error")
        else:
            get_db().execute("UPDATE users SET username=? WHERE id=?", (name, user["id"]))
            get_db().commit()
            return redirect(url_for("locate", next=safe_next()))
    return render_template("choose_username.html")


@app.route("/locate")
def locate():
    if not current_user():
        return redirect(url_for("login"))
    if not current_user()["username"]:
        return redirect(url_for("choose_username", next=safe_next()))
    return render_template("locate.html", next_url=safe_next())


def _save_location(user, form):
    lat = parse_float(form.get("lat"), -90, 90)
    lng = parse_float(form.get("lng"), -180, 180)
    acc = parse_float(form.get("accuracy"), 0, 1e7)
    if lat is None or lng is None:
        return False
    ts = datetime.now(timezone.utc).timestamp()
    get_db().execute("""UPDATE users SET last_lat=?, last_lng=?, last_acc=?, last_seen=?, last_seen_ts=?
                        WHERE id=?""", (lat, lng, acc, now(), ts, user["id"]))
    _record_timeline(user, lat, lng, acc, ts)
    get_db().commit()
    session["loc_at"] = ts
    return True


def _record_timeline(user, lat, lng, acc, ts):
    if user["save_timeline"] == 0 or (acc is not None and acc > TIMELINE_MAX_ACC_M):
        return
    db = get_db()
    last = db.execute("SELECT lat, lng, ts FROM location_points WHERE user_id=? ORDER BY ts DESC LIMIT 1",
                      (user["id"],)).fetchone()
    if last and haversine_km(lat, lng, last["lat"], last["lng"]) * 1000 < TIMELINE_MIN_M and ts - last["ts"] < TIMELINE_MIN_S:
        return
    db.execute("INSERT INTO location_points (user_id, lat, lng, acc, ts) VALUES (?,?,?,?,?)",
               (user["id"], lat, lng, acc, ts))
    if not last or int(ts) % 50 == 0:   # now and then, forget points older than TIMELINE_DAYS
        db.execute("DELETE FROM location_points WHERE user_id=? AND ts < ?", (user["id"], ts - TIMELINE_DAYS * 86400))


def _ist_day(ts):
    return datetime.fromtimestamp(ts, IST).strftime("%Y-%m-%d")


def _day_bounds(day):
    d = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=IST)
    return d.timestamp(), d.timestamp() + 86400


@app.route("/timeline")
def timeline():
    return render_template("timeline.html")


@app.route("/api/timeline/days")
def api_timeline_days():
    """The days on which I have timeline points, newest first, with distance travelled."""
    rows = get_db().execute("SELECT lat, lng, ts FROM location_points WHERE user_id=? ORDER BY ts",
                            (current_user()["id"],)).fetchall()
    days = {}
    prev = None
    for r in rows:
        d = _ist_day(r["ts"])
        e = days.setdefault(d, {"day": d, "points": 0, "km": 0.0, "first": r["ts"], "last": r["ts"]})
        e["points"] += 1
        e["last"] = r["ts"]
        if prev and _ist_day(prev["ts"]) == d:
            e["km"] += haversine_km(prev["lat"], prev["lng"], r["lat"], r["lng"])
        prev = r
    out = sorted(days.values(), key=lambda x: x["day"], reverse=True)
    for e in out:
        e["km"] = round(e["km"], 1)
        e["from"] = datetime.fromtimestamp(e.pop("first"), IST).strftime("%I:%M %p")
        e["to"] = datetime.fromtimestamp(e.pop("last"), IST).strftime("%I:%M %p")
    total = round(sum(e["km"] for e in out), 1)
    return {"days": out, "total_km": total, "recording": current_user()["save_timeline"] != 0}


@app.route("/api/timeline")
def api_timeline_day():
    day = request.args.get("day", "")
    if day == "all":
        rows = get_db().execute("SELECT lat, lng, ts FROM location_points WHERE user_id=? ORDER BY ts",
                                (current_user()["id"],)).fetchall()
    else:
        try:
            a, b = _day_bounds(day)
        except ValueError:
            return {"error": "bad day"}, 400
        rows = get_db().execute("SELECT lat, lng, ts FROM location_points WHERE user_id=? AND ts>=? AND ts<? ORDER BY ts",
                                (current_user()["id"], a, b)).fetchall()
    pts = [[round(r["lat"], 6), round(r["lng"], 6), int(r["ts"])] for r in rows]
    # parikrama stops passed within 1 km
    stops, seen = [], set()
    if pts:
        cand = get_db().execute("SELECT id, stage, serial, village, lat, lng FROM stops WHERE lat IS NOT NULL").fetchall()
        lat_min, lat_max = min(p[0] for p in pts) - .02, max(p[0] for p in pts) + .02
        lng_min, lng_max = min(p[1] for p in pts) - .02, max(p[1] for p in pts) + .02
        for s in cand:
            if not (lat_min <= s["lat"] <= lat_max and lng_min <= s["lng"] <= lng_max):
                continue
            for p in pts:
                if haversine_km(p[0], p[1], s["lat"], s["lng"]) <= 1.0:
                    if s["id"] not in seen:
                        seen.add(s["id"])
                        stops.append({"id": s["id"], "v": s["village"], "st": s["stage"], "n": s["serial"],
                                      "at": datetime.fromtimestamp(p[2], IST).strftime("%d %b, %I:%M %p"), "ts": p[2]})
                    break
        stops.sort(key=lambda x: x["ts"])
    return {"points": pts, "stops": stops}


@app.route("/timeline/delete", methods=["POST"])
def timeline_delete():
    day = request.form.get("day", "")
    db = get_db()
    if day == "all":
        db.execute("DELETE FROM location_points WHERE user_id=?", (current_user()["id"],))
        flash("Your whole timeline was deleted.", "ok")
    else:
        try:
            a, b = _day_bounds(day)
        except ValueError:
            abort(400)
        db.execute("DELETE FROM location_points WHERE user_id=? AND ts>=? AND ts<?", (current_user()["id"], a, b))
        flash(f"Timeline for {day} deleted.", "ok")
    db.commit()
    return redirect(url_for("timeline"))


@app.route("/api/location", methods=["POST"])
def api_location():
    user = current_user()
    if not user:
        return {"error": "login required"}, 401
    if form_skip := request.form.get("skip"):
        if user["role"] == "admin" and form_skip == "1":   # admins may enter without GPS (e.g. on a desktop)
            session["loc_skip"] = True
            return {"ok": True}
        return {"error": "location required"}, 400
    if not _save_location(user, request.form):
        return {"error": "bad location"}, 400
    return {"ok": True}


@app.route("/api/heartbeat", methods=["POST"])
def api_heartbeat():
    """Called every minute by the map page: keeps the user 'online' and their position fresh."""
    user = current_user()
    if request.form.get("lat"):
        _save_location(user, request.form)
    else:
        ts = datetime.now(timezone.utc).timestamp()
        get_db().execute("UPDATE users SET last_seen=?, last_seen_ts=? WHERE id=?", (now(), ts, user["id"]))
        get_db().commit()
    return {"ok": True}


@app.route("/api/online")
def api_online():
    """Users seen in the last ONLINE_MINUTES. Positions are rounded to ~1 km for privacy."""
    me = current_user()
    since = datetime.now(timezone.utc).timestamp() - ONLINE_MINUTES * 60
    rows = get_db().execute(
        """SELECT id, username, role, last_lat, last_lng, last_seen_ts, show_on_map FROM users
           WHERE last_seen_ts >= ? AND username IS NOT NULL ORDER BY last_seen_ts DESC""", (since,)).fetchall()
    out = []
    for r in rows:
        visible = bool(r["show_on_map"]) and r["last_lat"] is not None
        out.append({
            "u": r["username"], "me": r["id"] == me["id"],
            "role": r["role"] if r["role"] in ("admin", "super") else "",
            "lat": round(r["last_lat"], 2) if visible else None,
            "lng": round(r["last_lng"], 2) if visible else None,
            "ago": int((datetime.now(timezone.utc).timestamp() - r["last_seen_ts"]) // 60),
        })
    return {"online": out, "minutes": ONLINE_MINUTES}


@app.route("/api/reports")
def api_reports():
    """Approved path reports from the last REPORT_DAYS days (plus my own pending ones)."""
    me = current_user()
    since = datetime.now(timezone.utc).timestamp() - REPORT_DAYS * 86400
    rows = get_db().execute(
        """SELECT r.*, u.username FROM path_reports r JOIN users u ON u.id=r.user_id
           WHERE r.created_ts >= ? AND (r.status='approved' OR (r.status='pending' AND r.user_id=?))
           ORDER BY r.id DESC LIMIT 2000""", (since, me["id"])).fetchall()
    return {"kinds": REPORT_KINDS, "reports": [{
        "id": r["id"], "lat": r["lat"], "lng": r["lng"], "kind": r["kind"], "label": REPORT_KINDS.get(r["kind"], r["kind"]),
        "note": r["note"] or "", "mode": r["mode"] or "all", "by": r["username"], "at": r["created_at"],
        "pending": r["status"] == "pending", "mine": r["user_id"] == me["id"],
        "days": int((datetime.now(timezone.utc).timestamp() - r["created_ts"]) // 86400)} for r in rows]}


@app.route("/api/reports", methods=["POST"])
def api_report_create():
    code, payload = create_report(current_user(), request.form)
    return payload, code


def create_report(user, f):
    """Validate and save a path report. Used by the website and the app API.
    Returns (http_status, json_payload)."""
    lat, lng = parse_float(f.get("lat"), -90, 90), parse_float(f.get("lng"), -180, 180)
    kind = f.get("kind", "")
    note = f.get("note", "").strip()[:500]
    mode = f.get("mode", "all") if f.get("mode") in ("walk", "bike", "car", "all") else "all"
    if lat is None or lng is None:
        return 400, {"error": "Tap the spot on the map you want to report."}
    if kind not in REPORT_KINDS:
        return 400, {"error": "Choose what kind of report this is."}
    if kind == "other" and len(note) < 3:
        return 400, {"error": "Please write a short note."}
    s_lat, s_lng = parse_float(f.get("my_lat"), -90, 90), parse_float(f.get("my_lng"), -180, 180)
    s_acc = parse_float(f.get("my_acc"), 0, 1e7)
    distance = haversine_km(lat, lng, s_lat, s_lng) if s_lat is not None and s_lng is not None else None
    if user["role"] != "admin" and REQUIRE_GPS:
        if distance is None:
            return 400, {"error": "We need your current location to accept a path report."}
        if s_acc is not None and s_acc > GPS_MAX_ACCURACY_M:
            return 400, {"error": "Your GPS signal is too weak. Step outside and try again."}
        if distance > REPORT_RADIUS_KM:
            return 400, {"error": f"You are {distance:.1f} km from that spot. You can only report paths within {REPORT_RADIUS_KM:g} km of where you are."}
    auto = user["role"] in ("super", "admin")
    ts = datetime.now(timezone.utc).timestamp()
    get_db().execute(
        """INSERT INTO path_reports (user_id, lat, lng, kind, note, mode, sender_lat, sender_lng, sender_acc,
                                     distance_km, status, created_at, created_ts, reviewed_by, reviewed_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (user["id"], lat, lng, kind, note, mode, s_lat, s_lng, s_acc, distance,
         "approved" if auto else "pending", now(), ts, user["id"] if auto else None, now() if auto else None))
    get_db().commit()
    return 200, {"ok": True, "live": auto,
            "message": "Thank you! Your report is on the map." if auto else "Thank you! The admin will check your report before it shows to everyone."}


@app.route("/admin/report/<int:report_id>", methods=["POST"])
@admin_required
def admin_report(report_id):
    action = request.form.get("action")
    db = get_db()
    if action == "delete":
        db.execute("DELETE FROM path_reports WHERE id=?", (report_id,))
    elif action in ("approve", "reject"):
        db.execute("UPDATE path_reports SET status=?, reviewed_by=?, reviewed_at=? WHERE id=?",
                   ("approved" if action == "approve" else "rejected", current_user()["id"], now(), report_id))
    else:
        abort(400)
    db.commit()
    flash("Path report " + {"delete": "deleted", "approve": "approved", "reject": "rejected"}[action] + ".", "ok")
    return redirect(request.referrer or url_for("admin_queue"))


@app.route("/settings", methods=["GET", "POST"])
def settings():
    user = current_user()
    if request.method == "POST":
        show = 1 if request.form.get("show_on_map") == "1" else 0
        save_tl = 1 if request.form.get("save_timeline") == "1" else 0
        name = request.form.get("username", "").strip().lower().lstrip("@")
        err = username_error(name, user["id"]) if name != (user["username"] or "") else None
        if err:
            flash(err, "error")
        else:
            get_db().execute("UPDATE users SET show_on_map=?, save_timeline=?, username=? WHERE id=?",
                             (show, save_tl, name, user["id"]))
            get_db().commit()
            flash("Settings saved.", "ok")
            return redirect(url_for("settings"))
    return render_template("settings.html")


@app.route("/my-updates")
@login_required
def my_updates():
    rows = get_db().execute(
        """SELECT e.*, s.village, s.stage FROM edits e JOIN stops s ON s.id=e.stop_id
           WHERE e.user_id=? ORDER BY e.id DESC""", (current_user()["id"],)).fetchall()
    reports = get_db().execute("SELECT * FROM path_reports WHERE user_id=? ORDER BY id DESC",
                               (current_user()["id"],)).fetchall()
    return render_template("my_updates.html", edits=decode(rows), reports=reports, kinds=REPORT_KINDS)


# ---------------------------------------------------------------- suggest an update
@app.route("/stop/<int:stop_id>/edit", methods=["GET", "POST"])
@login_required
def edit_stop(stop_id):
    db = get_db()
    stop = db.execute("SELECT * FROM stops WHERE id=?", (stop_id,)).fetchone()
    if not stop:
        abort(404)
    user = current_user()
    if request.method == "POST":
        errors, auto = submit_stop_update(user, stop, request.form, request.files)
        if errors:
            for e in errors:
                flash(e, "error")
            return render_template("edit.html", stop=stop, fields=FIELDS, form=request.form)
        flash("Update published. Thank you!" if auto else
              "Thank you! Your update was sent to the admin for approval.", "ok")
        return redirect(url_for("stop_detail", stop_id=stop_id))
    return render_template("edit.html", stop=stop, fields=FIELDS, form={})


def submit_stop_update(user, stop, form, files, partial=False):
    """Validate and save a stop update (fields, GPS, photos, video, links).
    Used by the website and by the app API. Returns (errors, published_now).
    partial=True: only fields present in the form count as changes (app API)."""
    db = get_db()
    stop_id = stop["id"]
    changes = {}
    for name in FIELD_NAMES:
        if partial and name not in form:
            continue
        new = form.get(name, "").strip()[:1000]
        old = stop[name] or ""
        if new != old:
            changes[name] = [old, new]
    note = form.get("note", "").strip()[:1000]
    errors = []

    # --- location check
    lat = parse_float(form.get("lat"), -90, 90)
    lng = parse_float(form.get("lng"), -180, 180)
    acc = parse_float(form.get("accuracy"), 0, 1e6)
    distance = None
    gps_needed = REQUIRE_GPS and user["role"] != "admin"
    if lat is None or lng is None:
        if gps_needed:
            errors.append("We could not read your location. Please allow location access and try again.")
    else:
        if gps_needed and acc is not None and acc > GPS_MAX_ACCURACY_M:
            errors.append(f"Your GPS signal is too weak (about {acc:.0f} m). Step outside or wait a moment, then try again.")
        if stop["lat"] is not None:
            radius = stop_radius(stop)
            distance = haversine_km(lat, lng, stop["lat"], stop["lng"])
            # Only a location confirmed by a visit is strict. An approximate
            # OpenStreetMap point may be wrong, so the admin decides instead.
            if gps_needed and stop["loc_src"] == "visit" and distance > radius:
                errors.append(f"You seem to be {distance:.1f} km away from {stop['village'] or 'this stop'}. "
                              f"Updates can only be sent from within {radius:g} km of the place.")

    # --- photos
    photos = [f for f in files.getlist("photos") if f and f.filename]
    if len(photos) > MAX_PHOTOS:
        errors.append(f"Please choose at most {MAX_PHOTOS} photos.")
    for f in photos:
        head = f.stream.read(16); f.stream.seek(0)
        if ext_of(f.filename) not in PHOTO_EXT or not looks_like_image(head):
            errors.append(f"“{f.filename}” is not a photo (JPG, PNG, WEBP or HEIC).")
        elif file_size(f) > MAX_PHOTO_MB * 1024 * 1024:
            errors.append(f"“{f.filename}” is bigger than {MAX_PHOTO_MB} MB.")

    # --- video
    video = files.get("video")
    video_secs = None
    if video and video.filename:
        ext = ext_of(video.filename)
        if ext not in VIDEO_EXT:
            errors.append("Video must be MP4, MOV, WEBM or 3GP.")
        elif file_size(video) > MAX_VIDEO_MB * 1024 * 1024:
            errors.append(f"Video is bigger than {MAX_VIDEO_MB} MB. Please record a shorter or lower-quality clip.")
        else:
            if ext in ("mp4", "mov", "m4v", "3gp"):
                video_secs = mp4_duration(video.stream)
            if video_secs is None:
                video_secs = parse_float(form.get("video_duration"), 0, 1e6)
            if video_secs is not None and video_secs > MAX_VIDEO_SECONDS + 1:
                errors.append(f"Video is {video_secs:.0f} seconds long. Please keep it to {MAX_VIDEO_SECONDS} seconds or less.")
    else:
        video = None

    # --- links
    links = []
    for raw in form.getlist("links"):
        url = raw.strip()
        if not url:
            continue
        if not re.match(r"^https?://[^\s<>\"']+\.[^\s<>\"']+$", url) or len(url) > 500:
            errors.append(f"“{url[:60]}” is not a valid web link (it should start with https://).")
        else:
            links.append(url)
    links = links[:MAX_LINKS]

    if not errors and not changes and not photos and not video and not links:
        errors.append("You did not change anything or add any photo, video or link.")
    if errors:
        return errors, False

    auto = user["role"] in ("super", "admin")
    cur = db.execute(
        """INSERT INTO edits (stop_id, user_id, changes, note, status, created_at, reviewed_by, reviewed_at,
                              lat, lng, accuracy, distance_km)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (stop_id, user["id"], json.dumps(changes, ensure_ascii=False), note,
         "approved" if auto else "pending", now(), user["id"] if auto else None, now() if auto else None,
         lat, lng, acc, distance))
    edit_id = cur.lastrowid
    for f in photos:
        db.execute("INSERT INTO media (edit_id, stop_id, kind, path, created_at) VALUES (?,?,?,?,?)",
                   (edit_id, stop_id, "photo", save_photo(f), now()))
    if video:
        vname = f"{uuid.uuid4().hex}.{ext_of(video.filename)}"
        video.save(os.path.join(UPLOAD_DIR, vname))
        db.execute("INSERT INTO media (edit_id, stop_id, kind, path, duration, created_at) VALUES (?,?,?,?,?,?)",
                   (edit_id, stop_id, "video", vname, video_secs, now()))
    for url in links:
        db.execute("INSERT INTO media (edit_id, stop_id, kind, path, created_at) VALUES (?,?,?,?,?)",
                   (edit_id, stop_id, "link", url, now()))
    if auto:
        apply_edit(db, db.execute("SELECT * FROM edits WHERE id=?", (edit_id,)).fetchone())
    db.commit()
    return [], auto


def apply_edit(db, edit):
    """Make an approved edit live: field changes, and the stop's map location
    if this is the first verified visit with GPS."""
    changes = json.loads(edit["changes"])
    sets = [f"{f}=?" for f in changes if f in FIELD_NAMES]
    vals = [changes[f][1] for f in changes if f in FIELD_NAMES]
    db.execute(f"UPDATE stops SET {', '.join(sets + ['updated_by=?', 'updated_at=?'])} WHERE id=?",
               vals + [edit["user_id"], now(), edit["stop_id"]])
    if edit["lat"] is not None and (edit["accuracy"] is None or edit["accuracy"] <= GPS_MAX_ACCURACY_M):
        # First verified visit fixes the position: replaces "no location" or an
        # approximate OpenStreetMap one (the visit was already within range of it).
        db.execute("""UPDATE stops SET lat=?, lng=?, located_by=?, loc_src='visit'
                      WHERE id=? AND (lat IS NULL OR loc_src IS NULL OR loc_src='osm')""",
                   (edit["lat"], edit["lng"], edit["user_id"], edit["stop_id"]))


# ---------------------------------------------------------------- admin
@app.route("/admin")
@admin_required
def admin_queue():
    rows = get_db().execute(
        """SELECT e.*, u.name || ' (@' || COALESCE(u.username, '?') || ')' AS user_name, u.email, u.mobile, u.role, s.village, s.stage, s.serial,
                  s.lat AS stop_lat, s.lng AS stop_lng, s.loc_src
           FROM edits e JOIN users u ON u.id=e.user_id JOIN stops s ON s.id=e.stop_id
           WHERE e.status='pending' ORDER BY e.id""").fetchall()
    media = media_for("edit_id IN (SELECT id FROM edits WHERE status='pending')", [])
    reports = get_db().execute(
        """SELECT r.*, u.username, u.name, u.mobile FROM path_reports r JOIN users u ON u.id=r.user_id
           WHERE r.status='pending' ORDER BY r.id""").fetchall()
    return render_template("admin_queue.html", edits=decode(rows), media=media, reports=reports, kinds=REPORT_KINDS)


@app.route("/admin/edit/<int:edit_id>", methods=["POST"])
@admin_required
def admin_review(edit_id):
    db = get_db()
    edit = db.execute("SELECT * FROM edits WHERE id=? AND status='pending'", (edit_id,)).fetchone()
    if not edit:
        flash("That update was already reviewed.", "info")
        return redirect(url_for("admin_queue"))
    action = request.form.get("action")
    admin = current_user()
    if action == "approve":
        apply_edit(db, edit)
        status = "approved"
    elif action == "reject":
        status = "rejected"
    else:
        abort(400)
    db.execute("UPDATE edits SET status=?, reviewed_by=?, reviewed_at=?, review_note=? WHERE id=?",
               (status, admin["id"], now(), request.form.get("review_note", "").strip()[:500], edit_id))
    if action == "approve" and request.form.get("make_super") == "1":
        db.execute("UPDATE users SET role='super' WHERE id=? AND role='user'", (edit["user_id"],))
    db.commit()
    flash(f"Update {status}.", "ok")
    return redirect(url_for("admin_queue"))


@app.route("/admin/stop/<int:stop_id>/clear-location", methods=["POST"])
@admin_required
def admin_clear_location(stop_id):
    db = get_db()
    db.execute("UPDATE stops SET lat=NULL, lng=NULL, located_by=NULL, loc_src=NULL WHERE id=?", (stop_id,))
    db.commit()
    flash("Map location cleared. The next approved update with GPS will set it again.", "ok")
    return redirect(url_for("stop_detail", stop_id=stop_id))


@app.errorhandler(413)
def too_large(_e):
    flash("Your files are too big to upload together. Please send fewer photos or a shorter video.", "error")
    return redirect(request.path)


@app.route("/admin/users")
@admin_required
def admin_users():
    rows = get_db().execute(
        """SELECT u.*,
             (SELECT COUNT(*) FROM edits e WHERE e.user_id=u.id) AS total,
             (SELECT COUNT(*) FROM edits e WHERE e.user_id=u.id AND e.status='approved') AS approved
           FROM users u ORDER BY u.id""").fetchall()
    return render_template("admin_users.html", users=rows)


@app.route("/admin/users/<int:user_id>/role", methods=["POST"])
@admin_required
def admin_set_role(user_id):
    role = request.form.get("role")
    if role not in ("user", "super", "admin"):
        abort(400)
    if user_id == current_user()["id"] and role != "admin":
        flash("You cannot remove your own admin rights.", "error")
        return redirect(url_for("admin_users"))
    db = get_db()
    db.execute("UPDATE users SET role=? WHERE id=?", (role, user_id))
    db.commit()
    flash("Role updated.", "ok")
    return redirect(url_for("admin_users"))


@app.errorhandler(403)
def forbidden(_e):
    return render_template("message.html", title="Admins only",
                           text="This page is only for the site admin."), 403


@app.errorhandler(404)
def not_found(_e):
    return render_template("message.html", title="Not found", text="That page does not exist."), 404


init_db()

import api_v1  # noqa: E402  (JSON API for the Android app)
app.register_blueprint(api_v1.create_blueprint(sys.modules[__name__]))

if __name__ == "__main__":
    app.run(debug=os.environ.get("FLASK_DEBUG") == "1", port=int(os.environ.get("PORT", 5000)))
