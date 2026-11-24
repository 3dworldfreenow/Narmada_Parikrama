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
    const r = indexedDB.open("narmada", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("queue", {keyPath: "id", autoIncrement: true});
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const qTx = async (mode, fn) => { const db = await idb; return new Promise((res, rej) => {
    const tx = db.transaction("queue", mode), st = tx.objectStore("queue"); const out = fn(st);
    tx.oncomplete = () => res(out && out.result !== undefined ? out.result : out); tx.onerror = () => rej(tx.error); }); };
  const queueAdd = item => qTx("readwrite", st => st.add({...item, created: Date.now()}));
  const queueAll = () => qTx("readonly", st => st.getAll());
  const queueDel = id => qTx("readwrite", st => st.delete(id));

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
    if (NATIVE) NATIVE.stopTracking();
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
    ["route", "stops", "reports", "people", "road", "pin", "track"].forEach(k => layers[k] = L.layerGroup().addTo(map));
    map.on("click", e => {
      const {lat, lng} = e.latlng;
      if (pickMode) { const f = pickMode; pickMode = null; f(lat, lng); return; }
      openPlace({label: "Dropped pin", sub: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, lat, lng});
    });
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
  const VIEWS = ["listView", "detailView", "placeView", "dirView", "reportView", "updateView", "menuView", "timelineView"];
  const viewStack = [];
  function show(v, push = true) {
    const cur = VIEWS.find(x => !$("#" + x).hidden);
    if (push && cur && cur !== v) viewStack.push(cur);
    VIEWS.forEach(x => $("#" + x).hidden = x !== v);
    if (v !== "listView") setSheet("half");
  }
  function back() { const v = viewStack.pop(); if (!v) return false; show(v, false); if (v === "listView") render(false); return true; }
  window.appBack = () => { if (!$("#results").hidden) { $("#results").hidden = true; return true; } if (pickMode) { pickMode = null; return true; } return back(); };
  const backBtn = l => `<button class="back" data-back>← ${l || "Back"}</button>`;
  document.addEventListener("click", e => { if (e.target.closest("[data-back]")) back(); });
  const panel = $("#panel");
  function setSheet(s) { panel.dataset.size = s; setTimeout(() => map && map.invalidateSize(), 260); }
  $("#grip").onclick = () => { const o = ["min", "half", "full"]; setSheet(o[(o.indexOf(panel.dataset.size) + 1) % 3]); };

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
    $$("#dirView [data-mode]").forEach(b => b.onclick = () => { dir.mode = b.dataset.mode; $$("#dirView [data-mode]").forEach(x => x.setAttribute("aria-selected", x === b)); route(); });
    route();
  }
  const resolvePt = p => new Promise(res => !p ? res(null) : !p.me ? res([p.lat, p.lng]) : withMyPos(res, () => res(null)));
  function stepText(s) { const m = s.maneuver, n = s.name ? `<b>${esc(s.name)}</b>` : "the road", mod = esc((m.modifier || "").replace("uturn", "U-turn"));
    switch (m.type) { case "depart": return s.name ? `Start on ${n}` : "Start"; case "arrive": return "You have arrived";
      case "turn": case "end of road": return `Turn ${mod} onto ${n}`; case "fork": return `Keep ${mod} at the fork`;
      case "roundabout": case "rotary": return `At the roundabout take exit ${m.exit || ""}`; default: return `Continue${mod ? " " + mod : ""} on ${n}`; } }
  let rSeq = 0;
  async function route() {
    const out = $("#dirOut"); if (!out) return;
    if (!dir.from || !dir.to) { out.innerHTML = `<div class="empty">Choose a start and a destination.</div>`; return; }
    const [a, b] = await Promise.all([resolvePt(dir.from), resolvePt(dir.to)]);
    if (!a || !b) { out.innerHTML = `<div class="empty">Turn on location to use “My location”.</div>`; return; }
    layers.road.clearLayers();
    const straight = km(a, b);
    if (!online()) {
      L.polyline([a, b], {color: "#1a73e8", weight: 4, dashArray: "8 8"}).addTo(layers.road); map.fitBounds([a, b], {padding: [60, 60]});
      out.innerHTML = `<div class="note">You're offline. Road directions need internet.</div><p>Straight-line distance: <b>${fmtKm(straight)}</b>. Check the stop's “Path to next stop” and path reports.</p>`; return;
    }
    const seq = ++rSeq; out.innerHTML = `<div class="empty">Finding the best ${MODE[dir.mode]} route…</div>`;
    try {
      const j = await (await fetch(`${ROUTERS[dir.mode]}${a[1]},${a[0]};${b[1]},${b[0]}?overview=full&geometries=geojson&steps=true&alternatives=true`)).json();
      if (seq !== rSeq) return; if (j.code !== "Ok") throw new Error();
      j.routes.slice(1).forEach(alt => L.geoJSON(alt.geometry, {style: {color: "#7f9cc9", weight: 5, opacity: .6}}).addTo(layers.road));
      const best = j.routes[0], line = L.geoJSON(best.geometry, {style: {color: "#1a73e8", weight: 6}}).addTo(layers.road);
      L.marker(b, {icon: L.divIcon({className: "", iconSize: [28, 40], iconAnchor: [14, 38], html: PIN})}).addTo(layers.road);
      map.fitBounds(line.getBounds(), {padding: [60, 60]});
      const steps = best.legs.flatMap(l => l.steps).filter(s => s.distance > 0 || s.maneuver.type === "arrive");
      const g = `https://www.google.com/maps/dir/?api=1&origin=${a[0]},${a[1]}&destination=${b[0]},${b[1]}&travelmode=${GMODE[dir.mode]}`;
      out.innerHTML = `<div class="routesum"><span class="rtime">${fmtTime(best.duration * (dir.mode === "bike" ? .85 : 1))}</span> <span class="rdist">(${fmtKm(best.distance / 1000)})</span><small>${MODE[dir.mode]} · by road, OpenStreetMap</small></div>
        <div class="actions" style="margin-bottom:10px"><button class="btn2" id="gnav">▶ Start in Google Maps</button></div>
        <ol class="steps">${steps.map(s => `<li><span class="si">↑</span><span>${stepText(s)}</span><small>${s.distance ? fmtKm(s.distance / 1000) : ""}</small></li>`).join("")}</ol>`;
      $("#gnav").onclick = () => NATIVE ? NATIVE.openExternal(g) : window.open(g);
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
        <div class="mrow"><span class="mi">🔄</span><div><b>Sync now</b><small id="syncState">${store.get("lastSync", null) ? "Last synced " + new Date(store.get("lastSync")).toLocaleString("en-IN") : "Not synced yet"}</small></div><button class="btn2 alt" id="syncBtn">Sync</button></div>
        <div class="mrow"><span class="mi">🌐</span><div><b>Server</b><small>${esc(SERVER)}</small></div></div>
        <div class="actions" style="margin-top:14px"><button class="btn2 alt" id="logoutBtn">Log out</button></div>
      </div>`;
    show("menuView");
    $("#mapBtn").onclick = downloadMap;
    if ($("#mapDel")) $("#mapDel").onclick = () => { NATIVE.deleteOfflineMap(); toast("Offline map deleted. Restart the app."); openMenu(); };
    $("#recT").onclick = () => { if (!NATIVE) return toast("Only in the Android app.");
      if (NATIVE.isTracking()) { NATIVE.stopTracking(); store.set("recording", false); } else { store.set("recording", NATIVE.startTracking()); }
      setTimeout(openMenu, 400); };
    $("#tlOpen").onclick = openTimeline;
    $("#showT").onclick = async () => { if (!online()) return toast("Needs internet.");
      try { ME = await apiJSON("/me/settings", {method: "POST", body: form({show_on_map: ME.show_on_map ? 0 : 1})}); store.set("me", ME); openMenu(); } catch (e) { toast(e.message); } };
    $("#syncBtn").onclick = () => sync(true);
    $("#logoutBtn").onclick = () => logout(false);
  }
  let dlTimer = null;
  async function downloadMap() {
    if (!NATIVE) return toast("Only in the Android app.");
    if (!online()) return toast("Connect to the internet (Wi-Fi is best) to download the map.");
    try {
      const info = await apiJSON("/map");
      if (!info.available) return toast("The server has no offline map yet. Ask the admin to run download-map.sh.");
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
    if (!online()) { $("#tlBody").innerHTML = `<div class="empty">Your journey is being saved on this phone${NATIVE ? ` (${NATIVE.pointCount()} points waiting)` : ""}.<br>Connect to the internet to upload it and see your days.</div>`; return; }
    await sync();
    try {
      const j = await apiJSON("/timeline/days");
      $("#tlBody").innerHTML = `<p><b>${j.total_km} km</b> in ${j.days.length} day(s)</p>` + (j.days.map(d => `<div class="dayrow" data-day="${d.day}"><div><b>${d.day}</b><small>${d.from} – ${d.to}</small></div><b>${d.km} km</b></div>`).join("") || `<div class="empty">Nothing recorded yet. Turn on “Record my journey” in the menu.</div>`);
      $$("#tlBody .dayrow").forEach(r => r.onclick = async () => {
        $$("#tlBody .dayrow").forEach(x => x.classList.toggle("on", x === r));
        const t = await apiJSON("/timeline?day=" + r.dataset.day);
        layers.track.clearLayers();
        if (t.points.length) { const line = L.polyline(t.points.map(p => [p[0], p[1]]), {color: "#1a73e8", weight: 5}).addTo(layers.track); map.fitBounds(line.getBounds(), {padding: [40, 40]}); setSheet("min"); }
      });
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
      // 3. presence (online pilgrims) + fresh data
      await api("/presence", {method: "POST", body: form(lastFix ? {lat: lastFix.lat, lng: lastFix.lng, accuracy: lastFix.acc} : {})});
      const cachedStops = store.get("stops", null);
      const r = await api("/stops", {headers: cachedStops ? {"If-None-Match": '"' + cachedStops.version + '"'} : {}});
      if (r.status === 200) { const j = await r.json(); store.set("stops", {version: j.version, stops: j.stops, fields: j.fields}); FIELDS = j.fields; setStops(j.stops); drawStops(); }
      const rep = await apiJSON("/reports"); REPORTS = rep.reports; REPORT_KINDS = rep.kinds; store.set("reports", REPORTS); store.set("reportKinds", REPORT_KINDS); drawReports();
      await loadOnline();
      store.set("lastSync", Date.now());
      if (manual) toast("Synced ✓");
    } catch (e) { if (manual) toast(e.message || "Sync failed"); }
    finally { syncing = false; updateNetbar(); }
  }
  async function loadOnline() {
    const j = await apiJSON("/online"); const list = j.online || [];
    $("#onlineCount").textContent = list.length; layers.people.clearLayers();
    list.forEach(u => { if (u.lat == null || u.me) return; const c = hue(u.u);
      L.marker([u.lat, u.lng], {icon: L.divIcon({className: "", iconSize: [30, 30], iconAnchor: [15, 15], html: `<div class="pmark" style="color:${c}"><span class="ring"></span><div class="dot" style="background:${c}">${esc(u.u[0].toUpperCase())}</div><span class="lbl">@${esc(u.u)}</span></div>`})}).addTo(layers.people); });
    $("#onlineList").innerHTML = list.map(u => `<div class="ou" data-lat="${u.lat ?? ""}" data-lng="${u.lng ?? ""}"><div class="av" style="background:${hue(u.u)}">${esc(u.u[0].toUpperCase())}</div><div><b>@${esc(u.u)}</b>${u.me ? " <small>(you)</small>" : ""}<br><small>${u.ago ? u.ago + " min ago" : "online now"}</small></div></div>`).join("") || `<div class="empty">No one else online.</div>`;
  }

  // ================================================================ controls + start
  function wireControls() {
    $$("[data-s]").forEach(b => b.onclick = () => { stage = +b.dataset.s; $$("[data-s]").forEach(x => x.classList.toggle("on", x === b)); render(); });
    $$("[data-f]").forEach(b => b.onclick = () => { const f = b.dataset.f;
      if (f === "near" && !filters.has("near") && !myPos) return withMyPos(() => { filters.add("near"); b.classList.add("on"); render(); map.flyTo(myPos, 10); });
      if (filters.has(f)) filters.delete(f); else filters.add(f); b.classList.toggle("on", filters.has(f)); render(); });
    $$("[data-tab]").forEach(b => b.onclick = () => { const t = b.dataset.tab; $$("[data-tab]").forEach(x => x.setAttribute("aria-selected", x === b));
      $("#stopsTab").hidden = t !== "stops"; $("#onlineTab").hidden = t !== "online"; if (t === "online" && online()) loadOnline().catch(() => {}); });
    $("#onlineList").addEventListener("click", e => { const r = e.target.closest(".ou"); if (r && r.dataset.lat) map.flyTo([+r.dataset.lat, +r.dataset.lng], 12); });
    $("#locBtn").onclick = () => withMyPos(p => map.flyTo(p, 14));
    $("#zIn").onclick = () => map.zoomIn(); $("#zOut").onclick = () => map.zoomOut();
    $("#fitBtn").onclick = () => { layers.road.clearLayers(); layers.pin.clearLayers(); layers.track.clearLayers(); if (placed.length) map.fitBounds(placed.map(o => [o.lat, o.lng]), {padding: [40, 40]}); };
    $("#avatarBtn").onclick = openMenu;
    window.addEventListener("online", () => { updateNetbar(); sync(); });
    window.addEventListener("offline", updateNetbar);
  }
  let started = false;
  function startApp() {
    $("#auth").hidden = true; $("#appRoot").hidden = false;
    $("#avatarBtn").textContent = ((ME && ME.username) || "?")[0].toUpperCase();
    if (!started) {
      started = true; initMap(); wireControls(); drawReports();
      if (placed.length) map.fitBounds(placed.map(o => [o.lat, o.lng]), {padding: [40, 40]});
      if (navigator.geolocation) navigator.geolocation.watchPosition(setMyPos, () => {}, {enableHighAccuracy: true, maximumAge: 30000});
      if (NATIVE && store.get("recording", true) && !NATIVE.isTracking()) store.set("recording", NATIVE.startTracking());
      setInterval(sync, 60000);
    }
    updateNetbar(); sync();
  }
  if (TOKEN) startApp(); else showAuth();
})();
