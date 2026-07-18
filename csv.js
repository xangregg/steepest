// CSV export of the current ranking. Columns differ by mode (the user gets
// what's relevant to how it was ranked): climb rows carry the climb's
// score/gain and its bottom/top endpoints; sustained rows carry the road's
// best-window endpoints. Coordinates are the ~25 m sample points bracketing the
// ranked stretch, with their DEM elevations. Pure and stringly, so unit-tested.

import { bestSustainedWindow } from './metrics.js';

const csvField = v => {
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
// A sample point as [lat, lon, elevation] for the CSV.
// Values aren't rounded to display precision — the numbers are approximate
// (DEM/geometry), but exposing 3 decimals keeps that detail inspectable.
const endpoint = (road, k) => [road.samples[k].lat.toFixed(6), road.samples[k].lon.toFixed(6), road.elev[k].toFixed(3)];

// Filename like steepest-climbs-chapel-hill.csv from the place label.
export function csvFilename(rankMode, windowM, label = 'area') {
    const place = label.split(',')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const what = rankMode === 'climb' ? 'climbs' : rankMode === 'incline' ? 'inclines' : `sustained-${Math.round(windowM)}m`;
    return `steepest-${what}-${place || 'area'}.csv`;
}

export function buildCsv({ entries, rankMode, windowM }) {
    const rows = [];
    if (rankMode === 'climb') {
        rows.push(['rank', 'name', 'score', 'grade_pct', 'gain_m', 'length_m',
            'start_lat', 'start_lon', 'start_elev_m', 'end_lat', 'end_lon', 'end_elev_m']);
        entries.forEach(({ road, climb }, idx) => {
            const lo = climb.dir > 0 ? climb.i : climb.j; // bottom of the climb
            const hi = climb.dir > 0 ? climb.j : climb.i; // top
            rows.push([idx + 1, road.name, climb.score.toFixed(3), (climb.grade * 100).toFixed(3),
                climb.gain.toFixed(3), climb.span.toFixed(3), ...endpoint(road, lo), ...endpoint(road, hi)]);
        });
    }
    else if (rankMode === 'incline') {
        rows.push(['rank', 'name', 'length_m', 'grade_pct', 'gain_m',
            'start_lat', 'start_lon', 'start_elev_m', 'end_lat', 'end_lon', 'end_elev_m']);
        entries.forEach(({ road, incline }, idx) => {
            rows.push([idx + 1, road.name, incline.span.toFixed(3), (incline.grade * 100).toFixed(3), incline.gain.toFixed(3),
                ...endpoint(road, incline.i), ...endpoint(road, incline.j)]);
        });
    }
    else {
        rows.push(['rank', 'name', 'grade_pct', 'window_m', 'road_length_m',
            'start_lat', 'start_lon', 'start_elev_m', 'end_lat', 'end_lon', 'end_elev_m']);
        entries.forEach(({ road }, idx) => {
            const w = bestSustainedWindow(road.samples, road.elev, windowM);
            const i = w ? w.i : 0;
            const j = w ? w.j : road.samples.length - 1;
            rows.push([idx + 1, road.name, (road.value * 100).toFixed(3), Math.round(windowM), road.length.toFixed(3),
                ...endpoint(road, i), ...endpoint(road, j)]);
        });
    }
    // BOM so Excel reads UTF-8 (accented road names); CRLF per the CSV RFC.
    return '\ufeff' + rows.map(r => r.map(csvField).join(',')).join('\r\n') + '\r\n';
}
