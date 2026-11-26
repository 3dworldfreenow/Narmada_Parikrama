/* Bike / four-wheeler parikrama route (Acharya Shri Anildas Yogiraj) – shared by the website and the app.
 * VRoute.init({data, map, box, onPick}) ; VRoute.show(true|false)
 */
(function () {
  "use strict";
  const COL = {1: "#0f6e77", 2: "#c8641e", 3: "#7a4fb0"};
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c]);
  let D = null, map = null, box = null, onPick = null, onRide = null, getPos = null, layer = null, part = 0, drawn = false;
  const markers = {};

  function draw() {
    if (drawn || !D) return; drawn = true;
    D.parts.forEach(p => {
      const pts = p.stops.filter(s => s.lat != null).map(s => [s.lat, s.lng]);
      if (pts.length > 1) {
        L.polyline(pts, {color: "#fff", weight: 7, opacity: .85, interactive: false}).addTo(layer);
        L.polyline(pts, {color: COL[p.id], weight: 4, opacity: .95}).bindTooltip(`🏍 Part ${p.id}: ${esc(p.title)}`, {sticky: true}).addTo(layer);
      }
      p.stops.forEach((s, i) => {
        if (s.lat == null) return;
        const m = L.circleMarker([s.lat, s.lng], {radius: i === 0 || i === p.stops.length - 1 ? 7 : 5, color: "#fff", weight: 2, fillColor: COL[p.id], fillOpacity: 1})
          .bindTooltip(`<b>${esc(s.n)}</b>${s.note ? "<br>" + esc(s.note) : ""}<br><small>Part ${p.id} · +${s.km} km · ${s.cum} km from ${esc(p.stops[0].n)}</small>`)
          .addTo(layer);
        markers[p.id + ":" + i] = m;
      });
    });
    // the boat across the mouth of the Narmada
    const a = D.parts[0].stops[D.parts[0].stops.length - 1], b = D.parts[1].stops[0];
    if (a.lat != null && b.lat != null)
      L.polyline([[a.lat, a.lng], [b.lat, b.lng]], {color: "#1e88e5", weight: 3, dashArray: "6 8"}).bindTooltip("⛴ Boat: Vimleshwar → Mithitalai (Dussehra to Akshaya Tritiya)", {sticky: true}).addTo(layer);
  }

  function render() {
    if (!box || !D) return;
    const c = D.credit;
    const parts = D.parts.filter(p => !part || p.id === part);
    const placed = D.parts.reduce((n, p) => n + p.stops.filter(s => s.lat != null).length, 0), all = D.parts.reduce((n, p) => n + p.stops.length, 0);
    box.innerHTML = `
      <div class="vcredit">🏍 <b>Bike / four-wheeler route</b> by <b>${esc(c.by)}</b>, ${esc(c.place)}${c.phone ? ` · 📞 ${c.phone.map(n => `<a href="tel:${esc(n)}">${esc(n)}</a>`).join(", ")}` : ""}
        <small>${esc(c.note)}${placed < all ? ` · ${placed} of ${all} stops on the map` : ""}</small></div>
      ${onRide ? `<button class="ridebtn" data-ride>🏍 Start riding the route<small>Turn-by-turn with voice, from the stop nearest to you, then stop after stop</small></button>` : ""}
      <div class="note warn">⛴ ${esc(D.boat)}</div>
      <div class="chiprow" role="group" aria-label="Part">
        <button class="chip2${part === 0 ? " on" : ""}" data-vp="0">All</button>
        ${D.parts.map(p => `<button class="chip2${part === p.id ? " on" : ""}" data-vp="${p.id}"><i class="sw s${p.id}"></i>Part ${p.id} · ${p.bank === "north" ? "North" : "South"}</button>`).join("")}
      </div>
      ${parts.map(p => `<div class="vpart"><h3><i class="sw s${p.id}"></i> Part ${p.id}: ${esc(p.title)}</h3>
        <small class="meta">${p.bank === "north" ? "North" : "South"} bank, going ${esc(p.dir)} · ${p.stops.length} stops · adds up to <b>${p.total_km} km</b>${p.stated_km && p.stated_km !== p.total_km ? ` (the list says ${p.stated_km} km)` : ""}</small>
        ${p.stops.map((s, i) => `<button class="vrow" data-vs="${p.id}:${i}">
          <span class="vnum" style="background:${COL[p.id]}">${i + 1}</span>
          <span class="vname"><b>${esc(s.n)}</b>${s.note ? `<small>${esc(s.note)}</small>` : ""}${s.lat == null ? `<small class="nomap">not on the map yet</small>` : ""}</span>
          <span class="vkm">${i ? "+" + s.km + " km" : "start"}<small>${s.cum} km</small></span></button>`).join("")}
        ${p.id === 1 ? `<div class="note warn">⛴ Cross by boat to Mithitalai (Dussehra to Akshaya Tritiya)</div>` : ""}</div>`).join("")}`;
  }

  function wire() {
    box.addEventListener("click", e => {
      if (e.target.closest("[data-ride]")) return ride();
      const ch = e.target.closest("[data-vp]");
      if (ch) { part = +ch.dataset.vp; render(); fit(); return; }
      const r = e.target.closest("[data-vs]"); if (!r) return;
      const [pid, i] = r.dataset.vs.split(":").map(Number), s = D.parts[pid - 1].stops[i];
      if (s.lat == null) return;
      map.flyTo([s.lat, s.lng], 13); const m = markers[r.dataset.vs]; if (m) setTimeout(() => m.openTooltip(), 900);
      if (onPick) onPick(s);
    });
  }
  /** all placed stops in riding order (part 1 → boat → part 2 → part 3), from the one nearest to me */
  function ride() {
    const seq = [];
    D.parts.forEach(p => p.stops.forEach((s, i) => {
      if (s.lat == null) return;
      const last = p.id === 1 && i === p.stops.length - 1;
      seq.push({label: s.n, lat: s.lat, lng: s.lng, note: [s.note, last ? "Take the boat to Mithitalai – it runs from Dussehra to Akshaya Tritiya" : ""].filter(Boolean).join(". ")});
    }));
    if (!seq.length) return;
    const me = getPos && getPos();
    let k = 0;
    if (me) {
      let bd = Infinity;
      seq.forEach((s, i) => { const d = kmBetween(me, [s.lat, s.lng]); if (d < bd) { bd = d; k = i; } });
      if (bd < 3 && k < seq.length - 1) k++;              // already at that stop: go on to the next
    }
    onRide(seq.slice(k), "");
  }

  function fit() {
    const pts = []; D.parts.forEach(p => { if (!part || p.id === part) p.stops.forEach(s => { if (s.lat != null) pts.push([s.lat, s.lng]); }); });
    if (pts.length) map.fitBounds(pts, {padding: [40, 40]});
  }

  // ---------------------------------------------------------------- finding stops by name
  const kmBetween = (a, b) => { const r = x => x * Math.PI / 180, h = Math.sin(r(b[0] - a[0]) / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(r(b[1] - a[1]) / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); };
  const norm = t => String(t || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  /** where a stop without a position should be: between its placed neighbours, by the km */
  function guessBetween(list, i, cumOf) {
    const c = cumOf(list[i]);
    let a = null, b = null;
    for (let j = i - 1; j >= 0; j--) if (list[j].lat != null && !isNaN(cumOf(list[j]))) { a = list[j]; break; }
    for (let j = i + 1; j < list.length; j++) if (list[j].lat != null && !isNaN(cumOf(list[j]))) { b = list[j]; break; }
    if (!a && !b) return null;
    if (!a || !b || isNaN(c)) { const o = a || b; return {lat: o.lat, lng: o.lng, a, b, spread: 30}; }
    const f = Math.min(1, Math.max(0, (c - cumOf(a)) / Math.max(1, cumOf(b) - cumOf(a))));
    return {lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f, a, b,
            spread: Math.max(8, Math.min(c - cumOf(a), cumOf(b) - c) + 8)};
  }
  /** look a name up on OpenStreetMap (Photon) near a guessed spot; null if nothing fits */
  async function findNear(name, guess, maxKm) {
    const clean = String(name).replace(/\(.*?\)/g, "").trim();
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(clean)}&limit=10&lang=en&lat=${guess.lat}&lon=${guess.lng}` +
      `&bbox=${[guess.lng - 1.2, guess.lat - 1.2, guess.lng + 1.2, guess.lat + 1.2].map(x => x.toFixed(3)).join(",")}`;
    const j = await (await fetch(url)).json();
    let best = null;
    (j.features || []).forEach(f => {
      const [lng, lat] = f.geometry.coordinates, d = kmBetween([lat, lng], [guess.lat, guess.lng]), p = f.properties;
      if (d > maxKm) return;
      if (!best || d < best.d) best = {lat, lng, d, label: p.name || clean, sub: [(p.osm_value || "place").replace(/_/g, " "), p.county || p.district, p.state].filter(Boolean).join(" · ")};
    });
    return best;
  }
  /** find the spot for a stop: its own position, an OpenStreetMap match near the right place, or an approximate spot */
  async function locate(name, list, i, cumOf, online) {
    const s = list[i];
    if (s.lat != null) return {lat: s.lat, lng: s.lng, kind: "exact"};
    const g = guessBetween(list, i, cumOf);
    if (online && g) {
      try { const f = await findNear(name, g, g.spread); if (f) return {lat: f.lat, lng: f.lng, kind: "osm", label: f.label, sub: f.sub}; } catch (e) { /* offline */ }
    }
    if (g) return {lat: g.lat, lng: g.lng, kind: "approx", a: g.a, b: g.b};
    return null;
  }

  window.VRoute = {
    /** bike/car stops whose English or Hindi name (or note) matches the words typed */
    search(q, n) {
      if (!D) return [];
      const t = norm(q).split(/\s+/).filter(Boolean), out = [];
      D.parts.forEach(p => p.stops.forEach((s, i) => {
        const hay = norm(`${s.n} ${s.hi} ${s.note}`);
        if (t.every(w => hay.includes(w))) out.push({key: p.id + ":" + i, s, part: p});
      }));
      return out.slice(0, n || 6);
    },
    /** {label, sub, lat, lng} for a bike/car stop, finding a position if it has none */
    async place(key, online) {
      const [pid, i] = key.split(":").map(Number), p = D.parts[pid - 1], s = p.stops[i];
      const at = await locate(s.n, p.stops, i, o => o.cum, online);
      if (!at) return null;
      const where = `🏍 Bike/car route · Part ${pid} · ${i ? "+" + s.km + " km · " : ""}${s.cum} km from ${p.stops[0].n}${s.note ? " · " + s.note : ""}`;
      const how = at.kind === "osm" ? " · position from OpenStreetMap, please check" : at.kind === "approx" ? (at.a && at.b ? ` · approximate spot between ${at.a.n} and ${at.b.n}` : ` · approximate spot near ${(at.a || at.b).n}`) : "";
      return {label: s.n, sub: where + how, lat: at.lat, lng: at.lng, approx: at.kind !== "exact"};
    },
    locate, guessBetween, findNear,
    init(o) { D = o.data; map = o.map; box = o.box; onPick = o.onPick; onRide = o.onRide; getPos = o.getPos; layer = L.layerGroup(); if (box) wire(); return !!D; },
    show(on) { if (!D) return; if (on) { draw(); layer.addTo(map); render(); fit(); } else layer.remove(); },
    data: () => D,
  };
})();
