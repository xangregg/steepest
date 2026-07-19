// Unit checks (no network): stitching gates, resampling, the metric math,
// climb extraction, long-incline masking, bridge/tunnel deck interpolation,
// CSV export, and name abbreviation — all on synthetic profiles. Run with
// `npm test`. The live end-to-end run (Nominatim/Overpass/terrain tiles) is in
// live.test.mjs (`npm run test:live`), so the default test suite needs no
// network.

import { parseLatLon, prepareRoads } from '../roads.js';
import { assert } from './assert.mjs';

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
import { resample, analyzeRoad, segmentSustained, sustainedGrade, bestSustainedWindow, hardestClimb, hardestClimbs, grindMask, longestIncline, longestInclinePaths, SAMPLE_STEP } from '../metrics.js';
import { abbrevName, shortLabel } from '../render.js';
import { buildCsv, csvFilename } from '../csv.js';

// Place-label shortening for the list sub-line: drop county-equivalent parts,
// abbreviate state + country.
assert(shortLabel('Brevard, Transylvania County, North Carolina, United States') === 'Brevard, NC, US',
    `shortLabel: ${shortLabel('Brevard, Transylvania County, North Carolina, United States')}`);
assert(shortLabel('Pittsburgh, Allegheny County, Pennsylvania, United States') === 'Pittsburgh, PA, US', 'shortLabel drops County (PA)');
assert(shortLabel('New Orleans, Orleans Parish, Louisiana, United States') === 'New Orleans, LA, US', 'shortLabel drops Parish (LA)');
assert(shortLabel('Utqiagvik, North Slope Borough, Alaska, United States') === 'Utqiagvik, AK, US', 'shortLabel drops Borough (AK)');
assert(shortLabel('Transylvania County, North Carolina, United States') === 'Transylvania County, NC, US', 'shortLabel keeps a county as the place');
assert(shortLabel('Toronto, Ontario, Canada') === 'Toronto, Ontario, Canada', 'shortLabel leaves non-US parts alone');

// Street-type abbreviation (display only): common type words shorten, but only
// as whole Title-Case words, so a name that merely starts with those letters
// is left alone.
assert(abbrevName('Pritchard Avenue Extension') === 'Pritchard Ave Ext',
    `abbrev: ${abbrevName('Pritchard Avenue Extension')}`);
assert(abbrevName('Martin Luther King Jr Boulevard') === 'Martin Luther King Jr Blvd', 'abbrev Blvd');
assert(abbrevName('Streetman Road') === 'Streetman Rd', 'abbrev keeps Streetman, shortens Road');
assert(abbrevName('Roadside Lane') === 'Roadside Ln', 'abbrev keeps Roadside, shortens Lane');
assert(abbrevName('Franklin Street') === 'Franklin St', 'abbrev St');

// CSV export (csv.js): per-mode columns, endpoints, escaping, filenames.
const csvRoad = (() => {
    const s = resample([{ lat: 35, lon: -82 }, { lat: 35.009, lon: -82 }]); // ~1 km due north
    const { elev, length } = analyzeRoad(s, s.map(p => Math.min(p.d, 500) * 0.10)); // 10% for 500 m, then flat
    return { id: 'r', name: 'Test Avenue', samples: s, elev, length, value: sustainedGrade(s, elev, 250), climbs: hardestClimbs(s, elev, 3) };
})();
const climbCsv = buildCsv({ entries: [{ road: csvRoad, climb: csvRoad.climbs[0] }], rankMode: 'climb', windowM: 250 });
assert(climbCsv.startsWith('\ufeff'), 'CSV starts with a UTF-8 BOM');
const cLines = climbCsv.replace(/^\ufeff/, '').trimEnd().split('\r\n');
assert(cLines[0] === 'rank,name,score,grade_pct,gain_m,length_m,start_lat,start_lon,start_elev_m,end_lat,end_lon,end_elev_m', 'climb CSV header');
const cCols = cLines[1].split(',');
assert(cCols[0] === '1' && cCols[1] === 'Test Avenue', `climb CSV rank/name: ${cCols[0]},${cCols[1]}`);
assert(+cCols[8] < +cCols[11], `climb CSV start elev (${cCols[8]}) below end elev (${cCols[11]}) — bottom to top`);
const sustCsv = buildCsv({ entries: [{ road: csvRoad, climb: null }], rankMode: 'sustained', windowM: 250 });
const sLines = sustCsv.replace(/^\ufeff/, '').trimEnd().split('\r\n');
assert(sLines[0] === 'rank,name,grade_pct,window_m,road_length_m,start_lat,start_lon,start_elev_m,end_lat,end_lon,end_elev_m', 'sustained CSV header');
assert(sLines[1].split(',')[3] === '250', 'sustained CSV window_m column');
const inclineEntry = { incline: {
    roads: [{ name: 'Lower Rd' }, { name: 'Upper Rd' }], span: 1400, grade: 0.06, gain: 84,
    start: { lat: 35, lon: -82, elev: 3.2 }, end: { lat: 35.012, lon: -82, elev: 87.5 },
} };
const inclineCsv = buildCsv({ entries: [inclineEntry], rankMode: 'incline', windowM: 250 });
const iLines = inclineCsv.replace(/^\ufeff/, '').trimEnd().split('\r\n');
assert(iLines[0] === 'rank,name,roads,length_m,grade_pct,gain_m,start_lat,start_lon,start_elev_m,end_lat,end_lon,end_elev_m', 'incline CSV header');
const iCols = iLines[1].split(',');
assert(iCols[1] === 'Lower Rd + Upper Rd' && iCols[3] === '1400.000', `incline CSV name/length: ${iCols[1]},${iCols[3]}`);
assert(iCols[2] === '2', `incline CSV roads count: ${iCols[2]}`);
const commaCsv = buildCsv({ entries: [{ road: { ...csvRoad, name: 'A, B Road' }, climb: csvRoad.climbs[0] }], rankMode: 'climb', windowM: 250 });
assert(commaCsv.includes('"A, B Road"'), 'CSV quotes a name containing a comma');
assert(csvFilename('climb', 250, 'Chapel Hill, NC') === 'steepest-climbs-chapel-hill.csv', 'csv filename (climb)');
assert(csvFilename('sustained', 250, 'Chapel Hill, NC') === 'steepest-sustained-250m-chapel-hill.csv', 'csv filename (sustained)');
assert(csvFilename('incline', 250, 'Chapel Hill, NC') === 'steepest-inclines-chapel-hill.csv', 'csv filename (incline)');

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
// The reported best window (for CSV export) matches the ranking value and sits
// in the steep half of the flat-then-steep road.
const bw = bestSustainedWindow(flat, analyzeRoad(flat, hill).elev, 100);
assert(Math.abs(bw.grade - sustainedGrade(flat, analyzeRoad(flat, hill).elev, 100)) < 1e-12,
    `best window grade equals ranking value (${(bw.grade * 100).toFixed(1)}%)`);
assert(bw.i < bw.j && flat[bw.i].d >= 490, `best window is in the steep half (starts at ${flat[bw.i].d.toFixed(0)} m)`);

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
// Asymmetric extension: a 3.5% shoulder (between the 4% bottom and 3% top
// thresholds) belongs to the climb when it's the finish but not the approach.
const topShoulder = hardestClimb(flat, mkElev(d => d < 300 ? d * 0.12 : d < 500 ? 36 + (d - 300) * 0.035 : 43));
assert(topShoulder.span > 420, `3.5% finish extends the climb: span ${topShoulder.span.toFixed(0)} m`);
const botShoulder = hardestClimb(flat, mkElev(d => d < 200 ? d * 0.035 : d < 500 ? 7 + (d - 200) * 0.12 : 43));
assert(botShoulder.span < 360, `3.5% approach excluded from the climb: span ${botShoulder.span.toFixed(0)} m`);

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
// longestIncline: the longest qualifying run with its span/grade (the "Longest
// inclines" ranking value); the V road's two ~1.5 km sides each beat the 1 km
// window, and the longest is returned.
const li = longestIncline(flat, mkElev(d => d * 0.025), 1000);
assert(li && li.span > 900 && Math.abs(li.grade - 0.025) < 0.006, `longest incline ${li && li.span.toFixed(0)} m @ ${li && (li.grade * 100).toFixed(1)}%`);
assert(longestIncline(flat, mkElev(d => d * 0.01), 1000) === null, 'no qualifying incline -> null');
const vLong = longestIncline(vRoad, analyzeRoad(vRoad, vRoad.map(s => Math.abs(s.d - 1500) * 0.03)).elev, 1000);
assert(vLong && vLong.span > 1000, `V road's longest incline side is ~1.5 km (${vLong && vLong.span.toFixed(0)} m)`);

// Multi-road inclines: two ~600 m roads meeting end-to-end, elevation climbing
// straight through the join. Neither is a 1 km incline alone, but together they
// are — longestInclinePaths(…, 2) must find and report the combined run.
const mkRoad = (a, b, name, e0) => {
    const s = resample([a, b]);
    return { id: name, name, unnamed: false, samples: s, elev: s.map(p => e0 + p.d * 0.05) };
};
const lower = mkRoad({ lat: 35, lon: -82 }, { lat: 35.0054, lon: -82 }, 'Lower Rd', 0);
const upper = mkRoad({ lat: 35.0054, lon: -82 }, { lat: 35.0108, lon: -82 }, 'Upper Rd', lower.elev.at(-1));
const solo = longestInclinePaths([lower, upper], 1000, 1);
assert(solo.length === 0, `neither ~600 m road alone is a 1 km incline (${solo.length} found)`);
const joined = longestInclinePaths([lower, upper], 1000, 2);
assert(joined.length === 1 && joined[0].roads.length === 2 && joined[0].span > 1000,
    `incline spans both roads (${joined[0] && joined[0].span.toFixed(0)} m over ${joined[0] && joined[0].roads.length} roads)`);
assert(Math.abs(joined[0].grade - 0.05) < 0.01, `combined incline grade ~5% (${joined[0] && (joined[0].grade * 100).toFixed(1)}%)`);
assert(joined[0].start.elev < joined[0].end.elev, 'incline start is the low end');

// Bridge interpolation: a 5% road crossing a ~40 m-deep valley on a bridge
// (middle third flagged b) must read ~5%, not a cliff. The valley is a gradual
// (< impossible-grade) dip, so it isolates the bridge flag — despiking leaves it
// alone, unlike a sheer DEM-artifact cliff (tested separately below).
const ptsB = [
    { lat: 35, lon: -82.7 },
    { lat: 35.003, lon: -82.7, b: true },
    { lat: 35.006, lon: -82.7, b: true },
    { lat: 35.009, lon: -82.7 },
];
const bs = resample(ptsB);
assert(bs.some(s => s.b) && !bs[0].b && !bs[bs.length - 1].b, 'resample carries bridge flags');
const bd = bs.filter(s => s.b).map(s => s.d);
const bLo = Math.min(...bd), bHi = Math.max(...bd), bMid = (bLo + bHi) / 2;
const gorge = bs.map(s => s.d * 0.05 - (s.d >= bLo && s.d <= bHi ? 40 * (1 - Math.abs(s.d - bMid) / (bMid - bLo)) : 0));
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

// DEM seam despiking: a real Fonllech Hir profile (Harlech) crosses a ~92 m
// step artifact in the terrarium tiles, so a weaving road reads ~243 m, dips
// into a bogus ~150 m "trench" for a few samples, then back to ~243 m — an
// impossible ~370 % edge. Despiking must bridge the trench back to ~243 m, not
// report a 120 %+ cliff; a genuine gentle road elsewhere must be untouched.
const seam = resample([{ lat: 52.858, lon: -4.083 }, { lat: 52.8525, lon: -4.093 }]); // ~800 m
const sMid = Math.floor(seam.length / 2);
const seamRaw = seam.map((s, i) => Math.abs(i - sMid) <= 2 ? 152 : 243); // 5-sample trench
const seamElev = analyzeRoad(seam, seamRaw).elev;
let seamMax = 0;
for (let i = 1; i < seam.length; i++)
    seamMax = Math.max(seamMax, Math.abs(seamElev[i] - seamElev[i - 1]) / (seam[i].d - seam[i - 1].d));
assert(seamMax < 0.60, `seam trench despiked: max grade ${(seamMax * 100).toFixed(0)}% (raw ~370%)`);
assert(seamElev[sMid] > 220, `trench bridged to the surrounding ~243 m, not 152 (got ${seamElev[sMid].toFixed(0)} m)`);
// A lone one-sided step can't be disambiguated, so it's capped, not bridged.
const stepRaw = seam.map((s, i) => i < sMid ? 243 : 152);
const stepElev = analyzeRoad(seam, stepRaw).elev;
let stepMax = 0;
for (let i = 1; i < seam.length; i++)
    stepMax = Math.max(stepMax, Math.abs(stepElev[i] - stepElev[i - 1]) / (seam[i].d - seam[i - 1].d));
assert(stepMax <= 0.61, `lone step capped at the plausible max (${(stepMax * 100).toFixed(0)}%)`);

console.log('PASS (unit)');
