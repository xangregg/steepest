// Road profile math: arc-length resampling, bridge/tunnel deck elevations,
// smoothing, sustained-window grades, hardest-climb extraction, and
// long-incline masking. Conventions: grades are fractions (0.08 = 8 %),
// distances are meters, and elevations are smoothed before any metric runs.
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

// 3-point moving average to tame elevation-model jitter.
function smooth(elevs) {
    return elevs.map((e, i) => {
        const a = elevs[Math.max(0, i - 1)], c = elevs[Math.min(elevs.length - 1, i + 1)];
        return (a + e + c) / 3;
    });
}

// samples + raw elevations -> per-road basics, keeping the smoothed elevation
// profile so sustainedGrade() can be re-queried cheaply for any window length.
export function analyzeRoad(samples, elevs) {
    const elev = smooth(deckElevations(samples, elevs));
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

const DIP_ABS = 2;       // m of counter-slope always forgiven (DEM noise)
const DIP_FRAC = 0.10;   // ... or up to this fraction of the total ascent
export const GRIND_MIN_GRADE = 0.0225; // a long incline counts from this average grade

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

const TRIM_KEEP = 0.95;  // report the shortest interval keeping this share of the best score
const EXT_MIN_GRADE = 0.05; // extend the reported extent over adjacent climbing this steep

// Up to maxCount non-overlapping hardest climbs on a road, best first, in
// either travel direction, so a road with two distinct hills can surface both.
// Each climb's extent is found by maximizing gain²/length (gain × average
// grade, FIETS-style) over intervals that are genuine climbs — interior
// descent, as experienced by the traveler, at most max(DIP_ABS, DIP_FRAC ×
// ascent) — then tightened to the shortest interval keeping TRIM_KEEP of that
// maximum, then extended over adjacent segments still climbing at
// >= extMinGrade. Later climbs may not overlap earlier ones' extents.
// The reported score is the effort integral over the extent:
// Σ segment length × grade², which equals gain²/length on a steady climb but
// is additive — every stretch of real climbing raises it, so a 5% shoulder
// counts toward the result instead of "diluting" it.
// Exact search over all sample pairs; roads are a few hundred samples at
// most, and results are memoized per road. Each climb is {score, gain, span,
// grade, i, j, dir}.
export function hardestClimbs(samples, elev, maxCount = 3, extMinGrade = EXT_MIN_GRADE) {
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
        let tight = best;
        const floor = TRIM_KEEP * best.score;
        for (let i = 0; i < n - 1; i++) {
            for (let j = i + 1; j < n; j++) {
                const c = evalPair(i, j);
                if (c && c.score >= floor && c.span < tight.span)
                    tight = c;
            }
        }
        // gain²/span only admits a tail steeper than half the climb's average,
        // so a 12% climb would disown a 5% finish. Extend the reported extent
        // over adjacent unclaimed segments still climbing at >= extMinGrade in
        // the travel direction; the score stays the core's (the extension
        // describes extent, not extra hardness).
        let { i, j } = tight;
        const climbGrade = k => ((elev[k + 1] - elev[k]) * tight.dir) / (samples[k + 1].d - samples[k].d);
        while (j < n - 1 && !taken[j] && climbGrade(j) >= extMinGrade)
            j++;
        while (i > 0 && !taken[i - 1] && climbGrade(i - 1) >= extMinGrade)
            i--;
        const gain = Math.abs(elev[j] - elev[i]);
        const span = samples[j].d - samples[i].d;
        // Effort integral: climbing segments contribute length × grade²; flats
        // and tolerated counter-slope inside the extent contribute nothing.
        let score = 0;
        for (let k = i; k < j; k++) {
            const de = (elev[k + 1] - elev[k]) * tight.dir;
            if (de > 0)
                score += (de * de) / (samples[k + 1].d - samples[k].d);
        }
        climbs.push({ ...tight, i, j, gain, span, grade: gain / span, score });
        for (let k = i; k < j; k++)
            taken[k] = 1;
        for (let k = 0; k < n - 1; k++)
            takenPre[k + 1] = takenPre[k] + taken[k];
    }
    return climbs;
}

// A road's single hardest climb (or null) — the head of hardestClimbs.
export function hardestClimb(samples, elev, extMinGrade = EXT_MIN_GRADE) {
    return hardestClimbs(samples, elev, 1, extMinGrade)[0] ?? null;
}
