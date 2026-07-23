// Road profile math: arc-length resampling, bridge/tunnel deck elevations,
// DEM-artifact despiking, optional smoothing, sustained-window grades,
// hardest-climb extraction, and long-incline masking. Conventions: grades are
// fractions (0.08 = 8 %), distances are meters, and elevations are corrected
// (deck-interpolated, then despiked) before any metric runs.
// Length thresholds snap to the nearest whole ~SAMPLE_STEP segment.

export const SAMPLE_STEP = 25;      // m between elevation samples along a road

export function haversine(a, b) {
    const R = 6371000, toR = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
    const la1 = a.lat * toR, la2 = b.lat * toR;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

// Polyline -> evenly spaced samples [{lat, lon, d}] (~step m apart, endpoints
// included). Even spacing keeps the elevation smoothing well-behaved and never
// drops the rise across short OSM segments. A sample inside a bridge/tunnel
// segment (both endpoints flagged b) inherits the flag, so its DEM elevation
// can be replaced later.
export function resample(pts, step = SAMPLE_STEP) {
    const cum = [0];
    for (let i = 1; i < pts.length; i++)
        cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]));
    const total = cum[cum.length - 1];
    if (total === 0)
        return [{ ...pts[0], d: 0 }];
    const bridgeSeg = s => !!(pts[s].b && pts[s + 1].b);
    const nSeg = Math.max(1, Math.round(total / step));
    const actual = total / nSeg;
    const out = [{ lat: pts[0].lat, lon: pts[0].lon, d: 0, ...(bridgeSeg(0) && { b: true }) }];
    let seg = 1;
    for (let k = 1; k <= nSeg; k++) {
        const target = k * actual;
        while (seg < cum.length - 1 && cum[seg] < target)
            seg++;
        const span = cum[seg] - cum[seg - 1];
        const f = span > 0 ? (target - cum[seg - 1]) / span : 0;
        out.push({
            lat: pts[seg - 1].lat + (pts[seg].lat - pts[seg - 1].lat) * f,
            lon: pts[seg - 1].lon + (pts[seg].lon - pts[seg - 1].lon) * f,
            d: target,
            ...(bridgeSeg(seg - 1) && { b: true }),
        });
    }
    return out;
}

// Bridge/tunnel samples carry the terrain's elevation (the gorge under the
// span, the hill over the bore), not the roadway's. Replace each flagged run
// with a straight-line deck between the solid ground on either side.
function deckElevations(samples, elevs) {
    const n = samples.length;
    const out = Array.from(elevs);
    let i = 0;
    while (i < n) {
        if (!samples[i].b) {
            i++;
            continue;
        }
        let z = i;
        while (z + 1 < n && samples[z + 1].b)
            z++;
        const a = i - 1, w = z + 1;
        if (a >= 0 && w < n) {
            const d0 = samples[a].d, span = samples[w].d - d0;
            for (let k = i; k <= z; k++) {
                const f = span > 0 ? (samples[k].d - d0) / span : 0;
                out[k] = elevs[a] + (elevs[w] - elevs[a]) * f;
            }
        }
        else if (a >= 0) {
            // bridge at road end
            for (let k = i; k <= z; k++)
                out[k] = elevs[a];
        }
        else if (w < n) {
            // bridge at road start
            for (let k = i; k <= z; k++)
                out[k] = elevs[w];
        }
        else {
            // The whole chain is a bridge (a named bridge is often its own
            // OSM way, hence its own chain). Anchor the deck on its own
            // endpoints — the abutments, where the DEM meets road level — so
            // the valley underneath doesn't read as a climb.
            const d0 = samples[i].d, span = samples[z].d - d0;
            for (let k = i; k <= z; k++) {
                const f = span > 0 ? (samples[k].d - d0) / span : 0;
                out[k] = elevs[i] + (elevs[z] - elevs[i]) * f;
            }
        }
        i = z + 1;
    }
    return out;
}

// A drivable road never exceeds ~37% (Ffordd Pen Llech, briefly the world's
// steepest street); a steeper "segment" is a DEM artifact — most often a seam
// between source datasets that a road weaves across, reading tens of metres too
// high or low on one side. Any segment beyond this is impossible, i.e. bad data.
const MAX_GRADE_PLAUSIBLE = 0.60;
// Farthest such an artifact excursion is bridged across (a road can dip into and
// back out of a bad-data strip over a short span); longer runs fall back to a
// per-edge cap.
const MAX_EXCURSION_M = 250;

// Repair impossible (> MAX_GRADE_PLAUSIBLE) elevation jumps left by DEM errors.
// A dataset seam a road crosses shows up as a spike or trench bounded by two
// impossible jumps that returns to the surrounding level: the road can't really
// jump there, so the consistent ground on both sides is the truth and the short
// excursion between is bad data — interpolate straight across it, exactly as a
// bridge deck spans a gorge. A lone jump with no matching return (a one-sided
// step, where which side is wrong is genuinely ambiguous) is instead capped at
// the plausible max, shifting the rest so the road's shape past it is kept.
function despike(elevs, samples) {
    const n = samples.length;
    const out = Array.from(elevs);
    const grade = i => Math.abs(out[i + 1] - out[i]) / (samples[i + 1].d - samples[i].d);
    let i = 0;
    while (i < n - 1) {
        if (grade(i) <= MAX_GRADE_PLAUSIBLE) {
            i++;
            continue;
        }
        // Impossible jump between samples i and i+1: look for the return jump
        // that closes a short excursion back to a level consistent with sample i.
        let j = i + 1;
        while (j < n - 1 && samples[j + 1].d - samples[i].d <= MAX_EXCURSION_M && grade(j) <= MAX_GRADE_PLAUSIBLE)
            j++;
        const span = samples[Math.min(j + 1, n - 1)].d - samples[i].d;
        const closes = j < n - 1 && grade(j) > MAX_GRADE_PLAUSIBLE && span <= MAX_EXCURSION_M
            && Math.abs(out[j + 1] - out[i]) <= MAX_GRADE_PLAUSIBLE * span;
        if (closes) {
            const d0 = samples[i].d;
            for (let k = i + 1; k <= j; k++)
                out[k] = out[i] + (out[j + 1] - out[i]) * (samples[k].d - d0) / span;
            i = j + 1;
        }
        else {
            const dist = samples[i + 1].d - samples[i].d;
            const shift = out[i] + Math.sign(out[i + 1] - out[i]) * MAX_GRADE_PLAUSIBLE * dist - out[i + 1];
            for (let k = i + 1; k < n; k++)
                out[k] += shift;
            i++;
        }
    }
    return out;
}

// Optional 3-point moving average to tame elevation-model jitter. Disabled for
// now (passes the profile through unchanged) so short, extreme pitches aren't
// flattened — the bilinear DEM sampling already smooths somewhat. Re-enable the
// averaging below if the raw data proves too noisy.
function smooth(elevs) {
    return elevs;
    // return elevs.map((e, i) => {
    //     const a = elevs[Math.max(0, i - 1)], c = elevs[Math.min(elevs.length - 1, i + 1)];
    //     return (a + e + c) / 3;
    // });
}

// samples + raw elevations -> per-road basics, keeping the corrected elevation
// profile so sustainedGrade() can be re-queried cheaply for any window length.
export function analyzeRoad(samples, elevs) {
    const elev = smooth(despike(deckElevations(samples, elevs), samples));
    let eMin = Infinity, eMax = -Infinity;
    for (const v of elev) {
        eMin = Math.min(eMin, v);
        eMax = Math.max(eMax, v);
    }
    return { elev, length: samples[samples.length - 1].d, eMin, eMax };
}

// Per-segment sustained grades: for each ~SAMPLE_STEP segment, the grade of
// the steepest ~windowM window that contains it. Length thresholds snap to
// the nearest whole segment (accept within half a sample step): a road whose
// spacing divides to 24.9 m gets a 249 m "250 m" window instead of being
// forced to 274 m, so effective windows stay symmetric around the nominal
// across roads. Returns a Float64Array of samples.length - 1 values, or null
// when the road is shorter than the window (the metric is undefined there).
// windowM = SAMPLE_STEP degenerates to per-segment grades.
export function segmentSustained(samples, elev, windowM) {
    const n = samples.length;
    const bound = windowM - SAMPLE_STEP / 2;
    if (n < 2 || samples[n - 1].d < bound)
        return null;
    const vals = new Float64Array(n - 1);
    let j = 0;
    for (let i = 0; i < n - 1; i++) {
        if (j <= i)
            j = i + 1;
        while (j < n - 1 && samples[j].d - samples[i].d < bound)
            j++;
        const span = samples[j].d - samples[i].d;
        if (span < bound)
            break; // remaining starts only get shorter windows
        const g = Math.abs(elev[j] - elev[i]) / span;
        for (let k = i; k < j; k++)
            if (g > vals[k])
                vals[k] = g;
    }
    return vals;
}

// Best average grade held over any stretch of at least windowM meters — the
// road's ranking value, i.e. the max of its per-segment values.
export function sustainedGrade(samples, elev, windowM) {
    const segs = segmentSustained(samples, elev, windowM);
    return segs ? segs.reduce((m, v) => Math.max(m, v), 0) : null;
}

// Where the sustained-mode ranking value comes from: the single >= windowM
// window of highest average grade, as sample endpoints { i, j, grade, span }
// (or null when the road is shorter than the window). Same minimal-window-per-
// start scan as segmentSustained, so best.grade equals sustainedGrade.
export function bestSustainedWindow(samples, elev, windowM) {
    const n = samples.length;
    const bound = windowM - SAMPLE_STEP / 2;
    if (n < 2 || samples[n - 1].d < bound)
        return null;
    let best = null;
    let j = 0;
    for (let i = 0; i < n - 1; i++) {
        if (j <= i)
            j = i + 1;
        while (j < n - 1 && samples[j].d - samples[i].d < bound)
            j++;
        const span = samples[j].d - samples[i].d;
        if (span < bound)
            break;
        const g = Math.abs(elev[j] - elev[i]) / span;
        if (!best || g > best.grade)
            best = { i, j, grade: g, span };
    }
    return best;
}

// Within one warm run, a second stretch is distinct only when the window
// grade between the peaks dips below this fraction of the weaker peak — a
// uniformly steep hill (no dip) stays ONE stretch, a hill-dip-hill run splits.
// Exported because the map uses the same fraction to extend a ranked
// stretch's red into its shoulders (see app.js): what isn't distinct enough
// to rank separately shouldn't read as a separate (violet) section either.
export const STRETCH_COL_FRAC = 0.8;

// A road's distinct ranked stretches. The road splits at "cold" segments
// (sustained value below minGrade — exactly where the map coloring goes
// silent) into warm runs; any window averaging >= minGrade lies wholly inside
// one warm run (every segment it covers inherits at least its grade). Within
// a run, candidate windows are taken steepest-first, and a later window
// counts as a separate stretch only if it doesn't overlap a chosen one and
// the col between them clears the STRETCH_COL_FRAC prominence test above.
// Falls back to the single best window when nothing clears minGrade, so
// gentle towns still rank their best roads. Steepest first, capped at
// maxCount (like the road's climbs).
export function sustainedStretches(samples, elev, windowM, minGrade, maxCount = 3) {
    const segs = segmentSustained(samples, elev, windowM);
    if (!segs)
        return [];
    const bound = windowM - SAMPLE_STEP / 2;
    // All minimal windows using only samples a..b, steepest first.
    const windowsWithin = (a, b) => {
        const cands = [];
        let j = a;
        for (let i = a; i < b; i++) {
            if (j <= i)
                j = i + 1;
            while (j < b && samples[j].d - samples[i].d < bound)
                j++;
            const span = samples[j].d - samples[i].d;
            if (span < bound)
                break;
            cands.push({ i, j, grade: Math.abs(elev[j] - elev[i]) / span, span });
        }
        return cands.sort((x, y) => y.grade - x.grade);
    };
    // Greedy prominence pick within one warm run (samples a..b).
    const pickRun = (a, b, out) => {
        const chosen = [];
        for (const w of windowsWithin(a, b)) {
            if (chosen.length >= maxCount)
                break;
            const distinct = chosen.every(c => {
                if (w.i < c.j && c.i < w.j)
                    return false; // overlaps a chosen stretch
                const [L, R] = w.j <= c.i ? [w, c] : [c, w];
                let col = Infinity;
                for (let k = L.j; k < R.i; k++)
                    col = Math.min(col, segs[k]);
                return col <= STRETCH_COL_FRAC * Math.min(w.grade, c.grade);
            });
            if (distinct)
                chosen.push(w);
        }
        out.push(...chosen);
    };
    const out = [];
    let a = -1;
    for (let k = 0; k <= segs.length; k++) {
        const warm = k < segs.length && segs[k] >= minGrade;
        if (warm && a < 0) {
            a = k;
        }
        else if (!warm && a >= 0) {
            pickRun(a, k, out);
            a = -1;
        }
    }
    if (!out.length) {
        const best = windowsWithin(0, samples.length - 1)[0];
        return best ? [best] : [];
    }
    out.sort((x, y) => y.grade - x.grade);
    return out.slice(0, maxCount);
}

const DIP_ABS = 2;       // m of counter-slope always forgiven (DEM noise)
const DIP_FRAC = 0.10;   // ... or up to this fraction of the total ascent
export const GRIND_MIN_GRADE = 0.025; // a long incline counts from this average grade

// Cumulative ascent/descent prefixes, for testing whether an interval is
// "mostly monotonic" as traveled (shared by climbs and long inclines).
function ascentPrefixes(elev) {
    const n = elev.length;
    const up = new Float64Array(n), down = new Float64Array(n);
    for (let k = 1; k < n; k++) {
        const de = elev[k] - elev[k - 1];
        up[k] = up[k - 1] + Math.max(0, de);
        down[k] = down[k - 1] + Math.max(0, -de);
    }
    return { up, down };
}

// Interior counter-slope beyond the tolerance disqualifies an interval.
const dipTooBig = (gain, counter) => counter > Math.max(DIP_ABS, DIP_FRAC * (gain + counter));

// "Grind" mask: segments belonging to any long (>= minSpan), mostly monotonic
// (same counter-slope tolerance as climbs), >= GRIND_MIN_GRADE average stretch
// in either direction. Too gentle to color as steep, too substantial to leave
// invisible. Returns a Uint8Array over segments, or null when nothing
// qualifies.
export function grindMask(samples, elev, minSpan) {
    const n = samples.length;
    // Snap to the nearest whole segment, like segmentSustained.
    const bound = minSpan - SAMPLE_STEP / 2;
    if (n < 2 || samples[n - 1].d < bound)
        return null;
    const { up, down } = ascentPrefixes(elev);
    const diff = new Int32Array(n + 1);
    let any = false;
    for (let i = 0; i < n - 1; i++) {
        for (let j = i + 1; j < n; j++) {
            const span = samples[j].d - samples[i].d;
            if (span < bound)
                continue;
            const net = elev[j] - elev[i];
            const gain = Math.abs(net);
            if (gain / span < GRIND_MIN_GRADE)
                continue;
            const counter = net > 0 ? down[j] - down[i] : up[j] - up[i];
            if (dipTooBig(gain, counter))
                continue;
            diff[i]++;
            diff[j]--;
            any = true;
        }
    }
    if (!any)
        return null;
    const mask = new Uint8Array(n - 1);
    let cover = 0;
    for (let k = 0; k < n - 1; k++) {
        cover += diff[k];
        if (cover > 0)
            mask[k] = 1;
    }
    // Interval membership alone would (a) mark a dead-flat tail whose interval
    // qualifies via an attached hill, and (b) merge opposite-direction inclines
    // that meet at a valley or summit into one incoherent run (a V at a creek
    // would report ~0 %). Refine each contiguous run: trim ends back to where
    // the ground actually inclines, drop leftovers shorter than the span, and
    // split runs that aren't a single mostly-monotonic incline at their
    // deepest reversal, recursing on the halves.
    const localOk = k => Math.abs(elev[k + 1] - elev[k]) / (samples[k + 1].d - samples[k].d) >= GRIND_MIN_GRADE / 2;
    const clear = (a, b) => {
        for (let k = a; k <= b; k++)
            mask[k] = 0;
    };
    const refine = (a, b) => {
        while (a <= b && !localOk(a))
            mask[a++] = 0;
        while (b >= a && !localOk(b))
            mask[b--] = 0;
        if (a > b)
            return;
        const span = samples[b + 1].d - samples[a].d;
        if (span < bound) {
            clear(a, b);
            return;
        }
        const net = elev[b + 1] - elev[a];
        const gain = Math.abs(net);
        const counter = net > 0 ? down[b + 1] - down[a] : up[b + 1] - up[a];
        if (gain / span >= GRIND_MIN_GRADE && !dipTooBig(gain, counter))
            return; // a single coherent incline
        // Deepest reversal: bottom of the largest drawdown or top of the
        // largest run-up, whichever is bigger (interior samples only).
        let maxE = elev[a], minE = elev[a];
        let bestDrop = 0, dropK = -1, bestRise = 0, riseK = -1;
        for (let k = a + 1; k <= b + 1; k++) {
            const e = elev[k];
            maxE = Math.max(maxE, e);
            minE = Math.min(minE, e);
            if (k <= b) {
                if (maxE - e > bestDrop) {
                    bestDrop = maxE - e;
                    dropK = k;
                }
                if (e - minE > bestRise) {
                    bestRise = e - minE;
                    riseK = k;
                }
            }
        }
        const m = bestDrop >= bestRise ? dropK : riseK;
        if (m < 0) {
            clear(a, b);
            return;
        }
        mask[m - 1] = 0;
        refine(a, m - 2);
        refine(m, b);
    };
    let a = -1;
    for (let k = 0; k <= n - 1; k++) {
        const on = k < n - 1 && mask[k];
        if (on && a < 0) {
            a = k;
        }
        else if (!on && a >= 0) {
            refine(a, k - 1);
            a = -1;
        }
    }
    return mask.some(v => v) ? mask : null;
}

// Every qualifying long-incline (grind) run on the profile — sample endpoints
// and stats {i, j, span, gain, grade}, longest first — using the same rule
// (and minSpan) as the amber underlay. The mask already separates opposite-
// direction inclines meeting at a summit or valley, so a road climbing over a
// hill (or out of a creek both ways) reports each side as its own incline.
export function longestInclines(samples, elev, minSpan) {
    const mask = grindMask(samples, elev, minSpan);
    if (!mask)
        return [];
    const runs = [];
    let a = -1;
    for (let k = 0; k <= mask.length; k++) {
        const on = k < mask.length && mask[k];
        if (on && a < 0) {
            a = k;
        }
        else if (!on && a >= 0) {
            const span = samples[k].d - samples[a].d;
            const gain = Math.abs(elev[k] - elev[a]);
            runs.push({ i: a, j: k, span, gain, grade: gain / span });
            a = -1;
        }
    }
    return runs.sort((x, y) => y.span - x.span);
}

// The single longest run — the ranking value for "Longest inclines".
export function longestIncline(samples, elev, minSpan) {
    return longestInclines(samples, elev, minSpan)[0] ?? null;
}

// --- Multi-road long inclines -------------------------------------------
// A long incline can continue across a junction onto a differently-named road
// (Burrell Mountain Rd -> Whitmire St). Build a junction graph from coincident
// sample points, then do a bounded search over chained road slices (up to
// maxRoads roads), running the same grind rule over each chain's combined
// profile so an incline can span, and be reported across, several roads.

const JOIN_TOL = 20; // m — roads connect where their sample points fall within this

// For each road end, the (road, sampleIndex) points on OTHER roads that coincide
// with it — roads meeting end-to-end or end-to-interior (a T-junction). A cheap
// equirectangular meter grid keeps the lookup local.
function endpointJunctions(roads) {
    const lat0 = roads[0]?.samples[0]?.lat ?? 0;
    const mLat = 111320, mLon = 111320 * Math.cos(lat0 * Math.PI / 180);
    const X = p => p.lon * mLon, Y = p => p.lat * mLat;
    const gkey = (x, y) => `${Math.round(x / JOIN_TOL)},${Math.round(y / JOIN_TOL)}`;
    const grid = new Map();
    for (const r of roads)
        for (let k = 0; k < r.samples.length; k++) {
            const p = r.samples[k], key = gkey(X(p), Y(p));
            let cell = grid.get(key);
            if (!cell)
                grid.set(key, cell = []);
            cell.push({ r, k, x: X(p), y: Y(p) });
        }
    const conns = new Map();
    for (const r of roads) {
        const ends = [0, r.samples.length - 1].map(end => {
            const p = r.samples[end], px = X(p), py = Y(p);
            const nearest = new Map(); // other road -> nearest {r, k, d}
            for (let dx = -1; dx <= 1; dx++)
                for (let dy = -1; dy <= 1; dy++)
                    for (const q of grid.get(gkey(px + dx * JOIN_TOL, py + dy * JOIN_TOL)) ?? []) {
                        if (q.r === r)
                            continue;
                        const d = Math.hypot(q.x - px, q.y - py);
                        if (d <= JOIN_TOL && (!nearest.has(q.r) || d < nearest.get(q.r).d))
                            nearest.set(q.r, { r: q.r, k: q.k, d });
                    }
            return [...nearest.values()];
        });
        conns.set(r, ends);
    }
    return conns;
}

// Concatenate an ordered list of road slices { r, from, to } (from>to means the
// road is traversed backwards) into one profile: fresh cumulative distance from
// the real coordinates, plus a provenance entry per sample mapping back to its
// road and index.
function combineSteps(steps) {
    const pts = [], elev = [], prov = [];
    for (const s of steps) {
        const dir = s.to >= s.from ? 1 : -1;
        for (let k = s.from; dir > 0 ? k <= s.to : k >= s.to; k += dir) {
            pts.push(s.r.samples[k]);
            elev.push(s.r.elev[k]);
            prov.push({ r: s.r, k });
        }
    }
    const samples = [{ lat: pts[0].lat, lon: pts[0].lon, d: 0 }];
    let d = 0;
    for (let i = 1; i < pts.length; i++) {
        d += haversine(pts[i - 1], pts[i]);
        samples.push({ lat: pts[i].lat, lon: pts[i].lon, d });
    }
    return { samples, elev, prov };
}

// Rank the longest qualifying long inclines across the road network, each
// possibly spanning up to maxRoads connected roads. Returns them longest-first,
// de-duplicated by physical extent — no stretch of pavement appears in two
// reported inclines, but a road with two distinct inclines (meeting at a
// summit or valley) reports both. maxRoads = 1 reproduces the single-road
// ranking. Each result:
//   { span, gain, grade, roads:[...], segs:[{r,from,to}], path:[[lat,lon]...],
//     start:{lat,lon,elev}, end:{lat,lon,elev} }
export function longestInclinePaths(roads, minSpan, maxRoads = 1) {
    const junc = maxRoads > 1 ? endpointJunctions(roads) : null;
    const found = [];

    const evaluate = steps => {
        const { samples, elev, prov } = combineSteps(steps);
        // Every qualifying run on the chain competes — a road that climbs over
        // a summit (or out of a valley both ways) reports each side.
        for (const inc of longestInclines(samples, elev, minSpan)) {
            const segs = [];
            for (let k = inc.i; k <= inc.j; k++) {
                const { r, k: idx } = prov[k];
                const last = segs[segs.length - 1];
                if (last && last.r === r)
                    last.to = idx;
                else
                    segs.push({ r, from: idx, to: idx });
            }
            const point = k => ({ lat: prov[k].r.samples[prov[k].k].lat, lon: prov[k].r.samples[prov[k].k].lon, elev: elev[k] });
            const bottom = elev[inc.i] <= elev[inc.j] ? inc.i : inc.j;
            // The incline's own extent as a standalone profile (distance
            // re-zeroed), so callers can build a "virtual road" for it — one
            // continuous amber underlay and halo across the junctions it spans.
            const profSamples = [], profElev = [];
            for (let k = inc.i; k <= inc.j; k++) {
                profSamples.push({ lat: samples[k].lat, lon: samples[k].lon, d: samples[k].d - samples[inc.i].d });
                profElev.push(elev[k]);
            }
            found.push({
                span: inc.span, gain: inc.gain, grade: inc.grade,
                roads: [...new Set(segs.map(s => s.r))],
                segs,
                samples: profSamples, elev: profElev,
                path: profSamples.map(s => [s.lat, s.lon]),
                start: point(bottom), end: point(bottom === inc.i ? inc.j : inc.i),
            });
        }
    };

    const dfs = (steps, roadSet, depth) => {
        evaluate(steps);
        if (!junc || depth >= maxRoads)
            return;
        const last = steps[steps.length - 1];
        const which = last.to === 0 ? 0 : 1; // the endpoint we arrived at
        for (const c of junc.get(last.r)[which]) {
            if (roadSet.has(c.r))
                continue;
            for (const to of [0, c.r.samples.length - 1]) {
                if (to === c.k)
                    continue; // empty slice
                steps.push({ r: c.r, from: c.k, to });
                roadSet.add(c.r);
                dfs(steps, roadSet, depth + 1);
                roadSet.delete(c.r);
                steps.pop();
            }
        }
    };

    for (const r of roads) {
        const last = r.samples.length - 1;
        if (last < 1)
            continue;
        dfs([{ r, from: 0, to: last }], new Set([r]), 1);
        if (junc) // the reverse orientation extends off the other end
            dfs([{ r, from: last, to: 0 }], new Set([r]), 1);
    }

    found.sort((a, b) => b.span - a.span);
    // Dedup by physical extent, longest first. Two inclines conflict when
    // they cover overlapping sample ranges on a shared road (the same chain's
    // sub-pieces, or the same incline found from the reverse orientation — so
    // a multi-road incline still supersedes its single-road pieces), or when
    // same-name slices on DIFFERENT road objects overlap geographically
    // (parallel same-name chains reporting the same hill). Two inclines that
    // merely meet at a summit or valley sample of one road both rank.
    const pad = 0.0005; // ~50 m, like app.js extentBox
    const segBox = s => {
        if (s.box)
            return s.box;
        const [lo, hi] = s.from <= s.to ? [s.from, s.to] : [s.to, s.from];
        let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity;
        for (let k = lo; k <= hi; k++) {
            const p = s.r.samples[k];
            latMin = Math.min(latMin, p.lat);
            latMax = Math.max(latMax, p.lat);
            lonMin = Math.min(lonMin, p.lon);
            lonMax = Math.max(lonMax, p.lon);
        }
        s.box = [latMin - pad, latMax + pad, lonMin - pad, lonMax + pad];
        return s.box;
    };
    const boxOverlap = (a, b) => a[0] <= b[1] && b[0] <= a[1] && a[2] <= b[3] && b[2] <= a[3];
    const conflicts = (a, b) => {
        for (const s of a.segs) {
            for (const t of b.segs) {
                if (s.r === t.r) {
                    const [slo, shi] = s.from <= s.to ? [s.from, s.to] : [s.to, s.from];
                    const [tlo, thi] = t.from <= t.to ? [t.from, t.to] : [t.to, t.from];
                    if (Math.max(slo, tlo) < Math.min(shi, thi))
                        return true; // share at least one segment
                }
                else if (!s.r.unnamed && !t.r.unnamed && s.r.name === t.r.name &&
                         boxOverlap(segBox(s), segBox(t))) {
                    return true;
                }
            }
        }
        return false;
    };
    const picked = [];
    for (const inc of found)
        if (!picked.some(p => conflicts(inc, p)))
            picked.push(inc);
    return picked;
}

// Extend the reported extent over adjacent climbing at least this steep. The top
// (end of the climb in the travel direction) uses a gentler threshold than the
// bottom, since a slight rise feels tougher late in a long climb.
const EXT_TOP_GRADE = 0.03; // at the climb's end (in the travel direction)
const EXT_BOT_GRADE = 0.04; // at the climb's start

// Up to maxCount non-overlapping hardest climbs on a road, best first, in
// either travel direction, so a road with two distinct hills can surface both.
// Each climb's extent is found by maximizing gain²/length (gain × average
// grade, FIETS-style) over intervals that are genuine climbs — interior
// descent, as experienced by the traveler, at most max(DIP_ABS, DIP_FRAC ×
// ascent) — then extended over adjacent segments still climbing (>= EXT_BOT_GRADE
// at the start, the gentler EXT_TOP_GRADE at the end). Later climbs may not
// overlap earlier ones' extents.
// The reported score is the effort integral over the extent:
// Σ segment length × grade², which equals gain²/length on a steady climb but
// is additive — every stretch of real climbing raises it, so a 5% shoulder
// counts toward the result instead of "diluting" it.
// Exact search over all sample pairs; roads are a few hundred samples at
// most, and results are memoized per road. Each climb is {score, gain, span,
// grade, i, j, dir}.
export function hardestClimbs(samples, elev, maxCount = 3) {
    const n = samples.length;
    if (n < 2)
        return [];
    const { up, down } = ascentPrefixes(elev);
    const taken = new Uint8Array(n - 1); // segments claimed by earlier climbs
    const takenPre = new Int32Array(n);  // prefix counts for O(1) overlap tests
    const climbs = [];
    // net > 0: climb traveling forward, counter-slope is forward descent.
    // net < 0: climb traveling backward, counter-slope is forward ascent.
    const evalPair = (i, j) => {
        if (takenPre[j] - takenPre[i] > 0)
            return null; // overlaps an earlier climb
        const net = elev[j] - elev[i];
        if (net === 0)
            return null;
        const gain = Math.abs(net);
        const counter = net > 0 ? down[j] - down[i] : up[j] - up[i];
        if (dipTooBig(gain, counter))
            return null;
        const span = samples[j].d - samples[i].d;
        return { score: (gain * gain) / span, gain, span, grade: gain / span, i, j, dir: Math.sign(net) };
    };
    while (climbs.length < maxCount) {
        let best = null;
        for (let i = 0; i < n - 1; i++) {
            for (let j = i + 1; j < n; j++) {
                const c = evalPair(i, j);
                if (c && (!best || c.score > best.score))
                    best = c;
            }
        }
        if (!best || best.gain < DIP_ABS)
            break;
        // A former step here tightened `best` to the shortest interval keeping
        // 95% of its score before extending. Measured (Pittsburgh, ~1800 roads)
        // to be a no-op for every rankable climb: whenever half the average
        // grade exceeds the extension floor (roughly avg > 8%), extension below
        // re-grows the extent past any trim, so only gentle, low-scoring climbs'
        // extents changed at all and no ranking moved. Dropped for simplicity.
        // If the extension floors (EXT_TOP/BOT_GRADE) rise much, restoring the
        // trim may again matter, to stop gentle climbs reporting extents that
        // reach below the floor via the argmax's implicit half-average cutoff.
        //
        // gain²/span only admits a tail steeper than half the climb's average,
        // so a 12% climb would disown a 5% finish. Extend the reported extent
        // over adjacent unclaimed segments still climbing in the travel
        // direction, gently enough to belong. The final score below is the
        // additive effort integral over this extent, so those shoulders add to
        // it rather than diluting it the way they would the gain²/span ratio.
        let { i, j } = best;
        const climbGrade = k => ((elev[k + 1] - elev[k]) * best.dir) / (samples[k + 1].d - samples[k].d);
        // Top gets the gentler threshold. Which array end is the top depends on
        // travel direction: a backward climb (dir < 0) runs from high index
        // (its bottom) to low index (its top).
        const jGrade = best.dir > 0 ? EXT_TOP_GRADE : EXT_BOT_GRADE;
        const iGrade = best.dir > 0 ? EXT_BOT_GRADE : EXT_TOP_GRADE;
        while (j < n - 1 && !taken[j] && climbGrade(j) >= jGrade)
            j++;
        while (i > 0 && !taken[i - 1] && climbGrade(i - 1) >= iGrade)
            i--;
        const gain = Math.abs(elev[j] - elev[i]);
        const span = samples[j].d - samples[i].d;
        // Effort integral: climbing segments contribute length × grade²; flats
        // and tolerated counter-slope inside the extent contribute nothing.
        let score = 0;
        for (let k = i; k < j; k++) {
            const de = (elev[k + 1] - elev[k]) * best.dir;
            if (de > 0)
                score += (de * de) / (samples[k + 1].d - samples[k].d);
        }
        climbs.push({ ...best, i, j, gain, span, grade: gain / span, score });
        for (let k = i; k < j; k++)
            taken[k] = 1;
        for (let k = 0; k < n - 1; k++)
            takenPre[k + 1] = takenPre[k] + taken[k];
    }
    return climbs;
}

// A road's single hardest climb (or null) — the head of hardestClimbs.
export function hardestClimb(samples, elev) {
    return hardestClimbs(samples, elev, 1)[0] ?? null;
}
