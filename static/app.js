/* Narmada Parikrama – map app */
(function () {
  "use strict";
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const isNo = v => !v || v === "No" || v === "–" || v === "-";
  const km = (a, b) => { const r = x => x * Math.PI / 180, dp = r(b[0] - a[0]), dl = r(b[1] - a[1]);
    const h = Math.sin(dp / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dl / 2) ** 2; return 2 * 6371 * Math.asin(Math.sqrt(h)); };
  const hue = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 55% 45%)`; };

  DATA.forEach((o, i) => { o._i = i; o._s = [o.v, o.vm, o.sp, o.acc, o.ti, o.te, o.sa, o.rt].join(" ").toLowerCase(); });

  // ------------------------------------------------------------ map
  const map = L.map("map", {zoomControl: false, attributionControl: true, preferCanvas: true}).setView([22.4, 77.5], 7);
  const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  if (LOCAL_MAP && window.protomapsL) {
    // Map file stored on our own server (deploy/download-map.sh) – no outside tile server needed.
    protomapsL.leafletLayer({url: LOCAL_MAP, flavor: "light", lang: "en", maxDataZoom: LOCAL_MAXZOOM,
      attribution: OSM_ATTR + ' &copy; <a href="https://protomaps.com">Protomaps</a>'}).addTo(map);
  } else {
    // Standard OpenStreetMap tiles: free, no API key (attribution required).
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {maxZoom: 19, attribution: OSM_ATTR}).addTo(map);
  }

  const routeLines = L.layerGroup().addTo(map);
  const stopLayer = L.layerGroup().addTo(map);
  const peopleLayer = L.layerGroup().addTo(map);
  const roadLayer = L.layerGroup().addTo(map);
  const markers = {};
  const placed = DATA.filter(o => o.lat != null);

  [1, 2, 3].forEach(st => {
    const pts = placed.filter(o => o.st === st).map(o => [o.lat, o.lng]);
    if (pts.length > 1) L.polyline(pts, {color: STAGES[st].c, weight: 3, opacity: .35, dashArray: "6 6"}).addTo(routeLines);
  });
  placed.forEach(o => {
    const m = L.circleMarker([o.lat, o.lng], {radius: 6, color: "#fff", weight: 2, fillColor: STAGES[o.st].c, fillOpacity: 1})
      .bindTooltip(esc(o.v || "Stop"), {className: "stoptip", direction: "top", offset: [0, -6]})
      .on("click", () => openDetail(o._i, false));
    markers[o._i] = m;
  });

  // ------------------------------------------------------------ state & filters
  let stage = 0, filters = new Set(), query = "", tab = "stops", myPos = null, shown = 120, selected = null;

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
    let rows = DATA.filter(matches);
    if (filters.has("near") && myPos) rows.sort((a, b) => km(myPos, [a.lat, a.lng]) - km(myPos, [b.lat, b.lng]));
    $("#stopCount").textContent = rows.length;
    // markers
    stopLayer.clearLayers();
    rows.forEach(o => { if (markers[o._i]) markers[o._i].addTo(stopLayer); });
    // list
    const list = $("#list");
    if (!rows.length) { list.innerHTML = `<div class="empty">No stops match.<br>Try another spelling, or clear the filters.</div>`; return; }
    list.innerHTML = rows.slice(0, shown).map(o => {
      const tags = [];
      if (o.fd === "Yes") tags.push('<span class="tag y">Food</span>');
      if (o.sd === "Yes") tags.push('<span class="tag y">Sadavrat</span>');
      if (!isNo(o.acc)) tags.push('<span class="tag">Stay</span>');
      if (o.pm) tags.push(`<span class="tag o">📷 ${o.pm}</span>`);
      if (o.ub) tags.push('<span class="tag o">Updated</span>');
      const dist = myPos && o.lat != null ? `${km(myPos, [o.lat, o.lng]).toFixed(o.lat != null && km(myPos, [o.lat, o.lng]) < 10 ? 1 : 0)} km away` : (o.cum ? `${esc(o.cum)} km` : "");
      return `<div class="item${selected === o._i ? " sel" : ""}" role="listitem" data-i="${o._i}">
        <div class="no${o.lat == null ? " off" : ""}" style="background:${STAGES[o.st].c}">${esc(o.n || "·")}</div>
        <div class="tx"><div class="t">${o.v ? hl(o.v) : "(not named)"}<small class="mr">${hl(o.vm)}</small></div>
          ${o.sp ? `<div class="s">${hl(o.sp)}</div>` : ""}${tags.length ? `<div class="tags">${tags.join("")}</div>` : ""}</div>
        <div class="km">${dist}</div></div>`;
    }).join("") + (rows.length > shown ? `<button class="more" id="more">Show more (${rows.length - shown} left)</button>` : "");
    const more = $("#more"); if (more) more.onclick = () => { shown += 200; render(false); };
  }
  $("#list").addEventListener("click", e => { const it = e.target.closest(".item"); if (it) openDetail(+it.dataset.i, true); });

  // ------------------------------------------------------------ detail
  function fact(label, v, wide) { return isNo(v) ? "" : `<div class="fact${wide ? " wide" : ""}"><b>${label}</b>${esc(v)}</div>`; }
  function nextStop(o) { for (let j = o._i + 1; j < DATA.length; j++) if (DATA[j].st === o.st && DATA[j].lat != null) return DATA[j]; return null; }
  function openDetail(i, fly) {
    const o = DATA[i]; selected = i;
    const nx = o.lat != null ? nextStop(o) : null;
    $("#detailView").innerHTML = `
      <div class="dhead"><button class="back" id="back">← All stops</button>
        <h2>${esc(o.v || "(not named)")} <span class="mr" style="font-size:16px;color:var(--muted)">${esc(o.vm)}</span></h2>
        <div class="sub">${STAGES[o.st].n} · ${STAGES[o.st].b} · No. ${esc(o.n || "–")} · ${esc(o.cum || "–")} km from stage start${o.lat == null ? " · not on map yet" : (o.ls === "visit" ? " · location confirmed" : " · approximate location")}</div></div>
      <div class="dbody">
        ${o.sp ? `<div class="note">${esc(o.sp)}</div>` : ""}
        <div class="facts">
          ${fact("Stay", o.acc, true)}${fact("Temples", o.te, true)}${fact("Tirth", o.ti)}${fact("Sangam", o.sa)}
          ${fact("Cooked food", o.fd)}${fact("Sadavrat", o.sd)}${fact("Built ghat", o.gh)}${fact("Bridge", o.br)}
          ${fact("Path to next stop", o.rt, true)}${fact("Km from previous", o.d)}${fact("Halt days", o.h)}
        </div>
        ${o.lat != null ? `
        <div class="fact wide" style="margin-bottom:10px"><b>Road route</b>
          <div class="chiprow" style="padding:6px 0 0" id="modes">
            <button class="chip2 on" data-m="foot">🚶 Walk</button><button class="chip2" data-m="bike">🏍 Bike</button><button class="chip2" data-m="car">🚗 Car</button>
          </div>
          <div class="actions">
            <button class="btn2" id="rFromMe">From my location</button>
            ${nx ? `<button class="btn2 alt" id="rToNext">To next stop: ${esc(nx.v)}</button>` : ""}
          </div>
          <div class="upd" id="rInfo"></div>
        </div>` : ""}
        <div class="actions">
          <a class="btn2" href="${URLS.edit}${o.id}/edit">✎ Update / add photos</a>
          <a class="btn2 alt" href="${URLS.stop}${o.id}">Full page</a>
          ${o.lat != null ? `<a class="btn2 alt" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${o.lat},${o.lng}">Navigate ↗</a>` : ""}
        </div>
        ${o.ub ? `<div class="upd">✎ Updated by @${esc(o.ub)} · ${esc(o.ua)}</div>` : ""}
      </div>`;
    $("#listView").hidden = true; $("#detailView").hidden = false;
    $("#back").onclick = closeDetail;
    if (o.lat != null) {
      let mode = "foot";
      $$("#modes .chip2").forEach(b => b.onclick = () => { mode = b.dataset.m; $$("#modes .chip2").forEach(x => x.classList.toggle("on", x === b)); });
      $("#rFromMe").onclick = () => withMyPos(p => drawRoad(p, [o.lat, o.lng], mode, `you → ${o.v}`));
      if (nx) $("#rToNext").onclick = () => drawRoad([o.lat, o.lng], [nx.lat, nx.lng], mode, `${o.v} → ${nx.v}`);
      if (fly) map.flyTo([o.lat, o.lng], Math.max(map.getZoom(), 12), {duration: .6});
      markers[i].setStyle({radius: 10}); setTimeout(() => markers[i] && markers[i].setStyle({radius: 6}), 1800);
    }
    if (window.innerWidth <= 760) setSheet("half");
  }
  function closeDetail() { selected = null; $("#detailView").hidden = true; $("#listView").hidden = false; render(false); }

  // ------------------------------------------------------------ road routing (OSRM on OpenStreetMap data)
  const ROUTERS = {foot: "https://routing.openstreetmap.de/routed-foot/route/v1/driving/",
                   bike: "https://routing.openstreetmap.de/routed-bike/route/v1/driving/",
                   car:  "https://routing.openstreetmap.de/routed-car/route/v1/driving/"};
  const SPEED = {foot: 4.5, bike: 35, car: 45};   // km/h for a realistic time estimate on rural roads
  async function drawRoad(a, b, mode, label) {
    const info = $("#rInfo"); if (info) info.textContent = "Finding the road route…";
    try {
      const r = await fetch(`${ROUTERS[mode]}${a[1]},${a[0]};${b[1]},${b[0]}?overview=full&geometries=geojson`);
      const j = await r.json();
      if (j.code !== "Ok" || !j.routes.length) throw new Error(j.message || "no route");
      const rt = j.routes[0], dkm = rt.distance / 1000, hrs = dkm / SPEED[mode];
      roadLayer.clearLayers();
      const line = L.geoJSON(rt.geometry, {style: {color: "#1a73e8", weight: 5, opacity: .85}}).addTo(roadLayer);
      L.circleMarker(a, {radius: 6, color: "#fff", weight: 2, fillColor: "#1a73e8", fillOpacity: 1}).addTo(roadLayer);
      map.fitBounds(line.getBounds(), {padding: [60, 60]});
      const t = hrs < 1 ? `${Math.round(hrs * 60)} min` : `${Math.floor(hrs)} h ${Math.round((hrs % 1) * 60)} min`;
      if (info) info.innerHTML = `<b>${dkm.toFixed(1)} km by road</b> · about ${t} ${mode === "foot" ? "walking" : mode === "bike" ? "by bike" : "by car"} (${esc(label)}). <a href="#" id="clearRoad">Clear</a>`;
      const c = $("#clearRoad"); if (c) c.onclick = e => { e.preventDefault(); roadLayer.clearLayers(); info.textContent = ""; };
    } catch (e) {
      if (info) info.textContent = "Couldn't find a road route right now. Try another mode, or use Navigate ↗.";
    }
  }

  // ------------------------------------------------------------ my location + heartbeat
  let meMarker = null, lastSent = 0;
  function setMyPos(p) {
    myPos = [p.coords.latitude, p.coords.longitude];
    if (!meMarker) meMarker = L.marker(myPos, {icon: L.divIcon({className: "", html: '<div class="mepin"></div>', iconSize: [18, 18]}), zIndexOffset: 1000}).addTo(map);
    else meMarker.setLatLng(myPos);
    if (Date.now() - lastSent > 60000) beat(p);
  }
  function withMyPos(cb) {
    if (myPos) return cb(myPos);
    navigator.geolocation.getCurrentPosition(p => { setMyPos(p); cb(myPos); },
      () => { const i = $("#rInfo"); if (i) i.textContent = "Allow location access to route from where you are."; }, {enableHighAccuracy: true, timeout: 20000});
  }
  function beat(p) {
    lastSent = Date.now();
    const b = new FormData(); b.append("_csrf", CSRF);
    if (p) { b.append("lat", p.coords.latitude); b.append("lng", p.coords.longitude); b.append("accuracy", p.coords.accuracy); }
    fetch(URLS.beat, {method: "POST", body: b, headers: {"X-CSRF-Token": CSRF}}).then(r => { if (r.status === 428 || r.status === 401) location.reload(); }).catch(() => {});
  }
  if (navigator.geolocation) navigator.geolocation.watchPosition(setMyPos, () => {}, {enableHighAccuracy: true, maximumAge: 60000});
  setInterval(() => { if (Date.now() - lastSent > 60000) beat(null); }, 30000);
  beat(null);

  // ------------------------------------------------------------ online pilgrims
  async function loadOnline() {
    try {
      const j = await (await fetch(URLS.online)).json();
      const list = j.online || [];
      $("#onlineCount").textContent = list.length;
      peopleLayer.clearLayers();
      list.forEach(u => {
        if (u.lat == null || u.me) return;
        const c = hue(u.u);
        L.marker([u.lat, u.lng], {icon: L.divIcon({className: "", iconSize: [30, 30], iconAnchor: [15, 15],
          html: `<div class="pmark" style="color:${c}"><span class="ring"></span><div class="dot" style="background:${c}">${esc(u.u[0].toUpperCase())}</div><span class="lbl">@${esc(u.u)}</span></div>`})})
          .bindTooltip(`@${esc(u.u)} · ${u.ago ? u.ago + " min ago" : "online now"} · approx. area`, {className: "stoptip"}).addTo(peopleLayer);
      });
      $("#onlineList").innerHTML = list.length ? list.map(u => `
        <div class="ou" data-lat="${u.lat ?? ""}" data-lng="${u.lng ?? ""}">
          <div class="av" style="background:${hue(u.u)}">${esc(u.u[0].toUpperCase())}</div>
          <div><b>@${esc(u.u)}</b>${u.me ? " <small>(you)</small>" : ""}${u.role ? ` <span class="tag o">${u.role === "admin" ? "Admin" : "Super user"}</span>` : ""}<br>
          <small>${u.ago ? u.ago + " min ago" : "online now"}${u.lat == null ? " · location hidden" : ""}</small></div></div>`).join("")
        : `<div class="empty">No one else is online right now.</div>`;
    } catch (e) { /* offline – try again later */ }
  }
  $("#onlineList").addEventListener("click", e => { const r = e.target.closest(".ou"); if (r && r.dataset.lat) map.flyTo([+r.dataset.lat, +r.dataset.lng], 12); });
  loadOnline(); setInterval(loadOnline, 30000);

  // ------------------------------------------------------------ controls
  let tmr;
  $("#q").addEventListener("input", e => { clearTimeout(tmr); tmr = setTimeout(() => { query = e.target.value.trim().toLowerCase(); if (!$("#detailView").hidden) closeDetail(); render(); }, 150); });
  $$("[data-s]").forEach(b => b.onclick = () => { stage = +b.dataset.s; $$("[data-s]").forEach(x => x.classList.toggle("on", x === b)); render(); fitVisible(); });
  $$("[data-f]").forEach(b => b.onclick = () => {
    const f = b.dataset.f;
    if (f === "near" && !filters.has("near") && !myPos) { withMyPos(() => { filters.add("near"); b.classList.add("on"); render(); map.flyTo(myPos, 10); }); return; }
    filters.has(f) ? filters.delete(f) : filters.add(f); b.classList.toggle("on", filters.has(f)); render();
  });
  $$("[data-tab]").forEach(b => b.onclick = () => {
    tab = b.dataset.tab; $$("[data-tab]").forEach(x => x.setAttribute("aria-selected", x === b));
    $("#stopsTab").hidden = tab !== "stops"; $("#onlineTab").hidden = tab !== "online"; if (tab === "online") loadOnline();
  });
  $("#locBtn").onclick = () => withMyPos(p => map.flyTo(p, 13));
  $("#zIn").onclick = () => map.zoomIn();
  $("#zOut").onclick = () => map.zoomOut();
  function fitVisible() { const pts = DATA.filter(o => matches(o) && o.lat != null).map(o => [o.lat, o.lng]); if (pts.length) map.fitBounds(pts, {padding: [40, 40]}); }
  $("#fitBtn").onclick = () => { roadLayer.clearLayers(); fitVisible(); };

  const av = $("#avatarBtn"), menu = $("#menu");
  av.onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; av.setAttribute("aria-expanded", !menu.hidden); };
  document.addEventListener("click", e => { if (!menu.hidden && !menu.contains(e.target)) { menu.hidden = true; av.setAttribute("aria-expanded", "false"); } });

  // bottom sheet sizes on mobile
  const panel = $("#panel"), order = ["min", "half", "full"];
  function setSheet(s) { panel.dataset.size = s; setTimeout(() => map.invalidateSize(), 260); }
  $("#grip").onclick = () => setSheet(order[(order.indexOf(panel.dataset.size) + 1) % 3]);
  $("#q").addEventListener("focus", () => { if (window.innerWidth <= 760) setSheet("full"); });

  render();
  fitVisible();
})();
