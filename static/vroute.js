/* Bike / four-wheeler parikrama route (Acharya Shri Anildas Yogiraj) – shared by the website and the app.
 * VRoute.init({data, map, box, onPick}) ; VRoute.show(true|false)
 */
(function () {
  "use strict";
  const COL = {1: "#0f6e77", 2: "#c8641e", 3: "#7a4fb0"};
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c]);
  let D = null, map = null, box = null, onPick = null, layer = null, part = 0, drawn = false;
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
      const ch = e.target.closest("[data-vp]");
      if (ch) { part = +ch.dataset.vp; render(); fit(); return; }
      const r = e.target.closest("[data-vs]"); if (!r) return;
      const [pid, i] = r.dataset.vs.split(":").map(Number), s = D.parts[pid - 1].stops[i];
      if (s.lat == null) return;
      map.flyTo([s.lat, s.lng], 13); const m = markers[r.dataset.vs]; if (m) setTimeout(() => m.openTooltip(), 900);
      if (onPick) onPick(s);
    });
  }
  function fit() {
    const pts = []; D.parts.forEach(p => { if (!part || p.id === part) p.stops.forEach(s => { if (s.lat != null) pts.push([s.lat, s.lng]); }); });
    if (pts.length) map.fitBounds(pts, {padding: [40, 40]});
  }

  window.VRoute = {
    init(o) { D = o.data; map = o.map; box = o.box; onPick = o.onPick; layer = L.layerGroup(); if (box) wire(); return !!D; },
    show(on) { if (!D) return; if (on) { draw(); layer.addTo(map); render(); fit(); } else layer.remove(); },
    data: () => D,
  };
})();
