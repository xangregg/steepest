# Steepest Road in Town

A static web app that answers the question: **what's the steepest road in town?**
Type a town name (or `lat, lon`), pick a search radius, a sustained-stretch
length, and a long-incline length — get a map of roads colored by steepness plus
a ranked bar list of the steepest ones.

Everything runs in the browser against free public APIs; there is no backend and
no database, so it hosts happily on GitHub Pages.

Code and docs were largely written using Claude Code (Fable 5 and Opus 4.8).

## How it works

1. **Geocoding** — [Nominatim](https://nominatim.org/release-docs/latest/api/Search/)
   turns the place name into coordinates (a `lat, lon` input skips this).
2. **Roads** — the [Overpass API](https://overpass-api.de/) returns all drivable
   OpenStreetMap (OSM) ways (`residential` … `trunk`) within the radius. Ways
   sharing a name and an endpoint are stitched into continuous roads — but
   only when travel continues roughly straight through the join (≤ 70° turn)
   and any TIGER `name_base`/`name_type` tags agree (TIGER is the US Census
   Bureau's road data, bulk-imported into OSM in 2007 with often-mangled
   names), so distinct streets that share such a name don't chain into one
   fictional road. Bridge and tunnel spans are
   kept for continuity, but their elevations are replaced by a straight-line
   deck between the solid ground at each end — the elevation model reports the
   gorge under a bridge, not the roadway.
3. **Elevation** — each road is resampled every ~25 m, and elevations come from
   [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
   (Mapzen terrarium PNGs, decoded pixel-by-pixel in a canvas — free, global,
   no API key). Elevations get a 3-point moving average to tame noise in the
   digital elevation model (DEM).
4. **Metrics** — three ranking modes:
   - **Hardest climb** (default): effort rather than grade — each road's best
     continuous climb (in either travel direction), scored by the **effort
     integral** Σ segment length × grade², which equals gain × average grade
     on a steady climb (the FIETS index from the Dutch cycling magazine
     *Fiets* uses the same core formula): same gain over half the distance scores
     double, and every stretch of real climbing adds. A climb tolerates only
     small counter-slope (≤ max(2 m, 10 % of ascent)), so a genuine dip ends
     one climb and starts another; near-flat tails (< 5 %) aren't part of the
     climb, while adjacent ≥ 5 % climbing is included even when it's gentler
     than the core. Up to three non-overlapping climbs are extracted per road
     and all compete individually in the ranking, so a road with two distinct
     hills can take two list spots (same-name entries are deduped
     geographically, so parallel carriageways still yield one row per
     physical climb).
   - **Steepest sustained**: the best average grade a road holds over any
     stretch of the chosen length (default 250 m). The length is a numeric
     input: 25 m degenerates to "steepest single segment" (noisy — treat with
     skepticism), longer windows reward genuinely long climbs. Roads shorter
     than the window are excluded, since the metric is undefined for them.
   - **Longest incline**: the length of the road's longest long-incline run —
     the same mostly-monotonic, ≥ 2.25 % stretches (of at least the "long
     incline" length) that get the amber underlay described below. Ranks roads
     by how far the hill goes rather than how steep it gets; roads with no
     qualifying incline drop out.

   Changing mode or window re-ranks instantly from cached elevation profiles.
5. **Caching** — processed results (roads with elevation profiles) are cached
   in IndexedDB per center+radius for two weeks, so repeat searches skip
   Overpass and tile sampling entirely; a "refresh from OSM" link in the status
   line forces a refetch. Geocode lookups are cached in localStorage.
6. **Rendering** — Leaflet (canvas renderer) with a CARTO basemap; roads are
   colored on a fixed 5–25 % single-hue color gradient so colors mean the same
   thing in every town. Coloring is localized: each ~25 m segment is colored by
   the steepest window-length stretch it belongs to, and stretches under 5 %
   get no highlight at all — so the map shows where the hills are, and a long
   road fades in and out with its actual climbs instead of wearing its single
   best grade everywhere. Long inclines — mostly monotonic stretches at least
   the "long incline" length (default 800 m), averaging ≥ 2.25 % — are drawn as a
   continuous
   translucent amber underlay beneath the steepness ribbons, so a mile-long
   2.5 % incline is acknowledged instead of invisible; its width flare
   accumulates over the whole incline, unbroken by whatever steep colors sit
   on top. In hardest-climb mode, the listed (top-25) roads' climbs wear the
   red gradient while all other steep stretches use a contrasting violet
   gradient (same 5–25 % scale), so map color mirrors the ranking. A winning
   climb is also kept visually continuous: any flat or gentle stretch inside
   it is colored as if it had the climb's average grade, so a breather
   mid-climb doesn't punch a hole in the highlight (the popup still reports
   the true local grade). The sidebar bar chart shares the color gradient and
   doubles as the ranked list; hover to highlight on the map, click to zoom.
   A "Download CSV" button exports the current ranking — including begin/end
   lat/lon/elevation for each ranked stretch, with columns tailored to the
   ranking mode. Searches are encoded in the URL hash, so results are
   shareable. Light and dark themes follow the OS.

## Code tour

- `roads.js` — geocoding (Nominatim, localStorage-cached), the streaming
  Overpass fetch with mirror retries, and way stitching: same-name ways merge
  where travel continues straight through the join (bearing gate), TIGER
  `name_base`/`name_type` tags must agree, and three-end junctions (a two-way
  road becoming a divided road) merge their straightest pair. Bridge/tunnel
  points are flagged for elevation correction.
- `elevation.js` — terrarium PNG tile decoding and bilinear sampling, with a
  module-level tile cache and a pluggable decoder (canvas in the browser,
  pngjs in Node tests).
- `metrics.js` — all profile math; see its header for conventions. Tunable
  thresholds live as documented constants at the top of each section.
- `render.js` — ribbon drawing, hue rules, legend, popups; see its header for
  the full rendering model.
- `cache.js` — IndexedDB persistence of processed roads (versioned; bump
  `VERSION_TAG` when the processed shape or pipeline output changes).
- `csv.js` — builds the "Download CSV" export of the current ranking; the
  columns differ by mode (climb rows carry each climb's score/gain and its
  bottom→top endpoints; sustained rows carry the best-window endpoints), with
  begin/end lat/lon/elevation for the ranked stretch.
- `app.js` — UI wiring and orchestration; its header documents the road
  object's field lifecycle. Also exposes the `window.steepest` dev hook for
  live style experiments.
- `test/unit.test.mjs` — network-free checks on synthetic profiles (the default
  `npm test`); `test/live.test.mjs` is the on-demand end-to-end run against real
  Nominatim/Overpass/tiles (`npm run test:live`), and `test/assert.mjs` is the
  shared assert. `test/render.html` is a visual fixture of synthetic roads
  exercising every rendering rule; `test/cache.html` and `test/cache-unit.html`
  cover the IndexedDB cache in a real browser. `test/make-fixture.mjs` captures a
  real search into `test/fixtures/<name>.json` (e.g. the committed
  `brevard.json`), which the app renders offline via `#fixture=<name>` — for
  checking the UI without Overpass.

## Running locally

Browsers block ES modules from `file://`, so serve the directory:

```sh
npm start          # python3 -m http.server 8080
open http://localhost:8080
```

### Offline preview

`#fixture=brevard` renders a saved Brevard search
(`test/fixtures/brevard.json`) with no Nominatim/Overpass/tile-metadata calls —
useful for demos or UI work when the public APIs are slow, e.g.
`http://localhost:8080/#fixture=brevard`. Capture more (or refresh this one)
with `node test/make-fixture.mjs "<place>" <radius_m> <name>` when Overpass is
responsive.

## Testing

`npm test` runs the network-free unit checks (stitching, resampling, the metric
and climb math, long-incline masking, bridge/tunnel interpolation, CSV export)
on synthetic profiles — fast and safe for CI, no network needed.

`npm run test:live` runs the on-demand end-to-end check: a real
Nominatim/Overpass/terrain-tile run against a small town (`pngjs` stands in for
the browser's canvas decoder), so it needs network access and is subject to the
public servers' rate limits. `npm run test:all` runs both.

All of them need `npm install` once (for `pngjs`).

## Deploying to GitHub Pages

Push to GitHub, then Settings → Pages → deploy from branch `main`, root folder.
No build step.

## Known limitations

- The DEM is ~10–30 m resolution: on switchbacks or roads cut into steep
  hillsides, samples can catch the hillside instead of the roadbed and overstate
  grades (longer sustained windows resist this; short ones don't).
- Public Overpass servers rate-limit; big-city searches at large radii can be
  slow or need a retry (the app retries mirrors automatically).
- "Town" is approximated by a radius around the geocoded center rather than
  actual municipal boundaries.
