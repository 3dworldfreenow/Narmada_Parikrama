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
      return {status: "free", routes, crossings: R.ready ? R.crossings(routes[0].coords) : []};
    }
    const sideA = R.side(a), sideB = R.side(b);
    const banks = ["north", "south"];
    if (banks.includes(sideA) && banks.includes(sideB) && sideA !== sideB) {
      return {status: "opposite", routes: [], crossings: [], sideA, sideB};
    }
    const routes = await osrm(router, [a, b], true);
    const legal = routes.filter(r => R.crossings(r.coords).length === 0);
    if (legal.length) return {status: "ok", routes: legal.concat(routes.filter(r => !legal.includes(r))).slice(0, 3), legalCount: legal.length, crossings: [], sideA, sideB};
    // every road route crosses: force it along this bank through the parikrama stops
    const bank = banks.includes(sideA) ? sideA : sideB;
    if (banks.includes(bank)) {
      const chain = R.bankChains(stops)[bank];
      const via = viaAlong(chain, a, b, 18);
      if (via.length) {
        try {
          const kept = await osrm(router, [a, ...via, b], false);
          const cx = R.crossings(kept[0].coords);
          if (!cx.length) return {status: "kept", routes: kept, crossings: [], sideA, sideB, bank, via: via.length};
        } catch (e) { /* fall through */ }
      }
    }
    return {status: "crosses", routes, crossings: R.crossings(routes[0].coords), sideA, sideB};
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
      return {status: "around", which, routes: r, boat: null, crossings: R.crossings(r[0].coords), sideA, sideB};
    }
    // sea: road to this bank's coast, boat across the gulf, road on from the other coast
    const coastA = [A[0].lat, A[0].lng], coastB = [B[0].lat, B[0].lng];
    const leg1 = (await osrm(router, [a, ...viaAlong(A, a, coastA, 11), coastA], false))[0];
    const leg2 = (await osrm(router, [coastB, ...viaAlong(B, coastB, b, 11), b], false))[0];
    const joined = {coords: leg1.coords.concat(leg2.coords), distance: leg1.distance + leg2.distance,
      duration: leg1.duration + leg2.duration, steps: leg1.steps.concat(leg2.steps), legs: [leg1, leg2]};
    return {status: "around", which, routes: [joined], boat: [coastA, coastB], boatKm: kmBetween(coastA, coastB),
      coastA: A[0].v, coastB: B[0].v, crossings: [], sideA, sideB};
  };

  R.kmBetween = kmBetween;
  root.RiverRule = R;
})(window);
