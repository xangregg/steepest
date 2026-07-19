// Capture a real search as a canned fixture so the app can be checked offline
// (no Overpass/tiles). Writes test/fixtures/<name>.json in the same processed
// shape the IndexedDB cache stores, plus the center/radius. Load it in the app
// with #fixture=<name>. Regenerate with, e.g.:
//   node test/make-fixture.mjs "Brevard, NC" 2000 brevard
import { PNG } from 'pngjs';
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { geocode, fetchRoads, prepareRoads } from '../roads.js';
import { elevatePoints } from '../elevation.js';
import { resample, analyzeRoad } from '../metrics.js';

const [query, radiusStr, name] = process.argv.slice(2);
if (!query || !radiusStr || !name) {
    console.error('usage: node test/make-fixture.mjs "<place>" <radius_m> <name>');
    process.exit(1);
}
const radiusM = +radiusStr;

const decodeTile = async url => {
    const res = await fetch(url);
    if (!res.ok)
        throw new Error(`tile HTTP ${res.status}`);
    return PNG.sync.read(Buffer.from(await res.arrayBuffer())).data;
};

const center = await geocode(query);
console.log(`geocoded: ${center.label}`);
const roads = prepareRoads(await fetchRoads(center, radiusM))
    .map(r => ({ ...r, samples: resample(r.pts) }))
    .filter(r => r.samples.length >= 3);
const points = roads.flatMap(r => r.samples);
const elevs = await elevatePoints(points, { decodeTile });
let offset = 0;
for (const r of roads) {
    Object.assign(r, analyzeRoad(r.samples, Array.from(elevs.subarray(offset, offset + r.samples.length))));
    offset += r.samples.length;
}

// Same fields the cache keeps. Coordinates rounded to 6 decimals (~0.1 m) to
// shrink the file — 5 decimals (~1 m) jittered the centerline enough to make the
// ribbon neck/spike on the fixture where full-precision live data doesn't.
const r6 = v => Math.round(v * 1e6) / 1e6;
const r2 = v => Math.round(v * 100) / 100;
const pt = p => (p.b ? { lat: r6(p.lat), lon: r6(p.lon), b: true } : { lat: r6(p.lat), lon: r6(p.lon) });
const fixture = {
    center: { lat: center.lat, lon: center.lon, label: center.label },
    radiusM,
    roads: roads.map(({ id, name, unnamed, pts, samples, elev, length, eMin, eMax }) => ({
        id, name, unnamed,
        pts: pts.map(pt),
        samples: samples.map(s => (s.b ? { ...pt(s), d: r2(s.d), b: true } : { ...pt(s), d: r2(s.d) })),
        elev: Array.from(elev, r2),
        length: r2(length), eMin: r2(eMin), eMax: r2(eMax),
    })),
};
const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
mkdirSync(dir, { recursive: true });
const path = join(dir, `${name}.json`);
writeFileSync(path, JSON.stringify(fixture));
console.log(`wrote ${fixture.roads.length} roads to ${path}`);
