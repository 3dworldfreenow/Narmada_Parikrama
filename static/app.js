/* Narmada Parikrama – map app: stops, search, directions, path reports, online pilgrims */
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
  const hue = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 55% 45%)`; };
  const post = (url, data) => { const b = new FormData(); b.append("_csrf", CSRF); Object.entries(data).forEach(([k, v]) => v != null && b.append(k, v));
    return fetch(url, {method: "POST", body: b, headers: {"X-CSRF-Token": CSRF}}); };

  DATA.forEach((o, i) => { o._i = i; o._s = [o.v, o.vm, o.sp, o.acc, o.ti, o.te, o.sa, o.rt].join(" ").toLowerCase(); });

  // ================================================================ map
  // two-finger rotate (leaflet-rotate add-on; without it the map just doesn't rotate)
  const map = L.map("map", {zoomControl: false, preferCanvas: true, rotate: true, touchRotate: true, shiftKeyRotate: true, rotateControl: false, bearing: 0}).setView([22.4, 77.5], 7);
  const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  if (LOCAL_MAP && window.protomapsL) {
    protomapsL.leafletLayer({url: LOCAL_MAP, flavor: "light", lang: "en", maxDataZoom: LOCAL_MAXZOOM,
      attribution: OSM_ATTR + ' &copy; <a href="https://protomaps.com">Protomaps</a>'}).addTo(map);
  } else {
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {maxZoom: 19, attribution: OSM_ATTR}).addTo(map);
  }
  const routeLines = L.layerGroup().addTo(map), stopLayer = L.layerGroup().addTo(map), reportLayer = L.layerGroup().addTo(map);
  const peopleLayer = L.layerGroup().addTo(map), roadLayer = L.layerGroup().addTo(map), pinLayer = L.layerGroup().addTo(map);
  const markers = {};
  const placed = DATA.filter(o => o.lat != null);
  [1, 2, 3].forEach(st => {
    const pts = placed.filter(o => o.st === st).map(o => [o.lat, o.lng]);
    if (pts.length > 1) L.polyline(pts, {color: STAGES[st].c, weight: 3, opacity: .3, dashArray: "6 6", interactive: false}).addTo(routeLines);
  });
  placed.forEach(o => {
    markers[o._i] = L.circleMarker([o.lat, o.lng], {radius: 6, color: "#fff", weight: 2, fillColor: STAGES[o.st].c, fillOpacity: 1})
      .bindTooltip(esc(o.v || "Stop"), {className: "stoptip", direction: "top", offset: [0, -6]})
      .on("click", e => { L.DomEvent.stopPropagation(e); openStop(o._i, false); });
  });

  // ================================================================ panel views
  const VIEWS = ["listView", "detailView", "placeView", "dirView", "reportView"];
  const viewStack = [];
  function show(v, push = true) {
    const cur = VIEWS.find(x => !$("#" + x).hidden);
    if (push && cur && cur !== v) viewStack.push(cur);
    VIEWS.forEach(x => $("#" + x).hidden = x !== v);
    if (v !== "listView") setSheet("half");
  }
  function back() { const v = viewStack.pop() || "listView"; show(v, false); if (v === "listView") { selected = null; render(false); } }
  const backBtn = label => `<button class="back" data-back>← ${label || "Back"}</button>`;
  document.addEventListener("click", e => { if (e.target.closest("[data-back]")) back(); });

  // ================================================================ stops list + filters
  let stage = 0, query = "", myPos = null, myAcc = null, shown = 120, selected = null;
  const filters = new Set();
  function matches(o) {
    if (stage && o.st !== stage) return false;
    if (query && !query.split(/\s+/).every(t => o._s.includes(t))) return false;
    if (filters.has("food") && o.fd !== "Yes") return false;
    if (filters.has("rat") && o.sd !== "Yes") return false;
    if (filters.has("stay") && isNo(o.acc)) return false;
    if (filters.has("ghat") && isNo(o.gh)) return false;
    if (filters.has("pm") && !o.pm) return false;
    if (filters.has("near") && (!myPos || o.lat == null || km(myPos, [o.lat, o.lng]) > 25)) return false;
    return true;
  }
  const hl = t => { let s = esc(t); if (!query) return s;
    query.split(/\s+/).forEach(w => { if (w) s = s.replace(new RegExp("(" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi"), "<mark>$1</mark>"); }); return s; };
  function render(resetLimit = true) {
    if (resetLimit) shown = 120;
    const rows = DATA.filter(matches);
    if (filters.has("near") && myPos) rows.sort((a, b) => km(myPos, [a.lat, a.lng]) - km(myPos, [b.lat, b.lng]));
    $("#stopCount").textContent = rows.length;
    stopLayer.clearLayers(); rows.forEach(o => markers[o._i] && markers[o._i].addTo(stopLayer));
    const list = $("#list");
    if (!rows.length) { list.innerHTML = `<div class="empty">No stops match.<br>Try another spelling, or clear the filters.</div>`; return; }
    list.innerHTML = rows.slice(0, shown).map(o => {
      const tags = [];
      if (o.fd === "Yes") tags.push('<span class="tag y">Food</span>');
      if (o.sd === "Yes") tags.push('<span class="tag y">Sadavrat</span>');
      if (!isNo(o.acc)) tags.push('<span class="tag">Stay</span>');
      if (o.pm) tags.push(`<span class="tag o">📷 ${o.pm}</span>`);
      if (o.ub) tags.push('<span class="tag o">Updated</span>');
      const dist = myPos && o.lat != null ? fmtKm(km(myPos, [o.lat, o.lng])) : (o.cum ? `${esc(o.cum)} km` : "");
      return `<div class="item${selected === o._i ? " sel" : ""}" role="listitem" data-i="${o._i}">
        <div class="no${o.lat == null ? " off" : ""}" style="background:${STAGES[o.st].c}">${esc(o.n || "·")}</div>
        <div class="tx"><div class="t">${o.v ? hl(o.v) : "(not named)"}<small class="mr">${hl(o.vm)}</small></div>
          ${o.sp ? `<div class="s">${hl(o.sp)}</div>` : ""}${tags.length ? `<div class="tags">${tags.join("")}</div>` : ""}</div>
        <div class="km">${dist}</div></div>`;
    }).join("") + (rows.length > shown ? `<button class="more" id="more">Show more (${rows.length - shown} left)</button>` : "");
    const more = $("#more"); if (more) more.onclick = () => { shown += 200; render(false); };
  }
  $("#list").addEventListener("click", e => { const it = e.target.closest(".item"); if (it) openStop(+it.dataset.i, true); });

  // ================================================================ stop detail
  const fact = (label, v, wide) => isNo(v) ? "" : `<div class="fact${wide ? " wide" : ""}"><b>${label}</b>${esc(v)}</div>`;
  const nextStop = o => { for (let j = o._i + 1; j < DATA.length; j++) if (DATA[j].st === o.st && DATA[j].lat != null) return DATA[j]; return null; };
  const stopPoint = o => ({label: o.v || "Stop", lat: o.lat, lng: o.lng});
  function openStop(i, fly) {
    const o = DATA[i]; selected = i;
    const nx = o.lat != null ? nextStop(o) : null;
    $("#detailView").innerHTML = `
      <div class="dhead">${backBtn("All stops")}
        <h2>${esc(o.v || "(not named)")} <span class="mr" style="font-size:16px;color:var(--muted)">${esc(o.vm)}</span></h2>
        <div class="sub">${STAGES[o.st].n} · ${STAGES[o.st].b} · No. ${esc(o.n || "–")} · ${esc(o.cum || "–")} km from stage start${o.lat == null ? " · not on map yet" : (o.ls === "visit" ? " · location confirmed" : " · approximate location")}</div>
        ${o.lat != null ? `<div class="actions">
          <button class="btn2 go" data-start>▶ Start</button><button class="btn2" data-dir-to>➤ Directions</button>
          ${nx ? `<button class="btn2 alt" data-dir-next>To next stop</button>` : ""}
          <button class="btn2 alt" data-report-here>⚑ Report path</button></div>` : ""}
      </div>
      <div class="dbody">
        ${o.sp ? `<div class="note">${esc(o.sp)}</div>` : ""}
        <div class="facts">
          ${fact("Stay", o.acc, true)}${fact("Temples", o.te, true)}${fact("Tirth", o.ti)}${fact("Sangam", o.sa)}
          ${fact("Cooked food", o.fd)}${fact("Sadavrat", o.sd)}${fact("Built ghat", o.gh)}${fact("Bridge", o.br)}
          ${fact("Path to next stop", o.rt, true)}${fact("Km from previous", o.d)}${fact("Halt days", o.h)}
        </div>
        <div class="actions">
          <a class="btn2" href="${URLS.edit}${o.id}/edit">✎ Update / add photos</a>
          <a class="btn2 alt" href="${URLS.stop}${o.id}">Full page</a>
        </div>
        ${o.ub ? `<div class="upd">✎ Updated by @${esc(o.ub)} · ${esc(o.ua)}</div>` : ""}
      </div>`;
    show("detailView");
    const dv = $("#detailView");
    if (o.lat == null) locateWalkingStop(o);
    if (o.lat != null) {
      dv.querySelector("[data-dir-to]").onclick = () => openDirections(null, stopPoint(o));
      dv.querySelector("[data-start]").onclick = () => startNav(stopPoint(o));
      const n = dv.querySelector("[data-dir-next]"); if (n) n.onclick = () => openDirections(stopPoint(o), stopPoint(nx));
      dv.querySelector("[data-report-here]").onclick = () => openReport(o.lat, o.lng);
      if (fly) map.flyTo([o.lat, o.lng], Math.max(map.getZoom(), 12), {duration: .6});
      markers[i].setStyle({radius: 10}); setTimeout(() => markers[i] && markers[i].setStyle({radius: 6}), 1800);
    }
  }

  // ================================================================ search (stops + OpenStreetMap places)
  const results = $("#results");
  let searchTimer, searchSeq = 0;
  const BBOX = "72.3,21.0,82.2,23.8";   // the Narmada region
  async function placeSearch(q) {
    const c = map.getCenter ? map.getCenter() : {lat: 22.4, lng: 77.5};
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=7&lang=en&bbox=${BBOX}&lat=${c.lat}&lon=${c.lng}`;
    const j = await (await fetch(url)).json();
    return (j.features || []).map(f => {
      const p = f.properties, [lng, lat] = f.geometry.coordinates;
      const where = [p.city || p.county || p.district, p.state].filter(Boolean).join(", ");
      const kind = (p.osm_value || p.type || "place").replace(/_/g, " ");
      return {label: p.name || q, sub: `${kind}${where ? " · " + where : ""}`, lat, lng};
    });
  }
  function stopSuggestions(q) {
    const t = q.toLowerCase().split(/\s+/).filter(Boolean);
    return DATA.filter(o => t.every(w => o._s.includes(w))).slice(0, 5);
  }
  async function suggest(q, box, onPick) {
    const seq = ++searchSeq;
    if (q.length < 2) { box.hidden = true; return; }
    const stops = stopSuggestions(q); const veh = window.VRoute ? VRoute.search(q, 6) : [];
    const draw = places => {
      if (seq !== searchSeq) return;
      let h = "";
      if (stops.length) h += `<div class="rh">Parikrama stops</div>` + stops.map(o =>
        `<div class="ri" data-stop="${o._i}"><span class="ric" style="background:${STAGES[o.st].c}">${esc(o.n || "·")}</span><div><b>${esc(o.v || "(not named)")}</b> <span class="mr">${esc(o.vm)}</span><small>${STAGES[o.st].n} · ${o.lat == null ? "not on map yet" : esc(o.sp || STAGES[o.st].b)}</small></div></div>`).join("");
      if (veh.length) h += `<div class="rh">🏍 Bike / Car route</div>` + veh.map(v => `<div class="ri" data-veh="${v.key}"><span class="ric" style="background:${({1: "#0f6e77", 2: "#c8641e", 3: "#7a4fb0"})[v.part.id]}">${v.part.id}</span><div><b>${esc(v.s.n)}</b> <span class="mr">${esc(v.s.hi)}</span><small>Part ${v.part.id} · ${v.s.cum} km from ${esc(v.part.stops[0].n)}${v.s.lat == null ? " · not placed yet – tap to look it up" : ""}</small></div></div>`).join("");
      if (places === null) h += `<div class="rh">Places</div><div class="ri muted">Searching the map…</div>`;
      else if (places.length) h += `<div class="rh">Places on the map</div>` + places.map((p, k) =>
        `<div class="ri" data-place="${k}"><span class="ric pl">📍</span><div><b>${esc(p.label)}</b><small>${esc(p.sub)}</small></div></div>`).join("");
      if (!h) h = `<div class="ri muted">Nothing found. Try another spelling.</div>`;
      box.innerHTML = h; box.hidden = false; box._places = places || [];
    };
    draw(null);
    try { draw(await placeSearch(q)); } catch (e) { draw([]); }
    box.onclick = e => {
      e.stopPropagation();
      const s = e.target.closest("[data-stop]"), p = e.target.closest("[data-place]"), v = e.target.closest("[data-veh]");
      if (v) { box.hidden = true; onPick({veh: v.dataset.veh}); }
      else if (s) { box.hidden = true; onPick({stop: +s.dataset.stop}); }
      else if (p) { box.hidden = true; onPick({place: box._places[+p.dataset.place]}); }
    };
  }
  $("#q").addEventListener("input", e => {
    const v = e.target.value.trim();
    query = v.toLowerCase(); render();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => suggest(v, results, pick => {
      if (pick.veh) openVeh(pick.veh); else if (pick.stop != null) openStop(pick.stop, true); else openPlace(pick.place);
    }), 300);
  });
  $("#q").addEventListener("keydown", e => { if (e.key === "Escape") results.hidden = true; if (e.key === "Enter") { results.hidden = true; show("listView"); } });
  document.addEventListener("click", e => { if (!e.target.closest(".searchbox")) results.hidden = true; });


  // a stop without a map position: look it up on OpenStreetMap near where the km put it, else show an approximate spot
  async function locateWalkingStop(o) {
    if (!window.VRoute || o.lat != null) return;
    const list = DATA.filter(x => x.st === o.st), i = list.indexOf(o);
    const at = await VRoute.locate(o.v, list, i, x => parseFloat(x.cum), navigator.onLine);
    if (!at || selected !== o._i) return;
    dropPin(at.lat, at.lng); map.flyTo([at.lat, at.lng], at.kind === "osm" ? 13 : 11, {duration: .6});
    const box = document.createElement("div"); box.className = "note warn";
    box.innerHTML = at.kind === "osm" ? `📍 Not placed by the guide yet. The pin shows “${esc(at.label)}” found on OpenStreetMap near the right km – please check.`
      : `📍 Not placed by the guide yet. The pin is an approximate spot ${at.a && at.b ? `between ${esc(at.a.v)} and ${esc(at.b.v)}, by the km` : `near ${esc((at.a || at.b).v)}`}.`;
    const go = document.createElement("button"); go.className = "btn2"; go.textContent = "➤ Directions to this spot"; go.style.marginTop = "8px";
    go.onclick = () => openDirections(null, {label: o.v + (at.kind === "osm" ? "" : " (approx.)"), lat: at.lat, lng: at.lng});
    box.appendChild(document.createElement("br")); box.appendChild(go);
    const head = $("#detailView .dhead"); if (head) head.appendChild(box);
  }
  async function openVeh(key) {
    const p = await VRoute.place(key, navigator.onLine);
    if (!p) return alertMsg("That stop isn't on the map yet.");
    openPlace(p);
  }

  // ================================================================ place card (any point on the map)
  const PIN_HTML = '<div class="gpin"><span></span></div>';
  function dropPin(lat, lng) {
    pinLayer.clearLayers();
    L.marker([lat, lng], {icon: L.divIcon({className: "", iconSize: [28, 40], iconAnchor: [14, 38], html: PIN_HTML})}).addTo(pinLayer);
  }
  const nearestStops = (lat, lng, n) => placed.map(o => [o, km([lat, lng], [o.lat, o.lng])]).sort((a, b) => a[1] - b[1]).slice(0, n);
  function openPlace(p) {
    dropPin(p.lat, p.lng); map.flyTo([p.lat, p.lng], Math.max(map.getZoom(), 13), {duration: .6});
    const near = nearestStops(p.lat, p.lng, 3);
    const rep = REPORTS.filter(r => km([p.lat, p.lng], [r.lat, r.lng]) < 3);
    $("#placeView").innerHTML = `
      <div class="dhead">${backBtn()}<h2>${esc(p.label)}</h2><div class="sub">${esc(p.sub || "")}${myPos ? ` · ${fmtKm(km(myPos, [p.lat, p.lng]))} from you` : ""}</div>
        <div class="actions"><button class="btn2 go" data-start>▶ Start</button><button class="btn2" data-go>➤ Directions</button><button class="btn2 alt" data-rep>⚑ Report path here</button>
        <a class="btn2 alt" target="_blank" rel="noopener" href="https://www.google.com/maps?q=${p.lat},${p.lng}">Google Maps ↗</a></div></div>
      <div class="dbody">
        ${rep.length ? `<div class="fact wide" style="margin-bottom:10px"><b>Path reports nearby</b>${rep.map(r => `<div>${esc(r.label)}${r.note ? " – " + esc(r.note) : ""} <small class="muted">@${esc(r.by)}, ${r.days ? r.days + " d ago" : "today"}</small></div>`).join("")}</div>` : ""}
        <div class="fact wide"><b>Nearest parikrama stops</b>${near.map(([o, d]) => `<div class="ri" data-stop="${o._i}" style="padding:6px 0"><span class="ric" style="background:${STAGES[o.st].c}">${esc(o.n || "·")}</span><div><b>${esc(o.v)}</b><small>${fmtKm(d)} · ${STAGES[o.st].n}</small></div></div>`).join("")}</div>
      </div>`;
    show("placeView");
    const pv = $("#placeView");
    pv.querySelector("[data-go]").onclick = () => openDirections(null, {label: p.label, lat: p.lat, lng: p.lng});
    pv.querySelector("[data-start]").onclick = () => startNav({label: p.label, lat: p.lat, lng: p.lng});
    pv.querySelector("[data-rep]").onclick = () => openReport(p.lat, p.lng);
    pv.querySelectorAll("[data-stop]").forEach(el => el.onclick = () => openStop(+el.dataset.stop, true));
  }
  // tap on the map = drop a pin (like Google Maps), or fill a field when "pick on map" is active
  let pickMode = null;
  map.on("click", e => {
    const {lat, lng} = e.latlng;
    if (pickMode) { const f = pickMode; pickMode = null; $("#map").classList.remove("picking"); f(lat, lng); return; }
    openPlace({label: "Dropped pin", sub: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, lat, lng});
  });

  // ================================================================ directions (car / bike / paidal)
  const ROUTERS = {car: "https://routing.openstreetmap.de/routed-car/route/v1/driving/",
                   bike: "https://routing.openstreetmap.de/routed-car/route/v1/driving/",   // motorbikes use roads like cars
                   walk: "https://routing.openstreetmap.de/routed-foot/route/v1/driving/"};
  const MODE_LABEL = {car: "🚗 Car", bike: "🏍 Bike", walk: "🚶 Paidal"};
  const GMODE = {car: "driving", bike: "driving", walk: "walking"};
  const dir = {from: null, to: null, mode: (() => { try { return localStorage.getItem("dirMode") || "bike"; } catch (e) { return "bike"; } })()};
  function openDirections(from, to) {
    dir.from = from || {label: "My location", me: true}; dir.to = to;
    $("#dirView").innerHTML = `
      <div class="dhead">${backBtn()}<h2 style="font-size:20px">Directions</h2>
        <div class="modes" role="tablist">${Object.keys(MODE_LABEL).map(m => `<button role="tab" data-mode="${m}" aria-selected="${m === dir.mode}">${MODE_LABEL[m]}</button>`).join("")}</div>
        <label class="rulechip"><input type="checkbox" id="ruleT" ${RULE ? "checked" : ""}> 🕉 Parikrama rule: don't cross the Narmada</label>
        <div class="endpoints">
          <div class="ep"><span class="epdot a"></span><input id="fromIn" placeholder="Choose starting point" autocomplete="off"><button class="epbtn" data-me="from" title="My location">◎</button><button class="epbtn" data-pick="from" title="Pick on map">⌖</button></div>
          <div class="ep"><span class="epdot b"></span><input id="toIn" placeholder="Choose destination" autocomplete="off"><button class="epbtn" data-me="to" title="My location">◎</button><button class="epbtn" data-pick="to" title="Pick on map">⌖</button></div>
          <button class="swap" id="swap" title="Swap">⇅</button>
          <div class="results inpanel" id="epResults" hidden></div>
        </div></div>
      <div class="dbody" id="dirOut"><div class="empty">Choose where you're going.</div></div>`;
    show("dirView");
    $("#dirOut").addEventListener("click", e => { if (!e.target.closest("[data-navstart]")) return;
      if (!dir.to || dir.to.me) return; startNav(dir.to, {route: dir.from && dir.from.me ? lastBest : null}); });
    const fromIn = $("#fromIn"), toIn = $("#toIn"), box = $("#epResults");
    const fill = () => { fromIn.value = dir.from ? dir.from.label : ""; toIn.value = dir.to ? dir.to.label : ""; };
    fill();
    [["from", fromIn], ["to", toIn]].forEach(([k, inp]) => {
      let t;
      inp.addEventListener("focus", () => inp.select());
      inp.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => suggest(inp.value.trim(), box, pick => {
        if (pick.veh) { VRoute.place(pick.veh, navigator.onLine).then(pl => { if (!pl) return alertMsg("That stop isn't on the map yet.");
          dir[k] = {label: pl.label, lat: pl.lat, lng: pl.lng}; fill(); route(); }); return; }
        if (pick.stop != null) {
          const o = DATA[pick.stop];
          if (o.lat == null) { alertMsg("That stop isn't on the map yet."); return; }
          dir[k] = stopPoint(o);
        } else dir[k] = {label: pick.place.label, lat: pick.place.lat, lng: pick.place.lng};
        fill(); route();
      }), 300); });
    });
    $$("#dirView [data-me]").forEach(b => b.onclick = () => { dir[b.dataset.me] = {label: "My location", me: true}; fill(); route(); });
    $$("#dirView [data-pick]").forEach(b => b.onclick = () => {
      const k = b.dataset.pick; $("#map").classList.add("picking");
      alertMsg("Tap the map to choose the " + (k === "from" ? "starting point" : "destination"));
      setSheet("min");
      pickMode = (lat, lng) => { dir[k] = {label: `Pin ${lat.toFixed(4)}, ${lng.toFixed(4)}`, lat, lng}; fill(); setSheet("half"); route(); };
    });
    $("#swap").onclick = () => { [dir.from, dir.to] = [dir.to, dir.from]; fill(); route(); };
    $("#ruleT").onchange = e => { RULE = e.target.checked; try { localStorage.setItem("riverRule", RULE ? "1" : "0"); } catch (x) { /* ignore */ } route(); };
    $$("#dirView [data-mode]").forEach(b => b.onclick = () => { dir.mode = b.dataset.mode; try { localStorage.setItem("dirMode", dir.mode); } catch (e) { /* ignore */ } $$("#dirView [data-mode]").forEach(x => x.setAttribute("aria-selected", x === b)); route(); });
    route();
  }
  const resolvePt = p => new Promise(res => { if (!p) return res(null); if (!p.me) return res([p.lat, p.lng]); withMyPos(pos => res(pos), () => res(null)); });
  function stepText(s) {
    const m = s.maneuver, name = s.name ? `<b>${esc(s.name)}</b>` : "the road", mod = esc((m.modifier || "").replace("uturn", "U-turn"));
    switch (m.type) {
      case "depart": return s.name ? `Start on ${name}` : "Start";
      case "arrive": return "You have arrived";
      case "turn": case "end of road": return `Turn ${mod} onto ${name}`;
      case "fork": return `Keep ${mod} at the fork${s.name ? " onto " + name : ""}`;
      case "merge": return `Merge ${mod} onto ${name}`;
      case "roundabout": case "rotary": case "roundabout turn": return `At the roundabout take exit ${m.exit || ""} onto ${name}`;
      case "on ramp": case "off ramp": return `Take the ramp ${mod} onto ${name}`;
      default: return `Continue${mod ? " " + mod : ""} on ${name}`;
    }
  }
  const STEP_ICON = {left: "↰", right: "↱", "slight left": "↖", "slight right": "↗", "sharp left": "↰", "sharp right": "↱", straight: "↑", uturn: "↶"};
  // ---- parikrama rule: never cross the Narmada (see static/river-rule.js)
  let RULE = true;
  try { RULE = localStorage.getItem("riverRule") !== "0"; } catch (e) { /* ignore */ }
  const RR = window.RiverRule && window.RIVER && window.RiverRule.init(window.RIVER) ? window.RiverRule : null;
  // ---------------------------------------------------------------- turn-by-turn navigation (static/nav.js)
  let lastBest = null, wakeLock = null;
  const AWAKE = on => { if (window.NATIVE_AWAKE) return window.NATIVE_AWAKE(on);
    try { if (on && navigator.wakeLock) navigator.wakeLock.request("screen").then(l => { wakeLock = l; }).catch(() => {}); else if (!on && wakeLock) { wakeLock.release(); wakeLock = null; } } catch (e) { /* ignore */ } };
  function startNav(to, opts) {
    if (!window.Nav) return alertMsg("Navigation is not available here.");
    const mode = (opts && opts.mode) || dir.mode;
    try {
      Nav.start(Object.assign({map, router: ROUTERS[mode], mode, dest: to, from: myPos || null, online: () => navigator.onLine, speak: window.NATIVE_SPEAK, keepAwake: AWAKE,
        checkRiver: RULE && RR && mode !== "car" ? coords => RR.crossings(coords).length : null,
        onStart: () => { results.hidden = true; pinLayer.clearLayers(); setSheet("map"); }, onEnd: () => setSheet("half")}, opts || {}));
    } catch (e) { alertMsg(e.message); }
  }

  const BANK = {north: "north (uttar) bank", south: "south (dakshin) bank"};
  const X_ICON = L.divIcon({className: "", iconSize: [26, 26], iconAnchor: [13, 13], html: '<div class="xmark">✕</div>'});

  function drawBankPath(bp) {
    if (!bp) return [];
    const parts = [bp.coords].concat(bp.coords2 ? [bp.coords2] : []);
    parts.forEach(c => L.polyline(c, {color: "#188038", weight: 5, opacity: .85, dashArray: "10 8"}).bindTooltip("Parikrama path along the bank").addTo(roadLayer));
    bp.stops.forEach(o => L.circleMarker([o.lat, o.lng], {radius: 4, color: "#fff", weight: 1.5, fillColor: "#188038", fillOpacity: 1}).bindTooltip(esc(o.v)).addTo(roadLayer));
    return parts.flat();
  }
  function bankHtml(bp, bankName) {
    if (!bp) return "";
    const names = bp.stops.map(o => esc(o.v || "stop"));
    return `<div class="bankpath"><b>🚶 Parikrama path${bankName ? " along the " + bankName : ""}</b> (green dashed line) – about <b>${Math.round(bp.km)} km</b> through ${bp.stops.length} stops:
      <div class="stopchain">${names.slice(0, 40).join(" → ")}${names.length > 40 ? " → …" : ""}</div></div>`;
  }
  function drawRoutes(routes, a, b, crossings, boat, bankPath, greyRoad) {
    roadLayer.clearLayers(); pinLayer.clearLayers();
    routes.slice(1).forEach(alt => L.polyline(alt.coords, {color: "#7f9cc9", weight: 5, opacity: .6}).addTo(roadLayer));
    const best = routes[0];
    const parts = best.legs ? best.legs.map(l => l.coords) : [best.coords];
    let line = null;
    parts.forEach(c => { const pl = L.polyline(c, greyRoad ? {color: "#8a9599", weight: 5, opacity: .7} : {color: "#1a73e8", weight: 6, opacity: .9}).addTo(roadLayer); line = line ? line : pl; });
    const bankPts = drawBankPath(bankPath);
    if (boat) L.polyline(boat, {color: "#0f6e77", weight: 4, dashArray: "2 10", lineCap: "round"}).bindTooltip("Boat across the sea").addTo(roadLayer);
    (crossings || []).forEach(x => L.marker(x, {icon: X_ICON}).bindTooltip("Crosses the Narmada here").addTo(roadLayer));
    L.circleMarker(a, {radius: 7, color: "#fff", weight: 3, fillColor: "#1a73e8", fillOpacity: 1}).addTo(roadLayer);
    L.marker(b, {icon: L.divIcon({className: "", iconSize: [28, 40], iconAnchor: [14, 38], html: PIN_HTML})}).addTo(roadLayer);
    const all = parts.flat().concat(boat || [], bankPts);
    map.fitBounds(all, {padding: [60, 60]});
    return best;
  }
  function routeHtml(best, a, b, extraNote) {
    lastBest = best;
    const dur = best.duration * (dir.mode === "bike" ? 0.85 : 1);
    const onRoute = REPORTS.filter(rp => { for (let k = 0; k < best.coords.length; k += 3) if (km([rp.lat, rp.lng], best.coords[k]) < 0.3) return true; return false; });
    const steps = best.steps.filter(s => s.distance > 0 || s.maneuver.type === "arrive");
    const gUrl = `https://www.google.com/maps/dir/?api=1&origin=${a[0]},${a[1]}&destination=${b[0]},${b[1]}&travelmode=${GMODE[dir.mode]}`;
    return `<div class="routesum"><div><span class="rtime">${fmtTime(dur)}</span> <span class="rdist">(${fmtKm(best.distance / 1000)})</span></div>
        <small>${MODE_LABEL[dir.mode]} · by road, from OpenStreetMap</small></div>
      ${extraNote || ""}
      ${onRoute.length ? `<div class="note">⚑ ${onRoute.length} path report${onRoute.length > 1 ? "s" : ""} on this route: ${onRoute.slice(0, 4).map(r => esc(r.label)).join(", ")}</div>` : ""}
      <div class="actions" style="margin-bottom:10px"><button class="btn2 go" data-navstart>▶ Start</button><a class="btn2 alt" target="_blank" rel="noopener" href="${gUrl}">Google Maps ↗</a></div>
      ${RULE ? `<p class="hintline">Google Maps may choose a different road that crosses the river – follow the blue line on this map.</p>` : ""}
      <ol class="steps">${steps.slice(0, 60).map(s => `<li><span class="si">${STEP_ICON[s.maneuver.modifier] || (s.maneuver.type === "arrive" ? "◉" : "↑")}</span><span>${stepText(s)}</span><small>${s.distance ? fmtKm(s.distance / 1000) : ""}</small></li>`).join("")}${steps.length > 60 ? `<li><span></span><span class="muted">… ${steps.length - 60} more steps</span></li>` : ""}</ol>
      ${dir.mode === "walk" ? `<p class="hintline">Paidal routes use footpaths and roads in OpenStreetMap. Ghat and forest paths may be missing – check the stop's “Path to next stop” and pilgrims' path reports.</p>` : ""}`;
  }
  let routeSeq = 0;
  async function route() {
    const out = $("#dirOut"); if (!out) return;
    if (!dir.from || !dir.to) { out.innerHTML = `<div class="empty">Choose a starting point and a destination.</div>`; return; }
    const seq = ++routeSeq;
    out.innerHTML = `<div class="empty">Finding the best ${MODE_LABEL[dir.mode]} route…</div>`;
    const [a, b] = await Promise.all([resolvePt(dir.from), resolvePt(dir.to)]);
    if (seq !== routeSeq) return;
    if (!a || !b) { out.innerHTML = `<div class="empty">Allow location access to use “My location”.</div>`; return; }
    try {
      if (!RR) {
        const j = await (await fetch(`${ROUTERS[dir.mode]}${a[1]},${a[0]};${b[1]},${b[0]}?overview=full&geometries=geojson&steps=true&alternatives=true`)).json();
        if (j.code !== "Ok") throw new Error();
        const routes = j.routes.map(r => ({coords: r.geometry.coordinates.map(c => [c[1], c[0]]), distance: r.distance, duration: r.duration, steps: r.legs.flatMap(l => l.steps)}));
        out.innerHTML = routeHtml(drawRoutes(routes, a, b, []), a, b); return;
      }
      const plan = await RR.plan({a, b, router: ROUTERS[dir.mode], rule: RULE, stops: DATA});
      if (seq !== routeSeq) return;
      if (plan.status === "opposite") {
        roadLayer.clearLayers();
        out.innerHTML = `<div class="note rule">🕉 <b>${esc(dir.to.label)}</b> is on the ${BANK[plan.sideB]}; you start on the ${BANK[plan.sideA]}.<br>
          The parikrama never crosses the Narmada. Go round one of these ways:</div>
          <div class="actions"><button class="btn2" data-around="source">Via Amarkantak (source)</button><button class="btn2 alt" data-around="sea">Via the sea crossing (boat)</button></div>
          <div class="actions"><button class="btn2 alt" data-around="direct">Show the direct road anyway</button></div><div id="aroundOut"></div>`;
        out.querySelectorAll("[data-around]").forEach(btn => btn.onclick = async () => {
          const box = $("#aroundOut"); box.innerHTML = `<div class="empty">Planning the way round…</div>`;
          try {
            if (btn.dataset.around === "direct") {
              const p2 = await RR.plan({a, b, router: ROUTERS[dir.mode], rule: false, stops: DATA});
              box.innerHTML = routeHtml(drawRoutes(p2.routes, a, b, p2.crossings), a, b,
                `<div class="note warn">⚠ This road crosses the Narmada ${p2.crossings.length} time(s) (✕ on the map). Not allowed during parikrama.</div>`);
              return;
            }
            const r = await RR.planAround({a, b, router: ROUTERS[dir.mode], stops: DATA, which: btn.dataset.around});
            const note = r.which === "source"
              ? `<div class="note ok">✓ Round the source at Amarkantak – stays on the ${BANK[plan.sideA]} up to the source, then down the ${BANK[plan.sideB]}.</div>`
              : `<div class="note ok">✓ Road to ${esc(r.coastA)} on the coast, then <b>boat across the Gulf (~${Math.round(r.boatKm)} km, not included in time)</b> to ${esc(r.coastB)}, then road on. Boats run Oct–May, ask locally for timings.</div>`;
            box.innerHTML = routeHtml(drawRoutes(r.routes, a, b, r.crossings, r.boat, r.bankPath, r.crossings.length > 0), a, b, note + bankHtml(r.bankPath) +
              (r.crossings.length ? `<div class="note warn">⚠ Part of this road still touches the river at ${r.crossings.length} spot(s) (✕). Follow the parikrama path there.</div>` : ""));
          } catch (e) { box.innerHTML = `<div class="empty">Couldn't plan that way round right now. Try again or use another mode.</div>`; }
        });
        return;
      }
      const notes = {
        ok: plan.sideA && BANK[plan.sideA] && plan.sideA === plan.sideB ? `<div class="note ok">✓ Stays on the ${BANK[plan.sideA]} – does not cross the Narmada.</div>` : `<div class="note ok">✓ Does not cross the Narmada.</div>`,
        kept: `<div class="note ok">✓ Kept on the ${BANK[plan.bank]} through ${plan.via} parikrama stops – the shortest road would cross the river.</div>`,
        crosses: bankHtml(plan.bankPath, BANK[plan.bank]) + `<div class="note warn">⚠ The map has no road that stays on this bank, so the road route (grey) crosses the Narmada at ✕. Walk the parikrama path instead – bank footpaths are often missing from the map; ask locally.</div>`,
        free: plan.crossings.length ? `<div class="note">This route crosses the Narmada ${plan.crossings.length} time(s). Turn on the parikrama rule to avoid that.</div>` : "",
      };
      const crossing = plan.status === "crosses";
      out.innerHTML = routeHtml(drawRoutes(plan.routes, a, b, crossing || plan.status === "free" ? plan.crossings : [], null, crossing ? plan.bankPath : null, crossing), a, b, notes[plan.status] || "");
    } catch (e) {
      out.innerHTML = `<div class="empty">No ${MODE_LABEL[dir.mode]} route found between these points.<br>Try another mode, or <a target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${b[0]},${b[1]}">open in Google Maps ↗</a>.</div>`;
    }
  }
  $("#dirOpen").onclick = e => { e.preventDefault(); e.stopPropagation(); openDirections(null, null); };

  // ================================================================ path reports
  let REPORTS = [];
  const reportIcon = r => L.divIcon({className: "", iconSize: [30, 30], iconAnchor: [15, 15],
    html: `<div class="rmark${r.pending ? " pend" : ""}">${(REPORT_KINDS[r.kind] || "📝").split(" ")[0]}</div>`});
  async function loadReports() {
    try {
      const j = await (await fetch(URLS_EXTRA.reports)).json();
      REPORTS = j.reports || [];
      reportLayer.clearLayers();
      REPORTS.forEach(r => L.marker([r.lat, r.lng], {icon: reportIcon(r)})
        .bindPopup(`<b>${esc(r.label)}</b>${r.note ? `<br>${esc(r.note)}` : ""}<br><small>${r.mode !== "all" ? MODE_LABEL[r.mode] + " · " : ""}by @${esc(r.by)} · ${r.days ? r.days + " days ago" : "today"}${r.pending ? " · <i>waiting for approval</i>" : ""}</small>`)
        .addTo(reportLayer));
    } catch (e) { /* ignore */ }
  }
  const needLogin = what => { if (ME) return false;
    alertMsg(`Log in or join to ${what}.`); setTimeout(() => { location.href = LOGIN + "?next=" + encodeURIComponent(location.pathname); }, 1200); return true; };
  function openReport(lat, lng) {
    if (needLogin("report a path")) return;
    let spot = lat != null ? [lat, lng] : null, kind = null, mode = "all", noteVal = "";
    const keepNote = () => { const n = $("#rNote"); if (n) noteVal = n.value; draw(); };
    function draw() {
      $("#reportView").innerHTML = `
        <div class="dhead">${backBtn()}<h2 style="font-size:20px">Report the path</h2>
          <div class="sub">Tell other pilgrims what the road or footpath is like here. You must be within ${REPORT_RADIUS} km of the spot.</div></div>
        <div class="dbody">
          <div class="fact wide" style="margin-bottom:10px"><b>Spot</b>${spot ? `${spot[0].toFixed(5)}, ${spot[1].toFixed(5)}` : "Not chosen yet"}
            <div class="actions"><button class="btn2 alt" data-spot-me>◎ Where I am</button><button class="btn2 alt" data-spot-pick>⌖ Tap on map</button></div></div>
          <div class="kinds">${Object.entries(REPORT_KINDS).map(([k, v]) => `<button class="kind${kind === k ? " on" : ""}" data-kind="${k}">${esc(v)}</button>`).join("")}</div>
          <div class="modes" style="margin:10px 0">${["all", "walk", "bike", "car"].map(m => `<button data-rmode="${m}" aria-selected="${mode === m}">${m === "all" ? "Everyone" : MODE_LABEL[m]}</button>`).join("")}</div>
          <textarea id="rNote" class="rnote" maxlength="500" placeholder="Details (optional) – e.g. “Bridge washed away, use the boat 200 m upstream”"></textarea>
          <div class="actions"><button class="btn2" id="rSend">Send report</button></div>
          <p class="hintline" id="rMsg" role="status"></p>
        </div>`;
      $("#rNote").value = noteVal;
      const rv = $("#reportView");
      rv.querySelector("[data-spot-me]").onclick = () => withMyPos(p => { spot = p; dropPin(p[0], p[1]); keepNote(); });
      rv.querySelector("[data-spot-pick]").onclick = () => { $("#map").classList.add("picking"); setSheet("min");
        pickMode = (la, ln) => { spot = [la, ln]; dropPin(la, ln); setSheet("half"); keepNote(); }; };
      rv.querySelectorAll("[data-kind]").forEach(b => b.onclick = () => { kind = b.dataset.kind; keepNote(); });
      rv.querySelectorAll("[data-rmode]").forEach(b => b.onclick = () => { mode = b.dataset.rmode; keepNote(); });
      rv.querySelector("#rSend").onclick = () => {
        const msg = $("#rMsg");
        if (!spot) { msg.textContent = "Choose the spot first."; return; }
        if (!kind) { msg.textContent = "Choose what kind of report this is."; return; }
        if (!navigator.geolocation) { msg.textContent = "This browser can't share location."; return; }
        msg.textContent = "Checking your location…";
        const send = async p => {
          const r = await post(URLS_EXTRA.reports, {lat: spot[0], lng: spot[1], kind, mode, note: $("#rNote").value,
            my_lat: p.coords.latitude, my_lng: p.coords.longitude, my_acc: p.coords.accuracy});
          const j = await r.json().catch(() => ({}));
          if (r.ok) { alertMsg(j.message || "Thank you!"); pinLayer.clearLayers(); loadReports(); back(); }
          else msg.textContent = j.error || "Could not send. Please try again.";
        };
        // use the position we are already tracking if it is fresh, otherwise ask the phone
        if (lastFix && Date.now() - lastFix.timestamp < 60000) send(lastFix);
        else navigator.geolocation.getCurrentPosition(send,
          () => { msg.textContent = "Allow location access – reports are only accepted from people near the spot."; },
          {enableHighAccuracy: true, timeout: 25000, maximumAge: 30000});
      };
    }
    if (spot) dropPin(spot[0], spot[1]);
    draw(); show("reportView");
  }

  // ================================================================ my location + heartbeat
  let meMarker = null, meCircle = null, lastSent = 0, lastFix = null;
  function setMyPos(p) {
    myPos = [p.coords.latitude, p.coords.longitude]; myAcc = p.coords.accuracy; lastFix = p;
    if (!meMarker) {
      meCircle = L.circle(myPos, {radius: myAcc, color: "#1a73e8", weight: 1, fillOpacity: .08, interactive: false}).addTo(map);
      meMarker = L.marker(myPos, {icon: L.divIcon({className: "", html: '<div class="mepin"></div>', iconSize: [18, 18]}), zIndexOffset: 1000}).addTo(map);
    } else { meMarker.setLatLng(myPos); meCircle.setLatLng(myPos); if (meCircle.setRadius) meCircle.setRadius(myAcc); }
    if (Date.now() - lastSent > (LIVE ? 20000 : 60000)) beat(p);
  }
  function withMyPos(cb, fail) {
    if (myPos) return cb(myPos);
    if (!navigator.geolocation) { alertMsg("This browser can't share location."); if (fail) fail(); return; }
    navigator.geolocation.getCurrentPosition(p => { setMyPos(p); cb(myPos); },
      () => { alertMsg("Allow location access for this site."); if (fail) fail(); }, {enableHighAccuracy: true, timeout: 20000});
  }
  function beat(p) {
    lastSent = Date.now();
    if (!ME) return;                                   // guests don't appear online
    post(URLS.beat, p ? {lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy} : {})
      .then(r => { if (r.status === 428 || r.status === 401) location.reload(); }).catch(() => {});
  }
  // pilgrims share their position; guests are only asked when they tap "my location"
  if (ME && navigator.geolocation) navigator.geolocation.watchPosition(setMyPos, () => {}, {enableHighAccuracy: true, maximumAge: 60000});
  setInterval(() => { if (Date.now() - lastSent > 60000) beat(null); }, 30000);
  beat(null);

  // ================================================================ online pilgrims
  const agoText = u => u.live && u.sec < 90 ? "live now" : (u.ago ? u.ago + " min ago" : "online now");
  const personTip = u => `@${esc(u.u)} · ${agoText(u)} · ${u.live ? "live location" + (u.acc ? " ±" + u.acc + " m" : "") : "approx. area"}`;
  const personIcon = u => { const c = hue(u.u); return L.divIcon({className: "", iconSize: [30, 30], iconAnchor: [15, 15],
    html: `<div class="pmark${u.live ? " live" : ""}" style="color:${c}"><span class="ring"></span><div class="dot" style="background:${c}">${esc(u.u[0].toUpperCase())}</div>${u.live ? '<span class="livetag">LIVE</span>' : ""}<span class="lbl">@${esc(u.u)}</span></div>`}); };
  async function loadOnline() {
    try {
      const j = await (await fetch(URLS.online)).json();
      const list = j.online || [];
      $("#onlineCount").textContent = list.length;
      peopleLayer.clearLayers();
      list.forEach(u => {
        if (u.lat == null || u.me) return;
        const c = hue(u.u);
        L.marker([u.lat, u.lng], {icon: personIcon(u), zIndexOffset: u.live ? 500 : 0})
          .bindTooltip(personTip(u), {className: "stoptip"}).addTo(peopleLayer);
      });
      $("#onlineList").innerHTML = list.length ? list.map(u => `
        <div class="ou" data-lat="${u.lat ?? ""}" data-lng="${u.lng ?? ""}">
          <div class="av" style="background:${hue(u.u)}">${esc(u.u[0].toUpperCase())}</div>
          <div><b>@${esc(u.u)}</b>${u.me ? " <small>(you)</small>" : ""}${u.role ? ` <span class="tag o">${u.role === "admin" ? "Admin" : "Super user"}</span>` : ""}<br>
          <small>${u.live ? "🔴 " : ""}${agoText(u)}${u.lat == null ? " · location hidden" : u.live ? " · live location" : ""}</small></div></div>`).join("")
        : `<div class="empty">No one else is online right now.</div>`;
    } catch (e) { /* offline */ }
  }
  $("#onlineList").addEventListener("click", e => { const r = e.target.closest(".ou"); if (r && r.dataset.lat) map.flyTo([+r.dataset.lat, +r.dataset.lng], 12); });


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
  const pathLayer = L.layerGroup().addTo(map);
  async function loadPaths() {
    try {
      PATHS = (await (await fetch(URLS.paths)).json()).paths || [];
      $("#pathCount").textContent = PATHS.filter(p => !p.me || p.shared).length;
      if (SEL >= PATHS.length) SEL = -1;
      renderPaths();
    } catch (e) { /* offline */ }
  }
  function renderPaths() { drawPaths(pathLayer, PATHS); $("#pathNav").innerHTML = pathNavHtml(PATHS); $("#pathList").innerHTML = pathListHtml(PATHS); }
  function showPath(i) { SEL = i; renderPaths(); if (PATHS[SEL]) { fitPath(PATHS[SEL]); setSheet("min"); } }
  $("#pathList").addEventListener("click", e => { const r = e.target.closest(".pr"); if (r) showPath(+r.dataset.pi); });
  $("#pathNav").addEventListener("click", e => { const b = e.target.closest("[data-pn]"); if (b) showPath(stepPath(PATHS, +b.dataset.pn)); });

  // ================================================================ public geotagged photos (from the app), shown when zoomed in
  const photoLayer = L.layerGroup().addTo(map); let photoTimer = null, PHOTOS = {};
  function loadPhotos() {
    clearTimeout(photoTimer);
    photoTimer = setTimeout(async () => {
      photoLayer.clearLayers(); if (map.getZoom() < 12) return;
      const b = map.getBounds().pad(0.3);
      try {
        const j = await (await fetch(`${URLS.photos}?bbox=${[b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map(x => x.toFixed(4)).join(",")}`)).json();
        (j.photos || []).forEach(ph => { PHOTOS[ph.id] = ph;
          L.marker([ph.lat, ph.lng], {icon: L.divIcon({className: "", iconSize: [46, 46], iconAnchor: [23, 46], html: `<div class="phmark"><img src="${esc(ph.thumb)}" alt="" loading="lazy"></div>`}), zIndexOffset: 300})
            .bindPopup(`<div class="phpop"><a href="${esc(ph.full)}" target="_blank" rel="noopener"><img src="${esc(ph.full)}" alt="Photo by @${esc(ph.u)}"></a>
              <b>@${esc(ph.u)}</b> · ${esc(ph.when)}${ph.near ? " · near " + esc(ph.near) : ""}${ph.caption ? `<p>${esc(ph.caption)}</p>` : ""}
              ${ph.can_delete ? `<button class="btn2 alt" data-phdel="${ph.id}">Remove photo</button>` : ""}</div>`, {maxWidth: 340, minWidth: 260})
            .addTo(photoLayer); });
      } catch (e) { /* offline */ }
    }, 400);
  }
  map.on("moveend zoomend", loadPhotos);
  document.addEventListener("click", async e => {
    const b = e.target.closest("[data-phdel]"); if (!b) return;
    if (!b.dataset.sure) { b.dataset.sure = 1; b.textContent = "Click again to remove"; return; }
    const r = await post(URLS.photoDel.replace(/0\/delete$/, b.dataset.phdel + "/delete"), {});
    if (r.ok) { map.closePopup(); alertMsg("Photo removed."); loadPhotos(); } else alertMsg("Could not remove it.");
  });

  // ================================================================ controls
  function alertMsg(t) {
    let box = $(".toasts"); if (!box) { box = document.createElement("div"); box.className = "toasts"; document.body.appendChild(box); }
    const d = document.createElement("div"); d.className = "toast"; d.textContent = t; box.appendChild(d); setTimeout(() => d.remove(), 6000);
  }
  $$("[data-s]").forEach(b => b.onclick = () => { stage = +b.dataset.s; $$("[data-s]").forEach(x => x.classList.toggle("on", x === b)); render(); fitVisible(); });
  $$("[data-f]").forEach(b => b.onclick = () => {
    const f = b.dataset.f;
    if (f === "near" && !filters.has("near") && !myPos) { withMyPos(() => { filters.add("near"); b.classList.add("on"); render(); map.flyTo(myPos, 10); }); return; }
    if (filters.has(f)) filters.delete(f); else filters.add(f);
    b.classList.toggle("on", filters.has(f)); render();
  });
  $$("[data-tab]").forEach(b => b.onclick = () => {
    const tab = b.dataset.tab; $$("[data-tab]").forEach(x => x.setAttribute("aria-selected", x === b));
    $("#stopsTab").hidden = tab !== "stops"; $("#onlineTab").hidden = tab !== "online"; $("#pathsTab").hidden = tab !== "paths";
    if (tab === "online") loadOnline(); if (tab === "paths") loadPaths();
  });
  $("#locBtn").onclick = () => withMyPos(p => map.flyTo(p, 14));
  $("#zIn").onclick = () => map.zoomIn();
  $("#zOut").onclick = () => map.zoomOut();
  function fitVisible() { const pts = DATA.filter(o => matches(o) && o.lat != null).map(o => [o.lat, o.lng]); if (pts.length) map.fitBounds(pts, {padding: [40, 40]}); }
  $("#fitBtn").onclick = () => { roadLayer.clearLayers(); pinLayer.clearLayers(); fitVisible(); };

  const av = $("#avatarBtn"), menu = $("#menu");
  if (av) {                                            // (guests have Log in / Join buttons instead)
    av.onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; av.setAttribute("aria-expanded", !menu.hidden); };
    document.addEventListener("click", e => { if (!menu.hidden && !menu.contains(e.target)) { menu.hidden = true; av.setAttribute("aria-expanded", "false"); } });
  }

  const panel = $("#panel"), order = ["min", "half", "full"];
  function setSheet(s) { if (window.innerWidth > 760 && s !== "map" && panel.dataset.size !== "map") return; panel.dataset.size = s; setTimeout(() => map.invalidateSize(), 260); }


  // ---------------------------------------------------------------- compass: shows when the map is turned; tap = north up
  (function compass() {
    const b = $("#northBtn"); if (!b) return;
    if (typeof map.setBearing !== "function") { b.hidden = true; return; }
    const upd = () => { const d = map.getBearing() || 0; b.hidden = Math.abs(((d + 540) % 360) - 180) < 1; b.firstElementChild.style.transform = `rotate(${d}deg)`; };
    map.on("rotate", upd); upd();
    b.onclick = () => map.setBearing(0);
  })();
  // ---------------------------------------------------------------- walking guide ↔ bike / car route
  (function routeSwitch() {
    const has = window.VRoute && VRoute.init({data: window.VROUTE, map, box: $("#vehBox"), onPick: () => setSheet("min"), getPos: () => myPos,
      onRide: (chain, intro) => startNav(chain[0], {chain, mode: "bike", checkRiver: null, intro})});
    const sw = $(".routesw"); if (!has) { sw.hidden = true; return; }
    const set = r => {
      $$(".routesw [data-route]").forEach(b => b.setAttribute("aria-checked", b.dataset.route === r));
      $("#vehBox").hidden = r !== "vehicle"; $("#walkBox").hidden = r === "vehicle";
      VRoute.show(r === "vehicle"); [routeLines, stopLayer].forEach(l => r === "vehicle" ? l.remove() : l.addTo(map)); try { localStorage.setItem("routeMode", r); } catch (e) { /* private mode */ }
    };
    sw.addEventListener("click", e => { const b = e.target.closest("[data-route]"); if (b) set(b.dataset.route); });
    let saved = "walk"; try { saved = localStorage.getItem("routeMode") || "walk"; } catch (e) { /* ignore */ }
    if (saved === "vehicle") set("vehicle");
  })();
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


  render(); fitVisible(); loadOnline(); loadReports(); loadPaths();
  setInterval(loadOnline, 20000); setInterval(loadReports, 120000); setInterval(loadPaths, 180000);
})();
