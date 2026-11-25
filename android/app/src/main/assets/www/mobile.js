/* Narmada Parikrama – Android app UI.
 * Offline-first: stops, reports and the map are stored on the phone; updates, path reports
 * and the journey timeline are queued and sent to the server when there is internet. */
(function () {
  "use strict";
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const isNo = v => !v || v === "No" || v === "–" || v === "-";
  const km = (a, b) => { const r = x => x * Math.PI / 180, dp = r(b[0] - a[0]), dl = r(b[1] - a[1]);
    const h = Math.sin(dp / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dl / 2) ** 2; return 2 * 6371 * Math.asin(Math.sqrt(h)); };
  const fmtKm = d => d < 1 ? `${Math.round(d * 1000)} m` : `${d < 10 ? d.toFixed(1) : Math.round(d)} km`;
  const fmtTime = s => { const m = Math.round(s / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
  const fmtMB = b => b > 1e9 ? (b / 1e9).toFixed(2) + " GB" : Math.round(b / 1e6) + " MB";
  const hue = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 55% 45%)`; };
  const NATIVE = window.Android || null;      // native helpers (missing when testing in a normal browser)
  const STAGES = {1:{n:"Stage 1",b:"South bank",c:"#0f6e77"}, 2:{n:"Stage 2",b:"North bank",c:"#c8641e"}, 3:{n:"Stage 3",b:"South bank",c:"#7a4fb0"}};
  const REPORT_KINDS_DEFAULT = {good:"✅ Good path", closed:"⛔ Road/path closed", mud:"🟤 Muddy / slippery", water_high:"🌊 Flooded / water high",
    bridge:"🌉 Bridge or boat problem", danger:"⚠️ Danger (animals, theft…)", water:"💧 Drinking water here", food:"🍲 Food / chai here", rest:"🛖 Rest place / shade", other:"📝 Other"};

  // ================================================================ storage
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* full */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  const DEFAULT_SERVER = "https://narmada.opirsys.com";
  let SERVER = store.get("server", DEFAULT_SERVER);
  let TOKEN = store.get("token", null);
  let ME = store.get("me", null);

  // IndexedDB queue (keeps photos as blobs while offline)
  const idb = new Promise((res, rej) => {
    const r = indexedDB.open("narmada", 2);
    r.onupgradeneeded = () => { const d = r.result;
      if (!d.objectStoreNames.contains("queue")) d.createObjectStore("queue", {keyPath: "id", autoIncrement: true});
      if (!d.objectStoreNames.contains("photos")) d.createObjectStore("photos", {keyPath: "id"}); };   // my camera photos (private stay here)
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const qTx = async (mode, fn) => { const db = await idb; return new Promise((res, rej) => {
    const tx = db.transaction("queue", mode), st = tx.objectStore("queue"); const out = fn(st);
    tx.oncomplete = () => res(out && out.result !== undefined ? out.result : out); tx.onerror = () => rej(tx.error); }); };
  const queueAdd = item => qTx("readwrite", st => st.add({...item, created: Date.now()}));
  const queueAll = () => qTx("readonly", st => st.getAll());
  const queueDel = id => qTx("readwrite", st => st.delete(id));
  const phTx = async (mode, fn) => { const db = await idb; return new Promise((res, rej) => {
    const tx = db.transaction("photos", mode), st = tx.objectStore("photos"); const out = fn(st);
    tx.oncomplete = () => res(out && out.result !== undefined ? out.result : out); tx.onerror = () => rej(tx.error); }); };
  const photoPut = rec => phTx("readwrite", st => st.put(rec));
  const photoAll = () => phTx("readonly", st => st.getAll());
  const photoDel = id => phTx("readwrite", st => st.delete(id));

  // ================================================================ server API
  const online = () => navigator.onLine !== false;
  async function api(path, opts = {}) {
    const headers = Object.assign({}, opts.headers || {}, TOKEN ? {Authorization: "Bearer " + TOKEN} : {});
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), opts.timeout || 30000);
    try {
      const r = await fetch(SERVER.replace(/\/$/, "") + "/api/v1" + path, {...opts, headers, signal: ctl.signal});
      if (r.status === 401 && TOKEN) { logout(true); throw new Error("Please log in again."); }
      return r;
    } finally { clearTimeout(t); }
  }
  async function apiJSON(path, opts) { const r = await api(path, opts); const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(j.error || ("Error " + r.status)), {status: r.status, body: j}); return j; }
  const form = obj => { const f = new FormData(); Object.entries(obj).forEach(([k, v]) => { if (v == null) return; if (Array.isArray(v)) v.forEach(x => f.append(k, x)); else f.append(k, v); }); return f; };

  // ================================================================ toast + net bar
  function toast(t) { const d = document.createElement("div"); d.className = "toast"; d.textContent = t; $("#toasts").appendChild(d); setTimeout(() => d.remove(), 5000); }
  async function updateNetbar() {
    const n = (await queueAll().catch(() => [])).length;
    const bar = $("#netbar");
    if (!online()) { bar.hidden = false; bar.className = "netbar"; bar.textContent = `Offline${n ? ` · ${n} waiting to send` : ""}`; }
    else if (n) { bar.hidden = false; bar.className = "netbar"; bar.textContent = `Sending ${n}…`; }
    else bar.hidden = true;
  }

  // ================================================================ auth screen
  function showAuth() { $("#auth").hidden = false; $("#appRoot").hidden = true; $("#serverIn").value = SERVER; }
  $$("[data-auth]").forEach(b => b.onclick = () => {
    $$("[data-auth]").forEach(x => x.setAttribute("aria-selected", x === b));
    $("#loginForm").hidden = b.dataset.auth !== "login"; $("#registerForm").hidden = b.dataset.auth !== "register"; $("#authErr").textContent = "";
  });
  $("#serverSave").onclick = () => { let v = $("#serverIn").value.trim(); if (v && !/^https?:\/\//.test(v)) v = "https://" + v; SERVER = v || DEFAULT_SERVER; store.set("server", SERVER); toast("Server saved: " + SERVER); };
  async function doAuth(path, fd) {
    $("#authErr").textContent = online() ? "Please wait…" : "You need internet to log in the first time.";
    try {
      const j = await apiJSON(path, {method: "POST", body: fd});
      TOKEN = j.token; ME = j.user; store.set("token", TOKEN); store.set("me", ME);
      $("#authErr").textContent = ""; startApp();
    } catch (e) { $("#authErr").textContent = e.name === "AbortError" ? "Server not reachable. Check internet or the server address." : e.message; }
  }
  $("#loginForm").onsubmit = e => { e.preventDefault(); doAuth("/auth/login", new FormData(e.target)); };
  $("#registerForm").onsubmit = e => { e.preventDefault(); doAuth("/auth/register", new FormData(e.target)); };
  function logout(expired) {
    if (!expired && TOKEN && online()) api("/auth/logout", {method: "POST"}).catch(() => {});
    TOKEN = null; ME = null; store.del("token"); store.del("me");
    if (NATIVE) { if (NATIVE.setAuth) NATIVE.setAuth("", "", false, false); NATIVE.stopTracking(); }
    store.set("family", null); store.set("notifySince", null);
    showAuth(); if (expired) $("#authErr").textContent = "Your login expired. Please log in again.";
  }

  // ================================================================ data
  let DATA = [], FIELDS = [], REPORTS = store.get("reports", []), REPORT_KINDS = store.get("reportKinds", REPORT_KINDS_DEFAULT);
  function setStops(list) {
    DATA = list; DATA.forEach((o, i) => { o._i = i; o._s = [o.v, o.vm, o.sp, o.acc, o.ti, o.te, o.sa, o.rt].join(" ").toLowerCase(); });
  }
  const cached = store.get("stops", null);
  setStops(cached ? cached.stops : (window.SEED_STOPS || []));
  FIELDS = cached && cached.fields ? cached.fields : [];

  // ================================================================ map
  let map, markers = {}, placed = [], layers = {};
  function initMap() {
    map = L.map("map", {zoomControl: false, preferCanvas: true}).setView([22.4, 77.5], 7);
    const ATTR = '&copy; OpenStreetMap contributors';
    let usedOffline = false;
    if (NATIVE && NATIVE.hasOfflineMap() && window.protomapsL) {
      protomapsL.leafletLayer({url: "/offline/narmada.pmtiles", flavor: "light", lang: "en", maxDataZoom: store.get("mapMaxZoom", 14),
        attribution: ATTR + " &copy; Protomaps"}).addTo(map);
      usedOffline = true;
    }
    if (!usedOffline) {
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {maxZoom: 19, attribution: ATTR}).addTo(map);
      if (!online()) setTimeout(() => toast("No offline map yet – open ☰ Menu → Offline map when you have Wi-Fi."), 1500);
    }
    ["route", "paths", "stops", "reports", "photos", "people", "family", "road", "pin", "track"].forEach(k => layers[k] = L.layerGroup().addTo(map));
    map.on("click", e => {
      const {lat, lng} = e.latlng;
      if (pickMode) { const f = pickMode; pickMode = null; f(lat, lng); return; }
      openPlace({label: "Dropped pin", sub: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, lat, lng});
    });
    map.on("moveend zoomend", fetchAreaPhotos);
    drawStops();
  }
  function drawStops() {
    layers.route.clearLayers(); markers = {}; placed = DATA.filter(o => o.lat != null);
    [1, 2, 3].forEach(st => { const pts = placed.filter(o => o.st === st).map(o => [o.lat, o.lng]);
      if (pts.length > 1) L.polyline(pts, {color: STAGES[st].c, weight: 3, opacity: .3, dashArray: "6 6", interactive: false}).addTo(layers.route); });
    placed.forEach(o => { markers[o._i] = L.circleMarker([o.lat, o.lng], {radius: 6, color: "#fff", weight: 2, fillColor: STAGES[o.st].c, fillOpacity: 1})
      .bindTooltip(esc(o.v || "Stop"), {className: "stoptip", direction: "top", offset: [0, -6]})
      .on("click", e => { L.DomEvent.stopPropagation(e); openStop(o._i, false); }); });
    render();
  }

  // ================================================================ panel views
  const VIEWS = ["listView", "detailView", "placeView", "dirView", "reportView", "updateView", "menuView", "timelineView", "photoView"];
  const viewStack = [];
  function show(v, push = true) {
    const cur = VIEWS.find(x => !$("#" + x).hidden);
    if (push && cur && cur !== v) viewStack.push(cur);
    VIEWS.forEach(x => $("#" + x).hidden = x !== v);
    if (v !== "listView") setSheet("half");
  }
  function back() { const v = viewStack.pop(); if (!v) return false; show(v, false); if (v === "listView") render(false); return true; }
  window.appBack = () => { if (!$("#pviewer").hidden) { $("#pviewer").hidden = true; return true; } if (panel.dataset.size === "map") { setSheet("half"); return true; } if (!$("#results").hidden) { $("#results").hidden = true; return true; } if (pickMode) { pickMode = null; return true; } return back(); };
  const backBtn = l => `<button class="back" data-back>← ${l || "Back"}</button>`;
  document.addEventListener("click", e => { if (e.target.closest("[data-back]")) back(); });
  const panel = $("#panel");
  function setSheet(s) { panel.dataset.size = s; setTimeout(() => map && map.invalidateSize(), 260); }

  // ================================================================ list
  let stage = 0, query = "", myPos = null, lastFix = null, shown = 100, selected = null;
  const filters = new Set();
  function matches(o) {
    if (stage && o.st !== stage) return false;
    if (query && !query.split(/\s+/).every(t => o._s.includes(t))) return false;
    if (filters.has("food") && o.fd !== "Yes") return false;
    if (filters.has("rat") && o.sd !== "Yes") return false;
    if (filters.has("stay") && isNo(o.acc)) return false;
    if (filters.has("ghat") && isNo(o.gh)) return false;
    if (filters.has("near") && (!myPos || o.lat == null || km(myPos, [o.lat, o.lng]) > 25)) return false;
    return true;
  }
  function render(reset = true) {
    if (reset) shown = 100;
    const rows = DATA.filter(matches);
    if (filters.has("near") && myPos) rows.sort((a, b) => km(myPos, [a.lat, a.lng]) - km(myPos, [b.lat, b.lng]));
    $("#stopCount").textContent = rows.length;
    layers.stops.clearLayers(); rows.forEach(o => markers[o._i] && markers[o._i].addTo(layers.stops));
    $("#list").innerHTML = rows.length ? rows.slice(0, shown).map(o => {
      const tags = [];
      if (o.fd === "Yes") tags.push('<span class="tag y">Food</span>');
      if (o.sd === "Yes") tags.push('<span class="tag y">Sadavrat</span>');
      if (!isNo(o.acc)) tags.push('<span class="tag">Stay</span>');
      if (o.pm) tags.push(`<span class="tag o">📷 ${o.pm}</span>`);
      const dist = myPos && o.lat != null ? fmtKm(km(myPos, [o.lat, o.lng])) : (o.cum ? `${esc(o.cum)} km` : "");
      return `<div class="item" data-i="${o._i}"><div class="no${o.lat == null ? " off" : ""}" style="background:${STAGES[o.st].c}">${esc(o.n || "·")}</div>
        <div class="tx"><div class="t">${esc(o.v || "(not named)")}<small class="mr">${esc(o.vm)}</small></div>${o.sp ? `<div class="s">${esc(o.sp)}</div>` : ""}
        ${tags.length ? `<div class="tags">${tags.join("")}</div>` : ""}</div><div class="km">${dist}</div></div>`;
    }).join("") + (rows.length > shown ? `<button class="more" id="more">Show more (${rows.length - shown})</button>` : "")
      : `<div class="empty">No stops match.</div>`;
    const m = $("#more"); if (m) m.onclick = () => { shown += 200; render(false); };
  }
  $("#list").addEventListener("click", e => { const it = e.target.closest(".item"); if (it) openStop(+it.dataset.i, true); });

  // ================================================================ stop detail
  const fact = (l, v, w) => isNo(v) ? "" : `<div class="fact${w ? " wide" : ""}"><b>${l}</b>${esc(v)}</div>`;
  const nextStop = o => { for (let j = o._i + 1; j < DATA.length; j++) if (DATA[j].st === o.st && DATA[j].lat != null) return DATA[j]; return null; };
  const stopPoint = o => ({label: o.v || "Stop", lat: o.lat, lng: o.lng});
  function openStop(i, fly) {
    const o = DATA[i]; selected = i; const nx = o.lat != null ? nextStop(o) : null;
    $("#detailView").innerHTML = `
      <div class="dhead">${backBtn("All stops")}<h2>${esc(o.v || "(not named)")} <span class="mr" style="font-size:16px;color:var(--muted)">${esc(o.vm)}</span></h2>
        <div class="sub">${STAGES[o.st].n} · ${STAGES[o.st].b} · No. ${esc(o.n || "–")} · ${esc(o.cum || "–")} km${o.lat == null ? " · not on map yet" : ""}${myPos && o.lat != null ? " · " + fmtKm(km(myPos, [o.lat, o.lng])) + " from you" : ""}</div>
        <div class="actions">${o.lat != null ? `<button class="btn2" data-dir>➤ Directions</button>${nx ? `<button class="btn2 alt" data-next>To next stop</button>` : ""}` : ""}
          <button class="btn2 alt" data-upd>✎ Update</button>${o.lat != null ? `<button class="btn2 alt" data-rep>⚑ Report</button>` : ""}</div></div>
      <div class="dbody">${o.sp ? `<div class="note">${esc(o.sp)}</div>` : ""}
        <div class="facts">${fact("Stay", o.acc, 1)}${fact("Temples", o.te, 1)}${fact("Tirth", o.ti)}${fact("Sangam", o.sa)}${fact("Cooked food", o.fd)}${fact("Sadavrat", o.sd)}
          ${fact("Built ghat", o.gh)}${fact("Bridge", o.br)}${fact("Path to next stop", o.rt, 1)}${fact("Km from previous", o.d)}${fact("Halt days", o.h)}</div>
        ${o.ub ? `<div class="upd">✎ Updated by @${esc(o.ub)} · ${esc(o.ua)}</div>` : ""}
        <div id="gallery" class="gallery"></div></div>`;
    show("detailView");
    const dv = $("#detailView");
    const q = s => dv.querySelector(s);
    if (q("[data-dir]")) q("[data-dir]").onclick = () => openDirections(null, stopPoint(o));
    if (q("[data-next]")) q("[data-next]").onclick = () => openDirections(stopPoint(o), stopPoint(nx));
    q("[data-upd]").onclick = () => openUpdate(o);
    if (q("[data-rep]")) q("[data-rep]").onclick = () => openReport(o.lat, o.lng);
    if (o.lat != null) { if (fly) map.flyTo([o.lat, o.lng], Math.max(map.getZoom(), 12), {duration: .6});
      markers[i].setStyle({radius: 10}); setTimeout(() => markers[i] && markers[i].setStyle({radius: 6}), 1800); }
    if (o.pm && online()) loadGallery(o.id);
  }
  async function loadGallery(stopId) {
    try {
      const j = await apiJSON(`/stops/${stopId}`);
      const box = $("#gallery"); if (!box) return;
      for (const m of j.media.filter(m => m.kind === "photo").slice(0, 8)) {
        const r = await api(m.url.replace(/^\/api\/v1/, "")); if (!r.ok) continue;
        const img = document.createElement("img"); img.src = URL.createObjectURL(await r.blob()); img.alt = "Photo by @" + m.by; box.appendChild(img);
      }
    } catch (e) { /* offline */ }
  }

  // ================================================================ search
  const results = $("#results"); let sTimer, sSeq = 0;
  async function placeSearch(q) {
    const c = map.getCenter();
    const j = await (await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=7&lang=en&bbox=72.3,21.0,82.2,23.8&lat=${c.lat}&lon=${c.lng}`)).json();
    return (j.features || []).map(f => { const p = f.properties, [lng, lat] = f.geometry.coordinates;
      return {label: p.name || q, sub: [(p.osm_value || "place").replace(/_/g, " "), p.city || p.county || p.district, p.state].filter(Boolean).join(" · "), lat, lng}; });
  }
  async function suggest(q, box, onPick) {
    const seq = ++sSeq; if (q.length < 2) { box.hidden = true; return; }
    const t = q.toLowerCase().split(/\s+/).filter(Boolean), stops = DATA.filter(o => t.every(w => o._s.includes(w))).slice(0, 6);
    const draw = places => {
      if (seq !== sSeq) return;
      let h = stops.length ? `<div class="rh">Parikrama stops</div>` + stops.map(o => `<div class="ri" data-stop="${o._i}"><span class="ric" style="background:${STAGES[o.st].c}">${esc(o.n || "·")}</span><div><b>${esc(o.v || "(not named)")}</b> <span class="mr">${esc(o.vm)}</span><small>${STAGES[o.st].n}${o.lat == null ? " · not on map yet" : ""}</small></div></div>`).join("") : "";
      if (places === null) h += `<div class="rh">Places</div><div class="ri muted">Searching…</div>`;
      else if (places === "offline") h += `<div class="ri muted">Other places need internet.</div>`;
      else if (places.length) h += `<div class="rh">Places on the map</div>` + places.map((p, k) => `<div class="ri" data-place="${k}"><span class="ric pl">📍</span><div><b>${esc(p.label)}</b><small>${esc(p.sub)}</small></div></div>`).join("");
      box.innerHTML = h || `<div class="ri muted">Nothing found.</div>`; box.hidden = false; box._p = Array.isArray(places) ? places : [];
    };
    if (!online()) { draw("offline"); } else { draw(null); try { draw(await placeSearch(q)); } catch (e) { draw("offline"); } }
    box.onclick = e => { e.stopPropagation(); const s = e.target.closest("[data-stop]"), p = e.target.closest("[data-place]");
      if (s) { box.hidden = true; onPick({stop: +s.dataset.stop}); } else if (p) { box.hidden = true; onPick({place: box._p[+p.dataset.place]}); } };
  }
  $("#q").addEventListener("input", e => { const v = e.target.value.trim(); query = v.toLowerCase(); render();
    clearTimeout(sTimer); sTimer = setTimeout(() => suggest(v, results, pk => pk.stop != null ? openStop(pk.stop, true) : openPlace(pk.place)), 300); });
  $("#q").addEventListener("keydown", e => { if (e.key === "Enter") { results.hidden = true; e.target.blur(); show("listView"); } });
  document.addEventListener("click", e => { if (!e.target.closest(".searchbox")) results.hidden = true; });

  // ================================================================ place card
  const PIN = '<div class="gpin"><span></span></div>';
  const dropPin = (lat, lng) => { layers.pin.clearLayers(); L.marker([lat, lng], {icon: L.divIcon({className: "", iconSize: [28, 40], iconAnchor: [14, 38], html: PIN})}).addTo(layers.pin); };
  function openPlace(p) {
    dropPin(p.lat, p.lng); map.flyTo([p.lat, p.lng], Math.max(map.getZoom(), 13), {duration: .6});
    const near = placed.map(o => [o, km([p.lat, p.lng], [o.lat, o.lng])]).sort((a, b) => a[1] - b[1]).slice(0, 3);
    const rep = REPORTS.filter(r => km([p.lat, p.lng], [r.lat, r.lng]) < 3);
    $("#placeView").innerHTML = `<div class="dhead">${backBtn()}<h2>${esc(p.label)}</h2><div class="sub">${esc(p.sub || "")}${myPos ? " · " + fmtKm(km(myPos, [p.lat, p.lng])) + " from you" : ""}</div>
      <div class="actions"><button class="btn2" data-go>➤ Directions</button><button class="btn2 alt" data-rep>⚑ Report path here</button></div></div>
      <div class="dbody">${rep.length ? `<div class="fact wide" style="margin-bottom:10px"><b>Path reports nearby</b>${rep.map(r => `<div>${esc(r.label)}${r.note ? " – " + esc(r.note) : ""} <small class="muted">@${esc(r.by)}</small></div>`).join("")}</div>` : ""}
      <div class="fact wide"><b>Nearest parikrama stops</b>${near.map(([o, d]) => `<div class="ri" data-stop="${o._i}" style="padding:6px 0"><span class="ric" style="background:${STAGES[o.st].c}">${esc(o.n || "·")}</span><div><b>${esc(o.v)}</b><small>${fmtKm(d)}</small></div></div>`).join("")}</div></div>`;
    show("placeView");
    const pv = $("#placeView");
    pv.querySelector("[data-go]").onclick = () => openDirections(null, {label: p.label, lat: p.lat, lng: p.lng});
    pv.querySelector("[data-rep]").onclick = () => openReport(p.lat, p.lng);
    pv.querySelectorAll("[data-stop]").forEach(el => el.onclick = () => openStop(+el.dataset.stop, true));
  }
  let pickMode = null;

  // ================================================================ directions (internet needed)
  const ROUTERS = {car: "https://routing.openstreetmap.de/routed-car/route/v1/driving/", bike: "https://routing.openstreetmap.de/routed-car/route/v1/driving/", walk: "https://routing.openstreetmap.de/routed-foot/route/v1/driving/"};
  const MODE = {car: "🚗 Car", bike: "🏍 Bike", walk: "🚶 Paidal"}, GMODE = {car: "driving", bike: "driving", walk: "walking"};
  const dir = {from: null, to: null, mode: "walk"};
  function openDirections(from, to) {
    dir.from = from || {label: "My location", me: true}; dir.to = to;
    $("#dirView").innerHTML = `<div class="dhead">${backBtn()}<h2 style="font-size:20px">Directions</h2>
      <div class="modes">${Object.keys(MODE).map(m => `<button data-mode="${m}" aria-selected="${m === dir.mode}">${MODE[m]}</button>`).join("")}</div>
      <label class="rulechip"><input type="checkbox" id="ruleT" ${RULE ? "checked" : ""}> 🕉 Parikrama rule: don't cross the Narmada</label>
      <div class="endpoints"><div class="ep"><span class="epdot a"></span><input id="fromIn" placeholder="Start"><button class="epbtn" data-me="from">◎</button><button class="epbtn" data-pick="from">⌖</button></div>
      <div class="ep"><span class="epdot b"></span><input id="toIn" placeholder="Destination"><button class="epbtn" data-me="to">◎</button><button class="epbtn" data-pick="to">⌖</button></div>
      <button class="swap" id="swap">⇅</button><div class="results inpanel" id="epResults" hidden></div></div></div><div class="dbody" id="dirOut"></div>`;
    show("dirView");
    const fill = () => { $("#fromIn").value = dir.from ? dir.from.label : ""; $("#toIn").value = dir.to ? dir.to.label : ""; }; fill();
    [["from", $("#fromIn")], ["to", $("#toIn")]].forEach(([k, inp]) => { let t; inp.oninput = () => { clearTimeout(t); t = setTimeout(() => suggest(inp.value.trim(), $("#epResults"), pk => {
      if (pk.stop != null) { const o = DATA[pk.stop]; if (o.lat == null) return toast("That stop isn't on the map yet."); dir[k] = stopPoint(o); } else dir[k] = {label: pk.place.label, lat: pk.place.lat, lng: pk.place.lng};
      fill(); route(); }), 300); }; });
    $$("#dirView [data-me]").forEach(b => b.onclick = () => { dir[b.dataset.me] = {label: "My location", me: true}; fill(); route(); });
    $$("#dirView [data-pick]").forEach(b => b.onclick = () => { const k = b.dataset.pick; toast("Tap the map"); setSheet("min"); pickMode = (la, ln) => { dir[k] = {label: `Pin ${la.toFixed(4)}, ${ln.toFixed(4)}`, lat: la, lng: ln}; fill(); setSheet("half"); route(); }; });
    $("#swap").onclick = () => { [dir.from, dir.to] = [dir.to, dir.from]; fill(); route(); };
    $("#ruleT").onchange = e => { RULE = e.target.checked; store.set("riverRule", RULE); route(); };
    $$("#dirView [data-mode]").forEach(b => b.onclick = () => { dir.mode = b.dataset.mode; $$("#dirView [data-mode]").forEach(x => x.setAttribute("aria-selected", x === b)); route(); });
    route();
  }
  const resolvePt = p => new Promise(res => !p ? res(null) : !p.me ? res([p.lat, p.lng]) : withMyPos(res, () => res(null)));
  function stepText(s) { const m = s.maneuver, n = s.name ? `<b>${esc(s.name)}</b>` : "the road", mod = esc((m.modifier || "").replace("uturn", "U-turn"));
    switch (m.type) { case "depart": return s.name ? `Start on ${n}` : "Start"; case "arrive": return "You have arrived";
      case "turn": case "end of road": return `Turn ${mod} onto ${n}`; case "fork": return `Keep ${mod} at the fork`;
      case "roundabout": case "rotary": return `At the roundabout take exit ${m.exit || ""}`; default: return `Continue${mod ? " " + mod : ""} on ${n}`; } }
  // ---- parikrama rule: never cross the Narmada (river-rule.js + river-data.js bundled in the app)
  let RULE = store.get("riverRule", true);
  const RR = window.RiverRule && window.RIVER && window.RiverRule.init(window.RIVER) ? window.RiverRule : null;
  const BANK = {north: "north (uttar) bank", south: "south (dakshin) bank"};
  const X_ICON = L.divIcon({className: "", iconSize: [26, 26], iconAnchor: [13, 13], html: '<div class="xmark">✕</div>'});
  function drawBankPath(bp) {
    if (!bp) return [];
    const parts = [bp.coords].concat(bp.coords2 ? [bp.coords2] : []);
    parts.forEach(c => L.polyline(c, {color: "#188038", weight: 5, opacity: .85, dashArray: "10 8"}).addTo(layers.road));
    bp.stops.forEach(o => L.circleMarker([o.lat, o.lng], {radius: 4, color: "#fff", weight: 1.5, fillColor: "#188038", fillOpacity: 1}).bindTooltip(esc(o.v)).addTo(layers.road));
    return parts.flat();
  }
  function bankHtml(bp, bankName) {
    if (!bp) return "";
    const names = bp.stops.map(o => esc(o.v || "stop"));
    return `<div class="bankpath"><b>🚶 Parikrama path${bankName ? " along the " + bankName : ""}</b> (green dashed) – about <b>${Math.round(bp.km)} km</b>, ${bp.stops.length} stops:
      <div class="stopchain">${names.slice(0, 40).join(" → ")}${names.length > 40 ? " → …" : ""}</div></div>`;
  }
  function drawRoutes(routes, a, b, crossings, boat, bankPath, greyRoad) {
    layers.road.clearLayers(); layers.pin.clearLayers();
    routes.slice(1).forEach(alt => L.polyline(alt.coords, {color: "#7f9cc9", weight: 5, opacity: .6}).addTo(layers.road));
    const best = routes[0], parts = best.legs ? best.legs.map(l => l.coords) : [best.coords];
    parts.forEach(c => L.polyline(c, greyRoad ? {color: "#8a9599", weight: 5, opacity: .7} : {color: "#1a73e8", weight: 6}).addTo(layers.road));
    const bankPts = drawBankPath(bankPath);
    if (boat) L.polyline(boat, {color: "#0f6e77", weight: 4, dashArray: "2 10"}).addTo(layers.road);
    (crossings || []).forEach(x => L.marker(x, {icon: X_ICON}).addTo(layers.road));
    L.marker(b, {icon: L.divIcon({className: "", iconSize: [28, 40], iconAnchor: [14, 38], html: PIN})}).addTo(layers.road);
    map.fitBounds(parts.flat().concat(boat || [], bankPts), {padding: [60, 60]});
    return best;
  }
  function routeHtml(best, a, b, note) {
    const steps = best.steps.filter(s => s.distance > 0 || s.maneuver.type === "arrive");
    const g = `https://www.google.com/maps/dir/?api=1&origin=${a[0]},${a[1]}&destination=${b[0]},${b[1]}&travelmode=${GMODE[dir.mode]}`;
    setTimeout(() => { const gn = $("#gnav"); if (gn) gn.onclick = () => NATIVE ? NATIVE.openExternal(g) : window.open(g); }, 0);
    return `<div class="routesum"><span class="rtime">${fmtTime(best.duration * (dir.mode === "bike" ? .85 : 1))}</span> <span class="rdist">(${fmtKm(best.distance / 1000)})</span><small>${MODE[dir.mode]} · by road, OpenStreetMap</small></div>
      ${note || ""}<div class="actions" style="margin-bottom:10px"><button class="btn2" id="gnav">▶ Start in Google Maps</button></div>
      ${RULE ? `<p class="hintline">Google Maps may pick a road that crosses the river – follow the blue line here.</p>` : ""}
      <ol class="steps">${steps.slice(0, 60).map(s => `<li><span class="si">↑</span><span>${stepText(s)}</span><small>${s.distance ? fmtKm(s.distance / 1000) : ""}</small></li>`).join("")}</ol>`;
  }
  let rSeq = 0;
  async function route() {
    const out = $("#dirOut"); if (!out) return;
    if (!dir.from || !dir.to) { out.innerHTML = `<div class="empty">Choose a start and a destination.</div>`; return; }
    const [a, b] = await Promise.all([resolvePt(dir.from), resolvePt(dir.to)]);
    if (!a || !b) { out.innerHTML = `<div class="empty">Turn on location to use “My location”.</div>`; return; }
    layers.road.clearLayers();
    const sA = RR ? RR.side(a) : "unknown", sB = RR ? RR.side(b) : "unknown";
    const opposite = RULE && BANK[sA] && BANK[sB] && sA !== sB;
    if (!online()) {
      L.polyline([a, b], {color: "#1a73e8", weight: 4, dashArray: "8 8"}).addTo(layers.road); map.fitBounds([a, b], {padding: [60, 60]});
      out.innerHTML = `<div class="note">You're offline. Road directions need internet.</div>
        ${opposite ? `<div class="note rule">🕉 ${esc(dir.to.label)} is on the ${BANK[sB]}; you are on the ${BANK[sA]}. The parikrama does not cross the Narmada – go round via Amarkantak or the sea crossing.</div>` : ""}
        <p>Straight-line distance: <b>${fmtKm(km(a, b))}</b>.</p>`; return;
    }
    const seq = ++rSeq; out.innerHTML = `<div class="empty">Finding the best ${MODE[dir.mode]} route…</div>`;
    try {
      const plan = RR ? await RR.plan({a, b, router: ROUTERS[dir.mode], rule: RULE, stops: DATA}) : null;
      if (seq !== rSeq) return;
      if (!plan) throw new Error("no river data");
      if (plan.status === "opposite") {
        out.innerHTML = `<div class="note rule">🕉 <b>${esc(dir.to.label)}</b> is on the ${BANK[plan.sideB]}; you start on the ${BANK[plan.sideA]}. The parikrama never crosses the Narmada. Go round:</div>
          <div class="actions"><button class="btn2" data-around="source">Via Amarkantak (source)</button><button class="btn2 alt" data-around="sea">Via sea crossing (boat)</button></div>
          <div class="actions"><button class="btn2 alt" data-around="direct">Direct road anyway</button></div><div id="aroundOut"></div>`;
        out.querySelectorAll("[data-around]").forEach(btn => btn.onclick = async () => {
          const box = $("#aroundOut"); box.innerHTML = `<div class="empty">Planning…</div>`;
          try {
            if (btn.dataset.around === "direct") {
              const p2 = await RR.plan({a, b, router: ROUTERS[dir.mode], rule: false, stops: DATA});
              box.innerHTML = routeHtml(drawRoutes(p2.routes, a, b, p2.crossings), a, b, `<div class="note warn">⚠ Crosses the Narmada ${p2.crossings.length} time(s) (✕). Not allowed during parikrama.</div>`); return;
            }
            const r = await RR.planAround({a, b, router: ROUTERS[dir.mode], stops: DATA, which: btn.dataset.around});
            const note = r.which === "source" ? `<div class="note ok">✓ Round the source at Amarkantak.</div>`
              : `<div class="note ok">✓ Road to ${esc(r.coastA)}, <b>boat across the Gulf (~${Math.round(r.boatKm)} km, not in the time)</b> to ${esc(r.coastB)}, then road. Ask locally for boat timings.</div>`;
            box.innerHTML = routeHtml(drawRoutes(r.routes, a, b, r.crossings, r.boat, r.bankPath, r.crossings.length > 0), a, b, note + bankHtml(r.bankPath));
          } catch (e) { box.innerHTML = `<div class="empty">Couldn't plan that right now.</div>`; }
        });
        return;
      }
      const notes = {
        ok: BANK[plan.sideA] && plan.sideA === plan.sideB ? `<div class="note ok">✓ Stays on the ${BANK[plan.sideA]}.</div>` : `<div class="note ok">✓ Does not cross the Narmada.</div>`,
        kept: `<div class="note ok">✓ Kept on the ${BANK[plan.bank]} through ${plan.via} parikrama stops.</div>`,
        crosses: bankHtml(plan.bankPath, BANK[plan.bank]) + `<div class="note warn">⚠ The map has no road that stays on this bank, so the road route (grey) crosses the Narmada at ✕. Walk the parikrama path instead – bank footpaths are often missing from the map; ask locally.</div>`,
        free: plan.crossings.length ? `<div class="note">Crosses the Narmada ${plan.crossings.length} time(s).</div>` : ""};
      const crossing = plan.status === "crosses";
      out.innerHTML = routeHtml(drawRoutes(plan.routes, a, b, crossing || plan.status === "free" ? plan.crossings : [], null, crossing ? plan.bankPath : null, crossing), a, b, notes[plan.status]);
    } catch (e) { out.innerHTML = `<div class="empty">No ${MODE[dir.mode]} route found. Try another mode.</div>`; }
  }
  $("#dirOpen").onclick = e => { e.preventDefault(); e.stopPropagation(); openDirections(null, null); };

  // ================================================================ path reports (queued when offline)
  const reportIcon = r => L.divIcon({className: "", iconSize: [30, 30], iconAnchor: [15, 15], html: `<div class="rmark${r.pending ? " pend" : ""}">${(REPORT_KINDS[r.kind] || "📝").split(" ")[0]}</div>`});
  function drawReports() {
    layers.reports.clearLayers();
    REPORTS.forEach(r => L.marker([r.lat, r.lng], {icon: reportIcon(r)}).bindPopup(`<b>${esc(r.label || REPORT_KINDS[r.kind])}</b>${r.note ? "<br>" + esc(r.note) : ""}<br><small>@${esc(r.by || ME && ME.username)}${r.pending ? " · waiting" : ""}</small>`).addTo(layers.reports));
  }
  function openReport(lat, lng) {
    let spot = lat != null ? [lat, lng] : null, kind = null, mode = "all", note = "";
    const draw = () => {
      $("#reportView").innerHTML = `<div class="dhead">${backBtn()}<h2 style="font-size:20px">Report the path</h2><div class="sub">You must be within 5 km of the spot. Works offline – sent when you have internet.</div></div>
        <div class="dbody"><div class="fact wide" style="margin-bottom:10px"><b>Spot</b>${spot ? spot[0].toFixed(5) + ", " + spot[1].toFixed(5) : "Not chosen"}
          <div class="actions"><button class="btn2 alt" data-me>◎ Where I am</button><button class="btn2 alt" data-pick>⌖ Tap on map</button></div></div>
        <div class="kinds">${Object.entries(REPORT_KINDS).map(([k, v]) => `<button class="kind${kind === k ? " on" : ""}" data-kind="${k}">${esc(v)}</button>`).join("")}</div>
        <div class="modes" style="margin:10px 0">${["all", "walk", "bike", "car"].map(m => `<button data-rmode="${m}" aria-selected="${mode === m}">${m === "all" ? "Everyone" : MODE[m]}</button>`).join("")}</div>
        <textarea id="rNote" class="rnote" maxlength="500" placeholder="Details (optional)"></textarea>
        <div class="actions"><button class="btn2" id="rSend">Send report</button></div><p class="hintline" id="rMsg"></p></div>`;
      $("#rNote").value = note;
      const rv = $("#reportView"), keep = () => { note = $("#rNote").value; draw(); };
      rv.querySelector("[data-me]").onclick = () => withMyPos(p => { spot = p; dropPin(p[0], p[1]); keep(); });
      rv.querySelector("[data-pick]").onclick = () => { setSheet("min"); toast("Tap the spot on the map"); pickMode = (a, b) => { spot = [a, b]; dropPin(a, b); setSheet("half"); keep(); }; };
      rv.querySelectorAll("[data-kind]").forEach(b => b.onclick = () => { kind = b.dataset.kind; keep(); });
      rv.querySelectorAll("[data-rmode]").forEach(b => b.onclick = () => { mode = b.dataset.rmode; keep(); });
      rv.querySelector("#rSend").onclick = () => {
        if (!spot) return ($("#rMsg").textContent = "Choose the spot first.");
        if (!kind) return ($("#rMsg").textContent = "Choose what kind of report this is.");
        $("#rMsg").textContent = "Checking your location…";
        withMyPos(async () => {
          const fields = {lat: spot[0], lng: spot[1], kind, mode, note: $("#rNote").value, my_lat: lastFix.lat, my_lng: lastFix.lng, my_acc: lastFix.acc};
          await queueAdd({type: "report", path: "/reports", fields, files: []});
          REPORTS.unshift({id: "local" + Date.now(), lat: spot[0], lng: spot[1], kind, note: fields.note, by: ME.username, pending: true, label: REPORT_KINDS[kind]}); drawReports();
          layers.pin.clearLayers(); toast(online() ? "Sending your report…" : "Saved. It will be sent when you have internet."); back(); sync();
        }, () => ($("#rMsg").textContent = "Turn on location – reports are only accepted from people near the spot."));
      };
    };
    if (spot) dropPin(spot[0], spot[1]); draw(); show("reportView");
  }

  // ================================================================ stop update (queued when offline)
  // server field name -> short key used in the stops list
  const KEY = {village: "v", village_mr: "vm", dist: "d", cum: "cum", special: "sp", stay: "acc", temples: "te", tirth: "ti",
               sangam: "sa", ghat: "gh", bridge: "br", path: "rt", food: "fd", rations: "sd", halt: "h"};
  function openUpdate(o) {
    const files = [];
    const fl = FIELDS.length ? FIELDS : [["stay", "Place to stay", "textarea"], ["food", "Cooked food available", "yesno"], ["rations", "Sadavrat (rations) available", "yesno"], ["path", "Path to next stop", "text"], ["special", "Special note", "textarea"]];
    $("#updateView").innerHTML = `<div class="dhead">${backBtn()}<h2 style="font-size:20px">Update ${esc(o.v || "stop")}</h2>
      <div class="sub">Change only what you see is different now. You must be at this place. Works offline – sent when you have internet.</div></div>
      <div class="dbody">
        <div class="ufield"><label>Photos (up to 6)</label><input type="file" id="uPhotos" accept="image/*" multiple><div class="thumbs" id="uThumbs"></div></div>
        ${fl.map(([name, label, kind]) => `<div class="ufield"><label>${esc(label)}</label>${kind === "yesno"
          ? `<select data-f="${name}"><option value="">(no change)</option><option>Yes</option><option>No</option></select>`
          : kind === "textarea" ? `<textarea data-f="${name}" rows="2">${esc(o[KEY[name] || name] || "")}</textarea>`
          : `<input data-f="${name}" value="${esc(o[KEY[name] || name] || "")}">`}</div>`).join("")}
        <div class="ufield"><label>How do you know? (optional)</label><textarea id="uNote" rows="2"></textarea></div>
        <div class="actions"><button class="btn2" id="uSend">Send update</button></div><p class="hintline" id="uMsg"></p></div>`;
    show("updateView");
    const orig = {}; $$("#updateView [data-f]").forEach(el => orig[el.dataset.f] = el.value);
    $("#uPhotos").onchange = e => { files.length = 0; [...e.target.files].slice(0, 6).forEach(f => files.push(f));
      $("#uThumbs").innerHTML = ""; files.forEach(f => { const i = document.createElement("img"); i.src = URL.createObjectURL(f); $("#uThumbs").appendChild(i); }); };
    $("#uSend").onclick = () => {
      const fields = {};
      $$("#updateView [data-f]").forEach(el => { if (el.value !== orig[el.dataset.f] && !(el.tagName === "SELECT" && el.value === "")) fields[el.dataset.f] = el.value; });
      if (!Object.keys(fields).length && !files.length) return ($("#uMsg").textContent = "Change something or add a photo first.");
      fields.note = $("#uNote").value;
      $("#uMsg").textContent = "Checking your location…";
      withMyPos(async () => {
        fields.lat = lastFix.lat; fields.lng = lastFix.lng; fields.accuracy = lastFix.acc;
        await queueAdd({type: "update", path: `/stops/${o.id}/updates`, fields, files: files.map(f => ({field: "photos", name: f.name, blob: f}))});
        toast(online() ? "Sending your update…" : "Saved. It will be sent when you have internet."); back(); sync();
      }, () => ($("#uMsg").textContent = "Turn on location – updates must be sent from the place."));
    };
  }

  // ================================================================ menu: offline map, recording, timeline, settings
  function openMenu() {
    const has = NATIVE && NATIVE.hasOfflineMap(), rec = NATIVE && NATIVE.isTracking();
    $("#menuView").innerHTML = `<div class="dhead">${backBtn()}<h2>@${esc(ME && ME.username)}</h2><div class="sub">${esc({admin: "Admin", super: "Super user"}[ME && ME.role] || "Pilgrim")} · app ${NATIVE ? esc(NATIVE.appVersion()) : "web"}</div></div>
      <div class="dbody">
        <div class="mrow"><span class="mi">🗺</span><div><b>Offline map</b><small id="mapState">${has ? "Downloaded · " + fmtMB(NATIVE.offlineMapBytes()) : "Not downloaded – the map needs internet"}</small>
          <div class="progress" id="mapProg" hidden><span></span></div></div><button class="btn2 alt" id="mapBtn">${has ? "Update" : "Download"}</button></div>
        ${has ? `<div class="mrow"><span class="mi">🗑</span><div><b>Delete offline map</b><small>Frees space on the phone</small></div><button class="btn2 alt" id="mapDel">Delete</button></div>` : ""}
        <div class="mrow"><span class="mi">🕒</span><div><b>Record my journey</b><small>Saves your route for “My timeline”, also offline and with the screen off</small></div><button class="toggle${rec ? " on" : ""}" id="recT" aria-label="Record my journey"></button></div>
        <div class="mrow" id="tlOpen" style="cursor:pointer"><span class="mi">📅</span><div><b>My timeline</b><small>Your days, distance and stops passed${NATIVE && NATIVE.pointCount() ? ` · ${NATIVE.pointCount()} points waiting to upload` : ""}</small></div><span>›</span></div>
        <div class="mrow"><span class="mi">👁</span><div><b>Show me to other pilgrims</b><small>Username and approximate area only</small></div><button class="toggle${ME && ME.show_on_map ? " on" : ""}" id="showT"></button></div>
        <div class="mrow"><span class="mi">🔴</span><div><b>Share my live location</b><small>Other pilgrims see exactly where you are (every ~20 s), also while you use other apps</small></div><button class="toggle${ME && ME.share_live ? " on" : ""}" id="liveT" aria-label="Share my live location"></button></div>
        <div class="mrow"><span class="mi">🚶</span><div><b>Share my yatra path publicly</b><small>Everyone sees the route you walked (from “Record my journey”) with your username</small></div><button class="toggle${ME && ME.share_path ? " on" : ""}" id="shareT" aria-label="Share my yatra path"></button></div>
        ${NATIVE && NATIVE.ignoresBatteryLimits ? `<div class="mrow"><span class="mi">🔋</span><div><b>Work in the background</b><small>${NATIVE.ignoresBatteryLimits() ? "On ✓ – GPS keeps working while you use other apps" : "Some phones stop GPS apps to save battery. Allow this app to run in the background."}</small></div>${NATIVE.ignoresBatteryLimits() ? "" : `<button class="btn2 alt" id="batBtn">Allow</button>`}</div>` : ""}
        <div class="mrow"><span class="mi">🔄</span><div><b>Sync now</b><small id="syncState">${store.get("lastSync", null) ? "Last synced " + new Date(store.get("lastSync")).toLocaleString("en-IN") : "Not synced yet"}</small></div><button class="btn2 alt" id="syncBtn">Sync</button></div>
        <div class="mrow"><span class="mi">🌐</span><div><b>Server</b><small>${esc(SERVER)}</small></div></div>
        <div class="actions" style="margin-top:14px"><button class="btn2 alt" id="logoutBtn">Log out</button></div>
      </div>`;
    show("menuView");
    $("#mapBtn").onclick = downloadMap;
    if ($("#mapDel")) $("#mapDel").onclick = () => { NATIVE.deleteOfflineMap(); toast("Offline map deleted. Restart the app."); openMenu(); };
    $("#recT").onclick = () => { if (!NATIVE) return toast("Only in the Android app.");
      if (NATIVE.isTracking()) { NATIVE.stopTracking(); store.set("recording", false); if (ME && ME.share_live) toast("Live location also stops while recording is off in the background."); } else { store.set("recording", NATIVE.startTracking()); }
      setTimeout(openMenu, 400); };
    $("#tlOpen").onclick = openTimeline;
    $("#showT").onclick = async () => { if (!online()) return toast("Needs internet.");
      try { ME = await apiJSON("/me/settings", {method: "POST", body: form({show_on_map: ME.show_on_map ? 0 : 1})}); store.set("me", ME); openMenu(); } catch (e) { toast(e.message); } };
    $("#liveT").onclick = async () => { if (!online()) return toast("Needs internet.");
      try { ME = await apiJSON("/me/settings", {method: "POST", body: form({share_live: ME.share_live ? 0 : 1})}); store.set("me", ME);
        toast(ME.share_live ? "Live location ON 🔴 – also while you use other apps" : "Live location OFF");
        if (ME.share_live && NATIVE && NATIVE.ignoresBatteryLimits && !NATIVE.ignoresBatteryLimits() && !store.get("batAsked", false)) { store.set("batAsked", true); setTimeout(() => NATIVE.askBatteryUnrestricted(), 800); } if (ME.share_live) livePing(); nativeAuth(); openMenu(); } catch (e) { toast(e.message); } };
    $("#shareT").onclick = async () => { if (!online()) return toast("Needs internet.");
      try { ME = await apiJSON("/me/settings", {method: "POST", body: form({share_path: ME.share_path ? 0 : 1})}); store.set("me", ME);
        toast(ME.share_path ? "Your path is now public 🚶" : "Your path is private again"); openMenu(); loadPaths().catch(() => {}); } catch (e) { toast(e.message); } };
    if ($("#batBtn")) $("#batBtn").onclick = () => { NATIVE.askBatteryUnrestricted(); setTimeout(openMenu, 4000); };
    $("#syncBtn").onclick = () => sync(true);
    $("#logoutBtn").onclick = () => logout(false);
  }
  let dlTimer = null;
  async function downloadMap() {
    if (!NATIVE) return toast("Only in the Android app.");
    if (!online()) return toast("Connect to the internet (Wi-Fi is best) to download the map.");
    try {
      const info = await apiJSON("/map");
      if (!info.available) return toast("The server has no offline map yet. Ask the admin to download it (Admin → Offline map on the website).");
      if (NATIVE.freeSpaceBytes() < info.bytes * 1.2) return toast(`Not enough space: the map needs ${fmtMB(info.bytes)}.`);
      store.set("mapMaxZoom", info.maxzoom);
      NATIVE.downloadMap(SERVER.replace(/\/$/, "") + info.url, TOKEN);
      toast(`Downloading the offline map (${fmtMB(info.bytes)})…`);
      clearInterval(dlTimer);
      dlTimer = setInterval(() => {
        const s = JSON.parse(NATIVE.mapDownloadStatus()), prog = $("#mapProg");
        if (prog) { prog.hidden = false; prog.firstElementChild.style.width = s.total ? (100 * s.bytes / s.total).toFixed(1) + "%" : "5%"; }
        const st = $("#mapState"); if (st && s.state === "running") st.textContent = `Downloading… ${fmtMB(s.bytes)} of ${fmtMB(s.total || info.bytes)}`;
        if (s.state === "done") { clearInterval(dlTimer); toast("Offline map ready! Restarting the map…"); setTimeout(() => location.reload(), 1200); }
        if (s.state === "failed") { clearInterval(dlTimer); toast("Download failed. Try again on a better connection."); }
      }, 1500);
    } catch (e) { toast(e.message); }
  }

  async function openTimeline() {
    $("#timelineView").innerHTML = `<div class="dhead">${backBtn()}<h2 style="font-size:20px">🕒 My timeline</h2><div class="sub">Only you can see this.</div></div><div class="dbody" id="tlBody"><div class="empty">Loading…</div></div>`;
    show("timelineView");
    await loadLocalPhotos();
    const byDay = {}; LOCAL_PHOTOS.slice().sort((a, b) => b.ts - a.ts).forEach(r => (byDay[dayOf(r.ts)] = byDay[dayOf(r.ts)] || []).push(r));
    if (!online()) {
      $("#tlBody").innerHTML = `<div class="empty">Your journey is being saved on this phone${NATIVE ? ` (${NATIVE.pointCount()} points waiting)` : ""}.<br>Connect to the internet to upload it and see your days.</div>` +
        Object.keys(byDay).map(d => `<div class="dayrow"><div><b>${d}</b><small>📷 ${byDay[d].length} photo(s)</small></div></div>${photoStrip(byDay[d])}`).join("");
      wireStrip($("#tlBody")); return;
    }
    await sync();
    try {
      const j = await apiJSON("/timeline/days");
      const days = j.days.slice(); Object.keys(byDay).forEach(d => { if (!days.some(x => x.day === d)) days.push({day: d, from: "", to: "", km: 0}); }); days.sort((a, b) => b.day.localeCompare(a.day));
      $("#tlBody").innerHTML = `<p><b>${j.total_km} km</b> in ${j.days.length} day(s)${LOCAL_PHOTOS.length ? ` · 📷 ${LOCAL_PHOTOS.length} photo(s)` : ""}</p>` + (days.map(d => `<div class="dayrow" data-day="${d.day}"><div><b>${d.day}</b><small>${d.from ? d.from + " – " + d.to : ""}${byDay[d.day] ? ` · 📷 ${byDay[d.day].length}` : ""}</small></div><b>${d.km} km</b></div>${photoStrip(byDay[d.day] || [])}`).join("") || `<div class="empty">Nothing recorded yet. Turn on “Record my journey” in the menu.</div>`);
      $$("#tlBody .dayrow").forEach(r => r.onclick = async () => {
        $$("#tlBody .dayrow").forEach(x => x.classList.toggle("on", x === r));
        const t = await apiJSON("/timeline?day=" + r.dataset.day);
        layers.track.clearLayers();
        const pts = t.points.map(p => [p[0], p[1]]).concat((byDay[r.dataset.day] || []).filter(x => x.lat != null).map(x => [x.lat, x.lng]));
        if (t.points.length) L.polyline(t.points.map(p => [p[0], p[1]]), {color: "#1a73e8", weight: 5}).addTo(layers.track);
        if (pts.length) { map.fitBounds(pts, {padding: [40, 40], maxZoom: 16}); if (map.getZoom() < PHOTO_ZOOM && byDay[r.dataset.day]) map.setZoom(PHOTO_ZOOM); setSheet("min"); }
      });
      wireStrip($("#tlBody"));
    } catch (e) { $("#tlBody").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }

  // ================================================================ location
  let meMarker = null;
  function setMyPos(p) {
    myPos = [p.coords.latitude, p.coords.longitude]; lastFix = {lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, t: Date.now()};
    if (!map) return;
    if (!meMarker) meMarker = L.marker(myPos, {icon: L.divIcon({className: "", html: '<div class="mepin"></div>', iconSize: [18, 18]}), zIndexOffset: 1000}).addTo(map);
    else meMarker.setLatLng(myPos);
  }
  function withMyPos(cb, fail) {
    if (lastFix && Date.now() - lastFix.t < 60000) return cb(myPos);
    navigator.geolocation.getCurrentPosition(p => { setMyPos(p); cb(myPos); }, () => { toast("Turn on location (GPS)."); if (fail) fail(); },
      {enableHighAccuracy: true, timeout: 25000, maximumAge: 30000});
  }
  window.onNativePermission = ok => { if (ok) navigator.geolocation.getCurrentPosition(setMyPos, () => {}, {enableHighAccuracy: true}); };

  // ================================================================ sync with the server
  let syncing = false;
  async function sync(manual) {
    if (syncing || !TOKEN) return; if (!online()) { updateNetbar(); if (manual) toast("You're offline."); return; }
    syncing = true;
    try {
      // 1. send queued reports / updates
      for (const item of await queueAll()) {
        const fd = form(item.fields); (item.files || []).forEach(f => fd.append(f.field, f.blob, f.name));
        try {
          const r = await api(item.path, {method: "POST", body: fd, timeout: 120000});
          const j = await r.json().catch(() => ({}));
          if (r.ok) { await queueDel(item.id); toast(j.message || "Sent ✓"); }
          else if (r.status >= 400 && r.status < 500) { await queueDel(item.id); toast("Not accepted: " + (j.error || r.status)); }
        } catch (e) { break; }     // network trouble – try again later
      }
      // 2. upload journey points recorded by the phone
      if (NATIVE) {
        for (let i = 0; i < 20; i++) {
          const pts = JSON.parse(NATIVE.pendingPoints(2000)); if (!pts.length) break;
          const r = await api("/timeline/points", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({points: pts})});
          if (!r.ok) break; NATIVE.clearPoints(Math.max(...pts.map(p => p.ts)));
        }
      }
      // 2b. public camera photos
      await uploadPhotos().catch(() => {});
      // 3. presence (online pilgrims) + fresh data
      await api("/presence", {method: "POST", body: form(lastFix ? {lat: lastFix.lat, lng: lastFix.lng, accuracy: lastFix.acc} : {})});
      const cachedStops = store.get("stops", null);
      const r = await api("/stops", {headers: cachedStops ? {"If-None-Match": '"' + cachedStops.version + '"'} : {}});
      if (r.status === 200) { const j = await r.json(); store.set("stops", {version: j.version, stops: j.stops, fields: j.fields}); FIELDS = j.fields; setStops(j.stops); drawStops(); }
      const rep = await apiJSON("/reports"); REPORTS = rep.reports; REPORT_KINDS = rep.kinds; store.set("reports", REPORTS); store.set("reportKinds", REPORT_KINDS); drawReports();
      await loadOnline();
      await loadPaths().catch(() => {});
      await loadFamily().catch(() => {});
      await checkNotify().catch(() => {});
      store.set("lastSync", Date.now());
      if (manual) toast("Synced ✓");
    } catch (e) { if (manual) toast(e.message || "Sync failed"); }
    finally { syncing = false; updateNetbar(); }
  }
  const agoText = u => u.live && u.sec < 90 ? "live now" : (u.ago ? u.ago + " min ago" : "online now");
  const personTip = u => `@${esc(u.u)} · ${agoText(u)} · ${u.live ? "live location" + (u.acc ? " ±" + u.acc + " m" : "") : "approx. area"}`;
  const personIcon = u => { const c = hue(u.u); return L.divIcon({className: "", iconSize: [30, 30], iconAnchor: [15, 15],
    html: `<div class="pmark${u.live ? " live" : ""}" style="color:${c}"><span class="ring"></span><div class="dot" style="background:${c}">${esc(u.u[0].toUpperCase())}</div>${u.live ? '<span class="livetag">LIVE</span>' : ""}<span class="lbl">@${esc(u.u)}</span></div>`}); };
  async function loadOnline() {
    const j = await apiJSON("/online"); const list = j.online || [];
    $("#onlineCount").textContent = list.length; layers.people.clearLayers();
    const fam = new Set(((typeof FAMILY !== "undefined" && FAMILY.members) || []).map(m => m.u));   // family has its own exact marker
    list.forEach(u => { if (u.lat == null || u.me || fam.has(u.u)) return;
      L.marker([u.lat, u.lng], {icon: personIcon(u), zIndexOffset: u.live ? 500 : 0}).bindTooltip(personTip(u)).addTo(layers.people); });
    $("#onlineList").innerHTML = list.map(u => `<div class="ou" data-lat="${u.lat ?? ""}" data-lng="${u.lng ?? ""}"><div class="av" style="background:${hue(u.u)}">${esc(u.u[0].toUpperCase())}</div><div><b>@${esc(u.u)}</b>${u.me ? " <small>(you)</small>" : ""}<br><small>${u.live ? "🔴 " : ""}${agoText(u)}${u.live ? " · live location" : ""}</small></div></div>`).join("") || `<div class="empty">No one else online.</div>`;
  }


  // ================================================================ camera: geotagged, time-stamped photos
  // Every photo is stamped (place, GPS, phone date/time, @user), kept on this phone and saved to the gallery.
  // Public ones are also sent to the server and appear on everyone's map when zoomed in; private ones never leave the phone.
  const PHOTO_ZOOM = 12;
  // who can see a photo: me (only this phone) · family (my family circle) · public (everyone, on the map)
  const VIS = {me: {i: "🔒", t: "Only me", d: "Stays on this phone"}, family: {i: "👨‍👩‍👧", t: "Family", d: "Sent straight to your family – they get a notification"},
               public: {i: "🌍", t: "Public", d: "Everyone sees it on the map when they zoom in here"}};
  const visOf = r => r.vis || (r.public ? "public" : "me");
  const defaultVis = () => store.get("photoVis", store.get("photoPublic", false) ? "public" : "me");
  let LOCAL_PHOTOS = [], SERVER_PHOTOS = store.get("photosCache", []), thumbURLs = {};
  const blobURL = (id, blob) => thumbURLs[id] || (thumbURLs[id] = URL.createObjectURL(blob));
  const dayOf = ts => new Date(ts).toLocaleDateString("en-CA");          // YYYY-MM-DD in the phone's time zone
  function nearestStop(lat, lng) {
    let best = null, bd = 1e9;
    placed.forEach(o => { const d = km([lat, lng], [o.lat, o.lng]); if (d < bd) { bd = d; best = o; } });
    return best && bd < 25 ? {name: best.v, km: bd} : null;
  }
  function fixForPhoto() {
    if (lastFix && Date.now() - lastFix.t < 120000) return Promise.resolve(lastFix);
    return new Promise(res => {
      if (!navigator.geolocation) return res(lastFix);
      navigator.geolocation.getCurrentPosition(p => { setMyPos(p); res(lastFix); }, () => res(lastFix && Date.now() - lastFix.t < 900000 ? lastFix : null),
        {enableHighAccuracy: true, timeout: 12000, maximumAge: 60000});
    });
  }
  const loadImg = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  const toBlob = (cv, q) => new Promise(res => cv.toBlob(res, "image/jpeg", q));
  const toDataURL = blob => new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });

  async function stampPhoto(file, fix, ts) {
    const url = URL.createObjectURL(file), img = await loadImg(url); URL.revokeObjectURL(url);
    const k = Math.min(1, 2048 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h; const g = cv.getContext("2d");
    g.drawImage(img, 0, 0, w, h);
    // the stamp strip on the lower part
    const fs = Math.max(14, Math.round(Math.min(w, h) * 0.034)), pad = Math.round(fs * 0.7), lh = Math.round(fs * 1.35);
    const near = fix ? nearestStop(fix.lat, fix.lng) : null;
    const d = new Date(ts);
    const when = d.toLocaleString("en-IN", {day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true, timeZoneName: "short"});
    const lines = [
      {t: near ? `📍 Near ${near.name}${near.km >= 0.5 ? ` (${near.km.toFixed(1)} km)` : ""}` : "📍 Narmada Parikrama", b: true},
      {t: fix ? `${Math.abs(fix.lat).toFixed(6)}°${fix.lat >= 0 ? "N" : "S"}, ${Math.abs(fix.lng).toFixed(6)}°${fix.lng >= 0 ? "E" : "W"}${fix.acc ? `  ±${Math.round(fix.acc)} m` : ""}` : "GPS location not available"},
      {t: `🕒 ${when}`},
      {t: `@${(ME && ME.username) || "pilgrim"} · Narmada Parikrama`, s: true},
    ];
    const bh = pad * 2 + lh * lines.length;
    const grad = g.createLinearGradient(0, h - bh - pad * 2, 0, h);
    grad.addColorStop(0, "rgba(0,0,0,0)"); grad.addColorStop(0.25, "rgba(0,0,0,.55)"); grad.addColorStop(1, "rgba(0,0,0,.72)");
    g.fillStyle = grad; g.fillRect(0, h - bh - pad * 2, w, bh + pad * 2);
    g.textBaseline = "top"; g.shadowColor = "rgba(0,0,0,.6)"; g.shadowBlur = 3;
    lines.forEach((l, i) => {
      g.font = `${l.b ? "700 " : ""}${l.s ? Math.round(fs * 0.8) : fs}px Roboto, "Noto Sans", sans-serif`;
      g.fillStyle = l.s ? "rgba(255,255,255,.8)" : "#fff";
      g.fillText(l.t, pad, h - bh + pad + i * lh, w - pad * 2);
    });
    const blob = await toBlob(cv, 0.88);
    // square thumbnail for the map
    const s = Math.min(w, h), tc = document.createElement("canvas"); tc.width = tc.height = 240;
    tc.getContext("2d").drawImage(cv, (w - s) / 2, Math.max(0, (h - s) / 2 - bh / 2), s, s, 0, 0, 240, 240);
    return {blob, thumb: await toBlob(tc, 0.8), near: near ? near.name : "", w, h};
  }

  async function takePhoto(file, req) {
    toast("Adding place and time…");
    const ts = Date.now(), fix = await fixForPhoto();
    let shot; try { shot = await stampPhoto(file, fix, ts); } catch (e) { return toast("Could not read the photo."); }
    const url = URL.createObjectURL(shot.blob), canShare = !!fix;
    let vis = !canShare ? "me" : (req ? (defaultVis() === "public" ? "public" : "family") : defaultVis());
    $("#photoView").innerHTML = `<div class="dhead">${backBtn("Cancel")}<h2 style="font-size:20px">📷 New photo</h2>
        <div class="sub">${fix ? `±${Math.round(fix.acc || 0)} m · ${esc(shot.near || "on the parikrama")}` : "⚠ No GPS fix – the photo is saved but can't go on the map"}</div></div>
      <div class="dbody"><img class="phprev" src="${url}" alt="Your photo with place and time">
        <label class="lbl2" for="phCap">Caption (optional)</label><input id="phCap" maxlength="300" placeholder="e.g. Morning aarti at the ghat">
        ${req ? `<div class="note ok">📷 For @${esc(req.u)}, who asked for a photo</div>` : ""}
        <div class="lbl2">Who can see it</div>
        <div class="seg" id="phVis" role="radiogroup">${Object.entries(VIS).map(([k, v]) => `<button role="radio" data-vis="${k}" aria-checked="${k === vis}" ${!canShare && k !== "me" ? "disabled" : ""}>${v.i} ${v.t}</button>`).join("")}</div>
        <small class="hintline" id="phWho">${VIS[vis].d}</small>
        <div class="actions"><button class="btn2" id="phSave">Save photo</button><button class="btn2 alt" id="phRetake">Retake</button></div>
        <p class="hintline">Saved to your gallery (Pictures › Narmada Parikrama) and your timeline.</p></div>`;
    show("photoView"); setSheet("full");
    $("#phVis").onclick = e => { const b = e.target.closest("[data-vis]"); if (!b || b.disabled) return; vis = b.dataset.vis;
      $$("#phVis [data-vis]").forEach(x => x.setAttribute("aria-checked", x === b)); $("#phWho").textContent = VIS[vis].d;
      if (!req) store.set("photoVis", vis); };            // remembered: choose Family once and every photo goes to family
    $("#phRetake").onclick = () => { URL.revokeObjectURL(url); back(); openCamera(req); };
    $("#phSave").onclick = async () => {
      $("#phSave").disabled = true;
      const rec = {id: "p" + ts + "_" + Math.random().toString(36).slice(2, 8), ts, lat: fix ? fix.lat : null, lng: fix ? fix.lng : null, acc: fix ? fix.acc : null,
        near: shot.near, caption: $("#phCap").value.trim(), vis, reqId: req && vis !== "me" ? req.id : null, uploaded: false, serverId: null, blob: shot.blob, thumb: shot.thumb};
      await photoPut(rec);
      const d = new Date(ts), p2 = n => String(n).padStart(2, "0");
      const name = `Narmada_${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.jpg`;
      let inGallery = false;
      if (NATIVE && NATIVE.saveToGallery) inGallery = NATIVE.saveToGallery(await toDataURL(shot.blob), name);
      URL.revokeObjectURL(url);
      toast(vis === "me" ? `Saved ✓ ${inGallery ? "in your gallery – " : ""}only you can see it`
        : (online() ? `Saved ✓ Sending to ${vis === "family" ? "your family" : "the map"}…` : `Saved ✓ It is sent when you're online`));
      if (req && vis === "me" && online()) api(`/photo-requests/${req.id}/decline`, {method: "POST"}).catch(() => {});
      back(); setSheet("min"); await loadLocalPhotos(); if (rec.lat != null) map.setView([rec.lat, rec.lng], Math.max(map.getZoom(), 15));
      if (vis !== "me") sync();
      if (req) loadFamily().catch(() => {});
    };
  }
  let pendingReq = null;
  function openCamera(req) { pendingReq = req || null; const i = $("#camIn"); i.value = ""; fixForPhoto(); i.click(); }

  async function uploadPhotos() {
    for (const rec of await photoAll()) {
      const v = visOf(rec);
      if (v === "me" || rec.lat == null || (rec.uploaded && rec.sentVis === v)) continue;
      const fd = form({lat: rec.lat, lng: rec.lng, acc: rec.acc, ts: rec.ts / 1000, caption: rec.caption, near: rec.near, client_id: rec.id,
                       visibility: v, request_id: rec.reqId || ""});
      fd.append("photo", rec.blob, rec.id + ".jpg");
      const r = await api("/photos", {method: "POST", body: fd, timeout: 120000});
      const j = await r.json().catch(() => ({}));
      if (r.ok) { rec.uploaded = true; rec.sentVis = v; rec.serverId = j.photo.id; await photoPut(rec); toast(v === "family" ? "Photo sent to your family 👨‍👩‍👧" : "Photo shared on the map 🌍"); }
      else if (r.status >= 400 && r.status < 500) { rec.vis = "me"; delete rec.public; await photoPut(rec); toast("Photo kept private: " + (j.error || r.status)); }
      else break;
    }
  }

  // ---------------------------------------------------------------- photos on the map (zoomed in, like Google Maps)
  async function loadLocalPhotos() { try { LOCAL_PHOTOS = await photoAll(); } catch (e) { LOCAL_PHOTOS = []; } drawPhotos(); }
  let photoTimer = null;
  function fetchAreaPhotos() {
    clearTimeout(photoTimer);
    photoTimer = setTimeout(async () => {
      if (!map || map.getZoom() < PHOTO_ZOOM || !online() || !TOKEN) return drawPhotos();
      const b = map.getBounds().pad(0.3);
      try {
        const j = await apiJSON(`/photos?bbox=${[b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map(x => x.toFixed(4)).join(",")}`);
        const have = new Set(SERVER_PHOTOS.map(x => x.id));
        SERVER_PHOTOS = SERVER_PHOTOS.concat(j.photos.filter(x => !have.has(x.id))).slice(-600);
        store.set("photosCache", SERVER_PHOTOS);
      } catch (e) { /* offline: use the cache */ }
      drawPhotos();
    }, 400);
  }
  const absURL = u => /^https?:/.test(u) ? u : SERVER.replace(/\/$/, "") + u;
  function allPhotos() {
    const mine = new Set(LOCAL_PHOTOS.map(r => r.id));
    const local = LOCAL_PHOTOS.filter(r => r.lat != null).map(r => ({local: r, id: r.id, lat: r.lat, lng: r.lng, ts: r.ts, thumb: blobURL(r.id + "t", r.thumb),
      u: ME && ME.username, mine: true, priv: visOf(r) === "me", fam: visOf(r) === "family", near: r.near, caption: r.caption}));
    const srv = SERVER_PHOTOS.filter(x => !(x.mine && mine.has(x.client_id))).map(x => ({srv: x, id: "s" + x.id, lat: x.lat, lng: x.lng, ts: x.ts * 1000,
      thumb: absURL(x.thumb), u: x.u, mine: x.mine, fam: x.vis === "family", near: x.near, caption: x.caption}));
    return local.concat(srv);
  }
  function drawPhotos() {
    if (!map) return; layers.photos.clearLayers();
    if (map.getZoom() < PHOTO_ZOOM) return;
    const b = map.getBounds().pad(0.2);
    allPhotos().filter(p => b.contains([p.lat, p.lng])).forEach(p => {
      L.marker([p.lat, p.lng], {icon: L.divIcon({className: "", iconSize: [46, 46], iconAnchor: [23, 46],
        html: `<div class="phmark${p.priv ? " priv" : ""}${p.fam ? " famph" : ""}"><img src="${esc(p.thumb)}" alt="" loading="lazy">${p.priv ? "<span>🔒</span>" : p.fam ? "<span>👨‍👩‍👧</span>" : ""}</div>`}), zIndexOffset: 300})
        .on("click", () => openViewer(p)).addTo(layers.photos);
    });
  }

  // ---------------------------------------------------------------- full-screen viewer
  function openViewer(p) {
    const r = p.local, s = p.srv, v = $("#pviewer");
    const src = r ? blobURL(r.id + "f", r.blob) : absURL(s.full);
    const when = new Date(p.ts).toLocaleString("en-IN", {day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"});
    const cur = r ? visOf(r) : (s.vis || "public");
    const status = `${VIS[cur].i} ${cur === "me" ? "Only you (on this phone)" : VIS[cur].t}${r && cur !== "me" && !(r.uploaded && r.sentVis === cur) ? " · waiting for internet" : ""}`;
    v.innerHTML = `<div class="pvtop"><button class="pvbtn" id="pvClose" aria-label="Close">✕</button><div><b>@${esc(p.u || "")}</b><small>${esc(when)}${p.near ? " · near " + esc(p.near) : ""}</small></div></div>
      <img class="pvimg" src="${esc(src)}" alt="Photo by @${esc(p.u || "")}">
      <div class="pvbar">${p.caption ? `<p>${esc(p.caption)}</p>` : ""}<small>${status}</small>
        <div class="pvact">
          ${p.lat != null ? `<button class="btn2 alt" id="pvMap">Show on map</button>` : ""}
          ${r && r.lat != null ? Object.keys(VIS).filter(k => k !== cur).map(k => `<button class="btn2 alt" data-setvis="${k}">${VIS[k].i} ${VIS[k].t}</button>`).join("") : ""}
          ${r || (s && s.can_delete) ? `<button class="btn2 alt danger" id="pvDel">Delete</button>` : ""}
        </div></div>`;
    v.hidden = false;
    const close = () => { v.hidden = true; v.innerHTML = ""; };
    $("#pvClose").onclick = close;
    if ($("#pvMap")) $("#pvMap").onclick = () => { close(); map.setView([p.lat, p.lng], 17); setSheet("min"); };
    $$("#pviewer [data-setvis]").forEach(b => b.onclick = async () => {
      const k = b.dataset.setvis; delete r.public;
      if (k === "me") {
        if (r.uploaded && r.serverId) { if (!online()) return toast("Needs internet to remove it from the server.");
          const x = await api(`/photos/${r.serverId}/delete`, {method: "POST"}); if (!x.ok && x.status !== 404) return toast("Could not remove it from the server."); }
        SERVER_PHOTOS = SERVER_PHOTOS.filter(q => !(q.mine && q.client_id === r.id)); store.set("photosCache", SERVER_PHOTOS);
        r.vis = "me"; r.uploaded = false; r.sentVis = null; r.serverId = null; await photoPut(r); close(); toast("Now private – only on this phone 🔒"); return loadLocalPhotos();
      }
      r.vis = k; await photoPut(r); close(); toast(online() ? `Sending to ${k === "family" ? "your family" : "the map"}…` : "It is sent when you're online"); await loadLocalPhotos(); sync(); });
    if ($("#pvDel")) $("#pvDel").onclick = async () => {
      const yes = $("#pvDel").dataset.sure; if (!yes) { $("#pvDel").dataset.sure = 1; $("#pvDel").textContent = "Tap again to delete"; return; }
      const sid = r ? (r.uploaded && r.serverId) : s.id;
      if (sid) { if (!online()) return toast("Needs internet to remove it from the server.");
        const x = await api(`/photos/${sid}/delete`, {method: "POST"}); if (!x.ok && x.status !== 404) return toast("Could not delete on the server."); }
      if (r) await photoDel(r.id);
      SERVER_PHOTOS = SERVER_PHOTOS.filter(q => q.id !== sid); store.set("photosCache", SERVER_PHOTOS);
      close(); toast(r ? "Deleted from the app (the gallery copy stays)" : "Photo removed"); loadLocalPhotos(); };
  }
  function photoStrip(list) {
    return list.length ? `<div class="phstrip">${list.map(r => `<img src="${blobURL(r.id + "t", r.thumb)}" data-ph="${r.id}" alt="Photo${r.near ? " near " + esc(r.near) : ""}">`).join("")}</div>` : "";
  }
  function wireStrip(box) {
    box.querySelectorAll("[data-ph]").forEach(i => i.onclick = () => { const p = allPhotos().find(x => x.id === i.dataset.ph);
      const r = LOCAL_PHOTOS.find(x => x.id === i.dataset.ph);
      openViewer(p || {local: r, id: r.id, ts: r.ts, u: ME && ME.username, mine: true, near: r.near, caption: r.caption, lat: r.lat, lng: r.lng}); });
  }

  // ================================================================ family circle
  // Family members see each other's exact location, path and Family photos, and can ask for a photo.
  let FAMILY = store.get("family", {members: [], incoming: [], outgoing: [], photo_requests: []});
  const famIcon = m => { const c = hue(m.u); return L.divIcon({className: "", iconSize: [34, 34], iconAnchor: [17, 17],
    html: `<div class="pmark fam${m.online ? " live" : ""}" style="color:${c}"><span class="ring"></span><div class="dot" style="background:${c}">${esc(m.u[0].toUpperCase())}</div><span class="famtag">👨‍👩‍👧</span><span class="lbl">@${esc(m.u)}</span></div>`}); };
  function famAgo(m) { if (m.sec == null) return "not seen yet"; if (m.sec < 90) return "here now"; if (m.sec < 3600) return Math.round(m.sec / 60) + " min ago"; return m.seen; }
  function renderFamily() {
    const f = FAMILY, mine = lastFix ? [lastFix.lat, lastFix.lng] : null;
    layers.family.clearLayers();
    f.members.forEach(m => { if (m.lat == null) return;
      L.marker([m.lat, m.lng], {icon: famIcon(m), zIndexOffset: 800}).bindTooltip(`👨‍👩‍👧 @${esc(m.u)} · ${famAgo(m)}${m.acc ? " · ±" + Math.round(m.acc) + " m" : ""}`).addTo(layers.family); });
    const asks = f.photo_requests.map(a => `<div class="askcard"><div>📷 <b>@${esc(a.u)}</b> asks for a photo <small>${esc(a.when)}</small></div>
        <div class="actions"><button class="btn2" data-askyes="${a.id}" data-u="${esc(a.u)}">Take photo</button><button class="btn2 alt" data-askno="${a.id}">Not now</button></div></div>`).join("");
    const mem = f.members.map(m => `<div class="famcard">
        <div class="ou"><div class="av" style="background:${hue(m.u)}">${esc(m.u[0].toUpperCase())}</div>
          <div><b>@${esc(m.u)}</b> <small>${esc(m.name || "")}</small><br><small>${m.online ? "🟢 " : ""}${famAgo(m)}${mine && m.lat != null ? " · " + km(mine, [m.lat, m.lng]).toFixed(1) + " km away" : ""}</small></div></div>
        ${m.last_photo ? `<img class="famlast" src="${esc(absURL(m.last_photo.thumb))}" data-famph="${m.last_photo.id}" alt="Latest photo from @${esc(m.u)}">` : ""}
        <div class="actions">${m.lat != null ? `<button class="btn2 alt" data-fmap="${esc(m.u)}">📍 Map &amp; path</button>` : ""}
          <button class="btn2 alt" data-fask="${esc(m.u)}">📷 Ask for photo</button><button class="btn2 alt" data-fphotos="${esc(m.u)}">🖼 Photos</button></div>
        <div class="famphotos" id="fp_${esc(m.u)}"></div></div>`).join("");
    const inc = f.incoming.map(i => `<div class="askcard"><div>👨‍👩‍👧 <b>@${esc(i.u)}</b> wants to add you to their family</div>
        <div class="actions"><button class="btn2" data-facc="${i.id}">Accept</button><button class="btn2 alt" data-frem="${i.id}">Decline</button></div></div>`).join("");
    const out = f.outgoing.map(i => `<div class="ou"><div class="av nodot" style="background:#9aa0a6">${esc(i.u[0].toUpperCase())}</div><div><b>@${esc(i.u)}</b><br><small>Waiting for them to accept</small></div><button class="btn2 alt" data-frem="${i.id}">Cancel</button></div>`).join("");
    $("#famBody").innerHTML = asks + inc + (mem || (inc || out ? "" : `<div class="empty">No family yet. Add a family member or friend by their username – they accept on their phone. Then you see each other's live location, path and Family photos.</div>`)) + out;
    const n = f.photo_requests.length + f.incoming.length; $("#famCount").textContent = n || f.members.length; $("#famCount").classList.toggle("alert", n > 0);
  }
  async function loadFamily() {
    if (!online() || !TOKEN) return renderFamily();
    const prev = new Set((FAMILY.photo_requests || []).map(a => a.id));
    FAMILY = await apiJSON("/family"); store.set("family", FAMILY); renderFamily(); nativeAuth();
    const fresh = FAMILY.photo_requests.filter(a => !prev.has(a.id));
    if (fresh.length) { toast(`📷 @${fresh[0].u} asks for a photo – see the Family tab`); if (navigator.vibrate) navigator.vibrate([120, 80, 120]); }
  }
  // new family photos while the app is open
  async function checkNotify() {
    const since = store.get("notifySince", Date.now() / 1000 - 60);
    const j = await apiJSON(`/notify?since=${since}`); store.set("notifySince", j.now);
    const ph = j.items.filter(i => i.kind === "photo"), dec = j.items.filter(i => i.kind === "declined");
    if (ph.length) { toast(`${ph[ph.length - 1].title}${ph.length > 1 ? ` (+${ph.length - 1})` : ""}`); fetchAreaPhotos(); loadFamily().catch(() => {}); }
    dec.forEach(d => toast(d.title));
  }
  async function showFamilyPhotos(u) {
    const box = document.getElementById("fp_" + u); if (!box) return;
    if (box.innerHTML) { box.innerHTML = ""; return; }
    box.innerHTML = `<small>Loading…</small>`;
    try {
      const j = await apiJSON(`/photos?u=${encodeURIComponent(u)}&limit=60`);
      const have = new Set(SERVER_PHOTOS.map(x => x.id)); SERVER_PHOTOS = SERVER_PHOTOS.concat(j.photos.filter(x => !have.has(x.id))).slice(-600); store.set("photosCache", SERVER_PHOTOS);
      box.innerHTML = j.photos.length ? `<div class="phstrip">${j.photos.map(x => `<img src="${esc(absURL(x.thumb))}" data-famph="${x.id}" alt="${esc(x.when)}">`).join("")}</div>` : `<small>No photos yet.</small>`;
    } catch (e) { box.innerHTML = `<small>Needs internet.</small>`; }
  }
  function openServerPhoto(id) {
    const x = SERVER_PHOTOS.find(q => q.id === +id) || FAMILY.members.map(m => m.last_photo).find(q => q && q.id === +id);
    if (x) openViewer({srv: x, id: "s" + x.id, lat: x.lat, lng: x.lng, ts: x.ts * 1000, u: x.u, mine: x.mine, near: x.near, caption: x.caption});
  }
  function wireFamily() {
    $("#famAdd").onsubmit = async e => { e.preventDefault(); const u = $("#famUser").value.trim(); if (!u) return;
      if (!online()) return toast("Needs internet.");
      try { const r = await apiJSON("/family/add", {method: "POST", body: form({username: u})});
        toast(r.status === "accepted" ? "Added to your family ✓" : "Request sent – they accept on their phone"); $("#famUser").value = ""; loadFamily(); } catch (err) { toast(err.message); } };
    $("#famBody").addEventListener("click", async e => {
      const t = e.target.closest("button,img"); if (!t) return; const d = t.dataset;
      try {
        if (d.askyes) return openCamera({id: +d.askyes, u: d.u});
        if (d.askno) { await api(`/photo-requests/${d.askno}/decline`, {method: "POST"}); return loadFamily(); }
        if (d.facc) { await apiJSON(`/family/${d.facc}/accept`, {method: "POST"}); toast("You're now family ✓"); return loadFamily(); }
        if (d.frem) { if (!t.dataset.sure) { t.dataset.sure = 1; t.textContent = "Tap again"; return; } await apiJSON(`/family/${d.frem}/remove`, {method: "POST"}); return loadFamily(); }
        if (d.fask) { const r = await apiJSON("/family/ask", {method: "POST", body: form({username: d.fask})});
          return toast(r.again ? `Already asked @${d.fask} – waiting for the photo` : `Asked @${d.fask} for a photo 📷 You'll get a notification when it arrives.`); }
        if (d.fphotos) return showFamilyPhotos(d.fphotos);
        if (d.famph) return openServerPhoto(d.famph);
        if (d.fmap) { const m = FAMILY.members.find(x => x.u === d.fmap); map.flyTo([m.lat, m.lng], 15);
          const i = withPending(PATHS).findIndex(pp => pp.u === m.u); if (i >= 0) { SEL = i; renderPaths(); } setSheet("min"); }
      } catch (err) { toast(err.message || "Needs internet."); }
    });
  }
  // opened from a phone notification
  window.appOpen = what => {
    $$("[data-tab]").forEach(x => { if (x.dataset.tab === "family") x.click(); });
    setSheet("half");
    loadFamily().then(() => { if (String(what).startsWith("ask:")) { const a = FAMILY.photo_requests.find(r => r.id === +what.slice(4)); if (a) openCamera({id: a.id, u: a.u}); } }).catch(() => {});
  };

  // ================================================================ yatra paths (shared GPS tracks)
  let PATHS = [];
  let SEL = -1;       // which path is on the map (one at a time); -1 = none
  function drawPaths(layer, list) {
    layer.clearLayers();
    list.forEach((p, i) => {
      if (i !== SEL) return;
      const c = p.me ? "#1a73e8" : hue(p.u);
      const tip = `🚶 @${esc(p.u)}${p.me ? " (you)" : ""} · ${p.km} km · ${p.days} day(s) · ${esc(p.from)} – ${esc(p.to)}`;
      p.segs.forEach(s => {
        L.polyline(s, {color: "#fff", weight: p.me ? 7 : 6, opacity: .8, interactive: false}).addTo(layer);
        L.polyline(s, {color: c, weight: p.me ? 4 : 3, opacity: .9}).bindTooltip(tip, {sticky: true}).addTo(layer);
      });
      L.circleMarker(p.last, {radius: 5, color: "#fff", weight: 2, fillColor: c, fillOpacity: 1}).bindTooltip(tip).addTo(layer);
    });
  }
  function pathListHtml(list) {
    return list.map((p, i) => `<div class="ou pr${i === SEL ? " sel" : ""}" data-pi="${i}"><div class="av nodot" style="background:${p.me ? "#1a73e8" : hue(p.u)}">${esc(p.u[0].toUpperCase())}</div>
      <div><b>@${esc(p.u)}</b>${p.me ? ` <small>(you${p.shared ? ", public" : ", only you see it"})</small>` : ""}<br>
      <small>${p.km} km · ${p.days} day(s) · ${esc(p.from)} – ${esc(p.to)}</small></div></div>`).join("")
      || `<div class="empty">No one is sharing a path yet.</div>`;
  }
  function pathNavHtml(list) {
    if (!list.length) return "";
    const p = list[SEL];
    return `<div class="pathnav"><button class="btn2 alt" data-pn="-1" aria-label="Previous path">◀</button>
      <div>${p ? `<b>@${esc(p.u)}</b>${p.me ? " (you)" : ""}<small>${p.km} km · ${p.days} day(s)</small>` : `<small>Tap a pilgrim, or ▶ to see paths one by one</small>`}</div>
      <button class="btn2 alt" data-pn="1" aria-label="Next path">▶</button>${p ? `<button class="btn2 alt" data-pn="0" aria-label="Hide path">✕</button>` : ""}</div>`;
  }
  function stepPath(list, d) { SEL = d === 0 ? -1 : (SEL < 0 && d < 0 ? list.length - 1 : (SEL + d + list.length) % list.length); return SEL; }
  function fitPath(p) { const pts = p.segs.flat(); if (pts.length) map.fitBounds(pts, {padding: [40, 40]}); }
  PATHS = store.get("paths", []);
  // my own recent points that are still on the phone (not yet uploaded) extend my line, also offline
  function withPending(list) {
    if (!NATIVE || !ME) return list;
    let pend = []; try { pend = JSON.parse(NATIVE.pendingPoints(5000)).map(p => [p.lat, p.lng]); } catch (e) { /* none */ }
    if (pend.length < 2) return list;
    const out = list.map(p => p.me ? Object.assign({}, p, {segs: p.segs.concat([[p.last].concat(pend)]), last: pend[pend.length - 1]}) : p);
    if (!out.some(p => p.me)) out.unshift({u: ME.username, me: true, shared: !!ME.share_path, km: 0, days: 1, from: "today", to: "today", last: pend[pend.length - 1], segs: [pend]});
    return out;
  }
  function renderPaths() {
    const list = withPending(PATHS); if (SEL >= list.length) SEL = -1;
    drawPaths(layers.paths, list); $("#pathNav").innerHTML = pathNavHtml(list);
    $("#pathCount").textContent = PATHS.filter(p => !p.me || p.shared).length;
    $("#pathList").innerHTML = pathListHtml(list); $("#pathList")._list = list;
  }
  async function loadPaths() { const j = await apiJSON("/paths"); PATHS = j.paths || []; store.set("paths", PATHS); renderPaths(); }

  // ================================================================ controls + start
  function wireControls() {
    $$("[data-s]").forEach(b => b.onclick = () => { stage = +b.dataset.s; $$("[data-s]").forEach(x => x.classList.toggle("on", x === b)); render(); });
    $$("[data-f]").forEach(b => b.onclick = () => { const f = b.dataset.f;
      if (f === "near" && !filters.has("near") && !myPos) return withMyPos(() => { filters.add("near"); b.classList.add("on"); render(); map.flyTo(myPos, 10); });
      if (filters.has(f)) filters.delete(f); else filters.add(f); b.classList.toggle("on", filters.has(f)); render(); });
    $$("[data-tab]").forEach(b => b.onclick = () => { const t = b.dataset.tab; $$("[data-tab]").forEach(x => x.setAttribute("aria-selected", x === b));
      $("#stopsTab").hidden = t !== "stops"; $("#onlineTab").hidden = t !== "online"; $("#pathsTab").hidden = t !== "paths"; $("#famTab").hidden = t !== "family";
      if (t === "family") loadFamily().catch(() => renderFamily());
      if (t === "online" && online()) loadOnline().catch(() => {});
      if (t === "paths") { renderPaths(); if (online()) loadPaths().catch(() => {}); } });
    const showPath = i => { SEL = i; renderPaths(); const l = $("#pathList")._list; if (l[SEL]) { fitPath(l[SEL]); setSheet("min"); } };
    $("#pathList").addEventListener("click", e => { const r = e.target.closest(".pr"); if (r) showPath(+r.dataset.pi); });
    $("#pathNav").addEventListener("click", e => { const b = e.target.closest("[data-pn]"); if (b) showPath(stepPath($("#pathList")._list, +b.dataset.pn)); });
    $("#onlineList").addEventListener("click", e => { const r = e.target.closest(".ou"); if (r && r.dataset.lat) map.flyTo([+r.dataset.lat, +r.dataset.lng], 12); });
    $("#locBtn").onclick = () => withMyPos(p => map.flyTo(p, 14));
    $("#zIn").onclick = () => map.zoomIn(); $("#zOut").onclick = () => map.zoomOut();
    $("#fitBtn").onclick = () => { layers.road.clearLayers(); layers.pin.clearLayers(); layers.track.clearLayers(); if (placed.length) map.fitBounds(placed.map(o => [o.lat, o.lng]), {padding: [40, 40]}); };
    $("#avatarBtn").onclick = openMenu;
    // ---------------------------------------------------------------- bottom sheet: drag up/down like Google Maps
    // positions: map (full-screen map, only the handle) · min · half · full
    (function sheetGestures() {
      const grip = $("#grip"), fabs = document.querySelector(".fabs"), phone = () => window.innerWidth <= 760;
      const heightOf = s => ({map: 30, min: 118, half: window.innerHeight * 0.46, full: window.innerHeight - 84})[s];
      let y0 = 0, h0 = 0, moved = false, lastY = 0, lastT = 0, vel = 0, dragging = false;
      grip.addEventListener("pointerdown", e => {
        if (!phone()) return;
        dragging = true; moved = false; y0 = lastY = e.clientY; lastT = performance.now(); h0 = panel.getBoundingClientRect().height;
        grip.setPointerCapture(e.pointerId); panel.classList.add("dragging");
      });
      grip.addEventListener("pointermove", e => {
        if (!dragging) return;
        const dy = e.clientY - y0; if (Math.abs(dy) > 6) moved = true;
        const now = performance.now(); vel = (e.clientY - lastY) / Math.max(1, now - lastT); lastY = e.clientY; lastT = now;
        const h = Math.max(30, Math.min(heightOf("full"), h0 - dy));
        panel.style.height = h + "px"; if (fabs) fabs.style.bottom = (h + 14) + "px";
      });
      const end = () => {
        if (!dragging) return; dragging = false; panel.classList.remove("dragging");
        const h = panel.getBoundingClientRect().height; panel.style.height = ""; if (fabs) fabs.style.bottom = "";
        if (!moved) return;                                    // a tap: handled by onclick
        let s;
        if (vel > 0.6) s = h < heightOf("half") ? "map" : (h < heightOf("full") - 40 ? "min" : "half");      // flick down
        else if (vel < -0.6) s = h > heightOf("half") ? "full" : (h > heightOf("min") ? "half" : "min");     // flick up
        else s = ["map", "min", "half", "full"].reduce((a, b) => Math.abs(heightOf(b) - h) < Math.abs(heightOf(a) - h) ? b : a);
        setSheet(s); grip._skipClick = true; setTimeout(() => grip._skipClick = false, 50);
      };
      grip.addEventListener("pointerup", end); grip.addEventListener("pointercancel", end);
      // tap the handle: map → half → full → min …
      grip.onclick = () => { if (grip._skipClick) return; const o = ["min", "half", "full"], s = panel.dataset.size;
        setSheet(s === "map" ? "half" : o[(o.indexOf(s) + 1) % 3]); };
      // full-screen map button
      const fb = $("#fullBtn");
      const syncBtn = () => { const on = panel.dataset.size === "map"; fb.classList.toggle("on", on); fb.title = on ? "Show the panel" : "Full-screen map"; fb.setAttribute("aria-label", fb.title); };
      fb.onclick = () => { setSheet(panel.dataset.size === "map" ? (phone() ? "half" : "half") : "map"); syncBtn(); };
      new MutationObserver(syncBtn).observe(panel, {attributes: true, attributeFilter: ["data-size"]});
      // moving the map lowers a big sheet out of the way
      map.on("dragstart", () => { if (phone() && (panel.dataset.size === "half" || panel.dataset.size === "full")) setSheet("min"); });
    })();

    $("#camBtn").onclick = () => openCamera();
    wireFamily();
    $("#camIn").onchange = () => { const f = $("#camIn").files[0]; if (f) takePhoto(f, pendingReq); pendingReq = null; };
    window.addEventListener("online", () => { updateNetbar(); sync(); });
    window.addEventListener("offline", updateNetbar);
  }
  // live location: every 20 s send my position and refresh others, while the app is open and online
  async function livePing() {
    if (!TOKEN || !online() || syncing || document.hidden) return;
    try {
      if (ME && ME.share_live && lastFix) await api("/presence", {method: "POST", body: form({lat: lastFix.lat, lng: lastFix.lng, accuracy: lastFix.acc})});
      await loadOnline();
      await loadFamily(); await checkNotify();
    } catch (e) { /* try next time */ }
  }
  // hand the login to the phone's background service, so live location and journey upload
  // keep working while another app is open or the screen is off
  const nativeAuth = () => { if (NATIVE && NATIVE.setAuth && TOKEN) NATIVE.setAuth(SERVER, TOKEN, !!(ME && ME.share_live), !!(typeof FAMILY !== "undefined" && FAMILY.members.length)); };
  let started = false;
  function startApp() {
    $("#auth").hidden = true; $("#appRoot").hidden = false;
    $("#avatarBtn").textContent = ((ME && ME.username) || "?")[0].toUpperCase();
    if (!started) {
      started = true; initMap(); wireControls(); drawReports(); renderPaths(); loadLocalPhotos(); renderFamily();
      if (NATIVE && NATIVE.takeOpen) { const o = NATIVE.takeOpen(); if (o) setTimeout(() => window.appOpen(o), 1200); }
      if (placed.length) map.fitBounds(placed.map(o => [o.lat, o.lng]), {padding: [40, 40]});
      if (navigator.geolocation) navigator.geolocation.watchPosition(setMyPos, () => {}, {enableHighAccuracy: true, maximumAge: 30000});
      if (NATIVE && store.get("recording", true) && !NATIVE.isTracking()) store.set("recording", NATIVE.startTracking());
      setInterval(sync, 60000); setInterval(livePing, 20000);
    }
    nativeAuth(); updateNetbar(); sync();
  }
  if (TOKEN) startApp(); else showAuth();
})();
