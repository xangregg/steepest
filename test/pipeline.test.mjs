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
import { elevatePoints } from '../elevation.js';
import { resample, analyzeRoad, segmentSustained, sustainedGrade, hardestClimb, SAMPLE_STEP } from '../metrics.js';

const decodeTile = async url => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`tile HTTP ${res.status} for ${url}`);
    return PNG.sync.read(Buffer.from(await res.arrayBuffer())).data; // flat RGBA
};

function assert(cond, msg) {
    if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
    console.log(`ok: ${msg}`);
}

// Unit-ish checks first
assert(chains('Straight St') === 1, 'collinear same-name ways stitch into one road');
assert(chains('Corner St') === 2, 'right-angle same-name ways stay separate');
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
// Trim rule: a 5.5% monotonic approach into a 10% wall inflates the best
// interval to the whole km; the reported interval must give back the weakest
// part of the approach while keeping >= 95% of the score.
const diluted = hardestClimb(flat, mkElev(d => d < 500 ? d * 0.055 : 27.5 + (d - 500) * 0.10));
assert(diluted.span < 950 && diluted.span >= 500,
    `weak approach trimmed: climb span ${diluted.span.toFixed(0)} m of 1000 m road`);
// A near-flat approach must not be part of the climb at all.
const flatApproach = hardestClimb(flat, mkElev(d => d < 500 ? d * 0.01 : 5 + (d - 500) * 0.10));
assert(flatApproach.span < 560, `flat approach excluded: climb span ${flatApproach.span.toFixed(0)} m`);

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
