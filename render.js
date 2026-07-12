// Map + sidebar rendering. Steepness uses one single-hue sequential red ramp
// (light = flat recedes into the basemap, dark = steep) in light mode, and the
// reverse-lightness equivalent on the dark basemap.

export const GRADE_MIN = 0.05; // below this a segment gets no highlight at all
export const GRADE_MAX = 0.25; // ramp saturates at a 25% grade

export const RAMPS = {
    light: ['#fbd0cd', '#f5a8a3', '#ee7f7a', '#e34948', '#c22d2c', '#9c1f1f', '#7a1414'],
    dark: ['#4a1210', '#7a1414', '#a02020', '#c22d2c', '#e34948', '#f07f79', '#f9b2ad'],
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

    const legend = L.control({ position: 'bottomright' });
    legend.onAdd = () => {
        const div = L.DomUtil.create('div', 'legend');
        div.innerHTML = `<div class="legend-title">grade</div>
            <div class="legend-bar"></div>
            <div class="legend-ticks"><span>${Math.round(GRADE_MIN * 100)}%</span><span>${+((GRADE_MIN + GRADE_MAX) * 50).toFixed(1)}%</span><span>${Math.round(GRADE_MAX * 100)}%+</span></div>`;
        return div;
    };
    legend.addTo(map);

    const setLegendRamp = m => {
        const bar = map.getContainer().querySelector('.legend-bar');
        if (bar) bar.style.background = `linear-gradient(to right, ${RAMPS[m].join(',')})`;
    };
    setLegendRamp(mode);

    return { map, setMode: m => { setBase(m); setLegendRamp(m); } };
}

const fmtPct = g => `${(g * 100).toFixed(1)}%`;
const fmtLen = m => m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function popupHtml(road, stretchValue, windowM) {
    const climbRow = road.climb
        ? `<div class="popup-row"><span>Hardest climb</span><b>↑${Math.round(road.climb.gain)} m @ ${fmtPct(road.climb.grade)} over ${fmtLen(road.climb.span)}</b></div>`
        : '';
    return `<div class="popup"><div class="popup-name">${esc(road.name)}</div>
        <div class="popup-row popup-active"><span>This stretch (sustained ${windowM} m)</span><b>${fmtPct(stretchValue)}</b></div>
        <div class="popup-row"><span>Road best</span><b>${fmtPct(road.value)}</b></div>${climbRow}
        <div class="popup-row"><span>Length</span><b>${fmtLen(road.length)}</b></div>
        <div class="popup-row"><span>Elevation</span><b>${Math.round(road.eMin)}–${Math.round(road.eMax)} m</b></div></div>`;
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
function colorChunks(road) {
    const { samples, segs } = road;
    // Close short low-grade runs flanked by painted segments on both sides: a
    // 50 m crest flat shouldn't visually sever one continuous hill. Closed
    // gaps get exactly GRADE_MIN — the ramp's palest step.
    const paint = Float64Array.from(road.paint ?? segs);
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
        if (!cur || b !== cur.bin) {
            cur = { bin: b, paint: paint[k], value: segs[k], kStart: k, kEnd: k + 1, latlngs: [[samples[k].lat, samples[k].lon]] };
            chunks.push(cur);
        } else {
            cur.paint = Math.max(cur.paint, paint[k]);
            cur.value = Math.max(cur.value, segs[k]);
            cur.kEnd = k + 1;
        }
        cur.latlngs.push([samples[k + 1].lat, samples[k + 1].lon]);
    }
    return chunks;
}

// Draw ranked roads (already sorted steepest-first); shallower roads are drawn
// first so the steepest sit on top. Each road is a group of constant-color
// chunks, colored by the steepest >= windowM stretch each chunk belongs to.
// In climb mode, highlighting emphasizes the winning climb's chunks and dims
// the rest; a faint full-road skeleton appears on hover in both modes so the
// road's extent (including unpainted flats) stays legible.
export function drawRoads(map, ranked, windowM, mode, rankMode = 'sustained') {
    const color = makeGradeColor(RAMPS[mode]);
    const group = L.layerGroup().addTo(map);
    const lines = new Map(); // road -> { skeleton, chunks:[{line, inClimb}], steepest, steepestClimb }
    const isClimbMode = rankMode === 'climb';

    function setHighlight(road, on) {
        const e = lines.get(road);
        if (!e) return;
        e.skeleton.setStyle({ opacity: on ? 0.55 : 0 });
        const emphasizeClimb = isClimbMode && road.climb;
        for (const { line, inClimb } of e.chunks) {
            if (emphasizeClimb && !inClimb) line.setStyle({ weight: 3.5, opacity: on ? 0.45 : 0.9 });
            else line.setStyle({ weight: on ? 7 : 3.5, opacity: on ? 1 : 0.9 });
        }
    }

    for (const road of [...ranked].reverse()) {
        const fg = L.featureGroup();
        const skeleton = L.polyline(road.samples.map(s => [s.lat, s.lon]), {
            color: '#898781', weight: 2, opacity: 0, interactive: false,
        }).addTo(fg);
        const chunks = [];
        let steepest = null, steepestClimb = null;
        for (const chunk of colorChunks(road)) {
            const line = L.polyline(chunk.latlngs, {
                color: color(chunk.paint),
                weight: 3.5,
                opacity: 0.9,
            }).bindPopup(() => popupHtml(road, chunk.value, windowM));
            line.addTo(fg);
            const inClimb = isClimbMode && road.climb && chunk.kEnd > road.climb.i && chunk.kStart < road.climb.j;
            chunks.push({ line, inClimb });
            if (!steepest || chunk.paint > steepest.chunkPaint) {
                steepest = line;
                steepest.chunkPaint = chunk.paint;
            }
            if (inClimb && (!steepestClimb || chunk.paint > steepestClimb.chunkPaint)) {
                steepestClimb = line;
                steepestClimb.chunkPaint = chunk.paint;
            }
        }
        fg.on('mouseover', () => setHighlight(road, true));
        fg.on('mouseout', () => setHighlight(road, false));
        fg.addTo(group);
        lines.set(road, { skeleton, chunks, steepest, steepestClimb });
    }
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
        remove() { map.removeLayer(group); },
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
