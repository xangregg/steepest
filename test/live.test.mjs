// Live end-to-end run (real network): geocode a small mountain town via
// Nominatim, pull its roads from Overpass, sample real terrain tiles, and
// sanity-check the sustained-grade ranking. On-demand only
// (`npm run test:live`) — the default `npm test` (unit.test.mjs) needs no
// network. Requires network access and is subject to the public servers'
// rate limits, so it can be slow or need a retry.

import { PNG } from 'pngjs';
import { geocode, fetchRoads, prepareRoads } from '../roads.js';
import { elevatePoints } from '../elevation.js';
import { resample, analyzeRoad, sustainedGrade } from '../metrics.js';
import { assert } from './assert.mjs';

const decodeTile = async url => {
    const res = await fetch(url);
    if (!res.ok)
        throw new Error(`tile HTTP ${res.status} for ${url}`);
    return PNG.sync.read(Buffer.from(await res.arrayBuffer())).data; // flat RGBA
};

// Small mountain town, modest radius to be kind to Overpass.
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
console.log('PASS (live)');
