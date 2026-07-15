// End-to-end pipeline check in Node (no browser): geocode a real town, pull
// roads from Overpass, sample real terrain tiles (decoded with pngjs instead of
// canvas), and rank by sustained grade at a couple of window lengths.
// Run with `npm test`.

import { PNG } from 'pngjs';
import { geocode, parseLatLon, fetchRoads, prepareRoads } from '../roads.js';

// Stitching bearing gate: same-name ways merge straight through a join but
// not around a corner (distinct streets sharing a TIGER-mangled name).
const way = (id, name, coords) => ({
    type: 'way', id, tags: { name, highway: 'residential' },
    geometry: coords.map(([lat, lon]) => ({ lat, lon })),
});
const gateRoads = prepareRoads([
    way(1, 'Straight St', [[35, -79], [35.001, -79]]),
    way(2, 'Straight St', [[35.001, -79], [35.002, -79]]),
    way(3, 'Corner St', [[35, -78], [35.001, -78]]),
    way(4, 'Corner St', [[35.001, -78], [35.001, -77.999]]),
]);
const chains = name => gateRoads.filter(r => r.name === name).length;

// Two-way road becoming a divided road: three same-name ends meet where the
// carriageways split. The through pair must stitch; the opposite carriageway
// (a ~180° fold) must stay separate.
const divided = prepareRoads([
    way(8, 'Divided St', [[35, -76], [35.001, -76]]),                       // two-way approach
    way(9, 'Divided St', [[35.001, -76], [35.002, -76.00005]]),             // carriageway onward
    way(10, 'Divided St', [[35.002, -76.0003], [35.001, -76]]),             // carriageway returning
]);
const dividedLens = divided.map(r => r.pts.length).sort((x, y) => y - x);
assert(divided.length === 2 && dividedLens[0] === 3,
    `divided-road transition stitches through (${divided.length} chains)`);

// A 2-node tunnel way between two ordinary ways must keep its flag through
// stitching (the junction points get deduplicated when ways merge).
const tunnelWay = way(6, 'Bore St', [[35.001, -77], [35.002, -77]]);
tunnelWay.tags.tunnel = 'yes';
const bore = prepareRoads([
    way(5, 'Bore St', [[35, -77], [35.001, -77]]),
    tunnelWay,
    way(7, 'Bore St', [[35.002, -77], [35.003, -77]]),
]);
import { elevatePoints } from '../elevation.js';
import { resample, analyzeRoad, segmentSustained, sustainedGrade, hardestClimb, hardestClimbs, grindMask, SAMPLE_STEP } from '../metrics.js';

const decodeTile = async url => {
    const res = await fetch(url);
    if (!res.ok)
        throw new Error(`tile HTTP ${res.status} for ${url}`);
    return PNG.sync.read(Buffer.from(await res.arrayBuffer())).data; // flat RGBA
};

function assert(cond, msg) {
    if (!cond) {
        console.error(`FAIL: ${msg}`);
        process.exit(1);
    }
    console.log(`ok: ${msg}`);
}

// Unit-ish checks first
assert(chains('Straight St') === 1, 'collinear same-name ways stitch into one road');
assert(chains('Corner St') === 2, 'right-angle same-name ways stay separate');
assert(bore.length === 1 && resample(bore[0].pts).some(s => s.b),
    'tunnel flag survives stitching of a 2-node tunnel way');
assert(parseLatLon('35.23, -82.73')?.lat === 35.23, 'parseLatLon accepts coordinates');
assert(parseLatLon('Brevard, NC') === null, 'parseLatLon rejects place names');
const flat = resample([{ lat: 35, lon: -82.7 }, { lat: 35.009, lon: -82.7 }]); // ~1 km due north
assert(Math.abs(flat[flat.length - 1].d - 1001) < 5, `resample length ~1001 m (got ${flat[flat.length - 1].d.toFixed(0)})`);
assert(flat.length === 41, `resample spacing ~25 m (got ${flat.length} samples)`);
const synth = analyzeRoad(flat, flat.map(s => s.d * 0.10)); // uniform 10% grade
const g100 = sustainedGrade(flat, synth.elev, 100);
assert(Math.abs(g100 - 0.10) < 0.005, `synthetic 10% road: sustained 100 m = ${(g100 * 100).toFixed(2)}%`);
const gStep = sustainedGrade(flat, synth.elev, SAMPLE_STEP);
assert(Math.abs(gStep - 0.10) < 0.005, `synthetic 10% road: sustained ${SAMPLE_STEP} m = ${(gStep * 100).toFixed(2)}%`);
assert(sustainedGrade(flat, synth.elev, 5000) === null, 'window longer than road -> null');
const segs = segmentSustained(flat, synth.elev, 100);
assert(segs.length === flat.length - 1, 'one value per segment');
// End segments read slightly low from the 3-point elevation smoothing.
assert(segs.every(v => Math.abs(v - 0.10) < 0.02), 'uniform road: every segment 8–12%');
assert(segs.slice(5, -5).every(v => Math.abs(v - 0.10) < 0.005), 'uniform road: interior segments ~10%');
// Half flat, half 20% up: segments should localize the steep half.
const hill = flat.map(s => (s.d < 500 ? 0 : (s.d - 500) * 0.20));
const hillSegs = segmentSustained(flat, analyzeRoad(flat, hill).elev, 100);
assert(hillSegs[2] < 0.03 && hillSegs[hillSegs.length - 3] > 0.17,
    `flat-then-steep road localizes: start ${(hillSegs[2] * 100).toFixed(1)}%, end ${(hillSegs[hillSegs.length - 3] * 100).toFixed(1)}%`);
assert(Math.abs(Math.max(...hillSegs) - sustainedGrade(flat, analyzeRoad(flat, hill).elev, 100)) < 1e-12,
    'max of segment values equals road ranking value');

// Length thresholds snap to the nearest whole segment: a 10-segment run
// summing 249 m counts for a 250 m window (the alternative is a 274 m window
// that would dilute the value).
const short = resample([{ lat: 35, lon: -82.5 }, { lat: 35.00896, lon: -82.5 }]); // ~996 m -> 24.9 m spacing
const spacing = short[1].d - short[0].d;
assert(spacing < 25, `sub-25 spacing road built (${spacing.toFixed(2)} m)`);
// Mid-road 10% climb spanning exactly 10 segments (~249 m), flat either side.
const climbElev = analyzeRoad(short, short.map(s =>
    Math.max(0, Math.min(s.d - 10 * spacing, 10 * spacing)) * 0.10)).elev;
const snap = sustainedGrade(short, climbElev, 250);
const forced = sustainedGrade(short, climbElev, 275);
assert(snap > forced + 0.004,
    `249 m run counts for the 250 m window: ${(snap * 100).toFixed(2)}% vs ${(forced * 100).toFixed(2)}% at 275 m`);

// Hardest-climb metric: same gain, half the distance -> roughly double score.
const mkElev = fn => analyzeRoad(flat, flat.map(s => fn(s.d))).elev;
const cLong = hardestClimb(flat, mkElev(d => d * 0.05));
const cShort = hardestClimb(flat, mkElev(d => Math.min(d, 500) * 0.10));
assert(cShort.score > cLong.score * 1.7, `steep-short (${cShort.score.toFixed(2)}) beats long-moderate (${cLong.score.toFixed(2)})`);
// A real dip (8 m) must end the climb rather than hide inside it.
const dipElev = mkElev(d => d < 200 ? d * 0.1 : d < 300 ? 20 - (d - 200) * 0.08 : d < 500 ? 12 + (d - 300) * 0.1 : 32);
const cDip = hardestClimb(flat, dipElev);
assert(cDip.span < 320, `dip splits the climb (span ${cDip.span.toFixed(0)} m)`);
assert(hardestClimb(flat, mkElev(d => 100 - d * 0.08)).dir === -1, 'descending road climbs backward');
assert(hardestClimb(flat, mkElev(() => 100)) === null, 'flat road has no climb');
// Extent rules: adjacent climbing >= 5% belongs to the climb even when the
// score formula would call it dilution; near-flat monotonic tails do not.
const diluted = hardestClimb(flat, mkElev(d => d < 500 ? d * 0.055 : 27.5 + (d - 500) * 0.10));
assert(diluted.span > 900, `5.5% approach included in extent: span ${diluted.span.toFixed(0)} m of 1000 m road`);
// A near-flat approach must not be part of the climb at all.
const flatApproach = hardestClimb(flat, mkElev(d => d < 500 ? d * 0.01 : 5 + (d - 500) * 0.10));
assert(flatApproach.span < 560, `flat approach excluded: climb span ${flatApproach.span.toFixed(0)} m`);
// Brookview case: a 5.2% finish above a 12% wall is below the score formula's
// half-average bar but must still be part of the reported climb.
const shoulder = hardestClimb(flat, mkElev(d => d < 300 ? d * 0.12 : d < 500 ? 36 + (d - 300) * 0.052 : 46.4));
assert(shoulder.span > 420 && shoulder.gain > 40,
    `5% finish included: ↑${shoulder.gain.toFixed(0)} m over ${shoulder.span.toFixed(0)} m`);
// Effort integral: the shoulder adds to the score (core alone would be ~4.3;
// the 5.2% shoulder adds ~0.5) instead of diluting it.
assert(shoulder.score > 4.35 && shoulder.score < 5.2,
    `shoulder adds effort: score ${shoulder.score.toFixed(2)}`);
// On a steady climb the integral equals gain²/span — the score scale is unchanged.
const steady = hardestClimb(flat, mkElev(d => Math.min(d, 500) * 0.10));
assert(Math.abs(steady.score - steady.gain ** 2 / steady.span) < 0.15,
    `steady climb: integral ≈ gain²/span (${steady.score.toFixed(2)} vs ${(steady.gain ** 2 / steady.span).toFixed(2)})`);

// Multiple climbs: two hills separated by a real dip are extracted as two
// non-overlapping climbs, best first (plus the dip itself as a lesser climb
// in the other direction).
const twoHills = mkElev(d => d < 400 ? d * 0.1 : d < 550 ? 40 - (d - 400) * 0.1 : d < 850 ? 25 + (d - 550) * 0.1 : 55);
const multi = hardestClimbs(flat, twoHills, 3);
assert(multi.length >= 2, `two-hill road yields ${multi.length} climbs`);
assert(multi[0].gain > 33 && multi[1].gain > 22,
    `both hills found (↑${multi[0].gain.toFixed(0)} m, ↑${multi[1].gain.toFixed(0)} m)`);
assert(multi[0].score >= multi[1].score, 'climbs come best first');
assert(multi.every((a, x) => multi.every((b, y) => x === y || a.j <= b.i || b.j <= a.i)),
    'climb extents do not overlap');

// Grind mask: a 2.5% monotonic km qualifies (span threshold 1000 m), a 1% km
// doesn't, and a rolling profile with real dips doesn't.
const grind = grindMask(flat, mkElev(d => d * 0.025), 1000);
assert(grind && grind.reduce((s, v) => s + v, 0) >= flat.length - 3, 'steady 2.5% km is a grind');
assert(grindMask(flat, mkElev(d => d * 0.01), 1000) === null, '1% km is not a grind');
assert(grindMask(flat, mkElev(d => d * 0.025 + 8 * Math.sin(d / 50)), 1000) === null,
    'rolling profile with real dips is not a grind');
// Flat-then-wall: the qualifying 1 km interval is half flat and half a 500 m
// wall — the coherent incline itself is shorter than the threshold, so no
// long-incline mark survives at all (the wall gets steepness paint anyway).
assert(grindMask(flat, mkElev(d => Math.max(0, d - 500) * 0.1), 1000) === null,
    'flat-then-wall leaves no long-incline mark (incline itself too short)');
// Two inclines meeting at a valley bottom must split into two runs, not merge
// into one incoherent ~0 % run (the Bolin Creek case).
const vRoad = resample([{ lat: 35, lon: -82.4 }, { lat: 35.027, lon: -82.4 }]); // ~3 km
const vMask = grindMask(vRoad, analyzeRoad(vRoad, vRoad.map(s => Math.abs(s.d - 1500) * 0.03)).elev, 1000);
const midSeg = Math.floor(vMask.length / 2);
assert(vMask && vMask[5] && vMask[vMask.length - 6], 'V profile keeps both incline sides');
const gap = [];
for (let k = 0; k < vMask.length; k++)
    if (!vMask[k])
        gap.push(k);
assert(gap.length >= 1 && gap.every(k => Math.abs(k - midSeg) < 4),
    `V splits at the valley bottom (unmasked segs: ${gap.join(',')})`);

// Bridge interpolation: a 5% road crossing a 40 m-deep gorge on a bridge
// (middle third flagged b) must read ~5%, not a cliff.
const ptsB = [
    { lat: 35, lon: -82.7 },
    { lat: 35.003, lon: -82.7, b: true },
    { lat: 35.006, lon: -82.7, b: true },
    { lat: 35.009, lon: -82.7 },
];
const bs = resample(ptsB);
assert(bs.some(s => s.b) && !bs[0].b && !bs[bs.length - 1].b, 'resample carries bridge flags');
const gorge = bs.map(s => s.d * 0.05 - (s.b ? 40 : 0));
const withFix = sustainedGrade(bs, analyzeRoad(bs, gorge).elev, 100);
const noFlags = resample(ptsB.map(({ lat, lon }) => ({ lat, lon })));
const withoutFix = sustainedGrade(noFlags, analyzeRoad(noFlags, gorge).elev, 100);
assert(withFix < 0.08, `bridge deck interpolated: ${(withFix * 100).toFixed(1)}% (was ${(withoutFix * 100).toFixed(1)}% uncorrected)`);
assert(withoutFix > 0.2, 'sanity: uncorrected gorge does read as a cliff');
// A named bridge is often its own chain with every sample flagged: the deck
// must anchor on its own endpoints instead of silently keeping the valley.
const allBridge = resample([{ lat: 35, lon: -82.6, b: true }, { lat: 35.009, lon: -82.6, b: true }]);
const valley = allBridge.map(s => 100 + s.d * 0.02 - (s.d > 200 && s.d < 800 ? 35 : 0));
const deck = sustainedGrade(allBridge, analyzeRoad(allBridge, valley).elev, 100);
assert(deck < 0.03, `all-bridge chain reads as its deck: ${(deck * 100).toFixed(1)}%`);

// Live pipeline: small mountain town, modest radius to be kind to Overpass.
const center = await geocode('Brevard, North Carolina');
console.log(`geocoded: ${center.label} (${center.lat}, ${center.lon})`);
assert(Math.abs(center.lat - 35.23) < 0.2 && Math.abs(center.lon + 82.73) < 0.2, 'geocode near expected coords');

const elements = await fetchRoads(center, 2500);
const roads = prepareRoads(elements).map(r => ({ ...r, samples: resample(r.pts) })).filter(r => r.samples.length >= 3);
assert(roads.length > 50, `found ${roads.length} roads`);
const stitched = roads.filter(r => !r.unnamed).length;
console.log(`   ${stitched} named road chains after stitching`);

const points = roads.flatMap(r => r.samples);
let tiles = 0;
const elevs = await elevatePoints(points, { decodeTile, onProgress: (d, t) => (tiles = t) });
console.log(`   sampled ${points.length} points from ${tiles} tiles`);
const eMin = Math.min(...elevs), eMax = Math.max(...elevs);
assert(eMin > 400 && eMax < 2000 && eMax - eMin > 50, `elevations plausible for Brevard: ${eMin.toFixed(0)}–${eMax.toFixed(0)} m`);

let offset = 0;
for (const r of roads) {
    Object.assign(r, analyzeRoad(r.samples, Array.from(elevs.subarray(offset, offset + r.samples.length))));
    offset += r.samples.length;
}

const rankAt = windowM => roads
    .map(r => ({ ...r, value: sustainedGrade(r.samples, r.elev, windowM) }))
    .filter(r => r.value != null && r.length >= 200)
    .sort((a, b) => b.value - a.value);

const ranked = rankAt(100);
assert(ranked.length > 20, `${ranked.length} roads pass the 200 m minimum at window 100`);
const topG = ranked[0].value;
assert(topG > 0.04 && topG < 0.45, `top sustained-100 grade sane: ${(topG * 100).toFixed(1)}%`);

// Longer windows can only lower (or hold) a road's sustained grade.
const at400 = new Map(rankAt(400).map(r => [r.id, r.value]));
const monotone = ranked.every(r => !at400.has(r.id) || at400.get(r.id) <= r.value + 1e-9);
assert(monotone, 'sustained grade is non-increasing in window length');

console.log('\nTop 10 by sustained 100 m grade (min 200 m):');
for (const r of ranked.slice(0, 10)) {
    console.log(
        `  ${(r.value * 100).toFixed(1).padStart(5)}%  ${r.name.padEnd(28).slice(0, 28)} ` +
        `len ${Math.round(r.length).toString().padStart(5)} m  ` +
        `w25 ${(sustainedGrade(r.samples, r.elev, 25) * 100).toFixed(1)}%  ` +
        `w400 ${((sustainedGrade(r.samples, r.elev, 400) ?? 0) * 100).toFixed(1)}%`);
}
console.log('PASS');
