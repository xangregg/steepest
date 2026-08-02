// Location lookup (Nominatim) and road fetching (Overpass), plus stitching of
// same-name OSM ways into continuous roads.

import { haversine, bearing } from './metrics.js';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
];

// Nominatim's usage policy requires an identifying User-Agent (contact URL
// included so an operator can reach us); Overpass wants one too. Only sent from
// Node — browsers set their own UA and forbid overriding it via fetch. Update
// the URL if the repo slug changes.
const USER_AGENT = 'steepest-roads/1.0 (+https://github.com/xangregg/steepest)';

// Road classes worth ranking. Excludes service (driveways, parking aisles),
// tracks, and paths. Motorways are in: you can't walk or cycle up most of them,
// but leaving the interstate out puts a conspicuous blank through the middle of
// a mountain town's map where one of its steepest, longest grades actually is —
// I-40 over Swannanoa Gap at Black Mountain, NC is 7 km at 5.3 %. Their ramps
// stay out: a link is steep by design and says nothing about the terrain.
const HIGHWAY_RE = 'residential|unclassified|living_street|tertiary|secondary|primary|trunk|motorway';
const RANKED_RE = new RegExp(`^(${HIGHWAY_RE})$`);

// A roundabout is a junction, not a road: OSM gives the circle its own way, so
// every road through it is severed into stubs meeting the circle at different
// nodes. Such ways are kept out of the ranking and used only to stitch the
// severed halves back together (roundaboutNodes / the roundabout pass in
// stitchGroup). junction=circular covers the larger non-priority traffic
// circles, which split a road exactly the same way.
const ROUNDABOUT_RE = /^(roundabout|circular)$/;

// Decks that are never ranked but still have to be fetched: a ranked road
// passing under one reads the deck's elevation instead of its own (see
// markUnderpasses). Ramps are the common overpass, and railways are close
// behind; the motorways themselves now arrive with the ranked classes, and
// bridgeWays() reads decks off every element regardless of class. Asking for
// the bridge-tagged ways only keeps this to tens of kB beside a multi-megabyte
// road network.
const BRIDGE_HIGHWAY_RE = 'motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|service';
// Vehicle- and rail-carrying decks only. A footbridge is too narrow to shift a
// ~15 m elevation cell, so treating one would linearize real road for nothing;
// abandoned/disused railways are left out because the structure may be gone.
const BRIDGE_RAILWAY_RE = 'rail|light_rail|subway|tram|narrow_gauge|monorail|funicular';

// "35.2, -82.7" -> {lat, lon, label} or null if the text isn't a coordinate pair.
export function parseLatLon(text) {
    const m = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    if (!m)
        return null;
    const lat = +m[1], lon = +m[2];
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180)
        return null;
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
        if (hit && Date.now() - hit.t < GEO_TTL_MS)
            return hit;
    }
    catch { /* cache miss */ }

    const url = `${NOMINATIM}?format=json&limit=1&q=${encodeURIComponent(query)}`;
    const opts = { signal };
    if (typeof window === 'undefined')
        opts.headers = { 'User-Agent': USER_AGENT };
    const res = await fetch(url, opts);
    if (!res.ok)
        throw new Error(`Geocoding failed (HTTP ${res.status})`);
    const hits = await res.json();
    if (!hits.length)
        throw new Error(`No place found for “${query}”`);
    const result = { lat: +hits[0].lat, lon: +hits[0].lon, label: hits[0].display_name };
    try {
        localStorage.setItem(cacheKey, JSON.stringify({ ...result, t: Date.now() }));
    }
    catch { /* best effort */ }
    return result;
}

// All drivable roads within radiusM of center, as raw Overpass way elements,
// plus the unranked bridge decks over them (prepareRoads drops those from the
// ranking; bridgeIndex keeps them). onBytes(n) streams download progress;
// onNote(msg) reports retries.
export async function fetchRoads(center, radiusM, { signal, onBytes, onNote } = {}) {
    const around = `(around:${Math.round(radiusM)},${center.lat},${center.lon})`;
    const q = `[out:json][timeout:90];
(
way["highway"~"^(${HIGHWAY_RE})$"]${around};
way["bridge"]["highway"~"^(${BRIDGE_HIGHWAY_RE})$"]${around};
way["bridge"]["railway"~"^(${BRIDGE_RAILWAY_RE})$"]${around};
);
out geom;`;
    let lastErr;
    // Two passes over the mirrors with a pause between: public Overpass
    // instances rate-limit readily (HTTP 429), and a short wait usually clears it.
    for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt) {
            onNote?.('Overpass busy — retrying…');
            await new Promise(res => setTimeout(res, 8000));
        }
        for (const endpoint of OVERPASS_ENDPOINTS) {
            try {
                const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
                if (typeof window === 'undefined')
                    headers['User-Agent'] = USER_AGENT;
                const res = await fetch(endpoint, { method: 'POST', headers, body: 'data=' + encodeURIComponent(q), signal });
                if (!res.ok)
                    throw new Error(`Overpass HTTP ${res.status}`);
                let text;
                if (res.body?.getReader) {
                    // Stream the body so the UI can show live download progress.
                    const reader = res.body.getReader();
                    const decoder = new TextDecoder();
                    let received = 0;
                    text = '';
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done)
                            break;
                        received += value.length;
                        text += decoder.decode(value, { stream: true });
                        onBytes?.(received);
                    }
                    text += decoder.decode();
                }
                else {
                    text = await res.text();
                }
                const json = JSON.parse(text); // an HTML error page here throws -> retry
                return json.elements ?? [];
            }
            catch (err) {
                if (err.name === 'AbortError')
                    throw err;
                lastErr = err;
            }
        }
    }
    throw new Error(`Road query failed: ${lastErr?.message ?? 'unknown error'} — the public Overpass servers may be busy; try again in a minute.`);
}

// A motorway carries no name in OSM, only a route number — and where routes run
// together, several ("I 40;US 70"). The first is the primary designation, and
// taking just that both labels the road and keeps its chain intact: stitching
// groups by name, so using the raw tag would sever I-40 at the point US 70
// joins it. Rural state routes are unnamed the same way, so this rescues them
// from "(unnamed 51640822)" too.
const refName = ref => ref?.split(';')[0].trim() || null;

// Raw Overpass elements -> [{id, name, pts:[{lat,lon}]}], with same-name ways
// stitched end-to-end (and through roundabouts, which are themselves dropped —
// a junction is not a road to rank). Bridge/tunnel points are flagged (b): the
// elevation model shows the terrain under/over the span, not the roadway, so their
// elevations get interpolated later (metrics.js) — but the way itself is kept
// so a creek crossing doesn't sever the road and truncate its climbs.
export function prepareRoads(elements) {
    const rings = roundaboutNodes(elements);
    const ways = elements
        // The response also carries unranked decks (ramp, railway) fetched only
        // so underpasses can be found — they are not roads to rank, and neither
        // are roundabout circles.
        .filter(el => el.type === 'way' && el.geometry?.length >= 2 && RANKED_RE.test(el.tags?.highway ?? '')
            && !ROUNDABOUT_RE.test(el.tags?.junction ?? ''))
        .map(el => {
            const b = !!(el.tags?.bridge || el.tags?.tunnel);
            return {
                id: el.id,
                name: el.tags?.name ?? refName(el.tags?.ref),
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
        if (!w.name) {
            out.push({ ...w, name: `(unnamed ${w.id})`, unnamed: true });
            continue;
        }
        if (!byName.has(w.name))
            byName.set(w.name, []);
        byName.get(w.name).push(w);
    }
    for (const group of byName.values())
        out.push(...stitchGroup(group, rings));
    return out;
}

const ptKey = p => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;

// --- Roundabouts -----------------------------------------------------------

// Chain roundabout ways that share an endpoint: a big circle is often mapped as
// several arcs, and the pavement between two legs may span more than one of
// them. No bearing gate — anything tagged as one circle belongs to it.
function chainArcs(arcs) {
    const closed = a => ptKey(a[0]) === ptKey(a[a.length - 1]);
    let merged = true;
    while (merged) {
        merged = false;
        for (let i = 0; i < arcs.length && !merged; i++) {
            const a = arcs[i];
            if (closed(a))
                continue;
            for (let j = i + 1; j < arcs.length && !merged; j++) {
                const b = arcs[j];
                if (closed(b))
                    continue;
                const [aHead, aTail] = [ptKey(a[0]), ptKey(a[a.length - 1])];
                const [bHead, bTail] = [ptKey(b[0]), ptKey(b[b.length - 1])];
                let joined = null;
                if (aTail === bHead)
                    joined = [...a, ...b.slice(1)];
                else if (aTail === bTail)
                    joined = [...a, ...[...b].reverse().slice(1)];
                else if (aHead === bTail)
                    joined = [...b, ...a.slice(1)];
                else if (aHead === bHead)
                    joined = [...[...b].reverse(), ...a.slice(1)];
                if (!joined)
                    continue;
                arcs = arcs.filter((_, k) => k !== i && k !== j);
                arcs.push(joined);
                merged = true;
            }
        }
    }
    return arcs;
}

// Index of every roundabout node in the response: ptKey -> {ring, i}, where
// ring is the whole circle as a polyline with cumulative distances, so the
// pavement between two legs can be measured and both ways round compared.
function roundaboutNodes(elements) {
    const arcs = elements
        .filter(el => el.type === 'way' && el.geometry?.length >= 2 && ROUNDABOUT_RE.test(el.tags?.junction ?? ''))
        .map(el => {
            const b = !!(el.tags.bridge || el.tags.tunnel);
            return el.geometry.map(g => (b ? { lat: g.lat, lon: g.lon, b: true } : { lat: g.lat, lon: g.lon }));
        });
    const at = new Map();
    for (const pts of chainArcs(arcs)) {
        const cum = [0];
        for (let i = 1; i < pts.length; i++)
            cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]));
        const ring = { pts, cum, closed: ptKey(pts[0]) === ptKey(pts[pts.length - 1]) };
        // First occurrence wins, so a closed ring's repeated start/end node maps
        // to index 0; the arc slicing below is correct for either index.
        pts.forEach((p, i) => {
            if (!at.has(ptKey(p)))
                at.set(ptKey(p), { ring, i });
        });
    }
    return at;
}

// The roundabout pavement from pa to pb, exclusive of both — the shorter way
// round a closed circle, or the only way round an unclosed one. null if the two
// points aren't distinct nodes of one roundabout.
function roundaboutArc(index, pa, pb) {
    const a = index.get(ptKey(pa)), b = index.get(ptKey(pb));
    if (!a || !b || a.ring !== b.ring || a.i === b.i)
        return null;
    const { pts, cum, closed } = a.ring;
    const lo = Math.min(a.i, b.i), hi = Math.max(a.i, b.i);
    const inner = pts.slice(lo + 1, hi);                                    // lo -> hi
    // The complement runs hi -> (through the ring's start node) -> lo. The last
    // point is dropped because a closed ring repeats its first.
    const outer = closed ? [...pts.slice(hi + 1, pts.length - 1), ...pts.slice(0, lo)] : null;
    const innerLen = cum[hi] - cum[lo];
    const useInner = !outer || innerLen <= cum[cum.length - 1] - innerLen;
    const arc = useInner ? inner : outer;
    const forward = useInner ? a.i === lo : a.i === hi;
    return forward ? arc : [...arc].reverse();
}

const MAX_TURN = (70 * Math.PI) / 180; // sharper joins are treated as corners
const REF_DIST = 20;                   // m inside a way used to measure its bearing

// A point ~REF_DIST m along the way from the given end (immediate neighbors
// can be centimeters away, which makes bearings noisy).
function interiorRef(pts, atStart) {
    const ordered = atStart ? pts : [...pts].reverse();
    let acc = 0;
    for (let i = 1; i < ordered.length; i++) {
        acc += haversine(ordered[i - 1], ordered[i]);
        if (acc >= REF_DIST)
            return ordered[i];
    }
    return ordered[ordered.length - 1];
}

// How sharply does travel turn passing through the join? Distinct streets
// that share a (often TIGER-mangled) name usually meet at right angles; a
// continuous road carries on nearly straight. inPt and outPt are the same point
// at an ordinary join and the two attachment nodes across a roundabout.
function turnAngle(wa, aAtStart, wb, bAtStart, inPt, outPt = inPt) {
    const dirIn = bearing(interiorRef(wa.pts, aAtStart), inPt);
    const dirOut = bearing(outPt, interiorRef(wb.pts, bAtStart));
    let diff = Math.abs(dirIn - dirOut);
    if (diff > Math.PI)
        diff = 2 * Math.PI - diff;
    return diff;
}

// Orient both ways so the join is in the middle and concatenate them. arc is
// the roundabout pavement between their attachment nodes (null at an ordinary
// join, where the two ways share the node and the duplicate is dropped).
function joinPair(ways, a, b, arc) {
    const wa = ways[a.i], wb = ways[b.i];
    const head = a.atStart ? [...wa.pts].reverse() : wa.pts;
    const tail = b.atStart ? wb.pts : [...wb.pts].reverse();
    const pts = arc ? [...head, ...arc, ...tail] : [...head, ...tail.slice(1)];
    // The dropped duplicate (tail[0]) may carry a bridge/tunnel flag the
    // kept junction point lacks — without it, a 2-node tunnel way loses
    // its only segment's flag and its deck elevation never interpolates.
    if (!arc && tail[0].b && !pts[head.length - 1].b) {
        pts[head.length - 1] = { ...pts[head.length - 1], b: true };
    }
    const joined = {
        ...wa,
        base: wa.base ?? wb.base,
        nameType: wa.nameType ?? wb.nameType,
        pts,
    };
    return [...ways.filter((_, i) => i !== a.i && i !== b.i), joined];
}

// Repeatedly join two ways whose endpoints coincide — where two way-ends meet
// cleanly, or where three meet and one pair clearly continues straight (a
// two-way road becoming a divided road: the through-carriageway chains on,
// the U-fold between opposite carriageways fails the bearing gate). The
// bearing gate also stops different streets that happen to share a name from
// chaining around a corner.
//
// Ways that stop at a roundabout share no node — the circle is between them —
// so a second pass joins those through the circle's own pavement, under the
// same bearing gate (opposite legs read as straight ahead; a leg turning off
// the circle is a corner, and stays a separate road as it would anywhere else).
// Direct joins win over roundabout ones, since a road entering a circle may
// first have to gather its own carriageways.
//
// Among the legs that pass the gate the LONGEST pair wins, not the straightest:
// a road divided at the circle offers a carriageway stub beside each through
// chain, and the stubs (being short and splayed) read as straighter. Pairing a
// stub with a through chain leaves the other chain with only the opposite stub
// to pair with — too sharp a fold to pass — and the road stays severed. Taking
// the through chains first joins the route and leaves the stubs to each other.
function stitchGroup(ways, rings) {
    let merged = true;
    while (merged && ways.length > 1) {
        merged = false;
        const ends = new Map();
        ways.forEach((w, i) => {
            for (const p of [w.pts[0], w.pts[w.pts.length - 1]]) {
                const k = ptKey(p);
                if (!ends.has(k))
                    ends.set(k, []);
                ends.get(k).push({ i, atStart: p === w.pts[0] });
            }
        });
        const conflict = (x, y) => !!(x && y && x !== y);
        for (const list of ends.values()) {
            if (list.length < 2 || list.length > 3)
                continue;
            let a = null, b = null, bestTurn = Infinity;
            for (let x = 0; x < list.length; x++) {
                for (let y = x + 1; y < list.length; y++) {
                    const pa = list[x], pb = list[y];
                    if (pa.i === pb.i)
                        continue;
                    const wx = ways[pa.i], wy = ways[pb.i];
                    if (conflict(wx.base, wy.base) || conflict(wx.nameType, wy.nameType))
                        continue;
                    const pt = pa.atStart ? wx.pts[0] : wx.pts[wx.pts.length - 1];
                    const turn = turnAngle(wx, pa.atStart, wy, pb.atStart, pt);
                    if (turn <= MAX_TURN && turn < bestTurn) {
                        bestTurn = turn;
                        a = pa;
                        b = pb;
                    }
                }
            }
            if (!a)
                continue;
            ways = joinPair(ways, a, b, null);
            merged = true;
            break;
        }
        if (merged || !rings?.size)
            continue;

        // Roundabout pass: every way-end standing on a circle is a candidate,
        // and the longest gate-passing pair on one circle wins.
        const legs = [];
        ways.forEach((w, i) => {
            for (const atStart of [true, false]) {
                const p = atStart ? w.pts[0] : w.pts[w.pts.length - 1];
                const on = rings.get(ptKey(p));
                if (on)
                    legs.push({ i, atStart, p, ring: on.ring });
            }
        });
        const lengths = ways.map(w => w.pts.reduce((sum, p, i) => (i ? sum + haversine(w.pts[i - 1], p) : 0), 0));
        let a = null, b = null, bestLen = -Infinity, bestArc = null;
        for (let x = 0; x < legs.length; x++) {
            for (let y = x + 1; y < legs.length; y++) {
                const pa = legs[x], pb = legs[y];
                // Both ends of one way on one circle is a loop road, not a
                // road severed by the circle.
                if (pa.i === pb.i || pa.ring !== pb.ring)
                    continue;
                const wx = ways[pa.i], wy = ways[pb.i];
                if (conflict(wx.base, wy.base) || conflict(wx.nameType, wy.nameType))
                    continue;
                const arc = roundaboutArc(rings, pa.p, pb.p);
                if (!arc)
                    continue;
                const turn = turnAngle(wx, pa.atStart, wy, pb.atStart, pa.p, pb.p);
                const len = lengths[pa.i] + lengths[pb.i];
                if (turn <= MAX_TURN && len > bestLen) {
                    bestLen = len;
                    a = pa;
                    b = pb;
                    bestArc = arc;
                }
            }
        }
        if (a) {
            ways = joinPair(ways, a, b, bestArc);
            merged = true;
        }
    }
    return ways;
}

// --- Underpasses -----------------------------------------------------------
// A bridge carries its road above the terrain, so its own samples read the
// gorge below (handled by the b flag). The mirror case is the road *underneath*:
// nothing in OSM tags it — the crossing is implicit in the geometry — yet the
// elevation model reads the deck overhead, so a flat street picks up a metre-
// scale hump where an interchange or railway crosses it. Fordham Blvd over
// Raleigh Rd in Chapel Hill adds ~6 m, a fake ~14 % pitch.
//
// OSM's own rule makes the crossings findable: ways that meet at grade share a
// node, so two ways whose segments cross strictly *between* their nodes are on
// different levels. If the upper one is a bridge and the lower one is not, the
// lower one is in an underpass, and its samples get the same flag — and the
// same straight-line interpolation from solid ground either side — a bridge
// deck gets.

// Half-width of road treated as unreliable either side of a crossing point. The
// crossing locates the deck's centerline; the elevation is spoiled across the
// structure's footprint (~30 m for a divided highway, more at a skew) smeared by
// the ~15 m elevation cell. Windows from neighboring crossings merge into one
// run, so a multi-carriageway interchange widens itself.
const UNDERPASS_HALF = 40;  // m

const CELL = 0.002;  // deg (~200 m) — grid cell for looking up nearby decks

const cellsOf = (latLo, latHi, lonLo, lonHi, fn) => {
    for (let a = Math.floor(latLo / CELL); a <= Math.floor(latHi / CELL); a++)
        for (let o = Math.floor(lonLo / CELL); o <= Math.floor(lonHi / CELL); o++)
            fn(`${a},${o}`);
};

// Every bridge deck in the response (ranked class or not), as raw elements. A
// bridge tag with a layer at or below the roadway is contradictory data; skip it
// rather than linearize a road on its word. Exported so test/make-fixture.mjs
// can store exactly the decks the underpass pass ran against.
export function bridgeWays(elements) {
    return elements.filter(el => el.type === 'way' && el.tags?.bridge && el.geometry?.length >= 2
        && (el.tags.layer != null ? +el.tags.layer : 1) > 0);
}

// The same decks as a grid of segments, so a road is tested against the few
// decks near it instead of all of them.
export function bridgeIndex(elements) {
    const grid = new Map();
    for (const el of bridgeWays(elements)) {
        for (let i = 1; i < el.geometry.length; i++) {
            const seg = [el.geometry[i - 1], el.geometry[i]];
            cellsOf(
                Math.min(seg[0].lat, seg[1].lat), Math.max(seg[0].lat, seg[1].lat),
                Math.min(seg[0].lon, seg[1].lon), Math.max(seg[0].lon, seg[1].lon),
                key => {
                    if (!grid.has(key))
                        grid.set(key, []);
                    grid.get(key).push(seg);
                });
        }
    }
    return grid;
}

const M_PER_DEG = 111320;

// Where segments ab and cd cross strictly inside both: fraction along ab, else
// null. Endpoint touches (t or u at 0 or 1) are at-grade junctions — OSM gives
// those a shared node — so only interior crossings count as grade separation.
function crossFrac(a, b, c, d) {
    const kx = Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180) * M_PER_DEG;
    const ax = a.lon * kx, ay = a.lat * M_PER_DEG, bx = b.lon * kx, by = b.lat * M_PER_DEG;
    const cx = c.lon * kx, cy = c.lat * M_PER_DEG, dx = d.lon * kx, dy = d.lat * M_PER_DEG;
    const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
    const den = rx * sy - ry * sx;
    if (den === 0)
        return null;  // parallel or degenerate
    const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
    const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
    const EPS = 1e-9;
    if (t <= EPS || t >= 1 - EPS || u <= EPS || u >= 1 - EPS)
        return null;
    return t;
}

// Flag the samples of a road wherever it passes under a bridge, so the deck
// interpolation in metrics.js replaces the overhead structure's elevation.
// pts is the road's own polyline (its distances match samples' d), index comes
// from bridgeIndex(). Mutates and returns samples.
export function markUnderpasses(pts, samples, index) {
    if (!index?.size)
        return samples;
    const cuts = [];
    let cum = 0;
    for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const len = haversine(a, b);
        // A segment already flagged is itself a deck or a bore; what crosses it
        // belongs to some other level.
        if (!(a.b && b.b)) {
            const near = new Set();
            cellsOf(
                Math.min(a.lat, b.lat), Math.max(a.lat, b.lat),
                Math.min(a.lon, b.lon), Math.max(a.lon, b.lon),
                key => { for (const seg of index.get(key) ?? []) near.add(seg); });
            for (const seg of near) {
                const t = crossFrac(a, b, seg[0], seg[1]);
                if (t != null)
                    cuts.push(cum + t * len);
            }
        }
        cum += len;
    }
    for (const d of cuts) {
        for (const s of samples) {
            if (Math.abs(s.d - d) <= UNDERPASS_HALF)
                s.b = true;
        }
    }
    return samples;
}
