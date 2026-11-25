"""JSON API for the Android app:  https://YOUR-DOMAIN/api/v1/...

Authentication: POST /api/v1/auth/login (or /auth/register) returns a token.
Send it on every other call as   Authorization: Bearer <token>
Tokens are stored hashed. The same rules as the website apply (GPS checks,
admin approval for normal users, super users publish directly).

Endpoints
  POST /auth/register          username, name, email, mobile, password  -> {token, user}
  POST /auth/login             login (username or email), password      -> {token, user}
  POST /auth/logout            revoke this token
  GET  /me                                                               -> user
  POST /me/settings            show_on_map=0|1, save_timeline=0|1, share_path=0|1, share_live=0|1
  GET  /stops                  all stops (send If-None-Match for 304)  -> {version, stops}
  GET  /stops/<id>             one stop + approved history + media list
  POST /stops/<id>/updates     multipart: changed fields, note, lat, lng, accuracy,
                               photos[], video, links[]               -> {ok, live, message}
  GET  /media/<id>             photo / video file (approved, or my own)
  GET  /reports                path reports                            -> {kinds, reports}
  POST /reports                lat, lng, kind, note, mode, my_lat, my_lng, my_acc
  POST /presence               lat, lng, accuracy (optional) – "I'm online"
  GET  /online                 online pilgrims (rounded positions)
  GET  /paths                  yatra paths of pilgrims who share them (+ my own)
  POST /photos                 public geotagged photo: photo, lat, lng, acc, ts, caption, near, client_id
  GET  /photos                 ?bbox=s,w,n,e  public photos in an area · ?mine=1[&day=YYYY-MM-DD]
  POST /photos/<id>/delete     owner or admin
  (photos: visibility=public|family, request_id=<id> when answering "Ask for a photo"; GET /photos?u=<username>)
  GET  /family                 family circle: members (exact live position), invitations, photo requests to me
  POST /family/add             username
  POST /family/<id>/accept     accept an invitation
  POST /family/<id>/remove     decline / cancel / leave
  POST /family/ask             username – ask a family member for a photo
  POST /photo-requests/<id>/decline
  GET  /notify?since=<ts>      new requests, family photos, invitations (for phone notifications)
  POST /timeline/points        JSON {"points":[{lat,lng,acc,ts}, ...]} recorded offline
  GET  /timeline/days          my days
  GET  /timeline?day=YYYY-MM-DD|all
  GET  /map                    offline map info {available, bytes, maxzoom, url}
  GET  /map/narmada.pmtiles    the offline map file (supports Range / resume)
"""
import hashlib
import json
import os
import secrets
from datetime import datetime, timezone

from flask import Blueprint, abort, g, jsonify, request, send_file
from werkzeug.security import check_password_hash, generate_password_hash


def create_blueprint(core):
    """`core` is the main app module (passed in to avoid a circular import)."""
    bp = Blueprint("api_v1", __name__, url_prefix="/api/v1")
    db = core.get_db

    def h(token):
        return hashlib.sha256(token.encode()).hexdigest()

    def err(msg, code=400):
        return jsonify({"error": msg}), code

    def user_json(u):
        return {"id": u["id"], "username": u["username"], "name": u["name"], "role": u["role"],
                "show_on_map": u["show_on_map"] != 0, "save_timeline": u["save_timeline"] != 0,
                "share_path": (u["share_path"] or 0) != 0, "share_live": (u["share_live"] or 0) != 0}

    def issue_token(user_id):
        token = secrets.token_urlsafe(32)
        db().execute("INSERT INTO api_tokens (user_id, token_hash, created_at, last_used) VALUES (?,?,?,?)",
                     (user_id, h(token), core.now(), core.now()))
        db().commit()
        return token

    PUBLIC = {"api_v1.login", "api_v1.register"}

    @bp.before_request
    def auth():
        if request.method == "OPTIONS":
            return "", 204
        if request.endpoint in PUBLIC:
            return None
        hdr = request.headers.get("Authorization", "")
        token = hdr[7:].strip() if hdr.lower().startswith("bearer ") else ""
        if not token:
            return err("login required", 401)
        row = db().execute("""SELECT u.* FROM api_tokens t JOIN users u ON u.id=t.user_id
                              WHERE t.token_hash=?""", (h(token),)).fetchone()
        if not row:
            return err("login expired – please log in again", 401)
        g.user = row
        g.token_hash = h(token)
        db().execute("UPDATE api_tokens SET last_used=? WHERE token_hash=?", (core.now(), g.token_hash))
        return None

    # ------------------------------------------------------------ auth
    @bp.post("/auth/register")
    def register():
        f = request.form if request.form else (request.get_json(silent=True) or {})
        username = str(f.get("username", "")).strip().lower().lstrip("@")
        name, email = str(f.get("name", "")).strip(), str(f.get("email", "")).strip().lower()
        mobile, password = str(f.get("mobile", "")).replace(" ", ""), str(f.get("password", ""))
        errors = []
        e = core.username_error(username)
        if e:
            errors.append(e)
        if len(name) < 2:
            errors.append("Please enter your full name.")
        if not core.EMAIL_RE.match(email):
            errors.append("Please enter a valid email address.")
        if not core.MOBILE_RE.match(mobile):
            errors.append("Please enter a valid 10-digit Indian mobile number.")
        if len(password) < 6:
            errors.append("Password must be at least 6 characters.")
        if not errors and db().execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone():
            errors.append("An account with this email already exists. Please log in.")
        if errors:
            return jsonify({"error": " ".join(errors), "errors": errors}), 400
        first = db().execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
        role = "admin" if (first and not core.ADMIN_EMAILS) or email in core.ADMIN_EMAILS else "user"
        cur = db().execute("""INSERT INTO users (username, name, email, mobile, password_hash, role, created_at)
                              VALUES (?,?,?,?,?,?,?)""",
                           (username, name, email, mobile, generate_password_hash(password), role, core.now()))
        db().commit()
        u = db().execute("SELECT * FROM users WHERE id=?", (cur.lastrowid,)).fetchone()
        return jsonify({"token": issue_token(u["id"]), "user": user_json(u)})

    @bp.post("/auth/login")
    def login():
        f = request.form if request.form else (request.get_json(silent=True) or {})
        who = str(f.get("login", f.get("email", ""))).strip().lower().lstrip("@")
        u = db().execute("SELECT * FROM users WHERE email=? OR username=? COLLATE NOCASE", (who, who)).fetchone()
        if not u or not check_password_hash(u["password_hash"], str(f.get("password", ""))):
            return err("Wrong username/email or password.", 401)
        if not u["username"]:
            return err("Please log in on the website once to choose a username, then use the app.", 403)
        return jsonify({"token": issue_token(u["id"]), "user": user_json(u)})

    @bp.post("/auth/logout")
    def logout():
        db().execute("DELETE FROM api_tokens WHERE token_hash=?", (g.token_hash,))
        db().commit()
        return jsonify({"ok": True})

    @bp.get("/me")
    def me():
        return jsonify(user_json(g.user))

    @bp.post("/me/settings")
    def me_settings():
        f = request.form
        sets, vals = [], []
        for k in ("show_on_map", "save_timeline", "share_path", "share_live"):
            if k in f:
                sets.append(f"{k}=?"); vals.append(1 if f.get(k) in ("1", "true", "on") else 0)
        if sets:
            db().execute(f"UPDATE users SET {', '.join(sets)} WHERE id=?", vals + [g.user["id"]])
            db().commit()
        return jsonify(user_json(db().execute("SELECT * FROM users WHERE id=?", (g.user["id"],)).fetchone()))

    # ------------------------------------------------------------ stops
    def stops_version():
        r = db().execute("""SELECT COUNT(*), COALESCE(MAX(updated_at),''), (SELECT COUNT(*) FROM media),
                                   (SELECT COUNT(*) FROM stops WHERE lat IS NOT NULL) FROM stops""").fetchone()
        return hashlib.md5(json.dumps(list(r)).encode()).hexdigest()[:16]

    @bp.get("/stops")
    def stops():
        ver = stops_version()
        if request.headers.get("If-None-Match", "").strip('"') == ver:
            return "", 304
        rows = db().execute("""SELECT s.*, COALESCE(u.username, u.name) AS ub FROM stops s
                               LEFT JOIN users u ON u.id=s.updated_by ORDER BY s.stage, s.id""").fetchall()
        pm = dict(db().execute("""SELECT m.stop_id, COUNT(*) FROM media m JOIN edits e ON e.id=m.edit_id
                                  WHERE e.status='approved' GROUP BY m.stop_id""").fetchall())
        data = [{"id": r["id"], "st": r["stage"], "n": r["serial"], "v": r["village"], "vm": r["village_mr"],
                 "d": r["dist"], "cum": r["cum"], "sp": r["special"], "acc": r["stay"], "te": r["temples"],
                 "ti": r["tirth"], "sa": r["sangam"], "gh": r["ghat"], "br": r["bridge"], "rt": r["path"],
                 "fd": r["food"], "sd": r["rations"], "h": r["halt"], "ub": r["ub"], "ua": r["updated_at"],
                 "lat": r["lat"], "lng": r["lng"], "ls": r["loc_src"], "pm": pm.get(r["id"], 0)} for r in rows]
        resp = jsonify({"version": ver, "stops": data, "fields": core.FIELDS})
        resp.headers["ETag"] = f'"{ver}"'
        return resp

    @bp.get("/stops/<int:stop_id>")
    def stop(stop_id):
        s = db().execute("SELECT * FROM stops WHERE id=?", (stop_id,)).fetchone()
        if not s:
            return err("not found", 404)
        hist = db().execute("""SELECT e.id, e.changes, e.note, e.reviewed_at, COALESCE(u.username, u.name) AS by_user
                               FROM edits e JOIN users u ON u.id=e.user_id
                               WHERE e.stop_id=? AND e.status='approved' ORDER BY e.id DESC LIMIT 50""", (stop_id,)).fetchall()
        media = db().execute("""SELECT m.id, m.kind, m.path, COALESCE(u.username, u.name) AS by_user
                                FROM media m JOIN edits e ON e.id=m.edit_id JOIN users u ON u.id=e.user_id
                                WHERE m.stop_id=? AND e.status='approved' ORDER BY m.id DESC""", (stop_id,)).fetchall()
        return jsonify({
            "stop": dict(s),
            "history": [{"by": r["by_user"], "at": r["reviewed_at"], "note": r["note"],
                         "changes": json.loads(r["changes"])} for r in hist],
            "media": [{"id": m["id"], "kind": m["kind"], "by": m["by_user"],
                       "url": m["path"] if m["kind"] == "link" else f"/api/v1/media/{m['id']}"} for m in media]})

    @bp.post("/stops/<int:stop_id>/updates")
    def stop_update(stop_id):
        s = db().execute("SELECT * FROM stops WHERE id=?", (stop_id,)).fetchone()
        if not s:
            return err("not found", 404)
        errors, auto = core.submit_stop_update(g.user, s, request.form, request.files, partial=True)
        if errors:
            return jsonify({"error": " ".join(errors), "errors": errors}), 400
        return jsonify({"ok": True, "live": auto,
                        "message": "Update published. Thank you!" if auto else "Thank you! Sent to the admin for approval."})

    @bp.get("/media/<int:media_id>")
    def media(media_id):
        m = db().execute("""SELECT m.*, e.status, e.user_id FROM media m JOIN edits e ON e.id=m.edit_id
                            WHERE m.id=? AND m.kind IN ('photo','video')""", (media_id,)).fetchone()
        if not m or (m["status"] != "approved" and g.user["role"] != "admin" and g.user["id"] != m["user_id"]):
            return err("not found", 404)
        return send_file(os.path.join(core.UPLOAD_DIR, m["path"]), conditional=True, max_age=86400)

    # ------------------------------------------------------------ reports
    @bp.get("/reports")
    def reports():
        return core.api_reports()

    @bp.post("/reports")
    def report_create():
        code, payload = core.create_report(g.user, request.form)
        return jsonify(payload), code

    # ------------------------------------------------------------ presence, online, timeline
    @bp.post("/presence")
    def presence():
        if request.form.get("lat"):
            core._save_location(g.user, request.form)
        else:
            ts = datetime.now(timezone.utc).timestamp()
            db().execute("UPDATE users SET last_seen=?, last_seen_ts=? WHERE id=?", (core.now(), ts, g.user["id"]))
            db().commit()
        return jsonify({"ok": True})

    @bp.get("/online")
    def online():
        return core.api_online()

    @bp.post("/photos")
    def photo_upload():
        code, payload = core.save_geo_photo(g.user, request.form, request.files.get("photo"))
        return jsonify(payload), code

    @bp.get("/photos")
    def photo_list():
        return jsonify(core.list_geo_photos(g.user, request.args))

    @bp.post("/photos/<int:photo_id>/delete")
    def photo_delete(photo_id):
        code, payload = core.delete_geo_photo(g.user, photo_id)
        return jsonify(payload), code

    @bp.get("/family")
    def family():
        return jsonify(core.family_view(g.user))

    @bp.post("/family/add")
    def family_add():
        code, payload = core.family_add(g.user, request.form.get("username"))
        return jsonify(payload), code

    @bp.post("/family/<int:fid>/<action>")
    def family_respond(fid, action):
        if action not in ("accept", "remove"):
            return err("Unknown action.", 404)
        code, payload = core.family_respond(g.user, fid, action)
        return jsonify(payload), code

    @bp.post("/family/ask")
    def family_ask():
        code, payload = core.ask_photo(g.user, request.form.get("username"))
        return jsonify(payload), code

    @bp.post("/photo-requests/<int:rid>/decline")
    def photo_request_decline(rid):
        code, payload = core.decline_photo_request(g.user, rid)
        return jsonify(payload), code

    @bp.get("/notify")
    def notify():
        return jsonify(core.notifications(g.user, core.parse_float(request.args.get("since"), 0, 1e11)))

    @bp.get("/paths")
    def paths():
        return jsonify(core.public_paths(g.user["id"]))

    @bp.post("/timeline/points")
    def timeline_points():
        """Upload points the phone recorded (possibly offline). Accepts up to 5000 at a time."""
        body = request.get_json(silent=True) or {}
        pts = body.get("points") or []
        if not isinstance(pts, list) or len(pts) > 5000:
            return err("send at most 5000 points as {\"points\": [...]}")
        if g.user["save_timeline"] == 0:
            return jsonify({"ok": True, "saved": 0, "note": "timeline paused"})
        nowts = datetime.now(timezone.utc).timestamp()
        saved = 0
        for p in sorted((p for p in pts if isinstance(p, dict)), key=lambda p: p.get("ts", 0)):
            lat = core.parse_float(p.get("lat"), -90, 90)
            lng = core.parse_float(p.get("lng"), -180, 180)
            acc = core.parse_float(p.get("acc"), 0, 1e7)
            ts = core.parse_float(p.get("ts"), nowts - core.TIMELINE_DAYS * 86400, nowts + 3600)
            if None in (lat, lng, ts):
                continue
            before = db().execute("SELECT COUNT(*) FROM location_points WHERE user_id=?", (g.user["id"],)).fetchone()[0]
            core._record_timeline(g.user, lat, lng, acc, ts)
            saved += db().execute("SELECT COUNT(*) FROM location_points WHERE user_id=?", (g.user["id"],)).fetchone()[0] - before
        if pts:
            last = max((p for p in pts if isinstance(p, dict) and core.parse_float(p.get("ts"), 0, nowts + 3600)),
                       key=lambda p: float(p["ts"]), default=None)
            if last and nowts - float(last["ts"]) < 600:   # recent enough to count as "online here"
                core._save_location(g.user, {"lat": last.get("lat"), "lng": last.get("lng"), "accuracy": last.get("acc")})
        db().commit()
        return jsonify({"ok": True, "saved": saved})

    @bp.get("/timeline/days")
    def timeline_days():
        return core.api_timeline_days()

    @bp.get("/timeline")
    def timeline_day():
        return core.api_timeline_day()

    # ------------------------------------------------------------ offline map
    @bp.get("/map")
    def map_info():
        f = core.map_path()
        ok = bool(f)
        return jsonify({"available": ok, "bytes": os.path.getsize(f) if ok else 0, "maxzoom": core.map_maxzoom(),
                        "updated": datetime.fromtimestamp(os.path.getmtime(f), timezone.utc).isoformat() if ok else None,
                        "url": "/api/v1/map/narmada.pmtiles" if ok else None})

    @bp.get("/map/narmada.pmtiles")
    def map_file():
        f = core.map_path()
        if not f:
            return err("The server has no offline map yet. Ask the admin to download it (Admin → Offline map).", 404)
        resp = send_file(f, mimetype="application/octet-stream", conditional=True, max_age=3600)
        resp.headers["Accept-Ranges"] = "bytes"
        return resp

    # ------------------------------------------------------------ CORS for the app's WebView
    @bp.after_request
    def cors(resp):
        resp.headers["Access-Control-Allow-Origin"] = "*"          # token auth, no cookies
        resp.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type, If-None-Match, Range"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        resp.headers["Access-Control-Expose-Headers"] = "ETag, Content-Length, Content-Range, Accept-Ranges"
        resp.headers["Access-Control-Max-Age"] = "86400"
        return resp

    return bp
