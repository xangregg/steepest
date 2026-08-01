// Capture a real search as a canned fixture so the app can be checked offline
// (no Overpass/tiles). Writes test/fixtures/<name>.json in the same processed
// shape the IndexedDB cache stores, plus the center/radius. Load it in the app
// with #fixture=<name>. Regenerate with, e.g.:
//   node test/make-fixture.mjs "Brevard, NC" 2000 brevard
import { PNG } from 'pngjs';
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parseLatLon, geocode, fetchRoads, prepareRoads, bridgeIndex, bridgeWays, markUnderpasses } from '../roads.js';
import { VERSION_TAG } from '../cache.js';
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

// Coordinates accepted as well as place names, so a fixture can be centred on a
// specific feature (an underpass, say) that no place name lands on.
const center = parseLatLon(query) ?? await geocode(query);
console.log(`centred on: ${center.label}`);
const elements = await fetchRoads(center, radiusM);
const decks = bridgeIndex(elements);
const roads = prepareRoads(elements)
    .map(r => ({ ...r, samples: markUnderpasses(r.pts, resample(r.pts), decks) }))
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
    // Stamped so a fixture captured by an older pipeline can be spotted rather
    // than rendering silently stale (the app says so; unit.test.mjs fails).
    version: VERSION_TAG,
    center: { lat: center.lat, lon: center.lon, label: center.label },
    radiusM,
    // The bridge decks the underpass pass was run against, so a test can rebuild
    // the flags through the live code instead of trusting the captured ones.
    decks: bridgeWays(elements).map(el => ({
        type: 'way', id: el.id,
        tags: el.tags.layer != null ? { bridge: el.tags.bridge, layer: el.tags.layer } : { bridge: el.tags.bridge },
        geometry: el.geometry.map(g => ({ lat: r6(g.lat), lon: r6(g.lon) })),
    })),
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
console.log(`wrote ${fixture.roads.length} roads and ${fixture.decks.length} bridge decks to ${path}`);
