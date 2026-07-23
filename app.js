// Wires the UI to the pipeline: geocode -> Overpass roads -> terrain-tile
// elevations -> metrics -> map + ranked list. Everything runs client-side;
// processed results cache in IndexedDB so repeat searches skip the network.
//
// A road object accumulates fields as it moves through the pipeline:
//   pts       original OSM polyline [{lat, lon, b?}] (b = bridge/tunnel)
//   samples   ~25 m arc-length resampling [{lat, lon, d, b?}] (d = meters along road)
//   elev      smoothed, bridge-corrected elevation per sample
//   length, eMin, eMax
// and per render (cheap, recomputed on control changes):
//   segs      per-segment sustained-window grade (Float64Array)
//   value     max of segs — the sustained-mode ranking value
//   climbs    up to 3 non-overlapping hardest climbs, best first (memoized);
//             each is {score, gain, span, grade, i, j, dir}
//   grind     long-incline mask over segments (memoized per span)
//   paint     color values; climb mode floors climb extents for continuity
//   topExtents  [i, j] extents that made the ranked list (climb mode: this
//               road's listed climbs; sustained mode: the listed road's best
//               window) — those wear red on the map, the rest violet

import { parseLatLon, geocode, fetchRoads, prepareRoads } from './roads.js';
import { elevatePoints } from './elevation.js';
import { resample, analyzeRoad, segmentSustained, sustainedStretches, hardestClimbs, grindMask, longestInclinePaths, SAMPLE_STEP, STRETCH_COL_FRAC } from './metrics.js';
import { initMap, drawRoads, renderList, setGrindStyle, setRampStyle, setWidthStyle, shortLabel, GRADE_MIN } from './render.js';
import { searchKey, cacheGet, cachePut } from './cache.js';
import { buildCsv, csvFilename } from './csv.js';

const byId = id => document.getElementById(id);

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const mode = () => (darkQuery.matches ? 'dark' : 'light');

const { map, setMode, updateLegend } = initMap(byId('map'), mode());

let state = null;   // { roads, center, radiusM, label } after a successful run
let layer = null;   // drawRoads handle
let abort = null;
let downloadCtx = null;  // { entries, rankMode, windowM, filename } for CSV export

// progress: undefined hides the bar, null shows an indeterminate sweep, a
// number in [0,1] shows a determinate fill.
function status(msg, { error = false, progress } = {}) {
    byId('status').textContent = msg;
    byId('status').classList.toggle('error', error);
    const bar = byId('progress');
    bar.classList.toggle('active', progress !== undefined);
    bar.classList.toggle('indeterminate', progress === null);
    byId('progress-fill').style.width = typeof progress === 'number' ? `${Math.round(progress * 100)}%` : '';
}

async function run(refresh = false) {
    abort?.abort(); // cancel any still-running previous search before starting a new one
    const ctl = new AbortController();
    abort = ctl;
    byId('go').disabled = true;
    try {
        const query = byId('place').value.trim();
        const radiusM = Math.min(15, Math.max(1, +byId('radius').value || 6)) * 1000;

        status('Locating…');
        const center = parseLatLon(query) ?? await geocode(query, ctl.signal);  // localStorage cached

        const key = searchKey(center, radiusM);
        if (!refresh) {
            const hit = await cacheGet(key);
            if (hit) {
                state = { roads: hit.roads, center, radiusM, label: center.label, cachedAt: hit.t };
                map.fitBounds(L.latLng(center.lat, center.lon).toBounds(radiusM * 2));
                updateHash(query);  // the # part of the URL
                render();
                return;
            }
        }

        // Overpass answers with one big response: show elapsed time while the
        // server thinks, then live megabytes once the download starts.
        const t0 = Date.now();
        let roadsNote = 'Fetching roads from OpenStreetMap…';
        let bytes = 0;
        const roadsStatus = () => status(
            `${roadsNote} ${bytes ? `${(bytes / 1048576).toFixed(1)} MB received` : `${Math.round((Date.now() - t0) / 1000)} s`}`,
            { progress: null });
        roadsStatus();
        const tick = setInterval(roadsStatus, 500);
        let elements;
        try {
            elements = await fetchRoads(center, radiusM, {
                signal: ctl.signal,
                onBytes: b => { bytes = b; },
                onNote: n => { roadsNote = n; },
            });
        }
        finally {
            clearInterval(tick);
        }
        const roads = prepareRoads(elements).map(r => ({ ...r, samples: resample(r.pts) }))
            .filter(r => r.samples.length >= 3); // need >= ~50 m to say anything

        if (!roads.length)
            throw new Error('No roads found in this area — try a larger radius.');

        const points = roads.flatMap(r => r.samples);
        status(`Found ${roads.length.toLocaleString()} roads · sampling elevation…`, { progress: null });
        const elevs = await elevatePoints(points, {
            signal: ctl.signal,
            onProgress: (done, total) =>
                total && status(`Found ${roads.length.toLocaleString()} roads · elevation tiles ${done} of ${total}`,
                    { progress: done / total }),
        });

        let offset = 0;
        for (const r of roads) {
            Object.assign(r, analyzeRoad(r.samples, Array.from(elevs.subarray(offset, offset + r.samples.length))));
            offset += r.samples.length;
        }

        state = { roads, center, radiusM, label: center.label, cachedAt: null };
        // Cache only what rendering needs (pts kept: ribbons densify through
        // the full-resolution geometry on hairpins). Awaited so closing the
        // tab right after results appear can't lose the write.
        await cachePut(key, roads.map(({ id, name, unnamed, pts, samples, elev, length, eMin, eMax }) =>
            ({ id, name, unnamed, pts, samples, elev, length, eMin, eMax })));
        map.fitBounds(L.latLng(center.lat, center.lon).toBounds(radiusM * 2));
        updateHash(query);
        render();
    }
    catch (err) {
        if (err.name !== 'AbortError')
            status(err.message, { error: true });
    }
    finally {
        if (abort === ctl) {
            abort = null;
            byId('go').disabled = false;
        }
    }
}

// Geographic bounding box of an entry's ranked extent (climb or sustained
// stretch), padded ~50 m and cached, for deduping the same physical hill
// reported by parallel same-name chains.
function extentBox(e) {
    if (e.box)
        return e.box;
    // The ranked extent: sustained entries carry both a stretch (the ranked
    // unit) and a display-only climb — the stretch must win here, or one
    // stretch's long containing climb would swallow the road's other stretches.
    const ext = e.stretch ?? e.climb;
    const pad = 0.0005;
    let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity;
    for (let k = ext.i; k <= ext.j; k++) {
        const s = e.road.samples[k];
        latMin = Math.min(latMin, s.lat);
        latMax = Math.max(latMax, s.lat);
        lonMin = Math.min(lonMin, s.lon);
        lonMax = Math.max(lonMax, s.lon);
    }
    e.box = [latMin - pad, latMax + pad, lonMin - pad, lonMax + pad];
    return e.box;
}

const boxOverlap = (a, b) => a[0] <= b[1] && b[0] <= a[1] && a[2] <= b[3] && b[2] <= a[3];

// Re-rank and redraw from cached results (window-length / min-length / theme
// changes don't refetch anything — the elevation profiles are kept per road).
// A synthetic road spanning a (possibly multi-road) incline's exact extent: no
// colored ribbon (segs null), its whole length flagged grind so it draws one
// continuous amber underlay across the junctions it spans, and usable as the
// halo target so highlighting hugs the incline instead of each whole road.
function inclineVirtualRoad(incline, longLen) {
    const n = incline.samples.length;
    return {
        id: `incline-${incline.start.lat.toFixed(5)},${incline.start.lon.toFixed(5)}`,
        name: incline.roads.map(r => r.name).join(' + '), unnamed: false,
        samples: incline.samples, elev: incline.elev,
        pts: incline.samples.map(s => ({ lat: s.lat, lon: s.lon })),
        segs: null, value: null, paint: null, topExtents: null, listed: false,
        grind: n > 1 ? new Uint8Array(n - 1).fill(1) : null, grindSpan: longLen,
    };
}

function render() {
    if (!state)
        return;
    const windowM = Math.max(SAMPLE_STEP, +byId('window').value || 250);
    const longLen = Math.max(SAMPLE_STEP * 2, +byId('longlen').value || 800);
    const listMax = Math.min(100, Math.max(1, +byId('listmax').value || 15));
    const inclineRoads = Math.min(5, Math.max(1, +byId('inclineroads').value || 1));
    const rankMode = byId('rankmode').value;
    const withFields = state.roads.map(r => {
        r.segs = segmentSustained(r.samples, r.elev, windowM);
        r.value = r.segs ? r.segs.reduce((m, v) => Math.max(m, v), 0) : null;
        r.window = windowM; // the sustained length this road's segs/value use
        r.fullSegs = undefined; // set on per-segment-colored roads (sustained mode)
        r.paint = null;
        r.topExtents = null;
        r.listed = false; // set on listed roads (they wear red on the map vs violet)
        return r;
    });
    let ranked = withFields.filter(r => r.value != null); // shorter-than-window roads have no value
    let entries; // list rows: [{road, climb, stretch?} | {incline}] (climb is display-only in sustained mode)
    let drawn; // roads to draw (sustained mode widens this to shorter steep roads)

    // Long inclines, possibly spanning several connected roads (the "over N
    // roads" knob), computed in EVERY mode so the amber underlay reflects it —
    // not just the incline ranking. Cached per (length, roads) since it doesn't
    // depend on the window or mode; the search uses the whole network (incl.
    // short connectors), and each incline gets a virtual road carrying its
    // continuous amber underlay (and, when hovered, the halo).
    const inclineKey = `${longLen}:${inclineRoads}`;
    if (state.inclineKey !== inclineKey) {
        state.inclinePaths = longestInclinePaths(withFields, longLen, inclineRoads);
        for (const inc of state.inclinePaths)
            inc.virtual = inclineVirtualRoad(inc, longLen);
        state.inclineKey = inclineKey;
    }
    const inclinePaths = state.inclinePaths;
    const inclineVirtuals = inclinePaths.map(p => p.virtual);
    if (rankMode === 'climb') {
        // Climbs don't depend on the window; memoized until the next search.
        for (const r of ranked)
            if (r.climbs === undefined)
                r.climbs = hardestClimbs(r.samples, r.elev, 3);
        ranked = ranked.filter(r => r.climbs.length)
            .sort((a, b) => b.climbs[0].score - a.climbs[0].score);
        // Keep every climb visible across its interior flats: floor its
        // segments at the climb's average grade for coloring.
        for (const r of ranked) {
            const paint = Float64Array.from(r.segs);
            for (const c of r.climbs)
                for (let k = c.i; k < c.j; k++)
                    paint[k] = Math.max(paint[k], c.grade);
            r.paint = paint;
        }
        // Rows are CLIMBS: all roads' climbs compete in one pool, so a road
        // with two distinct hills can take two spots. Same-name entries are
        // kept only when geographically distinct — parallel carriageways and
        // overlapping same-name chains report one row per physical climb.
        const pool = [];
        for (const r of ranked)
            for (const c of r.climbs)
                pool.push({ road: r, climb: c });
        pool.sort((a, b) => b.climb.score - a.climb.score);
        entries = [];
        const keptByName = new Map();
        for (const e of pool) {
            if (entries.length >= listMax)
                break;
            if (!e.road.unnamed) {
                const kept = keptByName.get(e.road.name) ?? [];
                // Same-road entries are never duplicates (their extents are
                // disjoint along the road); the box check is for the same hill
                // reported by a DIFFERENT same-name chain, and would otherwise
                // eat a switchback road's genuinely distinct nearby climbs.
                if (kept.some(k => k.road !== e.road && boxOverlap(extentBox(k), extentBox(e))))
                    continue;
                kept.push(e);
                keptByName.set(e.road.name, kept);
            }
            entries.push(e);
        }
        // Listed climbs wear red on the map; everything else steep is violet,
        // so map color mirrors city-wide rank.
        for (const e of entries)
            (e.road.topExtents ??= []).push([e.climb.i, e.climb.j]);
    }
    else if (rankMode === 'incline') {
        // Rank by longest qualifying long incline (same rule and knob as the
        // amber underlay). Like the other modes, red marks each ranked
        // incline's exact extent — per constituent road, from the incline's
        // provenance slices — and every other steep road goes violet. The
        // extent's paint is floored at the palest step so the whole incline
        // reads red even where its grade sits below the 5 % color floor
        // (inclines only need 2.5 %); popups still report the true grades.
        entries = inclinePaths.slice(0, listMax).map(incline => ({ incline }));
        for (const { incline } of entries) {
            for (const s of incline.segs) {
                const r = s.r;
                const [i0, i1] = s.from <= s.to ? [s.from, s.to] : [s.to, s.from];
                r.listed = true;
                (r.topExtents ??= []).push([i0, i1]);
                // Short connector roads have no window segs; paint from zeros
                // so the floor still gives their slice the palest red.
                const paint = (r.paint ??= Float64Array.from(r.segs ?? new Float64Array(r.samples.length - 1)));
                for (let k = i0; k < i1 && k < paint.length; k++)
                    paint[k] = Math.max(paint[k], GRADE_MIN);
            }
        }
        // Draw roads with no ranking value too when a listed incline crosses
        // them (short connectors), so the red extent isn't interrupted.
        drawn = withFields.filter(r => r.value != null || r.listed);
    }
    else {
        // Rows are STRETCHES: each road's distinct steep sections (one best
        // window per >= 5 % run of the metric, up to 3 — see
        // sustainedStretches) compete in one pool, so a road with two steep
        // sections separated by gentler road can take two spots, like climb
        // mode. Same-name entries are deduped geographically, so parallel
        // carriageways and same-name pieces still yield one row per hill.
        const pool = [];
        for (const r of ranked)
            for (const s of sustainedStretches(r.samples, r.elev, windowM, GRADE_MIN, 3))
                pool.push({ road: r, stretch: s });
        pool.sort((a, b) => b.stretch.grade - a.stretch.grade);
        entries = [];
        const keptByName = new Map();
        for (const e of pool) {
            if (entries.length >= listMax)
                break;
            if (!e.road.unnamed) {
                const kept = keptByName.get(e.road.name) ?? [];
                // Same-road stretches are never duplicates (disjoint along the
                // road); the box check targets parallel same-name chains only.
                if (kept.some(k => k.road !== e.road && boxOverlap(extentBox(k), extentBox(e))))
                    continue;
                kept.push(e);
                keptByName.set(e.road.name, kept);
            }
            // Sub-line: the climb containing this stretch (falling back to the
            // road's hardest) — its rise and length say more than the road
            // length did. Display-only; the bar and right-hand % show the
            // stretch's sustained grade.
            const climbs = (e.road.climbs ??= hardestClimbs(e.road.samples, e.road.elev, 3));
            const mid = (e.stretch.i + e.stretch.j) / 2;
            e.climb = climbs.find(c => mid >= c.i && mid <= c.j) ?? climbs[0] ?? null;
            entries.push(e);
            e.road.listed = true;
            // The ranked stretch wears red, extended into its shoulders:
            // contiguous segments whose sustained grade stays within
            // STRETCH_COL_FRAC of the stretch's own (and above GRADE_MIN) —
            // the same fraction that decides when a neighboring peak ranks
            // separately, so steepness not distinct enough for its own row
            // reads as part of this red section instead of a violet wing.
            // The rest of the road goes violet like any unlisted road.
            const segs = e.road.segs;
            const thresh = Math.max(GRADE_MIN, STRETCH_COL_FRAC * e.stretch.grade);
            let a = e.stretch.i, b = e.stretch.j;
            while (a > 0 && segs[a - 1] >= thresh)
                a--;
            while (b < segs.length && segs[b] >= thresh)
                b++;
            (e.road.topExtents ??= []).push([a, b]);
        }
        // "Other steep" (non-listed) roads have no length threshold: any single
        // ~25 m segment at ≥ 5 % shows in violet, even on a road too short — or
        // not steep enough over the full window — to make the list. Re-evaluate
        // them at per-segment grades (both coloring and inclusion). The full-
        // window segs move to fullSegs so the popup can still report the
        // sustained grade at the chosen length — how far the spot falls short
        // of qualifying — instead of repeating the segment's own grade.
        for (const r of withFields) {
            if (r.listed)
                continue;
            r.fullSegs = r.segs; // null when the road is shorter than the window
            r.segs = segmentSustained(r.samples, r.elev, SAMPLE_STEP);
            r.window = SAMPLE_STEP;
            r.value = r.segs ? r.segs.reduce((m, v) => Math.max(m, v), 0) : null;
        }
        drawn = withFields.filter(r => r.listed || (r.value != null && r.value >= GRADE_MIN));
    }

    drawn ??= ranked; // climb/incline modes draw the ranked set as-is

    // Long-incline acknowledgment: mostly monotonic, >= 2% stretches at least
    // longLen long get the amber underlay where the steepness colors are silent.
    for (const r of drawn) {
        if (r.grindSpan !== longLen) {
            r.grind = grindMask(r.samples, r.elev, longLen);
            r.grindSpan = longLen;
        }
    }

    layer?.remove();
    // Virtual incline roads draw last so their amber sits over the real roads'.
    layer = drawRoads(map, [...drawn, ...inclineVirtuals], windowM, mode(), rankMode);
    updateLegend(mode(), rankMode, entries.length);

    renderList(byId('road-list'), entries, mode(), {
        rankMode,
        onHover: (entry, on) => entry.incline
            ? layer.highlightIncline(entry.incline, on)
            : layer.highlight(entry.road, on),
        onClick: entry => entry.incline
            ? layer.focusIncline(entry.incline)
            // Frame the ranked extent: the climb in climb mode, the stretch in
            // Steepest mode (rows are stretches, so clicking a road's second
            // stretch must show THAT stretch, not the road's best).
            : layer.focus(entry.road, rankMode === 'climb' ? entry.climb : entry.stretch ?? null),
    });

    downloadCtx = { entries, rankMode, windowM, filename: csvFilename(rankMode, windowM, state.label) };
    byId('download').hidden = entries.length === 0;

    byId('list-title').textContent = {
        climb: 'Hardest climbs — gain × grade',
        sustained: `Steepest roads — sustained ${windowM} m`,
        incline: `Longest inclines — ${longLen}+ m`,
    }[rankMode];
    const total = rankMode === 'incline' ? inclinePaths.length : ranked.length;
    const unit = rankMode === 'incline' ? `inclines ${longLen}+ m` : `roads ≥ ${windowM} m`;
    byId('list-sub').textContent = `${shortLabel(state.label)} · ${total.toLocaleString()} ${unit}`;

    const doneMsg = `${ranked.length.toLocaleString()} roads ranked within ${(state.radiusM / 1000).toFixed(1)} km.`;
    if (state.cachedAt) {
        status(`${doneMsg} Using roads cached ${ago(state.cachedAt)} — `);
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'linklike';
        b.textContent = 'refresh from OSM';
        b.addEventListener('click', () => void run(true));
        byId('status').append(b);
    }
    else {
        status(`Done. ${doneMsg}`);
    }
}

function ago(t) {
    const mins = Math.round((Date.now() - t) / 60000);
    if (mins < 60)
        return mins <= 1 ? 'just now' : `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 48)
        return `${hours} h ago`;
    return `${Math.round(hours / 24)} days ago`;
}

function updateHash(query) {
    const p = new URLSearchParams({
        q: query,
        r: String(+byId('radius').value),
        w: String(+byId('window').value),
        long: String(+byId('longlen').value),
        roads: String(+byId('inclineroads').value),
        n: String(+byId('listmax').value),
        mode: byId('rankmode').value,
    });
    history.replaceState(null, '', '#' + p.toString());
}

// Download the current ranking as CSV (built in csv.js; columns vary by mode).
function downloadCsv() {
    if (!downloadCtx || !downloadCtx.entries.length)
        return;
    const blob = new Blob([buildCsv(downloadCtx)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadCtx.filename;
    a.click();
    URL.revokeObjectURL(url);
}
byId('download').addEventListener('click', downloadCsv);

// Info dialogs (native <dialog>: the × and Esc close them; also close on a
// backdrop click, whose event target is the dialog element itself).
const wireDialog = (buttonId, dialogId) => {
    const dialog = byId(dialogId);
    byId(buttonId).addEventListener('click', () => dialog.showModal());
    dialog.addEventListener('click', e => {
        if (e.target === dialog)
            dialog.close();
    });
};
wireDialog('howto', 'howto-dialog');
wireDialog('credits', 'credits-dialog');

byId('controls').addEventListener('submit', e => {
    e.preventDefault();
    void run();
});
const onControlChange = () => {
    render();
    if (state)
        updateHash(byId('place').value.trim());
};
byId('window').addEventListener('change', onControlChange);
byId('longlen').addEventListener('change', onControlChange);
byId('inclineroads').addEventListener('change', onControlChange);
byId('listmax').addEventListener('change', onControlChange);
byId('rankmode').addEventListener('change', onControlChange);
darkQuery.addEventListener('change', () => {
    setMode(mode());
    render();
});

// Dev-tools hook for live style experiments (re-renders from cached data):
//   steepest.grind({ light: '#8a93a5', opacity: 0.4 })
//   steepest.grind({ dark: '#5f6a78' })
//   steepest.ramp({ light: { mid: '#ff0000', hi: '#330000' } })
//   steepest.ramp({ hue: 'violet', dark: { mid: '#9a6cff' } })
//   steepest.width({ refZoom: 14, zoomStep: 1.3, factorMin: 0.25, factorMax: 8, curvyMax: 1, curvyTurn: 0.025 })
//   steepest.curviness()  // table of roads by curviness + which are "curvy"
//   steepest.map           // the Leaflet map (e.g. steepest.map.setView(...))
window.steepest = {
    get map() {
        return map;
    },
    grind(opts) {
        setGrindStyle(opts);
        render();
    },
    ramp(opts) {
        setRampStyle(opts);
        render();
    },
    width(opts) {
        const cfg = setWidthStyle(opts);
        render();
        return cfg; // echo the current settings to the console
    },
    // Diagnostic: list the loaded roads by curviness and whether the current
    // curvyTurn classifies them "curvy" (so the flare-factor cap applies).
    curviness() {
        const { curvyTurn } = setWidthStyle();
        const rows = (state?.roads ?? [])
            .filter(r => r.curviness !== undefined)
            .map(r => ({ name: r.name, curviness: +r.curviness.toFixed(4), curvy: r.curviness > curvyTurn }))
            .sort((a, b) => b.curviness - a.curviness);
        console.table(rows.slice(0, 25));
        return `${rows.filter(r => r.curvy).length} of ${rows.length} roads classified curvy at curvyTurn=${curvyTurn}`;
    },
};

// Restore a shared/bookmarked search from the URL hash.
const params = new URLSearchParams(location.hash.slice(1));
if (params.get('fixture')) {
    // Offline/dev: render a canned processed-roads fixture (test/fixtures/<name>.json)
    // with no network, so the app can be checked without Overpass. See
    // test/make-fixture.mjs for capturing one.
    status('Loading fixture…');
    fetch(`test/fixtures/${params.get('fixture')}.json`)
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`fixture HTTP ${r.status}`)))
        .then(f => {
            state = { roads: f.roads, center: f.center, radiusM: f.radiusM, label: f.center.label, cachedAt: null };
            if (['climb', 'sustained', 'incline'].includes(params.get('mode')))
                byId('rankmode').value = params.get('mode');
            if (params.get('roads'))
                byId('inclineroads').value = params.get('roads');
            map.fitBounds(L.latLng(f.center.lat, f.center.lon).toBounds(f.radiusM * 2));
            render();
            // Optional close-up for inspecting a spot: #fixture=brevard&z=16&lat=..&lon=..
            if (params.get('z'))
                map.setView([+params.get('lat'), +params.get('lon')], +params.get('z'));
        })
        .catch(err => status(err.message, { error: true }));
}
else if (params.get('q')) {
    byId('place').value = params.get('q');
    if (params.get('r'))
        byId('radius').value = params.get('r');
    if (params.get('w'))
        byId('window').value = params.get('w');
    if (params.get('long'))
        byId('longlen').value = params.get('long');
    if (params.get('roads'))
        byId('inclineroads').value = params.get('roads');
    if (params.get('n'))
        byId('listmax').value = params.get('n');
    if (['sustained', 'climb', 'incline'].includes(params.get('mode')))
        byId('rankmode').value = params.get('mode');
    void run();
}
else {
    status('Enter a town (e.g. “Pittsburgh, PA”) or coordinates, then hit the button.');
}
