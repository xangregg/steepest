// Map + sidebar rendering.
//
// Roads draw as mitered ribbon polygons (not stroked lines), split into
// constant-color chunks. Color: two-segment sequential ramps over a fixed
// 5–25 % grade domain, interpolated in Oklab so equal grade steps read as
// equal color steps (perceptually uniform within each segment). Each ramp runs
// pale → full-chroma at GRADE_BREAK (12 %) → deep, so a road's steepest pitches
// stand out from its merely-steep ones. In climb mode, red for the listed
// top-N roads' climbs and violet for other steep stretches; below 5 % nothing
// is painted (short crest gaps
// close at the palest step). Each segment's color is capped at its own local
// grade so paint never claims steepness the ground doesn't have. Width flares
// with altitude above each run's base (thin -> thick = uphill), and the flare
// scales up with zoom so it stays legible when zoomed in. Ribbon
// geometry densifies through the original OSM vertices wherever the road
// genuinely curves between the ~25 m samples, so hairpins draw as hairpins,
// and everything rebuilds on zoom (pixel widths). Long gentle inclines render
// as one continuous translucent amber ribbon per run in a dedicated map pane
// beneath the ribbons (pane-level opacity, so overlaps never double-darken).
// The exported ramps/constants double as the live-experiment surface (see the
// window.steepest hook in app.js).

import { haversine, SAMPLE_STEP, GRIND_MIN_GRADE } from './metrics.js';

export const GRADE_MIN = 0.05; // below this a segment gets no highlight at all
export const GRADE_BREAK = 0.12; // grade where the ramp reaches full-chroma color
export const GRADE_MAX = 0.25; // ramp bottoms out (deepest color) at a 25% grade

// Each ramp is three anchor colors — pale (lo) at GRADE_MIN, full-chroma (mid)
// at GRADE_BREAK, deep (hi) at GRADE_MAX — interpolated in Oklab (see
// makeGradeColor). Light mode runs pale -> chroma -> dark (lightness falls as
// grade rises, so steeper = darker against the light basemap); dark mode is
// inverted (dark -> chroma -> pale), so steeper = brighter against the dark
// basemap. The dark-mode lo isn't as dark as the light-mode hi, so the gentlest
// painted grade still separates from the near-black basemap.
export const RAMPS = {
    light: { lo: '#fbd3d0', mid: '#dd2c22', hi: '#160302' },
    dark: { lo: '#5a1512', mid: '#e5352a', hi: '#fbd3d0' },
};

// Second sequential context (climb mode's "steep but not the hardest climb"):
// its own single-hue ramp over the same domain. Violet reads clearly against
// the gray basemap (cyan sank into it), stays well away from the climb reds,
// and the hue pair survives red-green color-vision deficiency.
export const RAMPS_ALT = {
    light: { lo: '#e6dcf8', mid: '#7c46dd', hi: '#0d0716' },
    dark: { lo: '#2e1a52', mid: '#8a55e8', hi: '#e6dcf8' },
};

// Categorical (non-gradient) color for long-incline stretches — mostly
// monotonic inclines of >= 2%. Drawn as a continuous translucent amber
// underlay beneath the steepness ribbons, mostly obscured where steep colors
// sit on top, peeking out where the incline ribbon runs wider.
export const GRIND_COLORS = { light: '#dd9922', dark: '#e9b04a' };
// Applied as CSS opacity on the inclines pane (not per polygon), so
// overlapping ribbons — parallel carriageways, crossing inclines — merge into
// one solid shape before the fade and never double-darken.
let GRIND_OPACITY = 0.4;

// Live style experimentation (see the window.steepest dev hook in app.js).
export function setGrindStyle({ light, dark, opacity } = {}) {
    if (light)
        GRIND_COLORS.light = light;
    if (dark)
        GRIND_COLORS.dark = dark;
    if (opacity !== undefined)
        GRIND_OPACITY = opacity;
}

// Tweak ramp anchors live: hue 'red' (RAMPS) or 'violet' (RAMPS_ALT); light/dark
// are partial { lo, mid, hi } patches merged into that mode's anchors.
export function setRampStyle({ hue = 'red', light, dark } = {}) {
    const target = hue === 'violet' ? RAMPS_ALT : RAMPS;
    if (light)
        Object.assign(target.light, light);
    if (dark)
        Object.assign(target.dark, dark);
}

const BASEMAPS = {
    light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
};
const BASEMAP_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

// --- Oklab color math (Björn Ottosson's Oklab) --------------------------
// We interpolate ramp colors in Oklab, not sRGB, because Oklab is
// perceptually uniform: a straight line sampled at even steps yields even
// perceived color steps. Plain sRGB interpolation would bunch the visible
// change unevenly along the ramp. No dependency — the transforms are a few
// matrix multiplies plus a gamma curve.
const srgbToLin = c => (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const linToSrgb = c => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.round(Math.max(0, Math.min(1, v)) * 255);
};
const hexToOklab = h => {
    const [r, g, b] = [1, 3, 5].map(i => srgbToLin(parseInt(h.slice(i, i + 2), 16)));
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ];
};
const oklabToRgb = ([L, A, B]) => {
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3;
    return [
        linToSrgb(+4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
        linToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
        linToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
    ];
};

// Two-segment ramp: pale(lo) -> chroma(mid) across [GRADE_MIN, GRADE_BREAK],
// then chroma(mid) -> deep(hi) across [GRADE_BREAK, GRADE_MAX]. Grade maps
// linearly to position within its segment, and the color is a straight Oklab
// lerp there, so each segment is perceptually uniform on its own.
export function makeGradeColor({ lo, mid, hi }) {
    const a0 = hexToOklab(lo), a1 = hexToOklab(mid), a2 = hexToOklab(hi);
    return grade => {
        const g = Math.max(GRADE_MIN, Math.min(GRADE_MAX, grade));
        const low = g <= GRADE_BREAK;
        const from = low ? a0 : a1;
        const to = low ? a1 : a2;
        const t = low
            ? (g - GRADE_MIN) / (GRADE_BREAK - GRADE_MIN)
            : (g - GRADE_BREAK) / (GRADE_MAX - GRADE_BREAK);
        const c = oklabToRgb(from.map((v, k) => v + (to[k] - v) * t));
        return `rgb(${c[0]},${c[1]},${c[2]})`;
    };
}

// A CSS gradient for the legend: sample the ramp at even grade steps (which,
// being uniform in grade, map to evenly spaced stops) so the swatch shows the
// same two-segment curve the map uses, kink and all.
const RAMP_SAMPLES = 13;
const rampCss = anchors => {
    const color = makeGradeColor(anchors);
    const stops = Array.from({ length: RAMP_SAMPLES }, (_, i) =>
        color(GRADE_MIN + (GRADE_MAX - GRADE_MIN) * i / (RAMP_SAMPLES - 1)));
    return `linear-gradient(to right, ${stops.join(',')})`;
};

export function initMap(el, mode) {
    const map = L.map(el, { renderer: L.canvas({ padding: 0.3 }) });
    map.setView([39, -96], 4); // continental US until a search runs
    let base = null;
    const setBase = m => {
        if (base)
            map.removeLayer(base);
        base = L.tileLayer(BASEMAPS[m], { attribution: BASEMAP_ATTR, maxZoom: 19 }).addTo(map);
    };
    setBase(mode);

    let legendDiv = null;
    const legend = L.control({ position: 'bottomright' });
    legend.onAdd = () => (legendDiv = L.DomUtil.create('div', 'legend'));
    legend.addTo(map);

    const barDiv = bg => `<div class="legend-bar" style="background:${bg}"></div>`;
    const ticks = `<div class="legend-ticks"><span>${Math.round(GRADE_MIN * 100)}%</span><span>${+((GRADE_MIN + GRADE_MAX) * 50).toFixed(1)}%</span><span>${Math.round(GRADE_MAX * 100)}%+</span></div>`;
    const updateLegend = (m, rankMode = 'sustained', topN = 25) => {
        // Below the ticks and swatch-sized, so the % scale clearly doesn't
        // apply to the categorical grind color.
        const grindRow = `<div class="legend-row legend-grind"><div class="legend-swatch" style="background:${GRIND_COLORS[m]};opacity:${GRIND_OPACITY}"></div><span class="legend-label">long incline (≥${+(GRIND_MIN_GRADE * 100).toFixed(2)}%)</span></div>`;
        // Every mode reserves red for the listed items and violet for the rest.
        const noun = rankMode === 'climb' ? 'climbs' : rankMode === 'incline' ? 'inclines' : 'roads';
        const listLabel = `top ${topN} ${noun}`;
        legendDiv.innerHTML = `<div class="legend-title">grade</div>
               <div class="legend-row">${barDiv(rampCss(RAMPS[m]))}<span class="legend-label">${listLabel}</span></div>
               <div class="legend-row">${barDiv(rampCss(RAMPS_ALT[m]))}<span class="legend-label">other steep</span></div>
               ${ticks}${grindRow}`;
    };
    updateLegend(mode);

    return { map, setMode: setBase, updateLegend };
}

const fmtPct = g => `${(g * 100).toFixed(1)}%`;
const fmtLen = m => m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
// Compact rise/run form (↑43m/299m ≈ 14.3%): wraps less than "↑43 m @ 14.3%
// over 299 m" in the narrow list, and with both lengths in metres the ratio
// reads directly as the grade. The ≈ (not =) is honest: the shown lengths are
// rounded, so they don't divide to exactly the displayed grade. Shared by the
// list rows and the map popup.
const fmtClimb = c => `↑${Math.round(c.gain)}m/${Math.round(c.span)}m ≈ ${fmtPct(c.grade)}`;
// Incline-list sub-line: gain and average grade (the length is the row's value).
const fmtIncline = c => `↑${Math.round(c.gain)}m ≈ ${fmtPct(c.grade)}`;
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Shorten common street-type words for the narrow list, so long names wrap
// less ("Pritchard Avenue Extension" -> "Pritchard Ave Ext"). Display only —
// road.name stays intact (it keys the dedup, and the popup shows it in full).
// Whole-word, Title-Case matches only, so a name like "Streetman Road" or
// "Roadside Lane" keeps its first word untouched.
const NAME_ABBREV = {
    Avenue: 'Ave', Street: 'St', Road: 'Rd', Drive: 'Dr', Boulevard: 'Blvd',
    Lane: 'Ln', Court: 'Ct', Place: 'Pl', Circle: 'Cir', Terrace: 'Ter',
    Parkway: 'Pkwy', Highway: 'Hwy', Extension: 'Ext', Trail: 'Trl',
    Square: 'Sq', Crescent: 'Cres', Heights: 'Hts', Turnpike: 'Tpke',
    Expressway: 'Expy', Freeway: 'Fwy', Junction: 'Jct',
};
const NAME_ABBREV_RE = new RegExp(`\\b(${Object.keys(NAME_ABBREV).join('|')})\\b`, 'g');
export const abbrevName = name => name.replace(NAME_ABBREV_RE, w => NAME_ABBREV[w]);

// US state / DC names -> postal codes, for shortening the verbose Nominatim
// place label in the list sub-line.
const US_STATES = {
    Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA',
    Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', Florida: 'FL', Georgia: 'GA',
    Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA', Kansas: 'KS',
    Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA',
    Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO', Montana: 'MT',
    Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ',
    'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND',
    Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI',
    'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT',
    Vermont: 'VT', Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV',
    Wisconsin: 'WI', Wyoming: 'WY', 'District of Columbia': 'DC',
};
// Shorten a comma-separated Nominatim label for display: drop county-equivalent
// admin parts entirely (County/Parish/Borough/Census Area/Municipality) — but
// never the first part, which is the place itself (it may legitimately be a
// county) — and abbreviate US states to postal codes and "United States" to US.
const COUNTY_RE = /\b(County|Parish|Borough|Census Area|Municipality)\b/;
export function shortLabel(label) {
    return label.split(',').map(s => s.trim())
        .filter((p, i) => i === 0 || !COUNTY_RE.test(p))
        .map((p, i) => {
            if (i === 0)
                return p;
            if (p === 'United States' || p === 'United States of America')
                return 'US';
            return US_STATES[p] ?? p;
        })
        .join(', ');
}

// segK: index of the ~25 m sample segment nearest the click, when the popup
// was opened by clicking the map (null when opened from the list).
function popupHtml(road, stretchValue, windowM, segK) {
    // Describe the climb containing the clicked segment if there is one,
    // otherwise the road's hardest.
    const climbs = road.climbs ?? [];
    const containing = segK != null ? climbs.find(c => segK >= c.i && segK < c.j) : null;
    const shown = containing ?? climbs[0];
    const climbRow = shown
        ? `<div class="popup-row"><span>${containing ? 'This climb' : 'Hardest climb'}</span><b>${fmtClimb(shown)}</b></div>`
        : '';
    let localRows;
    if (segK != null) {
        const s0 = road.samples[segK], s1 = road.samples[segK + 1];
        const e0 = road.elev[segK], e1 = road.elev[segK + 1];
        const g = Math.abs(e1 - e0) / (s1.d - s0.d);
        localRows = `
        <div class="popup-row popup-active"><span>This ${(s1.d - s0.d).toFixed(1)} m segment</span><b>${fmtPct(g)} · ${e0.toFixed(1)}→${e1.toFixed(1)} m</b></div>
        <div class="popup-row"><span>Sustained ${windowM} m here</span><b>${fmtPct(road.segs[segK])}</b></div>`;
        // When the click lands on a long incline, describe its whole run.
        if (road.grind?.[segK]) {
            let a = segK, b = segK;
            while (a > 0 && road.grind[a - 1])
                a--;
            while (b < road.grind.length - 1 && road.grind[b + 1])
                b++;
            const span = road.samples[b + 1].d - road.samples[a].d;
            const gain = Math.abs(road.elev[b + 1] - road.elev[a]);
            localRows += `
        <div class="popup-row"><span>Long incline</span><b>${fmtClimb({ gain, span, grade: gain / span })}</b></div>`;
        }
    }
    else {
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
        if (d2 < bestD) {
            bestD = d2;
            best = i;
        }
    }
    return Math.min(best, road.samples.length - 2);
}

// Merge consecutive segments that land in the same color bin (~1% grade), so
// a road becomes a handful of constant-color chunks rather than one ribbon
// per 25 m segment. Segments below GRADE_MIN are skipped entirely — the
// basemap's own road rendering shows through with no highlight.
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
        if (low && gapStart < 0) {
            gapStart = k;
        }
        else if (!low && gapStart >= 0) {
            // Snap to the nearest whole segment: a 4-segment flat at 25.03 m
            // spacing (100.1 m) should close like the 100 m it nominally is.
            if (gapStart > 0 && k < paint.length && samples[k].d - samples[gapStart].d <= GAP_CLOSE_M + SAMPLE_STEP / 2) {
                for (let m = gapStart; m < k; m++)
                    paint[m] = GRADE_MIN;
            }
            gapStart = -1;
        }
    }
    const bin = v => Math.min(BINS, Math.round(((v - GRADE_MIN) / (GRADE_MAX - GRADE_MIN)) * BINS));
    const chunks = [];
    let cur = null;
    for (let k = 0; k < segs.length; k++) {
        if (paint[k] < GRADE_MIN) {
            cur = null;
            continue;
        }
        const b = bin(paint[k]);
        if (!cur || b !== cur.bin || splitAt?.has(k)) {
            cur = { bin: b, paint: paint[k], value: segs[k], kStart: k, kEnd: k + 1 };
            chunks.push(cur);
        }
        else {
            cur.paint = Math.max(cur.paint, paint[k]);
            cur.value = Math.max(cur.value, segs[k]);
            cur.kEnd = k + 1;
        }
    }
    return chunks;
}

const LINE_WEIGHT = 3.5;  // highlight outline weight in px
const WIDTH_MIN = 3.5;    // px ribbon width at a run's lowest altitude (zoom-independent)
// The altitude flare is a fixed pixel amount, so zooming in — where a segment
// spans far more pixels than its width — makes the thin->thick cue hard to read.
// So the flare scales with zoom: WIDTH_PER_M and the cap apply as-is at
// WIDTH_REF_ZOOM, then grow by WIDTH_ZOOM_STEP per level above it, clamped so
// they neither shrink below the reference nor balloon over neighbours far in.
let WIDTH_PER_M = 0.15;   // extra px of flare per meter of altitude, at WIDTH_REF_ZOOM
let WIDTH_MAX = 14;       // px total-width cap, at WIDTH_REF_ZOOM
let WIDTH_REF_ZOOM = 14;  // below/at this zoom the flare is unchanged from before
let WIDTH_ZOOM_STEP = 1.3;
let WIDTH_FACTOR_MIN = 0.25, WIDTH_FACTOR_MAX = 8;
const flareFactor = (zoom, maxFactor) =>
    Math.min(maxFactor, Math.max(WIDTH_FACTOR_MIN, WIDTH_ZOOM_STEP ** (zoom - WIDTH_REF_ZOOM)));

// A very curvy road (switchbacks like SF's Lombard) can't wear a big flare: at
// high zoom a wide ribbon overruns its own hairpins into a blob. Rather than cap
// the width per vertex (noisy — it spikes and misfires on straight roads),
// classify each road once by curviness and cap its flare FACTOR low past the
// threshold; straight and gently-curving roads keep the full factor. Curviness
// is the MAX turning density over any ~CURVY_WINDOW_M window — not the
// whole-road average, which dilutes a short crooked block inside a long road
// below any useful threshold.
let CURVY_TURN_PER_M = 0.025; // rad/m (windowed) above which a road is "very curvy"
// Flare-factor ceiling for curvy roads. At 1 their flare never grows past the
// reference zoom — the zoom amplification is what overruns their bends into
// broken/blobby joins, even for moderately curvy roads like Brevard's
// Pickleseimer Mill Rd; the base thin->thick altitude cue still shows.
let CURVY_FLARE_MAX = 1;
let CURVY_WINDOW_M = 100;    // window the turning density is maximised over

// Curviness: the highest absolute turning per metre over any window of at least
// CURVY_WINDOW_M along the polyline (rad/m). A switchback block scores high even
// when the rest of the road is straight; jitter and gentle curves stay low.
function roadCurviness(verts) {
    const n = verts.length;
    if (n < 3)
        return 0;
    const cosLat = Math.cos(verts[0].lat * Math.PI / 180);
    const bearing = i => Math.atan2(verts[i + 1].lat - verts[i].lat,
        (verts[i + 1].lon - verts[i].lon) * cosLat);
    const turn = new Array(n).fill(0); // |bend| at each vertex (0 at the ends)
    const cum = new Array(n).fill(0);  // distance to each vertex (m)
    let prev = bearing(0);
    for (let i = 1; i < n; i++) {
        cum[i] = cum[i - 1] + haversine(verts[i - 1], verts[i]);
        if (i < n - 1) {
            const b = bearing(i);
            let d = b - prev;
            prev = b;
            while (d > Math.PI)
                d -= 2 * Math.PI;
            while (d < -Math.PI)
                d += 2 * Math.PI;
            turn[i] = Math.abs(d);
        }
    }
    // Max turning density over any window of at least CURVY_WINDOW_M: for each
    // right end, shrink to the shortest window still spanning >= WINDOW, so a
    // lone sharp corner (a short window) can't score high — only sustained
    // turning does. A road shorter than the window falls back to its average.
    let lo = 0, sum = 0, best = 0;
    for (let hi = 1; hi < n; hi++) {
        sum += turn[hi];
        while (cum[hi] - cum[lo + 1] >= CURVY_WINDOW_M) {
            sum -= turn[lo + 1];
            lo++;
        }
        if (cum[hi] - cum[lo] >= CURVY_WINDOW_M)
            best = Math.max(best, sum / (cum[hi] - cum[lo]));
    }
    if (best === 0) {
        let total = 0;
        for (let i = 1; i < n - 1; i++)
            total += turn[i];
        best = cum[n - 1] > 0 ? total / cum[n - 1] : 0;
    }
    return best;
}

// Live tuning of the altitude flare (see the window.steepest dev hook).
export function setWidthStyle({ perM, max, refZoom, zoomStep, factorMin, factorMax, curvyMax, curvyTurn, curvyWin } = {}) {
    if (perM !== undefined)
        WIDTH_PER_M = perM;
    if (max !== undefined)
        WIDTH_MAX = max;
    if (refZoom !== undefined)
        WIDTH_REF_ZOOM = refZoom;
    if (zoomStep !== undefined)
        WIDTH_ZOOM_STEP = zoomStep;
    if (factorMin !== undefined)
        WIDTH_FACTOR_MIN = factorMin;
    if (factorMax !== undefined)
        WIDTH_FACTOR_MAX = factorMax;
    if (curvyMax !== undefined)
        CURVY_FLARE_MAX = curvyMax;
    if (curvyTurn !== undefined)
        CURVY_TURN_PER_M = curvyTurn;
    if (curvyWin !== undefined)
        CURVY_WINDOW_M = curvyWin;
    // Return the current settings so the dev-console hook echoes them (instead
    // of undefined) and confirms the change landed.
    return { perM: WIDTH_PER_M, max: WIDTH_MAX, refZoom: WIDTH_REF_ZOOM, zoomStep: WIDTH_ZOOM_STEP, factorMin: WIDTH_FACTOR_MIN, factorMax: WIDTH_FACTOR_MAX, curvyMax: CURVY_FLARE_MAX, curvyTurn: CURVY_TURN_PER_M, curvyWin: CURVY_WINDOW_M };
}
const DENSIFY_RATIO = 1.02; // densify drawing where path between samples exceeds the chord by this

// Drawing path: the ~25 m sample vertices plus, wherever the true path between
// two samples is noticeably longer than their chord (hairpins, tight curves),
// the original full-resolution OSM vertices — so ribbons follow switchbacks
// instead of cutting across them. Each vertex records its bounding sample (k)
// and fraction (f) so per-sample widths interpolate smoothly. Falls back to
// samples alone when the original polyline isn't available.
function buildDrawPath(road) {
    const { samples, pts } = road;
    const n = samples.length;
    const verts = [];
    const sampleIdx = new Array(n);
    let cum = null;
    if (pts && pts.length >= 2) {
        cum = [0];
        for (let i = 1; i < pts.length; i++)
            cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]));
    }
    let p = 1;
    for (let k = 0; k < n; k++) {
        sampleIdx[k] = verts.length;
        verts.push({ lat: samples[k].lat, lon: samples[k].lon, k, f: 0 });
        if (k === n - 1 || !cum)
            continue;
        const d0 = samples[k].d, d1 = samples[k + 1].d;
        const span = d1 - d0;
        if (span <= 0)
            continue;
        while (p < cum.length - 1 && cum[p] <= d0 + 1e-6)
            p++;
        if (span <= haversine(samples[k], samples[k + 1]) * DENSIFY_RATIO)
            continue; // straight enough: the chord is fine
        while (p < cum.length - 1 && cum[p] < d1 - 1e-6) {
            verts.push({ lat: pts[p].lat, lon: pts[p].lon, k, f: (cum[p] - d0) / span });
            p++;
        }
    }
    return { verts, sampleIdx };
}

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
        }
        else {
            mx /= mlen;
            my /= mlen;
            // Miter: widen by 1/cos(half-angle), clamped so hairpins don't spike.
            normals.push({ nx: -my, ny: mx, scale: 1 / Math.max(1 / 3, mx * a.x + my * a.y) });
        }
    }
    return { map, zoom, pts, normals };
}

// Ribbon ring over draw-path vertices [iStart..iEnd]; widthAt(vertex) gives
// the half-width in px, so width can vary along the road (altitude flare).
function ribbonRing(geom, verts, iStart, iEnd, widthAt) {
    const left = [], right = [];
    for (let i = iStart; i <= iEnd; i++) {
        const p = geom.pts[i], { nx, ny, scale } = geom.normals[i];
        const w = widthAt(verts[i], geom.zoom) * scale;
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
    // Incline underlays live in their own pane just below the overlay pane:
    // structurally beneath every steep ribbon, drawn opaque, faded once via
    // the pane's CSS opacity.
    if (!map.getPane('inclines'))
        map.createPane('inclines').style.zIndex = 399;
    map.getPane('inclines').style.opacity = GRIND_OPACITY;
    map._inclineRenderer ??= L.canvas({ pane: 'inclines', padding: 0.3 });
    const group = L.layerGroup().addTo(map);
    const lines = new Map(); // road -> { skeleton, chunks:[{poly, ...}], steepest, dp }
    const isClimbMode = rankMode === 'climb';

    function setHighlight(road, on) {
        const e = lines.get(road);
        if (!e)
            return;
        e.skeleton.setStyle({ opacity: on ? 0.55 : 0 });
        const emphasizeClimb = isClimbMode && road.topExtents?.length;
        for (const { poly, prominent, isGrind } of e.chunks) {
            if (isGrind) {
                // Hover fattens the outline; the pane keeps it translucent.
                poly.setStyle({ opacity: on ? 1 : 0, fillOpacity: 1 });
            }
            else if (emphasizeClimb && !prominent) {
                poly.setStyle({ opacity: 0, fillOpacity: on ? 0.45 : 1 });
            }
            else {
                // The outline stroke (same color) fattens the ribbon when shown.
                poly.setStyle({ opacity: on ? 1 : 0, fillOpacity: 1 });
            }
        }
    }

    for (const road of [...ranked].reverse()) {
        const fg = L.featureGroup();
        const dp = buildDrawPath(road);
        const skeleton = L.polyline(dp.verts.map(v => [v.lat, v.lon]), {
            color: '#898781', weight: 2, opacity: 0, interactive: false,
        }).addTo(fg);
        const chunks = [];
        let steepest = null;
        let clickK = null; // set by a map click just before the bound popup opens
        const geom = roadGeometry(map, dp.verts);
        const lastK = road.samples.length - 1;
        // Very curvy roads cap their flare factor (computed once from the full
        // draw-path geometry) so a switchback can't balloon into a blob.
        road.curviness ??= roadCurviness(dp.verts);
        const roadMax = road.curviness > CURVY_TURN_PER_M ? CURVY_FLARE_MAX : WIDTH_FACTOR_MAX;
        // A run's half-width at each vertex: WIDTH_MIN at its lowest altitude,
        // plus flare growing with altitude above that base and with zoom (see
        // flareFactor) — thin -> thick reads as uphill. Per-sample values
        // interpolate across the densified draw-path vertices.
        const runWidthAt = (kStart, kEnd) => {
            let base = Infinity;
            for (let k = kStart; k <= kEnd; k++)
                base = Math.min(base, road.elev[k]);
            const halfAt = (k, f) =>
                (WIDTH_MIN + Math.min(WIDTH_PER_M * f * (road.elev[k] - base), (WIDTH_MAX - WIDTH_MIN) * f)) / 2;
            return (v, zoom) => {
                const f = flareFactor(zoom, roadMax);
                return halfAt(v.k, f) * (1 - v.f) + halfAt(Math.min(v.k + 1, lastK), f) * v.f;
            };
        };
        const wirePopup = (poly, stretchValue) => {
            // Click handler registered before bindPopup so it runs first and
            // the popup content can use the clicked segment.
            poly.on('click', e => { clickK = nearestSegIndex(road, e.latlng); });
            poly.bindPopup(() => {
                const k = clickK;
                clickK = null;
                return popupHtml(road, stretchValue, windowM, k);
            });
        };
        // Hue changes exactly at listed-climb extent boundaries.
        const split = isClimbMode && road.topExtents ? new Set(road.topExtents.flat()) : null;

        // Long-incline underlay: one continuous ribbon per incline run. Its
        // altitude-flare width accumulates over the whole run; the pane keeps
        // it beneath the steepness ribbons, which overlay without breaking it.
        if (road.grind) {
            let a = -1;
            for (let k = 0; k <= road.grind.length; k++) {
                const on = k < road.grind.length && road.grind[k];
                if (on && a < 0) {
                    a = k;
                }
                else if (!on && a >= 0) {
                    const kStart = a, kEnd = k; // sample range of the run
                    let best = 0;
                    for (let m = kStart; m < kEnd; m++)
                        best = Math.max(best, road.segs[m]);
                    const c = GRIND_COLORS[mode];
                    const widthAt = runWidthAt(kStart, kEnd);
                    const iStart = dp.sampleIdx[kStart], iEnd = dp.sampleIdx[kEnd];
                    const ring = ribbonRing(geom, dp.verts, iStart, iEnd, widthAt);
                    const poly = L.polygon(ring, {
                        pane: 'inclines', renderer: map._inclineRenderer,
                        interactive: false,
                        // Opaque within the pane; the pane itself is faded.
                        fillColor: c, fillOpacity: 1,
                        stroke: true, color: c, weight: LINE_WEIGHT, opacity: 0,
                    });
                    // Canvases don't forward pointer events between panes, so
                    // the visual ribbon can't receive clicks itself: an
                    // invisible twin on the main canvas is the hit target
                    // (added before the steep chunks, which win overlaps).
                    const hit = L.polygon(ring, { fill: true, fillOpacity: 0, stroke: false });
                    wirePopup(hit, best);
                    poly.addTo(fg);
                    hit.addTo(fg);
                    chunks.push({ poly, hit, prominent: false, isGrind: true, iStart, iEnd, widthAt });
                    a = -1;
                }
            }
        }

        // Group contiguous same-hue chunks into runs; each run's width starts
        // at WIDTH_MIN at its own lowest altitude, so thin -> thick = uphill.
        const runs = [];
        for (const chunk of colorChunks(road, split)) {
            // Red is reserved for the listed (top-N) roads — climb mode marks
            // the listed climb extents, sustained mode the whole listed road —
            // so map color mirrors the ranking; everything else steep is violet.
            const prominent = isClimbMode
                ? !!road.topExtents?.some(([ci, cj]) => chunk.kStart >= ci && chunk.kStart < cj)
                : !!road.listed;
            const hue = prominent ? 'climb' : 'other';
            const prev = runs[runs.length - 1];
            if (prev && prev.hue === hue && prev.kEnd === chunk.kStart) {
                prev.kEnd = chunk.kEnd;
                prev.items.push(chunk);
            }
            else {
                runs.push({ hue, prominent, kStart: chunk.kStart, kEnd: chunk.kEnd, items: [chunk] });
            }
        }
        for (const run of runs) {
            const widthAt = runWidthAt(run.kStart, run.kEnd);
            for (const chunk of run.items) {
                const c = (run.prominent ? color : colorAlt)(chunk.paint);
                const iStart = dp.sampleIdx[chunk.kStart], iEnd = dp.sampleIdx[chunk.kEnd];
                const poly = L.polygon(ribbonRing(geom, dp.verts, iStart, iEnd, widthAt), {
                    // Opaque fill: semi-transparent neighbors blend with the
                    // basemap at antialiased seam edges and show hairlines.
                    fillColor: c, fillOpacity: 1,
                    // Invisible outline; highlight raises its opacity to fatten the ribbon.
                    stroke: true, color: c, weight: LINE_WEIGHT, opacity: 0,
                });
                wirePopup(poly, chunk.value);
                poly.addTo(fg);
                chunks.push({ poly, prominent: run.prominent, kStart: chunk.kStart, kEnd: chunk.kEnd, paintVal: chunk.paint, iStart, iEnd, widthAt });
                if (!steepest || chunk.paint > steepest.chunkPaint) {
                    steepest = poly;
                    steepest.chunkPaint = chunk.paint;
                }
            }
        }
        fg.on('mouseover', () => setHighlight(road, true));
        fg.on('mouseout', () => setHighlight(road, false));
        fg.addTo(group);
        lines.set(road, { skeleton, chunks, steepest, dp });
    }

    // Pixel-based widths mean the ribbon geometry is zoom-dependent.
    const rebuild = () => {
        for (const e of lines.values()) {
            if (!e.chunks.length)
                continue;
            const geom = roadGeometry(map, e.dp.verts);
            for (const c of e.chunks) {
                const ring = ribbonRing(geom, e.dp.verts, c.iStart, c.iEnd, c.widthAt);
                c.poly.setLatLngs(ring);
                c.hit?.setLatLngs(ring);
            }
        }
    };
    map.on('zoomend', rebuild);

    return {
        group,
        highlight: setHighlight,
        focus(road, target) {
            const e = lines.get(road);
            if (!e)
                return;
            // Frame the given extent (a climb or an incline) if any, else the
            // whole road (sustained mode).
            const pts = target
                ? road.samples.slice(target.i, target.j + 1)
                : road.samples;
            map.fitBounds(L.latLngBounds(pts.map(s => [s.lat, s.lon])).pad(0.3));
            if (target) {
                // Open the popup on the steepest drawn chunk within the climb.
                let bestChunk = null;
                for (const c of e.chunks)
                    if (!c.isGrind && c.kEnd > target.i && c.kStart < target.j &&
                        (!bestChunk || c.paintVal > bestChunk.paintVal))
                        bestChunk = c;
                (bestChunk?.poly ?? e.steepest)?.openPopup();
            }
            else {
                e.steepest?.openPopup();
            }
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
export function renderList(el, entries, mode, { rankMode = 'sustained', onHover, onClick }) {
    const color = makeGradeColor(RAMPS[mode]);
    // Per-mode row fields: the bar length is `rankVal`, its color the `grade`,
    // the sub-line under the name, and the right-hand value label.
    const isClimb = rankMode === 'climb', isIncline = rankMode === 'incline';
    const rankVal = e => isClimb ? e.climb.score : isIncline ? e.incline.span : e.road.value;
    const grade = e => isClimb ? e.climb.grade : isIncline ? e.incline.grade : e.road.value;
    const subOf = e => isClimb ? fmtClimb(e.climb) : isIncline ? fmtIncline(e.incline) : fmtLen(e.road.length);
    const valueOf = e => isClimb ? e.climb.score.toFixed(1) : isIncline ? fmtLen(e.incline.span) : fmtPct(e.road.value);
    el.replaceChildren();
    if (!entries.length)
        return;
    const top = rankVal(entries[0]) || 1e-9;
    entries.forEach((entry, i) => {
        const { road } = entry;
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'road-row';
        row.innerHTML = `
            <span class="road-rank">${i + 1}</span>
            <span class="road-main">
                <span class="road-name" title="${esc(road.name)}">${esc(abbrevName(road.name))}</span>
                <span class="road-sub">${subOf(entry)}</span>
                <span class="road-track"><span class="road-bar" style="width:${Math.max(2, (rankVal(entry) / top) * 100)}%;background:${color(grade(entry))}"></span></span>
            </span>
            <span class="road-value">${valueOf(entry)}</span>`;
        row.addEventListener('mouseenter', () => onHover(entry, true));
        row.addEventListener('mouseleave', () => onHover(entry, false));
        row.addEventListener('click', () => onClick(entry));
        el.appendChild(row);
    });
}
