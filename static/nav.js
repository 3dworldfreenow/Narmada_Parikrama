/* Turn-by-turn navigation for bike, car or paidal – shared by the website and the Android app.
 *
 *   Nav.start({
 *     map,                      // the Leaflet map
 *     router,                   // OSRM base URL, e.g. https://routing.openstreetmap.de/routed-car/route/v1/driving/
 *     mode: "bike"|"car"|"walk",
 *     dest: {label, lat, lng},  // where to go …
 *     chain: [{label, lat, lng, note}],   // … or a list of stops to ride one after another (bike/car route)
 *     route,                    // optional: a route already shown in Directions ({coords, steps, distance, duration})
 *     online: () => bool, speak: text => void, keepAwake: on => void,
 *     onStart, onEnd,           // e.g. hide / show the panel
 *     checkRiver: coords => n   // optional: number of Narmada crossings (parikrama rule warning)
 *   })
 *
 * Works without internet too: then it points straight at the next stop with distance and direction.
 * Map data and routes © OpenStreetMap contributors.
 */
(function () {
  "use strict";
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dist = (a, b) => { const h = Math.sin(rad(b[0] - a[0]) / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
  const bearing = (a, b) => { const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0])), x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1])); return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360; };
  const compass = d => ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round(d / 45) % 8];
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c]);
  const fmtD = m => m >= 975 ? (m >= 10000 ? Math.round(m / 1000) : (m / 1000).toFixed(1)) + " km" : (m >= 100 ? Math.round(m / 50) * 50 : Math.max(10, Math.round(m / 10) * 10)) + " m";
  const sayD = m => m >= 975 ? (m >= 10000 ? Math.round(m / 1000) : (m / 1000).toFixed(1)) + " kilometres" : (m >= 100 ? Math.round(m / 50) * 50 : Math.round(m / 10) * 10) + " metres";
  const lc = t => t ? t[0].toLowerCase() + t.slice(1) : t;
  const fmtT = s => { const m = Math.round(s / 60); return m < 60 ? m + " min" : Math.floor(m / 60) + " h " + (m % 60) + " min"; };
  const clock = s => new Date(Date.now() + s * 1000).toLocaleTimeString("en-IN", {hour: "numeric", minute: "2-digit"});
  const ICON = {left: "↰", right: "↱", "slight left": "↖", "slight right": "↗", "sharp left": "↰", "sharp right": "↱", straight: "↑", uturn: "↶"};
  const SPEED = {bike: 11, car: 13, walk: 1.3};          // m/s, for arrival time when the road time is unknown

  function stepText(s) {
    const m = s.maneuver, name = s.name || s.ref || "", mod = (m.modifier || "").replace("uturn", "U-turn");
    const onto = name ? " onto " + name : "";
    switch (m.type) {
      case "depart": return name ? "Head " + compass(m.bearing_after || 0) + " on " + name : "Head " + compass(m.bearing_after || 0);
      case "arrive": return "Arrive";
      case "turn": case "end of road": return (mod === "straight" ? "Go straight" : mod === "U-turn" ? "Make a U-turn" : "Turn " + mod) + onto;
      case "fork": return "Keep " + mod + " at the fork" + onto;
      case "merge": return "Merge " + mod + onto;
      case "roundabout": case "rotary": case "roundabout turn": return "At the roundabout, take exit " + (m.exit || 1) + onto;
      case "on ramp": case "off ramp": return "Take the ramp" + (mod ? " on the " + mod : "") + onto;
      case "new name": case "continue": return mod && mod !== "straight" ? "Keep " + mod + onto : "Continue" + onto;
      default: return mod && mod !== "straight" ? "Keep " + mod + onto : "Continue" + onto;
    }
  }
  const stepIcon = s => s.maneuver.type === "arrive" ? "🏁" : /roundabout|rotary/.test(s.maneuver.type) ? "⟳" : ICON[s.maneuver.modifier] || "↑";

  let S = null;     // the running navigation

  function ui() {
    const top = document.createElement("div"); top.className = "navtop"; top.setAttribute("role", "status"); top.setAttribute("aria-live", "polite");
    const bot = document.createElement("div"); bot.className = "navbot";
    bot.innerHTML = `<div class="navinfo"><b class="navrem"></b><small class="naveta"></small><small class="navnext"></small></div>
      <button class="navbtn" data-nav="north" aria-label="Map turns with you" title="Map turns with you / north up">🧭</button>
      <button class="navbtn" data-nav="mute" aria-label="Mute voice">🔊</button>
      <button class="navbtn navend" data-nav="end">End</button>`;
    const rc = document.createElement("button"); rc.className = "navrecenter"; rc.textContent = "◎ Re-centre"; rc.hidden = true;
    document.body.append(top, bot, rc);
    bot.addEventListener("click", e => {
      const b = e.target.closest("[data-nav]"); if (!b) return;
      if (b.dataset.nav === "end") stop(true);
      if (b.dataset.nav === "north") { S.headUp = !S.headUp; b.classList.toggle("on", S.headUp); if (!S.headUp && S.map.setBearing) S.map.setBearing(0); update(); }
      if (b.dataset.nav === "mute") { S.muted = !S.muted; b.textContent = S.muted ? "🔇" : "🔊"; try { localStorage.setItem("navMute", S.muted ? "1" : ""); } catch (e) { /* ignore */ } }
    });
    rc.onclick = () => { S.follow = true; rc.hidden = true; if (S.pos) S.map.setView(S.pos, Math.max(S.map.getZoom(), 16)); };
    return {top, bot, rc};
  }

  function say(t) { if (S && !S.muted && t) try { S.speak(t); } catch (e) { /* no voice */ } }

  function prepare(route) {
    // cumulative distance along the line, and where each step starts on it
    const c = route.coords, cum = [0];
    for (let i = 1; i < c.length; i++) cum.push(cum[i - 1] + dist(c[i - 1], c[i]));
    const steps = (route.steps || []).map(s => {
      const loc = [s.maneuver.location[1], s.maneuver.location[0]];
      let best = 0, bd = Infinity;
      for (let i = 0; i < c.length; i++) { const d = dist(loc, c[i]); if (d < bd) { bd = d; best = i; } }
      return {s, at: cum[best], text: stepText(s), icon: stepIcon(s), said: {}};
    }).sort((a, b) => a.at - b.at);
    return {coords: c, cum, steps, total: cum[cum.length - 1], duration: route.duration || cum[cum.length - 1] / SPEED[S.mode]};
  }

  // nearest point on the route line, searching forward from where we were
  function snap(p) {
    const r = S.route, c = r.coords; let best = {d: Infinity, along: 0, i: 0};
    const from = Math.max(0, S.idx - 30), to = Math.min(c.length - 1, S.idx + 400);
    for (let i = from; i < to; i++) {
      const a = c[i], b = c[i + 1], seg = dist(a, b) || 1;
      // project p on a→b (flat-earth is fine over a few hundred metres)
      const kx = Math.cos(rad(a[0])), ax = (p[1] - a[1]) * kx, ay = p[0] - a[0], bx = (b[1] - a[1]) * kx, by = b[0] - a[0];
      const t = Math.max(0, Math.min(1, (ax * bx + ay * by) / ((bx * bx + by * by) || 1e-12)));
      const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], d = dist(p, q);
      if (d < best.d) best = {d, along: r.cum[i] + seg * t, i, q};
    }
    return best;
  }

  async function fetchRoute(from, to) {
    const url = S.router + `${from[1].toFixed(6)},${from[0].toFixed(6)};${to[1].toFixed(6)},${to[0].toFixed(6)}?overview=full&geometries=geojson&steps=true`;
    const j = await (await fetch(url)).json();
    if (j.code !== "Ok" || !j.routes || !j.routes.length) throw new Error("no route");
    const r = j.routes[0];
    return {coords: r.geometry.coordinates.map(c => [c[1], c[0]]), distance: r.distance, duration: r.duration * (S.mode === "bike" ? 0.85 : 1), steps: r.legs.flatMap(l => l.steps)};
  }

  function drawRoute() {
    S.layer.clearLayers();
    if (S.route) {
      L.polyline(S.route.coords, {color: "#0b57d0", weight: 10, opacity: .35, interactive: false}).addTo(S.layer);
      L.polyline(S.route.coords, {color: "#1a73e8", weight: 6, opacity: .95, interactive: false}).addTo(S.layer);
    }
    const d = S.dest;
    L.marker([d.lat, d.lng], {icon: L.divIcon({className: "", iconSize: [28, 40], iconAnchor: [14, 38], html: '<div class="gpin"><span></span></div>'}), interactive: false}).addTo(S.layer);
    S.puck = L.marker(S.pos || [d.lat, d.lng], {icon: puckIcon(0), zIndexOffset: 2000, interactive: false}).addTo(S.layer);
  }
  const puckIcon = deg => L.divIcon({className: "", iconSize: [44, 44], iconAnchor: [22, 22], html: `<div class="navpuck" style="transform:rotate(${deg}deg)"><svg viewBox="0 0 44 44" width="44" height="44"><circle cx="22" cy="22" r="20" fill="rgba(26,115,232,.18)"/><path d="M22 7 L33 33 L22 27 L11 33 Z" fill="#1a73e8" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/></svg></div>`});

  async function routeTo(reason) {
    if (!S.pos) return;
    S.dest = S.targets[S.ti];
    if (!S.online()) { S.route = null; S.straight = true; drawRoute(); update(); return; }
    try {
      S.routing = true; render({banner: reason === "reroute" ? "Finding a new route…" : "Getting the route…"});
      S.route = prepare(await fetchRoute(S.pos, [S.dest.lat, S.dest.lng])); S.idx = 0; S.straight = false; S.off = 0;
      S.cross = S.checkRiver ? S.checkRiver(S.route.coords) : 0;
      if (reason === "reroute") say("Route updated.");
    } catch (e) { S.route = null; S.straight = true; }
    S.routing = false; S.lastRoute = Date.now(); drawRoute(); update(reason !== "reroute");
  }

  function onFix(pos) {
    if (!S) return;
    const p = [pos.coords.latitude, pos.coords.longitude], acc = pos.coords.accuracy || 30;
    if (acc > 200 && S.pos) return;                          // too rough
    let hd = pos.coords.heading;
    if ((hd == null || isNaN(hd)) && S.pos && dist(S.pos, p) > 8) hd = bearing(S.pos, p);
    if (hd != null && !isNaN(hd)) S.heading = hd;
    const first = !S.pos; S.pos = p; S.acc = acc;
    if (pos.coords.speed != null && pos.coords.speed >= 0) S.speed = pos.coords.speed;
    if (first) { S.started = Date.now(); return S.preset ? (S.route = prepare(S.preset), S.preset = null, S.idx = 0, drawRoute(), update(true)) : routeTo("start"); }
    update();
  }

  function update(firstTime) {
    if (!S || !S.pos) return;
    const p = S.pos, d = S.dest, toDest = dist(p, [d.lat, d.lng]);
    // heading-up: turn the map so the way you are going points up (only when moving, so it doesn't spin)
    const canTurn = typeof S.map.setBearing === "function";
    if (canTurn && S.headUp && S.follow && S.heading != null && (S.speed == null || S.speed > 1.5)) S.map.setBearing(-S.heading);
    const mapTurn = canTurn ? (S.map.getBearing() || 0) : 0;
    if (S.puck) { S.puck.setLatLng(p); S.puck.setIcon(puckIcon((S.heading || 0) + mapTurn)); }
    if (S.follow) S.map.setView(p, Math.max(S.map.getZoom(), S.mode === "walk" ? 17 : 16), {animate: true});
    // arrived?
    if (toDest < Math.max(35, Math.min(80, S.acc))) return arrived();
    if (!S.route) {
      if (S.routing) return;                                 // the road route is on its way
      const b = bearing(p, [d.lat, d.lng]);
      render({icon: "➤", iconRot: b, main: `${fmtD(toDest)} to ${d.label}`, sub: `Head ${compass(b)}${S.online() ? " · no road route found" : " · offline: straight line, follow the roads"}`,
              rem: fmtD(toDest), eta: clock(toDest / SPEED[S.mode])});
      if (!S.saidStraight) { S.saidStraight = true; say(`${sayD(toDest)} to ${d.label}. Head ${compass(b)}.`); }
      if (S.online() && Date.now() - (S.lastRoute || 0) > 60000) routeTo("start");
      return;
    }
    const sn = snap(p); S.idx = sn.i;
    // off the route? (3 fixes in a row, more than 50 m or the GPS error away)
    if (sn.d > Math.max(50, S.acc * 1.5)) S.off++; else S.off = 0;
    if (S.off >= 3 && !S.routing && Date.now() - (S.lastRoute || 0) > 15000) { S.off = 0; return routeTo("reroute"); }
    const along = sn.along, r = S.route;
    const next = r.steps.find(st => st.at > along + 8 && st.s.maneuver.type !== "depart") || r.steps[r.steps.length - 1];
    const toStep = Math.max(0, next.at - along), remain = Math.max(0, r.total - along);
    const secs = r.duration * (remain / (r.total || 1));
    const after = r.steps[r.steps.indexOf(next) + 1];
    render({icon: next.icon, main: next.text, dist: fmtD(toStep), sub: after && after.at - next.at < 300 && after.s.maneuver.type !== "arrive" ? `then ${after.icon} ${after.text}` : (next.s.name ? "" : ""),
            rem: `${fmtD(remain)}`, eta: `${fmtT(secs)} · arrive ${clock(secs)}`});
    // voice: early warning, then at the turn
    const far = S.mode === "walk" ? 120 : 600, near = S.mode === "walk" ? 25 : 120;
    if (firstTime && !next.said.start) { next.said.start = 1; say(`${S.chainLabel || ""}${sayD(remain)} to ${d.label}. ${toStep > far ? "In " + sayD(toStep) + ", " + lc(next.text) : next.text}.`); next.said.far = 1; }
    if (toStep <= far && toStep > near * 1.6 && !next.said.far) { next.said.far = 1; say(`In ${sayD(toStep)}, ${lc(next.text)}.`); }
    if (toStep <= near && !next.said.near) { next.said.near = next.said.far = 1; say(next.s.maneuver.type === "arrive" ? `${d.label} is ahead.` : next.text + (after && after.at - next.at < 200 && after.s.maneuver.type !== "arrive" ? `, then ${after.text}` : "") + "."); }
  }

  function arrived() {
    const d = S.dest;
    if (S.ti < S.targets.length - 1) {                      // riding the route: on to the next stop
      const nx = S.targets[S.ti + 1];
      say(`You have reached ${d.label}.${d.note ? " " + d.note + "." : ""} Next stop, ${nx.label}.`);
      if (S.onArrive) S.onArrive(d, S.ti);
      S.ti++; S.chainLabel = ""; routeTo("next"); return;
    }
    say(`You have arrived at ${d.label}.`);
    render({icon: "🏁", main: `You have arrived at ${d.label}`, sub: d.note || "", rem: "", eta: ""});
    if (S.onArrive) S.onArrive(d, S.ti);
    setTimeout(() => stop(false), 8000);
  }

  function render(o) {
    if (!S) return;
    const t = S.ui.top;
    if (o.banner) { t.innerHTML = `<div class="navicon">⏳</div><div class="navtxt"><b>${esc(o.banner)}</b></div>`; return; }
    t.innerHTML = `<div class="navicon"${o.iconRot != null ? ` style="transform:rotate(${o.iconRot - 90}deg)"` : ""}>${o.icon}</div>
      <div class="navtxt">${o.dist ? `<span class="navdist">${esc(o.dist)}</span>` : ""}<b>${esc(o.main)}</b>${o.sub ? `<small>${esc(o.sub)}</small>` : ""}</div>`;
    if (S.cross) t.insertAdjacentHTML("beforeend", `<div class="navwarn">⚠ This road crosses the Narmada</div>`);
    const b = S.ui.bot;
    b.querySelector(".navrem").textContent = o.rem || "";
    b.querySelector(".naveta").textContent = o.eta || "";
    const tg = S.targets;
    b.querySelector(".navnext").textContent = tg.length > 1 ? `🏍 Stop ${S.ti + 1} of ${tg.length}: ${S.dest.label}` : `To ${S.dest.label}`;
  }

  function stop(byUser) {
    if (!S) return;
    if (S.watch != null) navigator.geolocation.clearWatch(S.watch);
    clearInterval(S.tick);
    S.layer.remove(); S.ui.top.remove(); S.ui.bot.remove(); S.ui.rc.remove();
    S.map.off("dragstart", S.onDrag);
    if (S.headUp && S.map.setBearing) S.map.setBearing(0);
    try { S.keepAwake(false); } catch (e) { /* ignore */ }
    document.body.classList.remove("navigating");
    const end = S.onEnd; S = null;
    if (byUser) try { speechSynthesis && speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    if (end) end();
  }

  function start(o) {
    if (S) stop(false);
    if (!navigator.geolocation) throw new Error("This device has no GPS.");
    const targets = (o.chain && o.chain.length ? o.chain : [o.dest]).filter(t => t && t.lat != null);
    if (!targets.length) throw new Error("No destination on the map.");
    let muted = false; try { muted = !!localStorage.getItem("navMute"); } catch (e) { /* ignore */ }
    S = {map: o.map, router: o.router, mode: o.mode || "bike", targets, ti: 0, dest: targets[0], follow: true, idx: 0, off: 0, muted,
         online: o.online || (() => navigator.onLine), speak: o.speak || defaultSpeak, keepAwake: o.keepAwake || (() => {}),
         onEnd: o.onEnd, onArrive: o.onArrive, checkRiver: o.checkRiver, preset: o.route || null, chainLabel: o.intro || "",
         layer: L.layerGroup().addTo(o.map)};
    S.ui = ui(); S.ui.bot.querySelector("[data-nav=mute]").textContent = muted ? "🔇" : "🔊";
    if (typeof o.map.setBearing !== "function") S.ui.bot.querySelector("[data-nav=north]").hidden = true;
    document.body.classList.add("navigating");
    S.onDrag = () => { S.follow = false; S.ui.rc.hidden = false; };
    o.map.on("dragstart", S.onDrag);
    try { S.keepAwake(true); } catch (e) { /* ignore */ }
    if (o.onStart) o.onStart();
    render({banner: "Waiting for GPS…"});
    // start at once from the last known position, then follow the GPS
    if (o.from) onFix({coords: {latitude: o.from[0], longitude: o.from[1], accuracy: 30, heading: null, speed: null}});
    navigator.geolocation.getCurrentPosition(onFix, () => {}, {enableHighAccuracy: true, maximumAge: 10000, timeout: 20000});
    S.watch = navigator.geolocation.watchPosition(onFix, err => render({banner: err.code === 1 ? "Allow location to navigate" : "Waiting for GPS…"}),
      {enableHighAccuracy: true, maximumAge: 2000, timeout: 30000});
    // keep the time/arrival fresh and retry routing when the internet comes back
    S.tick = setInterval(() => { if (!S) return; if (S.straight && S.online() && !S.routing && Date.now() - (S.lastRoute || 0) > 30000) routeTo("start"); }, 10000);
  }

  // speech in the browser; the Android app passes its own (Android TextToSpeech)
  function defaultSpeak(t) {
    if (!window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(t); u.lang = "en-IN"; u.rate = 1;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  }

  window.Nav = {start, stop: () => stop(true), active: () => !!S, stepText};
})();
