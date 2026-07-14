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
//   climb     hardest climb {score, gain, span, grade, i, j, dir} (memoized)
//   grind     long-incline mask over segments (memoized per span)
//   paint     color values; climb mode floors the climb extent for continuity
//   topClimb  road is in the ranked list, so its climb wears red

import { parseLatLon, geocode, fetchRoads, prepareRoads } from './roads.js';
import { elevatePoints } from './elevation.js';
import { resample, analyzeRoad, segmentSustained, hardestClimb, grindMask, SAMPLE_STEP } from './metrics.js';
import { initMap, drawRoads, renderList, setGrindStyle } from './render.js';
import { searchKey, cacheGet, cachePut } from './cache.js';

const byId = id => document.getElementById(id);

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const mode = () => (darkQuery.matches ? 'dark' : 'light');

const { map, setMode, updateLegend } = initMap(byId('map'), mode());

let state = null;   // { roads, center, radiusM, label } after a successful run
let layer = null;   // drawRoads handle
let abort = null;

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

// Re-rank and redraw from cached results (window-length / min-length / theme
// changes don't refetch anything — the elevation profiles are kept per road).
function render() {
    if (!state)
        return;
    const windowM = Math.max(SAMPLE_STEP, +byId('window').value || 250);
    const longLen = Math.max(SAMPLE_STEP * 2, +byId('longlen').value || 800);
    const listMax = Math.min(100, Math.max(1, +byId('listmax').value || 25));
    const rankMode = byId('rankmode').value;
    let ranked = state.roads
        .map(r => {
            r.segs = segmentSustained(r.samples, r.elev, windowM);
            r.value = r.segs ? r.segs.reduce((m, v) => Math.max(m, v), 0) : null;
            r.paint = null;
            r.topClimb = false;
            return r;
        })
        .filter(r => r.value != null); // shorter-than-window roads have no value
    if (rankMode === 'climb') {
        // Climbs don't depend on the window; memoized until the next search.
        for (const r of ranked)
            if (r.climb === undefined)
                r.climb = hardestClimb(r.samples, r.elev);
        ranked = ranked.filter(r => r.climb).sort((a, b) => b.climb.score - a.climb.score);
        // Keep a climb visible across its interior flats: floor the winning
        // climb's segments at the climb's average grade for coloring.
        for (const r of ranked) {
            const paint = Float64Array.from(r.segs);
            for (let k = r.climb.i; k < r.climb.j; k++)
                paint[k] = Math.max(paint[k], r.climb.grade);
            r.paint = paint;
        }
    }
    else {
        ranked.sort((a, b) => b.value - a.value);
    }

    // Long-incline acknowledgment: mostly monotonic, >= 2% stretches at least
    // longLen long get the amber underlay where the steepness colors are silent.
    for (const r of ranked) {
        if (r.grindSpan !== longLen) {
            r.grind = grindMask(r.samples, r.elev, longLen);
            r.grindSpan = longLen;
        }
    }

    // The list dedupes by name (a road split into disjoint pieces keeps only
    // its steepest piece); the map still shows every piece. In climb mode the
    // listed roads' climbs wear red on the map; everything else steep is
    // violet, so map color mirrors city-wide rank.
    const seen = new Set();
    const top = [];
    for (const r of ranked) {
        if (!r.unnamed && seen.has(r.name))
            continue;
        seen.add(r.name);
        top.push(r);
        if (top.length >= listMax)
            break;
    }
    if (rankMode === 'climb')
        for (const r of top)
            r.topClimb = true;

    layer?.remove();
    layer = drawRoads(map, ranked, windowM, mode(), rankMode);
    updateLegend(mode(), rankMode, top.length);

    renderList(byId('road-list'), top, mode(), {
        rankMode,
        onHover: (road, on) => layer.highlight(road, on),
        onClick: road => layer.focus(road),
    });

    byId('list-title').textContent = rankMode === 'climb'
        ? 'Hardest climbs — gain × grade'
        : `Steepest roads — sustained ${windowM} m`;
    byId('list-sub').textContent = `${state.label} · ${ranked.length.toLocaleString()} roads ≥ ${windowM} m`;

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
        n: String(+byId('listmax').value),
        mode: byId('rankmode').value,
    });
    history.replaceState(null, '', '#' + p.toString());
}

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
byId('listmax').addEventListener('change', onControlChange);
byId('rankmode').addEventListener('change', onControlChange);
darkQuery.addEventListener('change', () => {
    setMode(mode());
    render();
});

// Dev-tools hook for live style experiments (re-renders from cached data):
//   steepest.grind({ light: '#8a93a5', opacity: 0.4 })
//   steepest.grind({ dark: '#5f6a78' })
window.steepest = {
    grind(opts) {
        setGrindStyle(opts);
        render();
    },
};

// Restore a shared/bookmarked search from the URL hash.
const params = new URLSearchParams(location.hash.slice(1));
if (params.get('q')) {
    byId('place').value = params.get('q');
    if (params.get('r'))
        byId('radius').value = params.get('r');
    if (params.get('w'))
        byId('window').value = params.get('w');
    if (params.get('long'))
        byId('longlen').value = params.get('long');
    if (params.get('n'))
        byId('listmax').value = params.get('n');
    if (['sustained', 'climb'].includes(params.get('mode')))
        byId('rankmode').value = params.get('mode');
    void run();
}
else {
    status('Enter a town (e.g. “Pittsburgh, PA”) or coordinates, then hit the button.');
}
