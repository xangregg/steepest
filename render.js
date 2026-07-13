// Map + sidebar rendering. Steepness uses one single-hue sequential red ramp
// (light = flat recedes into the basemap, dark = steep) in light mode, and the
// reverse-lightness equivalent on the dark basemap.

export const GRADE_MIN = 0.05; // below this a segment gets no highlight at all
export const GRADE_MAX = 0.25; // ramp saturates at a 25% grade

export const RAMPS = {
    light: ['#fbd0cd', '#f5a8a3', '#ee7f7a', '#e34948', '#c22d2c', '#9c1f1f', '#7a1414'],
    dark: ['#4a1210', '#7a1414', '#a02020', '#c22d2c', '#e34948', '#f07f79', '#f9b2ad'],
};

// Second sequential context (climb mode's "steep but not the hardest climb"):
// its own single-hue ramp over the same 5–25 % domain. Violet reads clearly
// against the gray basemap (cyan sank into it), stays well away from the climb
// reds, and the hue pair survives red-green color-vision deficiency.
export const RAMPS_ALT = {
    light: ['#e4d9f7', '#cbb8ef', '#b096e5', '#9273d8', '#7657c4', '#5d41a6', '#452e85'],
    dark: ['#332057', '#452e85', '#5940a3', '#7657c4', '#9273d8', '#b096e5', '#d3c3f2'],
};

const BASEMAPS = {
    light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
};
const BASEMAP_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

const hexToRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));

export function makeGradeColor(rampHex) {
    const stops = rampHex.map(hexToRgb);
    return grade => {
        const t = Math.max(0, Math.min(1, (grade - GRADE_MIN) / (GRADE_MAX - GRADE_MIN))) * (stops.length - 1);
        const i = Math.min(stops.length - 2, Math.floor(t));
        const f = t - i;
        const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
        return `rgb(${c[0]},${c[1]},${c[2]})`;
    };
}

export function initMap(el, mode) {
    const map = L.map(el, { renderer: L.canvas({ padding: 0.3 }) });
    map.setView([39, -96], 4); // continental US until a search runs
    let base = null;
    const setBase = m => {
        if (base) map.removeLayer(base);
        base = L.tileLayer(BASEMAPS[m], { attribution: BASEMAP_ATTR, maxZoom: 19 }).addTo(map);
    };
    setBase(mode);

    let legendDiv = null;
    const legend = L.control({ position: 'bottomright' });
    legend.onAdd = () => (legendDiv = L.DomUtil.create('div', 'legend'));
    legend.addTo(map);

    const barDiv = ramp => `<div class="legend-bar" style="background:linear-gradient(to right, ${ramp.join(',')})"></div>`;
    const ticks = `<div class="legend-ticks"><span>${Math.round(GRADE_MIN * 100)}%</span><span>${+((GRADE_MIN + GRADE_MAX) * 50).toFixed(1)}%</span><span>${Math.round(GRADE_MAX * 100)}%+</span></div>`;
    const updateLegend = (m, rankMode = 'sustained') => {
        legendDiv.innerHTML = rankMode === 'climb'
            ? `<div class="legend-title">grade</div>
               <div class="legend-row">${barDiv(RAMPS[m])}<span class="legend-label">hardest climb</span></div>
               <div class="legend-row">${barDiv(RAMPS_ALT[m])}<span class="legend-label">other steep</span></div>
               ${ticks}`
            : `<div class="legend-title">grade</div>${barDiv(RAMPS[m])}${ticks}`;
    };
    updateLegend(mode);

    return { map, setMode: setBase, updateLegend };
}

const fmtPct = g => `${(g * 100).toFixed(1)}%`;
const fmtLen = m => m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// segK: index of the ~25 m sample segment nearest the click, when the popup
// was opened by clicking the map (null when opened from the list).
function popupHtml(road, stretchValue, windowM, segK) {
    const climbRow = road.climb
        ? `<div class="popup-row"><span>Hardest climb</span><b>↑${Math.round(road.climb.gain)} m @ ${fmtPct(road.climb.grade)} over ${fmtLen(road.climb.span)}</b></div>`
        : '';
    let localRows;
    if (segK != null) {
        const s0 = road.samples[segK], s1 = road.samples[segK + 1];
        const e0 = road.elev[segK], e1 = road.elev[segK + 1];
        const g = Math.abs(e1 - e0) / (s1.d - s0.d);
        localRows = `
        <div class="popup-row popup-active"><span>This ${Math.round(s1.d - s0.d)} m segment</span><b>${fmtPct(g)} · ${Math.round(e0)}→${Math.round(e1)} m</b></div>
        <div class="popup-row"><span>Sustained ${windowM} m here</span><b>${fmtPct(road.segs[segK])}</b></div>
        <div class="popup-row"><span>Along road</span><b>${fmtLen(s0.d)} of ${fmtLen(road.length)}</b></div>`;
    } else {
        localRows = `
        <div class="popup-row popup-active"><span>This stretch (sustained ${windowM} m)</span><b>${fmtPct(stretchValue)}</b></div>
        <div class="popup-row"><span>Length</span><b>${fmtLen(road.length)}</b></div>`;
    }
    return `<div class="popup"><div class="popup-name">${esc(road.name)}</div>${localRows}
        <div class="popup-row"><span>Road best</span><b>${fmtPct(road.value)}</b></div>${climbRow}
        <div class="popup-row"><span>Elevation</span><b>${Math.round(road.eMin)}–${Math.round(road.eMax)} m</b></div></div>`;
}

// Nearest sample segment to a clicked point (planar approximation is plenty
// at road scale).
function nearestSegIndex(road, latlng) {
    const cosLat = Math.cos((latlng.lat * Math.PI) / 180);
    let best = 0, bestD = Infinity;
    for (let i = 0; i < road.samples.length; i++) {
        const s = road.samples[i];
        const dLat = s.lat - latlng.lat, dLon = (s.lon - latlng.lng) * cosLat;
        const d2 = dLat * dLat + dLon * dLon;
        if (d2 < bestD) { bestD = d2; best = i; }
    }
    return Math.min(best, road.samples.length - 2);
}

// Merge consecutive segments that land in the same color bin (~1% grade) into
// one polyline, so a road becomes a handful of constant-color chunks rather
// than one segment per 25 m. Segments below GRADE_MIN are skipped entirely —
// the basemap's own road rendering shows through with no highlight.
// Color follows road.paint when present (climb mode floors a winning climb's
// segments at the climb's average grade so its flats stay visible); the
// chunk's reported value stays the honest local grade.
const BINS = Math.round((GRADE_MAX - GRADE_MIN) * 100); // one bin per % of grade
const GAP_CLOSE_M = 100; // close sub-GRADE_MIN gaps up to this long (crests, breathers)
const PAINT_LOCAL_CAP = 1.0; // paint never exceeds this × the segment's own local grade
// splitAt: segment indices where a chunk must break regardless of color bin
// (climb-interval boundaries, so climb and non-climb hues never share a chunk).
function colorChunks(road, splitAt) {
    const { samples, segs, elev } = road;
    // Paint starts from the sustained-window value (plus the climb floor in
    // climb mode) but is capped relative to the segment's own grade, so color
    // doesn't bleed past where a hill really ends.
    const paint = Float64Array.from(road.paint ?? segs);
    for (let k = 0; k < paint.length; k++) {
        const local = Math.abs(elev[k + 1] - elev[k]) / (samples[k + 1].d - samples[k].d);
        paint[k] = Math.min(paint[k], local * PAINT_LOCAL_CAP);
    }
    // Close short low-grade runs flanked by painted segments on both sides: a
    // 50 m crest flat shouldn't visually sever one continuous hill. Closed
    // gaps get exactly GRADE_MIN — the ramp's palest step.
    let gapStart = -1;
    for (let k = 0; k <= paint.length; k++) {
        const low = k < paint.length && paint[k] < GRADE_MIN;
        if (low && gapStart < 0) gapStart = k;
        else if (!low && gapStart >= 0) {
            if (gapStart > 0 && k < paint.length && samples[k].d - samples[gapStart].d <= GAP_CLOSE_M) {
                for (let m = gapStart; m < k; m++) paint[m] = GRADE_MIN;
            }
            gapStart = -1;
        }
    }
    const bin = v => Math.min(BINS, Math.round(((v - GRADE_MIN) / (GRADE_MAX - GRADE_MIN)) * BINS));
    const chunks = [];
    let cur = null;
    for (let k = 0; k < segs.length; k++) {
        if (paint[k] < GRADE_MIN) { cur = null; continue; }
        const b = bin(paint[k]);
        if (!cur || b !== cur.bin || splitAt?.has(k)) {
            cur = { bin: b, paint: paint[k], value: segs[k], kStart: k, kEnd: k + 1 };
            chunks.push(cur);
        } else {
            cur.paint = Math.max(cur.paint, paint[k]);
            cur.value = Math.max(cur.value, segs[k]);
            cur.kEnd = k + 1;
        }
    }
    return chunks;
}

const LINE_WEIGHT = 3.5;  // highlight outline weight in px
const WIDTH_MIN = 3.5;    // px ribbon width at a run's lowest altitude
const WIDTH_PER_M = 0.15; // extra px of width per meter of altitude above the run's base

// Road-wide projected geometry at the current zoom: pixel points plus a miter
// (angle-bisector) normal and clamp scale at every sample. Chunks offset from
// these shared normals, so adjacent chunks meet edge-to-edge with no cap
// overlap and no wedge gaps, whatever the join angle.
function roadGeometry(map, samples) {
    const zoom = map.getZoom();
    const pts = samples.map(s => map.project([s.lat, s.lon], zoom));
    const n = pts.length;
    const dirs = [];
    for (let i = 0; i < n - 1; i++) {
        const dx = pts[i + 1].x - pts[i].x, dy = pts[i + 1].y - pts[i].y;
        const len = Math.hypot(dx, dy) || 1;
        dirs.push({ x: dx / len, y: dy / len });
    }
    const normals = [];
    for (let i = 0; i < n; i++) {
        const a = dirs[Math.max(0, i - 1)], b = dirs[Math.min(n - 2, i)];
        let mx = a.x + b.x, my = a.y + b.y;
        const mlen = Math.hypot(mx, my);
        if (mlen < 1e-9) { // 180° hairpin: fall back to the previous normal
            normals.push({ nx: -a.y, ny: a.x, scale: 1 });
        } else {
            mx /= mlen; my /= mlen;
            // Miter: widen by 1/cos(half-angle), clamped so hairpins don't spike.
            normals.push({ nx: -my, ny: mx, scale: 1 / Math.max(1 / 3, mx * a.x + my * a.y) });
        }
    }
    return { map, zoom, pts, normals };
}

// Ribbon ring for samples [kStart..kEnd]; halfAt(k) gives the half-width in
// px at each sample, so width can vary along the road (altitude flare).
function ribbonRing(geom, kStart, kEnd, halfAt) {
    const left = [], right = [];
    for (let k = kStart; k <= kEnd; k++) {
        const p = geom.pts[k], { nx, ny, scale } = geom.normals[k];
        const w = halfAt(k) * scale;
        left.push(geom.map.unproject(L.point(p.x + nx * w, p.y + ny * w), geom.zoom));
        right.unshift(geom.map.unproject(L.point(p.x - nx * w, p.y - ny * w), geom.zoom));
    }
    return left.concat(right);
}

// Draw ranked roads (already sorted steepest-first); shallower roads are drawn
// first so the steepest sit on top. Each road is a group of constant-color
// chunks, colored by the steepest >= windowM stretch each chunk belongs to.
// In climb mode, highlighting emphasizes the winning climb's chunks and dims
// the rest; a faint full-road skeleton appears on hover in both modes so the
// road's extent (including unpainted flats) stays legible.
export function drawRoads(map, ranked, windowM, mode, rankMode = 'sustained') {
    const color = makeGradeColor(RAMPS[mode]);
    const colorAlt = makeGradeColor(RAMPS_ALT[mode]);
    const group = L.layerGroup().addTo(map);
    const lines = new Map(); // road -> { skeleton, chunks:[{line, inClimb}], steepest, steepestClimb }
    const isClimbMode = rankMode === 'climb';

    function setHighlight(road, on) {
        const e = lines.get(road);
        if (!e) return;
        e.skeleton.setStyle({ opacity: on ? 0.55 : 0 });
        const emphasizeClimb = isClimbMode && road.climb;
        for (const { poly, inClimb } of e.chunks) {
            if (emphasizeClimb && !inClimb) poly.setStyle({ opacity: 0, fillOpacity: on ? 0.45 : 1 });
            // The outline stroke (same color) fattens the ribbon when shown.
            else poly.setStyle({ opacity: on ? 1 : 0, fillOpacity: 1 });
        }
    }

    for (const road of [...ranked].reverse()) {
        const fg = L.featureGroup();
        const skeleton = L.polyline(road.samples.map(s => [s.lat, s.lon]), {
            color: '#898781', weight: 2, opacity: 0, interactive: false,
        }).addTo(fg);
        const chunks = [];
        let steepest = null, steepestClimb = null;
        let clickK = null; // set by a map click just before the bound popup opens
        const geom = roadGeometry(map, road.samples);
        const split = isClimbMode && road.climb ? new Set([road.climb.i, road.climb.j]) : null;
        // Group contiguous same-hue chunks into runs; each run's width starts
        // at WIDTH_MIN at its own lowest altitude, so thin -> thick = uphill.
        const runs = [];
        for (const chunk of colorChunks(road, split)) {
            const inClimb = isClimbMode && road.climb && chunk.kStart >= road.climb.i && chunk.kStart < road.climb.j;
            const prev = runs[runs.length - 1];
            if (prev && prev.inClimb === inClimb && prev.kEnd === chunk.kStart) {
                prev.kEnd = chunk.kEnd;
                prev.items.push(chunk);
            } else {
                runs.push({ inClimb, kStart: chunk.kStart, kEnd: chunk.kEnd, items: [chunk] });
            }
        }
        for (const run of runs) {
            let base = Infinity;
            for (let k = run.kStart; k <= run.kEnd; k++) base = Math.min(base, road.elev[k]);
            const halfAt = k => (WIDTH_MIN + WIDTH_PER_M * (road.elev[k] - base)) / 2;
            for (const chunk of run.items) {
                const c = (isClimbMode && !run.inClimb ? colorAlt : color)(chunk.paint);
                const poly = L.polygon(ribbonRing(geom, chunk.kStart, chunk.kEnd, halfAt), {
                    // Opaque fill: semi-transparent neighbors blend with the
                    // basemap at antialiased seam edges and show hairlines.
                    fillColor: c, fillOpacity: 1,
                    // Invisible outline; highlight raises its opacity to fatten the ribbon.
                    stroke: true, color: c, weight: LINE_WEIGHT, opacity: 0,
                });
                // Registered before bindPopup so it runs first on click.
                poly.on('click', e => { clickK = nearestSegIndex(road, e.latlng); });
                poly.bindPopup(() => {
                    const k = clickK;
                    clickK = null;
                    return popupHtml(road, chunk.value, windowM, k);
                });
                poly.addTo(fg);
                chunks.push({ poly, inClimb: run.inClimb, kStart: chunk.kStart, kEnd: chunk.kEnd, halfAt });
                if (!steepest || chunk.paint > steepest.chunkPaint) {
                    steepest = poly;
                    steepest.chunkPaint = chunk.paint;
                }
                if (run.inClimb && (!steepestClimb || chunk.paint > steepestClimb.chunkPaint)) {
                    steepestClimb = poly;
                    steepestClimb.chunkPaint = chunk.paint;
                }
            }
        }
        fg.on('mouseover', () => setHighlight(road, true));
        fg.on('mouseout', () => setHighlight(road, false));
        fg.addTo(group);
        lines.set(road, { skeleton, chunks, steepest, steepestClimb });
    }

    // Pixel-based widths mean the ribbon geometry is zoom-dependent.
    const rebuild = () => {
        for (const [road, e] of lines) {
            if (!e.chunks.length) continue;
            const geom = roadGeometry(map, road.samples);
            for (const c of e.chunks) c.poly.setLatLngs(ribbonRing(geom, c.kStart, c.kEnd, c.halfAt));
        }
    };
    map.on('zoomend', rebuild);

    return {
        group,
        highlight: setHighlight,
        focus(road) {
            const e = lines.get(road);
            if (!e) return;
            // Frame the climb in climb mode, the whole road otherwise.
            const pts = isClimbMode && road.climb
                ? road.samples.slice(road.climb.i, road.climb.j + 1)
                : road.samples;
            map.fitBounds(L.latLngBounds(pts.map(s => [s.lat, s.lon])).pad(0.3));
            (e.steepestClimb ?? e.steepest)?.openPopup();
        },
        remove() {
            map.off('zoomend', rebuild);
            map.removeLayer(group);
        },
    };
}

// Ranked bar list in the sidebar: rank, name, value bar, value label. In
// sustained mode the bar wears the road's grade color (the map color key); in
// climb mode bar length is the climb score and the color is the climb's grade.
export function renderList(el, roads, mode, { rankMode = 'sustained', onHover, onClick }) {
    const color = makeGradeColor(RAMPS[mode]);
    const isClimb = rankMode === 'climb';
    el.replaceChildren();
    if (!roads.length) return;
    const top = (isClimb ? roads[0].climb.score : roads[0].value) || 1e-9;
    roads.forEach((road, i) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'road-row';
        const value = isClimb ? road.climb.score : road.value;
        const sub = isClimb
            ? `↑${Math.round(road.climb.gain)} m @ ${fmtPct(road.climb.grade)} over ${fmtLen(road.climb.span)}`
            : fmtLen(road.length);
        row.innerHTML = `
            <span class="road-rank">${i + 1}</span>
            <span class="road-main">
                <span class="road-name">${esc(road.name)}</span>
                <span class="road-sub">${sub}</span>
                <span class="road-track"><span class="road-bar" style="width:${Math.max(2, (value / top) * 100)}%;background:${color(isClimb ? road.climb.grade : road.value)}"></span></span>
            </span>
            <span class="road-value">${isClimb ? value.toFixed(1) : fmtPct(value)}</span>`;
        row.addEventListener('mouseenter', () => onHover(road, true));
        row.addEventListener('mouseleave', () => onHover(road, false));
        row.addEventListener('click', () => onClick(road));
        el.appendChild(row);
    });
}
