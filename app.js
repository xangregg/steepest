// Wires the UI to the pipeline: geocode -> Overpass roads -> terrain-tile
// elevations -> sustained grades -> map + ranked list. Everything runs
// client-side.

import { parseLatLon, geocode, fetchRoads, prepareRoads } from './roads.js';
import { elevatePoints } from './elevation.js';
import { resample, analyzeRoad, segmentSustained, hardestClimb, SAMPLE_STEP } from './metrics.js';
import { initMap, drawRoads, renderList } from './render.js';
import { searchKey, cacheGet, cachePut } from './cache.js';

const LIST_MAX = 25;
const $ = id => document.getElementById(id);

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const mode = () => (darkQuery.matches ? 'dark' : 'light');

const { map, setMode } = initMap($('map'), mode());

let state = null;   // { roads, center, radiusM, label } after a successful run
let layer = null;   // drawRoads handle
let abort = null;

function status(msg, isError = false) {
    $('status').textContent = msg;
    $('status').classList.toggle('error', isError);
}

async function run(refresh = false) {
    abort?.abort();
    const ctl = new AbortController();
    abort = ctl;
    $('go').disabled = true;
    try {
        const query = $('place').value.trim();
        const radiusM = Math.min(15, Math.max(1, +$('radius').value || 10)) * 1000;

        status('Locating…');
        const center = parseLatLon(query) ?? await geocode(query, ctl.signal);

        const key = searchKey(center, radiusM);
        if (!refresh) {
            const hit = await cacheGet(key);
            if (hit) {
                state = { roads: hit.roads, center, radiusM, label: center.label, cachedAt: hit.t };
                map.fitBounds(L.latLng(center.lat, center.lon).toBounds(radiusM * 2));
                updateHash(query);
                render();
                return;
            }
        }

        status('Fetching roads from OpenStreetMap… (can take a moment for big areas)');
        const elements = await fetchRoads(center, radiusM, ctl.signal);
        const roads = prepareRoads(elements).map(r => ({ ...r, samples: resample(r.pts) }))
            .filter(r => r.samples.length >= 3); // need >= ~50 m to say anything

        if (!roads.length) throw new Error('No roads found in this area — try a larger radius.');

        const points = roads.flatMap(r => r.samples);
        status(`Found ${roads.length.toLocaleString()} roads · sampling elevation…`);
        const elevs = await elevatePoints(points, {
            signal: ctl.signal,
            onProgress: (done, total) =>
                total && status(`Found ${roads.length.toLocaleString()} roads · elevation tiles ${done}/${total}…`),
        });

        let offset = 0;
        for (const r of roads) {
            Object.assign(r, analyzeRoad(r.samples, Array.from(elevs.subarray(offset, offset + r.samples.length))));
            offset += r.samples.length;
        }

        state = { roads, center, radiusM, label: center.label, cachedAt: null };
        // Cache only what rendering needs (drop the raw OSM polylines). Awaited
        // so closing the tab right after results appear can't lose the write.
        await cachePut(key, roads.map(({ id, name, unnamed, samples, elev, length, eMin, eMax }) =>
            ({ id, name, unnamed, samples, elev, length, eMin, eMax })));
        map.fitBounds(L.latLng(center.lat, center.lon).toBounds(radiusM * 2));
        updateHash(query);
        render();
    } catch (err) {
        if (err.name !== 'AbortError') status(err.message, true);
    } finally {
        if (abort === ctl) { abort = null; $('go').disabled = false; }
    }
}

// Re-rank and redraw from cached results (window-length / min-length / theme
// changes don't refetch anything — the elevation profiles are kept per road).
function render() {
    if (!state) return;
    const windowM = Math.max(SAMPLE_STEP, +$('window').value || 250);
    const minLen = Math.max(0, +$('minlen').value || 0);
    const rankMode = $('rankmode').value;
    let ranked = state.roads
        .map(r => {
            r.segs = segmentSustained(r.samples, r.elev, windowM);
            r.value = r.segs ? r.segs.reduce((m, v) => Math.max(m, v), 0) : null;
            r.paint = null;
            return r;
        })
        .filter(r => r.value != null && r.length >= minLen);
    if (rankMode === 'climb') {
        // Climbs don't depend on the window; memoized until the next search.
        for (const r of ranked) if (r.climb === undefined) r.climb = hardestClimb(r.samples, r.elev);
        ranked = ranked.filter(r => r.climb).sort((a, b) => b.climb.score - a.climb.score);
        // Keep a climb visible across its interior flats: floor the winning
        // climb's segments at the climb's average grade for coloring.
        for (const r of ranked) {
            const paint = Float64Array.from(r.segs);
            for (let k = r.climb.i; k < r.climb.j; k++) paint[k] = Math.max(paint[k], r.climb.grade);
            r.paint = paint;
        }
    } else {
        ranked.sort((a, b) => b.value - a.value);
    }

    layer?.remove();
    layer = drawRoads(map, ranked, windowM, mode(), rankMode);

    // The list dedupes by name (a road split into disjoint pieces keeps only
    // its steepest piece); the map still shows every piece.
    const seen = new Set();
    const top = [];
    for (const r of ranked) {
        if (!r.unnamed && seen.has(r.name)) continue;
        seen.add(r.name);
        top.push(r);
        if (top.length >= LIST_MAX) break;
    }
    renderList($('road-list'), top, mode(), {
        rankMode,
        onHover: (road, on) => layer.highlight(road, on),
        onClick: road => layer.focus(road),
    });

    $('list-title').textContent = rankMode === 'climb'
        ? 'Hardest climbs — gain × grade'
        : `Steepest roads — sustained ${windowM} m`;
    $('list-sub').textContent = `${state.label} · ${ranked.length.toLocaleString()} roads ≥ ${Math.max(minLen, windowM)} m`;

    const doneMsg = `${ranked.length.toLocaleString()} roads ranked within ${(state.radiusM / 1000).toFixed(1)} km.`;
    if (state.cachedAt) {
        const el = $('status');
        el.classList.remove('error');
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'linklike';
        b.textContent = 'refresh from OSM';
        b.addEventListener('click', () => run(true));
        el.replaceChildren(`${doneMsg} Using roads cached ${ago(state.cachedAt)} — `, b);
    } else {
        status(`Done. ${doneMsg}`);
    }
}

function ago(t) {
    const mins = Math.round((Date.now() - t) / 60000);
    if (mins < 60) return mins <= 1 ? 'just now' : `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours} h ago`;
    return `${Math.round(hours / 24)} days ago`;
}

function updateHash(query) {
    const p = new URLSearchParams({
        q: query,
        r: String(+$('radius').value),
        w: String(+$('window').value),
        min: String(+$('minlen').value),
        mode: $('rankmode').value,
    });
    history.replaceState(null, '', '#' + p.toString());
}

$('controls').addEventListener('submit', e => { e.preventDefault(); run(); });
$('window').addEventListener('change', () => { render(); if (state) updateHash($('place').value.trim()); });
$('minlen').addEventListener('change', () => { render(); if (state) updateHash($('place').value.trim()); });
$('rankmode').addEventListener('change', () => { render(); if (state) updateHash($('place').value.trim()); });
darkQuery.addEventListener('change', () => { setMode(mode()); render(); });

// Restore a shared/bookmarked search from the URL hash.
const params = new URLSearchParams(location.hash.slice(1));
if (params.get('q')) {
    $('place').value = params.get('q');
    if (params.get('r')) $('radius').value = params.get('r');
    if (params.get('w')) $('window').value = params.get('w');
    if (params.get('min')) $('minlen').value = params.get('min');
    if (['sustained', 'climb'].includes(params.get('mode'))) $('rankmode').value = params.get('mode');
    run();
} else {
    status('Enter a town (e.g. “Pittsburgh, PA”) or coordinates, then hit the button.');
}
