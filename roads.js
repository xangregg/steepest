// Location lookup (Nominatim) and road fetching (Overpass), plus stitching of
// same-name OSM ways into continuous roads.

import { haversine } from './metrics.js';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
];

// Road classes worth ranking. Excludes service (driveways, parking aisles),
// tracks, and paths.
const HIGHWAY_RE = 'residential|unclassified|living_street|tertiary|secondary|primary|trunk';

// "35.2, -82.7" -> {lat, lon, label} or null if the text isn't a coordinate pair.
export function parseLatLon(text) {
    const m = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) return null;
    const lat = +m[1], lon = +m[2];
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon, label: `${lat.toFixed(4)}, ${lon.toFixed(4)}` };
}

const GEO_TTL_MS = 30 * 24 * 3600 * 1000;

export async function geocode(query, signal) {
    // localStorage cache: results are tiny, and it spares Nominatim (and its
    // rate limit) on every repeat search. try/catch also covers environments
    // without localStorage (Node tests, private browsing).
    const cacheKey = 'steepest.geo:' + query.toLowerCase().replace(/\s+/g, ' ').trim();
    try {
        const hit = JSON.parse(localStorage.getItem(cacheKey));
        if (hit && Date.now() - hit.t < GEO_TTL_MS) return hit;
    } catch { /* cache miss */ }

    const url = `${NOMINATIM}?format=json&limit=1&q=${encodeURIComponent(query)}`;
    // Nominatim's usage policy wants an identifying UA; browsers set their own.
    const opts = { signal };
    if (typeof window === 'undefined') opts.headers = { 'User-Agent': 'steepest-roads/1.0 (dev test)' };
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`Geocoding failed (HTTP ${res.status})`);
    const hits = await res.json();
    if (!hits.length) throw new Error(`No place found for “${query}”`);
    const result = { lat: +hits[0].lat, lon: +hits[0].lon, label: hits[0].display_name };
    try { localStorage.setItem(cacheKey, JSON.stringify({ ...result, t: Date.now() })); } catch { /* best effort */ }
    return result;
}

// All drivable roads within radiusM of center, as raw Overpass way elements.
export async function fetchRoads(center, radiusM, signal) {
    const q = `[out:json][timeout:90];
way["highway"~"^(${HIGHWAY_RE})$"](around:${Math.round(radiusM)},${center.lat},${center.lon});
out geom;`;
    let lastErr;
    // Two passes over the mirrors with a pause between: public Overpass
    // instances rate-limit readily (HTTP 429), and a short wait usually clears it.
    for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt) await new Promise(res => setTimeout(res, 8000));
        for (const endpoint of OVERPASS_ENDPOINTS) {
            try {
                const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
                if (typeof window === 'undefined') headers['User-Agent'] = 'steepest-roads/1.0 (dev test)';
                const res = await fetch(endpoint, { method: 'POST', headers, body: 'data=' + encodeURIComponent(q), signal });
                if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
                const json = await res.json();
                return json.elements ?? [];
            } catch (err) {
                if (err.name === 'AbortError') throw err;
                lastErr = err;
            }
        }
    }
    throw new Error(`Road query failed: ${lastErr?.message ?? 'unknown error'} — the public Overpass servers may be busy; try again in a minute.`);
}

// Raw Overpass elements -> [{id, name, pts:[{lat,lon}]}], with same-name ways
// stitched end-to-end. Bridge/tunnel points are flagged (b): the elevation
// model shows the terrain under/over the span, not the roadway, so their
// elevations get interpolated later (metrics.js) — but the way itself is kept
// so a creek crossing doesn't sever the road and truncate its climbs.
export function prepareRoads(elements) {
    const ways = elements
        .filter(el => el.type === 'way' && el.geometry?.length >= 2)
        .map(el => {
            const b = !!(el.tags?.bridge || el.tags?.tunnel);
            return {
                id: el.id,
                name: el.tags?.name ?? null,
                // TIGER-imported names often drop the street type ("Morehead"
                // for both Morehead Dr and Hoey Rd); keep the import's own
                // base/type so stitching can tell such streets apart.
                base: el.tags?.['tiger:name_base'],
                nameType: el.tags?.['tiger:name_type'],
                pts: el.geometry.map(g => (b ? { lat: g.lat, lon: g.lon, b: true } : { lat: g.lat, lon: g.lon })),
            };
        });

    const byName = new Map();
    const out = [];
    for (const w of ways) {
        if (!w.name) { out.push({ ...w, name: `(unnamed ${w.id})`, unnamed: true }); continue; }
        if (!byName.has(w.name)) byName.set(w.name, []);
        byName.get(w.name).push(w);
    }
    for (const group of byName.values()) out.push(...stitchGroup(group));
    return out;
}

const ptKey = p => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;

const MAX_TURN = (70 * Math.PI) / 180; // sharper joins are treated as corners
const REF_DIST = 20;                   // m inside a way used to measure its bearing

function bearing(a, b) {
    const toR = Math.PI / 180;
    const dLon = (b.lon - a.lon) * toR;
    const y = Math.sin(dLon) * Math.cos(b.lat * toR);
    const x = Math.cos(a.lat * toR) * Math.sin(b.lat * toR) -
        Math.sin(a.lat * toR) * Math.cos(b.lat * toR) * Math.cos(dLon);
    return Math.atan2(y, x);
}

// A point ~REF_DIST m along the way from the given end (immediate neighbors
// can be centimeters away, which makes bearings noisy).
function interiorRef(pts, atStart) {
    const ordered = atStart ? pts : [...pts].reverse();
    let acc = 0;
    for (let i = 1; i < ordered.length; i++) {
        acc += haversine(ordered[i - 1], ordered[i]);
        if (acc >= REF_DIST) return ordered[i];
    }
    return ordered[ordered.length - 1];
}

// Does travel flow roughly straight through the join, rather than turning a
// corner? Distinct streets that share a (often TIGER-mangled) name usually
// meet at right angles; a continuous road carries on.
function straightThrough(wa, aAtStart, wb, bAtStart, joinPt) {
    const dirIn = bearing(interiorRef(wa.pts, aAtStart), joinPt);
    const dirOut = bearing(joinPt, interiorRef(wb.pts, bAtStart));
    let diff = Math.abs(dirIn - dirOut);
    if (diff > Math.PI) diff = 2 * Math.PI - diff;
    return diff <= MAX_TURN;
}

// Repeatedly join two ways whose endpoints coincide — but only where exactly
// two way-ends meet (never guess at a junction of three+ pieces) and only
// where the bearing continues through the join (never chain different streets
// that happen to share a name around a corner).
function stitchGroup(ways) {
    let merged = true;
    while (merged && ways.length > 1) {
        merged = false;
        const ends = new Map();
        ways.forEach((w, i) => {
            for (const p of [w.pts[0], w.pts[w.pts.length - 1]]) {
                const k = ptKey(p);
                if (!ends.has(k)) ends.set(k, []);
                ends.get(k).push({ i, atStart: p === w.pts[0] });
            }
        });
        const conflict = (x, y) => !!(x && y && x !== y);
        for (const list of ends.values()) {
            if (list.length !== 2 || list[0].i === list[1].i) continue;
            const [a, b] = list;
            const wa = ways[a.i], wb = ways[b.i];
            if (conflict(wa.base, wb.base) || conflict(wa.nameType, wb.nameType)) continue;
            const joinPt = a.atStart ? wa.pts[0] : wa.pts[wa.pts.length - 1];
            if (!straightThrough(wa, a.atStart, wb, b.atStart, joinPt)) continue;
            const head = a.atStart ? [...wa.pts].reverse() : wa.pts;
            const tail = b.atStart ? wb.pts : [...wb.pts].reverse();
            const pts = [...head, ...tail.slice(1)];
            // The dropped duplicate (tail[0]) may carry a bridge/tunnel flag the
            // kept junction point lacks — without it, a 2-node tunnel way loses
            // its only segment's flag and its deck elevation never interpolates.
            if (tail[0].b && !pts[head.length - 1].b) {
                pts[head.length - 1] = { ...pts[head.length - 1], b: true };
            }
            const joined = {
                ...wa,
                base: wa.base ?? wb.base,
                nameType: wa.nameType ?? wb.nameType,
                pts,
            };
            ways = ways.filter((_, i) => i !== a.i && i !== b.i);
            ways.push(joined);
            merged = true;
            break;
        }
    }
    return ways;
}
