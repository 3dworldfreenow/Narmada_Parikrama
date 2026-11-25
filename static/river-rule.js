/* Parikrama rule for directions: never cross the Narmada.
 * The only allowed ways from one bank to the other are round the source (Amarkantak)
 * or across the sea at the mouth by boat (Vimleshwar / Kathpor ↔ Mithi Talai).
 *
 * Needs: window.RIVER = {lines: [[[lat,lng],...], ...]}   (data/narmada_river.json)
 * Shared by the website (static/app.js) and the Android app (mobile.js).
 */
(function (root) {
  "use strict";
  const R = {ready: false};
  let SEGS = [], BUCKETS = new Map(), EAST = 81.6, WEST = 72.6;
  const BW = 0.05;                                     // bucket width in degrees longitude
  const bkey = x => Math.floor(x / BW);
  const kmBetween = (a, b) => { const r = x => x * Math.PI / 180, dp = r(b[0] - a[0]), dl = r(b[1] - a[1]);
    const h = Math.sin(dp / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dl / 2) ** 2; return 2 * 6371 * Math.asin(Math.sqrt(h)); };

  R.init = function (river) {
    if (!river || !river.lines || !river.lines.length) return false;
    SEGS = []; BUCKETS = new Map();
    let minX = 999, maxX = -999;
    river.lines.forEach(l => { for (let i = 0; i < l.length - 1; i++) {
      const a = l[i], b = l[i + 1], s = {a, b, x0: Math.min(a[1], b[1]), x1: Math.max(a[1], b[1]), y0: Math.min(a[0], b[0]), y1: Math.max(a[0], b[0])};
      SEGS.push(s); minX = Math.min(minX, s.x0); maxX = Math.max(maxX, s.x1);
      for (let k = bkey(s.x0); k <= bkey(s.x1); k++) { if (!BUCKETS.has(k)) BUCKETS.set(k, []); BUCKETS.get(k).push(s); }
    } });
    WEST = minX; EAST = maxX - 0.08;                    // the last ~8 km before the source count as "source area"
    R.ready = true; return true;
  };

  // distance (km) from point to the river
  function distToRiver(p) {
    let best = 1e9;
    for (let k = bkey(p[1]) - 2; k <= bkey(p[1]) + 2; k++) (BUCKETS.get(k) || []).forEach(s => {
      const cos = Math.cos(p[0] * Math.PI / 180), ax = s.a[1] * cos, ay = s.a[0], bx = s.b[1] * cos, by = s.b[0], px = p[1] * cos, py = p[0];
      const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / ((dx * dx + dy * dy) || 1e-12)));
      best = Math.min(best, Math.hypot(px - ax - t * dx, py - ay - t * dy) * 111.32);
    });
    return best;
  }

  /** "north" | "south" | "river" (on the water / ghat, can't tell) | "source" (Amarkantak area) | "sea" | "unknown" */
  R.side = function (p) {
    if (!R.ready) return "unknown";
    if (p[1] >= EAST) return "source";
    if (p[1] <= WEST + 0.02) return "sea";
    if (distToRiver(p) < 0.3) return "river";
    let n = 0;                                          // count river lines crossed going due north
    (BUCKETS.get(bkey(p[1])) || []).forEach(s => {
      if ((s.a[1] <= p[1]) !== (s.b[1] <= p[1])) {
        const y = s.a[0] + (p[1] - s.a[1]) * (s.b[0] - s.a[0]) / (s.b[1] - s.a[1]);
        if (y > p[0]) n++;
      }
    });
    return n % 2 === 0 ? "north" : "south";
  };

  function segX(p1, p2, q1, q2) {                    // intersection point of two segments, or null
    const d = (p2[1] - p1[1]) * (q2[0] - q1[0]) - (p2[0] - p1[0]) * (q2[1] - q1[1]);
    if (Math.abs(d) < 1e-14) return null;
    const t = ((q1[1] - p1[1]) * (q2[0] - q1[0]) - (q1[0] - p1[0]) * (q2[1] - q1[1])) / d;
    const u = ((q1[1] - p1[1]) * (p2[0] - p1[0]) - (q1[0] - p1[0]) * (p2[1] - p1[1])) / d;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])] : null;
  }

  /** Where a route (list of [lat,lng]) crosses the river (ignores the source area). */
  R.crossings = function (coords) {
    if (!R.ready) return [];
    const out = [];
    for (let i = 0; i < coords.length - 1; i++) {
      const p1 = coords[i], p2 = coords[i + 1];
      const x0 = Math.min(p1[1], p2[1]), x1 = Math.max(p1[1], p2[1]), y0 = Math.min(p1[0], p2[0]), y1 = Math.max(p1[0], p2[0]);
      if (x1 >= EAST) continue;
      const seen = new Set();
      for (let k = bkey(x0); k <= bkey(x1); k++) (BUCKETS.get(k) || []).forEach(s => {
        if (seen.has(s) || s.x1 < x0 || s.x0 > x1 || s.y1 < y0 || s.y0 > y1) return;
        seen.add(s);
        const x = segX(p1, p2, s.a, s.b);
        if (x && !out.some(o => kmBetween(o, x) < 0.5)) out.push(x);
      });
    }
    return out;
  };

  /**
   * How far (km) the route runs on the wrong bank. `allowed(i, km)` returns the bank the route
   * should be on at that point. Ghats at the start/end (first/last 2 km) and points on the
   * water itself (islands, side channels) are ignored. Returns {offKm, marks:[[lat,lng]...]}.
   */
  R.offBank = function (coords, allowed) {
    if (!R.ready || coords.length < 2) return {offKm: 0, marks: []};
    let total = 0;
    const cum = [0];
    for (let i = 1; i < coords.length; i++) { total += kmBetween(coords[i - 1], coords[i]); cum.push(total); }
    let off = 0, lastSampleKm = -1, inRun = false, runStart = null;
    const marks = [];
    for (let i = 0; i < coords.length; i++) {
      const d = cum[i];
      if (d < 5 || total - d < 5 || d - lastSampleKm < 0.4) continue;   // ghats at either end are on the water
      const step = lastSampleKm < 0 ? 0.4 : d - lastSampleKm;
      lastSampleKm = d;
      const want = allowed(i, d), here = R.side(coords[i]);
      const wrong = (here === "north" || here === "south") && (want === "north" || want === "south") && here !== want;
      if (wrong) { off += step; if (!inRun) { inRun = true; runStart = coords[i]; } }
      else if (inRun) { inRun = false; if (marks.length < 8) marks.push(runStart); }
    }
    if (inRun && marks.length < 8) marks.push(runStart);
    return {offKm: off, marks};
  };
  const legalOn = (r, bank) => R.offBank(r.coords, () => bank).offKm < 2.0;

  /**
   * The parikrama path along one bank: the guide's stops in order from the stop nearest
   * `a` to the stop nearest `b` (or to the chain's end with toEnd = "first" | "last").
   * Roads along the bank are often missing from the map, but the stops are where pilgrims walk.
   */
  function nearestIdx(chain, p) {
    return chain.reduce((bi, o, i) => kmBetween(p, [o.lat, o.lng]) < kmBetween(p, [chain[bi].lat, chain[bi].lng]) ? i : bi, 0);
  }
  R.bankPath = function (chain, a, b, toEnd) {
    if (!chain || !chain.length) return null;
    const i = nearestIdx(chain, a);
    const j = toEnd === "first" ? 0 : toEnd === "last" ? chain.length - 1 : nearestIdx(chain, b);
    const step = i <= j ? 1 : -1, stops = [];
    for (let k = i; step > 0 ? k <= j : k >= j; k += step) stops.push(chain[k]);
    const coords = [a].concat(stops.map(o => [o.lat, o.lng]));
    if (!toEnd) coords.push(b);
    // distance: the guide's own km between consecutive stops of the same stage, else ~20% over straight
    let kmSum = kmBetween(a, [stops[0].lat, stops[0].lng]) * 1.2;
    for (let k = 1; k < stops.length; k++) {
      const p = stops[k - 1], q = stops[k], cp = parseFloat(p.cum), cq = parseFloat(q.cum);
      kmSum += p.st === q.st && !isNaN(cp) && !isNaN(cq) ? Math.abs(cq - cp) : kmBetween([p.lat, p.lng], [q.lat, q.lng]) * 1.2;
    }
    if (!toEnd) kmSum += kmBetween([stops[stops.length - 1].lat, stops[stops.length - 1].lng], b) * 1.2;
    return {coords, stops, km: kmSum};
  };

  /** Parikrama stops on each bank, ordered from the sea (west) to the source (east). */
  R.bankChains = function (stops) {
    const on = (st, bank) => stops.filter(o => o.st === st && o.lat != null && [bank, "river", "source", "sea"].includes(R.side([o.lat, o.lng])));
    const north = on(2, "north");                               // stage 2: Mithi Talai → Amarkantak
    const south = on(1, "south").reverse().concat(on(3, "south").reverse());   // Kathpor → Omkareshwar → Amarkantak
    return {north, south};
  };

  // pick up to n evenly spaced stops of `chain` between the stops nearest to a and to b
  function viaAlong(chain, a, b, n) {
    if (!chain.length) return [];
    const near = p => chain.reduce((bi, o, i) => kmBetween(p, [o.lat, o.lng]) < kmBetween(p, [chain[bi].lat, chain[bi].lng]) ? i : bi, 0);
    let i = near(a), j = near(b);
    const step = i <= j ? 1 : -1, picked = [];
    const len = Math.abs(j - i) + 1, every = Math.max(1, Math.ceil(len / n));
    for (let k = i, c = 0; step > 0 ? k <= j : k >= j; k += step, c++) if (c % every === 0 || k === j) picked.push([chain[k].lat, chain[k].lng]);
    return picked;
  }

  async function osrm(router, pts, alternatives) {
    const url = router + pts.map(p => `${p[1].toFixed(6)},${p[0].toFixed(6)}`).join(";") +
      `?overview=full&geometries=geojson&steps=true${alternatives ? "&alternatives=true" : ""}`;
    const j = await (await fetch(url)).json();
    if (j.code !== "Ok" || !j.routes || !j.routes.length) throw new Error(j.message || "no route");
    return j.routes.map(r => ({coords: r.geometry.coordinates.map(c => [c[1], c[0]]), geometry: r.geometry,
      distance: r.distance, duration: r.duration, steps: r.legs.flatMap(l => l.steps)}));
  }

  /**
   * Plan a route that obeys the rule.
   * returns {status, routes, crossings, sideA, sideB, note}
   *   status: "free" (rule off) | "ok" (no crossing) | "kept" (forced along the bank) |
   *           "crosses" (no legal road found – shown with warning) | "opposite" (other bank – choose a way round)
   */
  R.plan = async function ({a, b, router, rule, stops}) {
    if (!rule || !R.ready) {
      const routes = await osrm(router, [a, b], true);
      const sa = R.ready ? R.side(a) : "unknown";
      const marks = R.ready && (sa === "north" || sa === "south") ? R.offBank(routes[0].coords, () => sa).marks : [];
      return {status: "free", routes, crossings: marks};
    }
    const sideA = R.side(a), sideB = R.side(b);
    const banks = ["north", "south"];
    if (banks.includes(sideA) && banks.includes(sideB) && sideA !== sideB) {
      return {status: "opposite", routes: [], crossings: [], sideA, sideB};
    }
    const routes = await osrm(router, [a, b], true);
    const bank = banks.includes(sideA) ? sideA : (banks.includes(sideB) ? sideB : null);
    if (!bank) {   // both ends on the water / at the source: we can't tell a bank, so just avoid crossing the river line
      const clean = routes.filter(r => R.crossings(r.coords).length === 0);
      const use = clean.length ? clean : routes;
      return {status: clean.length ? "ok" : "crosses", routes: use, crossings: clean.length ? [] : R.crossings(use[0].coords), sideA, sideB};
    }
    const legal = routes.filter(r => legalOn(r, bank));
    if (legal.length) return {status: "ok", routes: legal.concat(routes.filter(r => !legal.includes(r))).slice(0, 3), legalCount: legal.length, crossings: [], sideA, sideB, bank};
    // every road route goes over to the other bank: force it along this bank through the parikrama stops
    const chain = R.bankChains(stops)[bank];
    for (const n of [18, 30]) {
      const via = viaAlong(chain, a, b, n);
      if (!via.length) break;
      try {
        const kept = await osrm(router, [a, ...via, b], false);
        if (legalOn(kept[0], bank)) return {status: "kept", routes: kept, crossings: [], sideA, sideB, bank, via: via.length};
      } catch (e) { break; }
    }
    return {status: "crosses", routes, crossings: R.offBank(routes[0].coords, () => bank).marks, sideA, sideB, bank,
            bankPath: R.bankPath(chain, a, b)};
  };

  /** Way round to the other bank: which = "source" (via Amarkantak) or "sea" (boat at the mouth). */
  R.planAround = async function ({a, b, router, stops, which}) {
    const sideA = R.side(a), sideB = R.side(b);
    const chains = R.bankChains(stops), A = chains[sideA], B = chains[sideB];
    if (!A || !B || !A.length || !B.length) throw new Error("bank stops missing");
    if (which === "source") {
      const endA = A[A.length - 1], endB = B[B.length - 1];
      const via = viaAlong(A, a, [endA.lat, endA.lng], 11).concat(viaAlong(B, [endB.lat, endB.lng], b, 11));
      const r = await osrm(router, [a, ...via, b], false);
      // bank A until the point nearest the source, bank B after it
      const src = [endA.lat, endA.lng];
      let turn = 0, best = 1e9;
      r[0].coords.forEach((c, i) => { const d = kmBetween(c, src); if (d < best) { best = d; turn = i; } });
      const chk = R.offBank(r[0].coords, i => (i <= turn ? sideA : sideB));
      const p1 = R.bankPath(A, a, null, "last"), p2 = R.bankPath(B, b, null, "last");
      const bankPath = p1 && p2 ? {coords: p1.coords.concat(p2.coords.slice().reverse()), stops: p1.stops.concat(p2.stops.slice().reverse()), km: p1.km + p2.km} : null;
      return {status: "around", which, routes: r, boat: null, crossings: chk.offKm >= 2 ? chk.marks : [], sideA, sideB, bankPath};
    }
    // sea: road to this bank's coast, boat across the gulf, road on from the other coast
    const coastA = [A[0].lat, A[0].lng], coastB = [B[0].lat, B[0].lng];
    const leg1 = (await osrm(router, [a, ...viaAlong(A, a, coastA, 11), coastA], false))[0];
    const leg2 = (await osrm(router, [coastB, ...viaAlong(B, coastB, b, 11), b], false))[0];
    const joined = {coords: leg1.coords.concat(leg2.coords), distance: leg1.distance + leg2.distance,
      duration: leg1.duration + leg2.duration, steps: leg1.steps.concat(leg2.steps), legs: [leg1, leg2]};
    const c1 = R.offBank(leg1.coords, () => sideA), c2 = R.offBank(leg2.coords, () => sideB);
    const marks = (c1.offKm >= 2 ? c1.marks : []).concat(c2.offKm >= 2 ? c2.marks : []);
    const q1 = R.bankPath(A, a, null, "first"), q2 = R.bankPath(B, b, null, "first");
    const bankPath = q1 && q2 ? {coords: q1.coords, coords2: q2.coords.slice().reverse(), stops: q1.stops.concat(q2.stops.slice().reverse()), km: q1.km + q2.km} : null;
    return {status: "around", which, routes: [joined], boat: [coastA, coastB], boatKm: kmBetween(coastA, coastB),
      coastA: A[0].v, coastB: B[0].v, crossings: marks, sideA, sideB, bankPath};
  };

  R.kmBetween = kmBetween;
  root.RiverRule = R;
})(window);
