"""Narmada Parikrama – community-updated village-by-village route guide.

Flask + SQLite. Anyone can browse. Registered users (name, email, mobile,
password) can suggest updates to any stop. Updates from normal users wait
for admin approval; updates from "super users" (trusted) go live at once.
"""
import json
import os
import re
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from functools import wraps

from flask import (Flask, abort, flash, g, redirect, render_template, request,
                   session, url_for)
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATABASE = os.environ.get("DATABASE_PATH", os.path.join(BASE_DIR, "instance", "narmada.db"))
SEED_FILE = os.path.join(BASE_DIR, "data", "stops.json")
ADMIN_EMAILS = {e.strip().lower() for e in os.environ.get("ADMIN_EMAILS", "").split(",") if e.strip()}

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY") or secrets.token_hex(32)
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

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
    db.close()


@app.cli.command("init-db")
def init_db_command():
    """Create tables and load the seed data (safe to run twice)."""
    init_db()
    print("Database ready:", DATABASE)


@app.cli.command("make-admin")
def make_admin_command():
    """Usage: flask make-admin  (asks for the email of an existing account)."""
    email = input("Email of the account to make admin: ").strip().lower()
    db = sqlite3.connect(DATABASE)
    cur = db.execute("UPDATE users SET role='admin' WHERE email=?", (email,))
    db.commit()
    print("Done." if cur.rowcount else "No account with that email. Register first.")


# ---------------------------------------------------------------- auth helpers
def current_user():
    if "user" not in g:
        uid = session.get("uid")
        g.user = get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone() if uid else None
    return g.user


@app.context_processor
def inject_globals():
    user = current_user()
    pending = 0
    if user and user["role"] == "admin":
        pending = get_db().execute("SELECT COUNT(*) FROM edits WHERE status='pending'").fetchone()[0]
    return {"user": user, "pending_count": pending, "csrf_token": csrf_token, "STAGES": STAGES, "labels": FIELD_LABELS}


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
    if request.method == "POST":
        if request.form.get("_csrf") != session.get("_csrf"):
            abort(400, "Form expired. Go back, refresh the page and try again.")


EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MOBILE_RE = re.compile(r"^(\+?91[\s-]?)?[6-9]\d{9}$")


# ---------------------------------------------------------------- public pages
@app.route("/")
def index():
    db = get_db()
    rows = db.execute(
        """SELECT s.*, u.name AS updated_by_name FROM stops s
           LEFT JOIN users u ON u.id = s.updated_by ORDER BY s.stage, s.id""").fetchall()
    data = [{
        "id": r["id"], "st": r["stage"], "n": r["serial"], "v": r["village"], "vm": r["village_mr"],
        "d": r["dist"], "cum": r["cum"], "sp": r["special"], "acc": r["stay"], "te": r["temples"],
        "ti": r["tirth"], "sa": r["sangam"], "gh": r["ghat"], "br": r["bridge"], "rt": r["path"],
        "fd": r["food"], "sd": r["rations"], "h": r["halt"],
        "ub": r["updated_by_name"], "ua": r["updated_at"],
    } for r in rows]
    recent = db.execute(
        """SELECT e.*, u.name AS user_name, s.village, s.stage FROM edits e
           JOIN users u ON u.id=e.user_id JOIN stops s ON s.id=e.stop_id
           WHERE e.status='approved' ORDER BY e.reviewed_at DESC, e.id DESC LIMIT 8""").fetchall()
    return render_template("index.html", data=data, recent=recent)


@app.route("/stop/<int:stop_id>")
def stop_detail(stop_id):
    db = get_db()
    stop = db.execute("""SELECT s.*, u.name AS updated_by_name FROM stops s
                         LEFT JOIN users u ON u.id=s.updated_by WHERE s.id=?""", (stop_id,)).fetchone()
    if not stop:
        abort(404)
    history = db.execute(
        """SELECT e.*, u.name AS user_name FROM edits e JOIN users u ON u.id=e.user_id
           WHERE e.stop_id=? AND e.status='approved' ORDER BY e.id DESC""", (stop_id,)).fetchall()
    mine = []
    if current_user():
        mine = db.execute("""SELECT * FROM edits WHERE stop_id=? AND user_id=? AND status='pending'
                             ORDER BY id DESC""", (stop_id, current_user()["id"])).fetchall()
    return render_template("stop.html", stop=stop, fields=FIELDS, history=decode(history),
                           mine=decode(mine))


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
    form = {"name": "", "email": "", "mobile": ""}
    if request.method == "POST":
        form = {k: request.form.get(k, "").strip() for k in ("name", "email", "mobile")}
        form["email"] = form["email"].lower()
        password = request.form.get("password", "")
        confirm = request.form.get("confirm", "")
        errors = []
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
                "INSERT INTO users (name, email, mobile, password_hash, role, created_at) VALUES (?,?,?,?,?,?)",
                (form["name"], form["email"], form["mobile"].replace(" ", ""),
                 generate_password_hash(password), role, now()))
            db.commit()
            session.clear()
            session["uid"] = cur.lastrowid
            flash("Welcome! Your account is ready." + (" You are the admin." if role == "admin" else ""), "ok")
            return redirect(url_for("index"))
    return render_template("register.html", form=form)


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        user = get_db().execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
        if user and check_password_hash(user["password_hash"], request.form.get("password", "")):
            session.clear()
            session["uid"] = user["id"]
            nxt = request.args.get("next", "")
            return redirect(nxt if nxt.startswith("/") and not nxt.startswith("//") else url_for("index"))
        flash("Wrong email or password.", "error")
    return render_template("login.html")


@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return redirect(url_for("index"))


@app.route("/my-updates")
@login_required
def my_updates():
    rows = get_db().execute(
        """SELECT e.*, s.village, s.stage FROM edits e JOIN stops s ON s.id=e.stop_id
           WHERE e.user_id=? ORDER BY e.id DESC""", (current_user()["id"],)).fetchall()
    return render_template("my_updates.html", edits=decode(rows))


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
        changes = {}
        for name in FIELD_NAMES:
            new = request.form.get(name, "").strip()[:1000]
            old = stop[name] or ""
            if new != old:
                changes[name] = [old, new]
        note = request.form.get("note", "").strip()[:1000]
        if not changes:
            flash("You did not change anything.", "info")
            return redirect(url_for("edit_stop", stop_id=stop_id))
        auto = user["role"] in ("super", "admin")
        db.execute(
            """INSERT INTO edits (stop_id, user_id, changes, note, status, created_at, reviewed_by, reviewed_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (stop_id, user["id"], json.dumps(changes, ensure_ascii=False), note,
             "approved" if auto else "pending", now(), user["id"] if auto else None, now() if auto else None))
        if auto:
            apply_changes(db, stop_id, changes, user["id"])
        db.commit()
        flash("Update published. Thank you!" if auto else
              "Thank you! Your update was sent to the admin for approval.", "ok")
        return redirect(url_for("stop_detail", stop_id=stop_id))
    return render_template("edit.html", stop=stop, fields=FIELDS)


def apply_changes(db, stop_id, changes, user_id):
    sets = ", ".join(f"{f}=?" for f in changes if f in FIELD_NAMES)
    vals = [changes[f][1] for f in changes if f in FIELD_NAMES]
    db.execute(f"UPDATE stops SET {sets}, updated_by=?, updated_at=? WHERE id=?",
               vals + [user_id, now(), stop_id])


# ---------------------------------------------------------------- admin
@app.route("/admin")
@admin_required
def admin_queue():
    rows = get_db().execute(
        """SELECT e.*, u.name AS user_name, u.email, u.mobile, u.role, s.village, s.stage, s.serial
           FROM edits e JOIN users u ON u.id=e.user_id JOIN stops s ON s.id=e.stop_id
           WHERE e.status='pending' ORDER BY e.id""").fetchall()
    return render_template("admin_queue.html", edits=decode(rows))


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
        apply_changes(db, edit["stop_id"], json.loads(edit["changes"]), edit["user_id"])
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

if __name__ == "__main__":
    app.run(debug=os.environ.get("FLASK_DEBUG") == "1", port=int(os.environ.get("PORT", 5000)))
