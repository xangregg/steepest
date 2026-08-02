// Unit checks (no network): stitching gates, resampling, the metric math,
// climb extraction, long-incline masking, bridge/tunnel/underpass elevation,
// CSV export, and name abbreviation — all on synthetic profiles. Run with
// `npm test`. The live end-to-end run (Nominatim/Overpass/terrain tiles) is in
// live.test.mjs (`npm run test:live`), so the default test suite needs no
// network.

import { readFileSync } from 'node:fs';
import { parseLatLon, prepareRoads, bridgeIndex, markUnderpasses } from '../roads.js';
import { VERSION_TAG } from '../cache.js';
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

// --- Roundabouts -----------------------------------------------------------
// A roundabout is a junction, not a road: OSM gives the circle its own way, so
// the road through it is severed into legs meeting the circle at different
// nodes (no shared node to stitch at). The legs must rejoin through the
// circle's own pavement, and the circle must not be ranked as a road.
const RING_R = 0.00018;                     // ~20 m of latitude
// deg is a compass bearing from the circle's center.
const ringNode = (clat, clon, deg) => [
    clat + RING_R * Math.cos(deg * Math.PI / 180),
    clon + (RING_R / Math.cos(clat * Math.PI / 180)) * Math.sin(deg * Math.PI / 180),
];
const roundabout = (id, clat, clon) => {
    const nodes = [];
    for (let deg = 0; deg < 360; deg += 30)
        nodes.push(ringNode(clat, clon, deg));
    nodes.push(nodes[0]);                   // closed ring
    return { ...way(id, null, nodes), tags: { highway: 'residential', junction: 'roundabout' } };
};
const legLen = r => {
    let m = 0;
    for (let i = 1; i < r.pts.length; i++)
        m += haversine(r.pts[i - 1], r.pts[i]);
    return m;
};

// Straight through: legs at 180° (south) and 30° (north-north-east) rejoin, and
// the joined road carries the SHORTER way round (the four nodes at 150…60),
// not the six the long way round.
const through = prepareRoads([
    roundabout(100, 35, -75),
    way(101, 'Ring Road', [[34.999, -75], ringNode(35, -75, 180)]),
    way(102, 'Ring Road', [ringNode(35, -75, 30), [35.001, -74.9995]]),
]);
assert(through.length === 1 && through[0].name === 'Ring Road',
    `roundabout: severed legs rejoin as one road (${through.length} entries: ${through.map(r => r.name)})`);
assert(!through.some(r => r.id === 100), 'roundabout: the circle itself is not ranked as a road');
const arcNodes = through[0].pts.filter(p => Math.abs(haversine(p, { lat: 35, lon: -75 }) - 20) < 1);
assert(arcNodes.length === 6, `roundabout: the joined road runs over the circle (${arcNodes.length} ring nodes: 2 legs + 4 between)`);
// The circle's pavement counts as road: the join must add the five 30° chords
// from 180° round to 30°, so distances (and so grades) stay honest.
const asPts = coords => ({ pts: coords.map(([lat, lon]) => ({ lat, lon })) });
const legsOnly = legLen(asPts([[34.999, -75], ringNode(35, -75, 180)])) +
    legLen(asPts([ringNode(35, -75, 30), [35.001, -74.9995]]));
const arcM = 5 * 2 * RING_R * 111320 * Math.sin(Math.PI / 12);
assert(Math.abs(legLen(through[0]) - legsOnly - arcM) < 2,
    `roundabout: joined length is the legs plus the arc (${legLen(through[0]).toFixed(0)} m = ${legsOnly.toFixed(0)} + ${arcM.toFixed(0)})`);

// A leg turning off the circle is a corner, not a continuation: same-name legs
// 90° apart must stay separate roads, exactly as they would at a plain junction.
const corner = prepareRoads([
    roundabout(200, 35, -74),
    way(201, 'Bend Street', [[34.999, -74], ringNode(35, -74, 180)]),
    way(202, 'Bend Street', [ringNode(35, -74, 90), [35, -73.999]]),
]);
assert(corner.length === 2, `roundabout: a 90° leg does not stitch through (${corner.length} entries)`);

// Divided at the circle (Mount Carmel Church Rd, Chapel Hill): each side offers
// a long through chain AND a short one-way carriageway stub. The approaches
// bend as they reach the circle, so a stub — short, and square to the circle —
// reads straighter (~14°) than the two through chains read to each other
// (~45°). Pairing by straightness alone therefore hooks a stub to a through
// chain and leaves the road in two mismatched halves; the longest pair must win
// so the through chains join and the stubs are left to each other.
const split = [34.9997, -73], joinN = [35.0003, -73];
const dividedRing = prepareRoads([
    roundabout(300, 35, -73),
    way(301, 'Divided Road', [[34.9985, -73.0008], split]),              // south approach
    way(302, 'Divided Road', [split, ringNode(35, -73, 210)]),           // south carriageway
    way(303, 'Divided Road', [ringNode(35, -73, 150), split]),           // south carriageway back
    way(304, 'Divided Road', [ringNode(35, -73, 30), joinN]),            // north carriageway
    way(305, 'Divided Road', [joinN, ringNode(35, -73, 330)]),           // north carriageway back
    way(306, 'Divided Road', [joinN, [35.002, -73.0008]]),               // north approach
]);
const longest = dividedRing.slice().sort((a, b) => legLen(b) - legLen(a))[0];
const ends = [longest.pts[0].lat, longest.pts[longest.pts.length - 1].lat].sort();
assert(Math.abs(ends[0] - 34.9985) < 1e-6 && Math.abs(ends[1] - 35.002) < 1e-6,
    `roundabout: the through carriageways join across the divided approach (${legLen(longest).toFixed(0)} m, ` +
    `${ends[0].toFixed(4)} -> ${ends[1].toFixed(4)})`);

import { resample, analyzeRoad, segmentSustained, sustainedGrade, bestSustainedWindow, sustainedStretches, hardestClimb, hardestClimbs, grindMask, longestIncline, longestInclines, longestInclinePaths, haversine, SAMPLE_STEP } from '../metrics.js';
import { abbrevName, shortLabel, popupHtml } from '../render.js';
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

// Popup segment grade: signed against the container it sits in, so a segment
// that drops inside a climb doesn't read like one that rises. The reference is
// the container's direction, NOT the road's stored point order — the same
// physical road stored either way must report the same sign.
const dipRoad = dir => {
    const elev = [100, 103, 102, 106, 109];
    const samples = [0, 25, 50, 75, 100].map(d => ({ lat: 35, lon: -82, d }));
    const e = dir > 0 ? elev : [...elev].reverse();
    return {
        name: 'Dip Road', samples, elev: e,
        climbs: [{ i: 0, j: 4, gain: 9, span: 100, grade: 0.09 }],
    };
};
const pctOf = html => html.match(/segment<\/span><b>(-?[\d.]+%)/)?.[1];
// Forward: segment 1 falls 1 m over 25 m inside a climb that rises.
assert(pctOf(popupHtml(dipRoad(1), null, 250, 1, 'climb')) === '-4.0%',
    `popup: a reversing segment reads negative (${pctOf(popupHtml(dipRoad(1), null, 250, 1, 'climb'))})`);
assert(pctOf(popupHtml(dipRoad(1), null, 250, 0, 'climb')) === '12.0%',
    'popup: a segment with the climb keeps its bare magnitude');
// Stored backwards, the same dip is segment 2 and rises in point order; the
// climb now falls in point order, so the sign must still be negative.
assert(pctOf(popupHtml(dipRoad(-1), null, 250, 2, 'climb')) === '-4.0%',
    `popup: the sign follows the climb, not the stored order (${pctOf(popupHtml(dipRoad(-1), null, 250, 2, 'climb'))})`);
// No directed container (an unranked road in sustained mode): no sign to give.
const plain = { name: 'Plain St', samples: dipRoad(1).samples, elev: dipRoad(1).elev, segs: [0.12, 0.04, 0.16, 0.12] };
assert(pctOf(popupHtml(plain, null, 250, 1, 'sustained')) === '4.0%',
    `popup: an unsigned segment keeps its magnitude (${pctOf(popupHtml(plain, null, 250, 1, 'sustained'))})`);

// Street View link: stand at the LOW end of the clicked segment and face the
// high end, whichever way the road's points happen to run, tilted by the grade.
// A 25 m segment climbing 2.5 m due north at 35N: heading 0, pitch ~5.7.
const nsRoad = {
    name: 'North St',
    samples: [{ lat: 35, lon: -82, d: 0 }, { lat: 35.000225, lon: -82, d: 25 }],
    elev: [100, 102.5],
    segs: [0.10],
};
const svOf = html => Object.fromEntries(new URL(html.match(/href="([^"]+)"/)[1].replace(/&amp;/g, '&')).searchParams);
const north = svOf(popupHtml(nsRoad, null, 250, 0, 'sustained'));
assert(north.map_action === 'pano' && north.api === '1',
    `street view: a pano URL (${JSON.stringify(north)})`);
assert(north.viewpoint === '35.000000,-82.000000' && Math.abs(+north.heading) < 1,
    `street view: stands at the foot facing uphill (${north.viewpoint} @ ${north.heading}°)`);
assert(Math.abs(+north.pitch - 5.7) < 0.3, `street view: tilted by the grade (${north.pitch}°)`);
// Same physical segment, points stored the other way: the camera must not flip
// to the top looking down.
const southRoad = { ...nsRoad, samples: [{ lat: 35.000225, lon: -82, d: 0 }, { lat: 35, lon: -82, d: 25 }], elev: [102.5, 100] };
const south = svOf(popupHtml(southRoad, null, 250, 0, 'sustained'));
assert(south.viewpoint === '35.000000,-82.000000' && Math.abs(+south.heading) < 1,
    `street view: stored backwards, still from the foot (${south.viewpoint} @ ${south.heading}°)`);

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

// sustainedStretches: distinct steep sections (warm runs of the window
// metric) rank separately; a uniform hill is ONE stretch, and a road whose
// best falls below the threshold still yields its single best window.
{
    const long = resample([{ lat: 35, lon: -82.6 }, { lat: 35.027, lon: -82.6 }]); // ~3 km due north
    // Two steep sections (10% and 7%, ~700 m each) separated by ~800 m of flat.
    const twoElev = analyzeRoad(long, long.map(s =>
        s.d < 700 ? s.d * 0.10 :
        s.d < 1500 ? 70 :
        s.d < 2200 ? 70 + (s.d - 1500) * 0.07 : 119)).elev;
    const two = sustainedStretches(long, twoElev, 250, 0.05);
    assert(two.length === 2, `two separated sections -> two stretches (got ${two.length})`);
    assert(Math.abs(two[0].grade - 0.10) < 0.01 && Math.abs(two[1].grade - 0.07) < 0.01,
        `stretches steepest-first: ${(two[0].grade * 100).toFixed(1)}%, ${(two[1].grade * 100).toFixed(1)}%`);
    assert(two[0].j <= two[1].i || two[1].j <= two[0].i, 'stretch extents do not overlap');
    const uniform = sustainedStretches(long, analyzeRoad(long, long.map(s => s.d * 0.08)).elev, 250, 0.05);
    assert(uniform.length === 1, `a uniformly steep road is one stretch (got ${uniform.length})`);
    const gentle = sustainedStretches(long, analyzeRoad(long, long.map(s => s.d * 0.03)).elev, 250, 0.05);
    assert(gentle.length === 1 && Math.abs(gentle[0].grade - 0.03) < 0.005,
        `below-threshold road falls back to its best window (${(gentle[0].grade * 100).toFixed(1)}%)`);
    // Within ONE warm run (nothing dips under 5%), a marked dip in the window
    // grade splits stretches by prominence: 10% and 9% hills joined by a 5.5%
    // saddle are two stretches...
    const dipElev = analyzeRoad(long, long.map(s =>
        s.d < 500 ? s.d * 0.10 :
        s.d < 1500 ? 50 + (s.d - 500) * 0.055 :
        s.d < 2000 ? 105 + (s.d - 1500) * 0.09 : 150)).elev;
    const dipped = sustainedStretches(long, dipElev, 250, 0.05);
    assert(dipped.length === 2 && Math.abs(dipped[0].grade - 0.10) < 0.01 && Math.abs(dipped[1].grade - 0.09) < 0.01,
        `in-run dip splits stretches (got ${dipped.map(s => (s.grade * 100).toFixed(1) + '%').join(', ')})`);
    // ...while a mere shoulder (10% easing to 9%, no dip) stays one stretch.
    const shoulderElev = analyzeRoad(long, long.map(s =>
        s.d < 500 ? s.d * 0.10 : s.d < 1500 ? 50 + (s.d - 500) * 0.09 : 140)).elev;
    const shoulder = sustainedStretches(long, shoulderElev, 250, 0.05);
    assert(shoulder.length === 1,
        `a shoulder without a dip is one stretch (got ${shoulder.map(s => (s.grade * 100).toFixed(1) + '%').join(', ')})`);
}

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

// Grind mask: a 4% monotonic km qualifies (span threshold 1000 m); a 1% km and
// a 2.4% km (just under the 3% GRIND_MIN_GRADE) don't, nor does a rolling
// profile with real dips.
const grind = grindMask(flat, mkElev(d => d * 0.04), 1000);
assert(grind && grind.reduce((s, v) => s + v, 0) >= flat.length - 3, 'steady 4% km is a grind');
assert(grindMask(flat, mkElev(d => d * 0.01), 1000) === null, '1% km is not a grind');
assert(grindMask(flat, mkElev(d => d * 0.024), 1000) === null, '2.4% km is below the 3% threshold -> not a grind');
assert(grindMask(flat, mkElev(d => d * 0.03 + 8 * Math.sin(d / 50)), 1000) === null,
    'rolling profile with real dips is not a grind');
// Flat-then-wall: the qualifying 1 km interval is half flat and half a 500 m
// wall — the coherent incline itself is shorter than the threshold, so no
// long-incline mark survives at all (the wall gets steepness paint anyway).
assert(grindMask(flat, mkElev(d => Math.max(0, d - 500) * 0.1), 1000) === null,
    'flat-then-wall leaves no long-incline mark (incline itself too short)');
// Dead-run cap: an incline may not stall for more than 400 m. A 3 km road that
// climbs 1 km at 6%, sits flat for 500 m, then climbs 1 km at 6% is two climbs
// with a plateau between, not one 2.5 km incline — the qualifying interval
// averages 4.8% and its counter-slope is nil, so only the dead run rejects it.
const plateau = resample([{ lat: 35, lon: -82.35 }, { lat: 35.027, lon: -82.35 }]); // ~3 km
const plateauElev = d => (d <= 1000 ? d * 0.06 : d <= 1500 ? 60 : 60 + (d - 1500) * 0.06);
const twoClimbs = analyzeRoad(plateau, plateau.map(s => plateauElev(s.d))).elev;
const plateauInclines = longestInclines(plateau, twoClimbs, 800);
const spansPlateau = i => plateau[i.i].d < 1000 && plateau[i.j].d > 1500;
assert(plateauInclines.length === 2 && !plateauInclines.some(spansPlateau),
    `500 m plateau splits the road into two inclines (${plateauInclines.map(i => `${plateau[i.i].d.toFixed(0)}–${plateau[i.j].d.toFixed(0)} m`).join(', ') || 'none'})`);
assert(plateauInclines.every(i => Math.abs(i.grade - 0.06) < 0.005),
    `each side reports its own 6% (${plateauInclines.map(i => (i.grade * 100).toFixed(1) + '%').join(', ')})`);
// A 200 m breather is under the cap, so the same road still reads as one incline.
const shortRest = analyzeRoad(plateau, plateau.map(s =>
    (s.d <= 1000 ? s.d * 0.06 : s.d <= 1200 ? 60 : 60 + (s.d - 1200) * 0.06))).elev;
const oneIncline = longestInclines(plateau, shortRest, 800);
assert(oneIncline.length === 1 && oneIncline[0].span > 2500,
    `a 200 m rest stays one incline (${oneIncline.map(i => i.span.toFixed(0) + ' m').join(', ') || 'none'})`);

// A summit is not a stall. On a run holding a whole hill, every metre of the
// climb "fails to advance" the descent (and vice versa), so applying the
// dead-run cap before the run is known to head one way deleted the descent
// outright — Brighton Road, Pittsburgh: a clean 822 m at 5% that vanished.
const overHill = resample([{ lat: 35, lon: -82.3 }, { lat: 35.027, lon: -82.3 }]); // ~3 km
const overHillElev = analyzeRoad(overHill, overHill.map(s => 100 - Math.abs(s.d - 1500) * 0.05)).elev;
const hillSides = longestInclines(overHill, overHillElev, 800);
assert(hillSides.length === 2 && hillSides.every(i => i.span > 1400),
    `hill reports both sides (${hillSides.map(i => i.span.toFixed(0) + ' m').join(', ') || 'none'})`);
assert(hillSides.every(i => Math.abs(i.grade - 0.05) < 0.005),
    `each side of the hill reads 5% (${hillSides.map(i => (i.grade * 100).toFixed(1) + '%').join(', ')})`);

// An incline must not begin or end on road running the other way. A 100 m dip
// hangs off the bottom of a 1 km climb: the whole thing still averages over 3%,
// so the interval qualifies, and trimming ends by |grade| alone kept the dip —
// it padded the span while subtracting from the gain, and the popup opened on a
// negative segment. The reported run must start at the low point instead.
const hookRoad = resample([{ lat: 35, lon: -82.5 }, { lat: 35.0099, lon: -82.5 }]); // ~1.1 km
const hookElev = analyzeRoad(hookRoad, hookRoad.map(s =>
    (s.d <= 100 ? 100 - s.d * 0.08 : 92 + (s.d - 100) * 0.06))).elev;   // 8% down, then 6% up
const hooked = longestInclines(hookRoad, hookElev, 800);
const startsUp = i => hookElev[i.i + 1] > hookElev[i.i] && hookElev[i.j] > hookElev[i.j - 1];
assert(hooked.length === 1 && startsUp(hooked[0]),
    `an incline starts where it starts inclining (${hooked.map(i => `${hookRoad[i.i].d.toFixed(0)}–${hookRoad[i.j].d.toFixed(0)} m`).join(', ') || 'none'})`);
assert(hooked[0].i > 0 && Math.abs(hooked[0].grade - 0.06) < 0.006,
    `the trimmed run reads its own 6%, not the dip-diluted average (${(hooked[0].grade * 100).toFixed(1)}%)`);

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
const li = longestIncline(flat, mkElev(d => d * 0.03), 1000);
assert(li && li.span > 900 && Math.abs(li.grade - 0.03) < 0.006, `longest incline ${li && li.span.toFixed(0)} m @ ${li && (li.grade * 100).toFixed(1)}%`);
assert(longestIncline(flat, mkElev(d => d * 0.01), 1000) === null, 'no qualifying incline -> null');
const vElev = analyzeRoad(vRoad, vRoad.map(s => Math.abs(s.d - 1500) * 0.03)).elev;
const vLong = longestIncline(vRoad, vElev, 1000);
assert(vLong && vLong.span > 1000, `V road's longest incline side is ~1.5 km (${vLong && vLong.span.toFixed(0)} m)`);
// Both sides of the V qualify individually — two opposite-direction inclines
// meeting at the valley floor each rank, on the same road.
const vBoth = longestInclines(vRoad, vElev, 1000);
assert(vBoth.length === 2 && vBoth.every(r => r.span > 1000),
    `V road reports both sides (${vBoth.map(r => r.span.toFixed(0)).join(', ')} m)`);
const vPicked = longestInclinePaths([{ id: 'v', name: 'V Rd', unnamed: false, samples: vRoad, elev: vElev }], 1000, 1);
assert(vPicked.length === 2 && vPicked[0].roads[0] === vPicked[1].roads[0],
    `one road can rank two inclines (${vPicked.length} found)`);

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

// Underpasses: the mirror of the bridge case. A road crossed by a bridge deck
// with no shared node passes underneath, and its elevation samples read the deck
// overhead. Modelled on Fordham Blvd over Raleigh Rd, Chapel Hill, where the
// terrarium tiles put a ~6 m hump (a fake ~14 % pitch) on a flat street.
const eastWest = (id, lat, tags = {}) => ({
    type: 'way', id, tags: { highway: 'residential', name: 'Under St', ...tags },
    geometry: [{ lat, lon: -82.3 }, { lat, lon: -82.29 }],   // ~900 m due east
});
const deckOver = (id, lon, tags = {}) => ({
    type: 'way', id, tags: { highway: 'motorway', bridge: 'yes', layer: '1', ...tags },
    geometry: [{ lat: 34.998, lon }, { lat: 35.002, lon }],  // crosses north-south
});
const underRoad = prepareRoads([eastWest(20, 35)])[0];
const overIdx = bridgeIndex([deckOver(21, -82.295)]);
const under = markUnderpasses(underRoad.pts, resample(underRoad.pts), overIdx);
const marked = under.filter(s => s.b);
const crossD = under[under.length - 1].d / 2;   // deck crosses the midpoint
assert(marked.length >= 3 && marked.every(s => Math.abs(s.d - crossD) <= 45),
    `underpass flags the crossing and only its surroundings (${marked.length} samples)`);
assert(prepareRoads([eastWest(20, 35), deckOver(21, -82.295)]).length === 1,
    'the overpass itself is not ranked as a road');
// The hump the deck leaves in the elevation model must interpolate away.
const humped = under.map(s => 100 + 6 * Math.max(0, 1 - Math.abs(s.d - crossD) / 45));
const humpFixed = analyzeRoad(under, humped).elev;
const humpRaw = analyzeRoad(under.map(({ lat, lon, d }) => ({ lat, lon, d })), humped).elev;
assert(Math.max(...humpFixed) - Math.min(...humpFixed) < 1,
    `deck hump interpolated away (${(Math.max(...humpFixed) - Math.min(...humpFixed)).toFixed(1)} m left of 6 m)`);
assert(Math.max(...humpRaw) - Math.min(...humpRaw) > 5, 'sanity: the untreated hump is really there');
// At-grade crossings share a node, so the ways touch instead of crossing: a
// deck that merely ends on the road (an abutment at a junction) means nothing.
const touching = markUnderpasses(underRoad.pts, resample(underRoad.pts),
    bridgeIndex([{ ...deckOver(22, -82.295), geometry: [{ lat: 35, lon: -82.295 }, { lat: 35.002, lon: -82.295 }] }]));
assert(!touching.some(s => s.b), 'a deck ending on the road (shared node) is not an underpass');
// Contradictory data — a bridge tagged at or below the roadway — is ignored.
assert(!markUnderpasses(underRoad.pts, resample(underRoad.pts),
    bridgeIndex([deckOver(23, -82.295, { layer: '-1' })])).some(s => s.b),
    'a bridge tagged below the roadway is not treated as an overpass');
// A road already flagged (its own deck or bore) is left to the bridge logic.
const ownDeck = prepareRoads([eastWest(24, 35, { bridge: 'yes' })])[0];
assert(resample(ownDeck.pts).every(s => s.b),
    'a road on its own bridge keeps every sample flagged either way');

// Fixtures store the same processed-road shape the IndexedDB cache versions,
// but are read straight off disk, so nothing else would notice one going stale.
const fixtures = Object.fromEntries(['brevard', 'underpass', 'roundabout'].map(n =>
    [n, JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8'))]));
for (const [n, f] of Object.entries(fixtures)) {
    assert(f.version === VERSION_TAG,
        `${n} fixture matches pipeline v${VERSION_TAG}` +
        (f.version === VERSION_TAG ? '' : ` — captured at v${f.version ?? 'none'}, recapture it`));
    // Rebuild the underpass flags through the live code over the fixture's own
    // geometry and decks. Comparing stored flags against stored flags would only
    // restate what was captured; this fails if markUnderpasses itself regresses.
    const decks = bridgeIndex(f.decks);
    let checked = 0, flagged = 0, mismatch = null;
    for (const r of f.roads) {
        const rebuilt = markUnderpasses(r.pts, resample(r.pts), decks);
        if (rebuilt.length !== r.samples.length)
            continue;   // 6-decimal rounding can shift a sample count by one
        checked++;
        for (let i = 0; i < rebuilt.length; i++) {
            if (!!rebuilt[i].b !== !!r.samples[i].b)
                mismatch ??= `${r.name} sample ${i} (fresh ${!!rebuilt[i].b}, stored ${!!r.samples[i].b})`;
            if (rebuilt[i].b && !r.pts.some(p => p.b))
                flagged++;
        }
    }
    assert(checked > f.roads.length - 3 && !mismatch,
        `${n}: ${checked} roads re-flagged by a fresh markUnderpasses run, all matching${mismatch ? ` — except ${mismatch}` : ''}`);
    assert(n === 'brevard' ? flagged === 0 : flagged > 0,
        `${n}: ${flagged} underpass flags rebuilt from source (${n === 'brevard' ? 'none expected' : 'roads under decks'})`);
}

// The real case, from the committed fixture (processed offline, no network):
// Raleigh Rd under Fordham Blvd. Untreated, the terrarium tiles read 88.7 m ->
// 94.3 m -> 90.2 m across the interchange — a ~22 % segment grade on a street
// that is nearly flat there.
const fixture = fixtures.underpass;
const raleigh = fixture.roads
    .filter(r => r.name === 'Raleigh Road')
    .find(r => r.samples.some(s => Math.hypot(s.lat - 35.90879, s.lon + 79.02690) < 3e-4));
const nearCross = raleigh.samples
    .map((s, i) => ({ i, s, off: Math.hypot((s.lat - 35.90879) * 111320, (s.lon + 79.02690) * 90000) }))
    .filter(x => x.off < 120);
assert(nearCross.some(x => x.s.b), 'fixture: Raleigh Rd is flagged where Fordham Blvd crosses it');
const underGrades = nearCross.slice(0, -1)
    .map(x => Math.abs(raleigh.elev[x.i + 1] - raleigh.elev[x.i]) / (raleigh.samples[x.i + 1].d - x.s.d));
assert(Math.max(...underGrades) < 0.04,
    `fixture: no fake pitch left under the interchange (${(Math.max(...underGrades) * 100).toFixed(1)}%)`);

// The real roundabout case, from its own fixture: Mount Carmel Church Rd at
// Bennett Rd, Chapel Hill. OSM severs the road at the circle — the two halves
// meet it at nodes ~36 m apart, sharing none — so it used to rank as a 3.9 km
// piece plus a 0.6 km piece, and the descent through the circle was clipped to
// the 800 m south of it. Stitched through, the same descent reads 1.3 km.
const rbFixture = fixtures.roundabout;
const CIRCLE = { lat: 35.886650, lon: -79.057230 };
const carmel = rbFixture.roads.filter(r => r.name === 'Mount Carmel Church Road');
const carmelThrough = carmel.filter(r => r.length > 1000);
assert(carmelThrough.length === 1 && carmelThrough[0].length > 4000,
    `fixture: Mount Carmel Church Rd is one road through the roundabout ` +
    `(${carmel.map(r => (r.length / 1000).toFixed(2) + ' km').join(' + ')})`);
// The circle is a junction, so nothing in the fixture stands on it as a road:
// the only pavement there belongs to the roads stitched through it.
const onCircle = rbFixture.roads.filter(r =>
    r.samples.every(s => haversine(s, CIRCLE) < 40) && haversine(r.samples[0], r.samples[r.samples.length - 1]) < 10);
assert(onCircle.length === 0, `fixture: the circle is not ranked as a road (${onCircle.map(r => r.name)})`);

// The incline that used to be cut in half: it runs through the circle, and
// neither severed side reaches nearly as far on its own — cut at the circle,
// this descent is ~800 m of the road's south piece (what the app used to
// report) and nothing at all on the north piece.
const carmelSamples = carmelThrough[0].samples;
const atCircle = carmelSamples.map((s, i) => i).filter(i => haversine(carmelSamples[i], CIRCLE) < 40);
const crossing = longestInclines(carmelSamples, carmelThrough[0].elev, 800)
    .find(r => atCircle.some(k => k > r.i && k < r.j));
assert(crossing && crossing.span > 1250,
    `fixture: the incline through the roundabout is reported whole (${crossing ? Math.round(crossing.span) + ' m' : 'not found'})`);
const cutLo = atCircle[0], cutHi = atCircle[atCircle.length - 1] + 1;
const severed = [
    { offset: 0, samples: carmelSamples.slice(0, cutLo), elev: carmelThrough[0].elev.slice(0, cutLo) },
    {
        offset: cutHi,
        samples: carmelSamples.slice(cutHi).map(s => ({ ...s, d: s.d - carmelSamples[cutHi].d })),
        elev: carmelThrough[0].elev.slice(cutHi),
    },
];
let severedBest = 0;
for (const side of severed)
    for (const run of longestInclines(side.samples, side.elev, 800))
        // Only runs over the same stretch of road count — the road's other
        // incline, well south of the circle, was never affected by the split.
        if (run.i + side.offset < crossing.j && run.j + side.offset > crossing.i)
            severedBest = Math.max(severedBest, run.span);
assert(crossing.span - severedBest > 400,
    `fixture: joining the halves lengthens that incline (${Math.round(crossing.span)} m joined vs ` +
    `${severedBest ? Math.round(severedBest) + ' m' : 'nothing over the 800 m bar'} severed)`);

// The real case for signed segment grades, from the Brevard fixture: White
// Squirrel Lane's 820 m long incline averages 12 % but dips 6.8 % partway up.
// Printed as a magnitude that reads as ordinary climbing, directly under a row
// calling the whole run an incline. (Reversals at the ENDS are trimmed off the
// incline entirely — see the grind-mask checks below — so only interior ones
// survive to be signed.)
const squirrel = fixtures.brevard.roads.find(r => r.name === 'White Squirrel Lane');
const squirrelInc = longestInclines(squirrel.samples, squirrel.elev, 800)[0];
const inclineRoad = {
    ...squirrel,
    rankedSpans: [{ i: squirrelInc.i, j: squirrelInc.j, rank: 1, gain: squirrelInc.gain, span: squirrelInc.span, grade: squirrelInc.grade }],
};
const segPct = k => popupHtml(inclineRoad, null, 250, k, 'incline').match(/segment<\/span><b>(-?[\d.]+%)/)?.[1];
const squirrelDir = Math.sign(squirrel.elev[squirrelInc.j] - squirrel.elev[squirrelInc.i]);
const dipSeg = (() => {
    for (let k = squirrelInc.i; k < squirrelInc.j; k++)
        if (squirrelDir * (squirrel.elev[k + 1] - squirrel.elev[k]) < 0)
            return k;
    return null;
})();
assert(segPct(dipSeg) === '-6.8%',
    `fixture: the segment falling inside White Squirrel Ln's incline reads negative (${segPct(dipSeg)})`);
assert(segPct(squirrelInc.i)?.startsWith('-') === false,
    `fixture: a segment climbing with that incline stays unsigned (${segPct(squirrelInc.i)})`);

// Real profiles are noisier than any synthetic one, so hold the rule over every
// incline in every fixture: none may open or close on a segment running against
// it. Before the ends were trimmed by direction, 4 of Brevard's 5 did.
let endChecked = 0, badEnd = null;
for (const [n, f] of Object.entries(fixtures))
    for (const r of f.roads) {
        if (r.samples.length < 3)
            continue;
        for (const inc of longestInclines(r.samples, r.elev, 800)) {
            const dir = Math.sign(r.elev[inc.j] - r.elev[inc.i]);
            const pct = k => dir * (r.elev[k + 1] - r.elev[k]) / (r.samples[k + 1].d - r.samples[k].d) * 100;
            endChecked++;
            for (const k of [inc.i, inc.j - 1])
                if (pct(k) < 0)
                    badEnd ??= `${n}/${r.name} segment ${k} at ${pct(k).toFixed(1)}%`;
        }
    }
assert(endChecked > 5 && !badEnd,
    `fixtures: all ${endChecked} inclines begin and end on inclining road${badEnd ? ` — except ${badEnd}` : ''}`);

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
