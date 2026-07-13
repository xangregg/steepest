# Steepest Road in Town

A static web app that answers the question: **what's the steepest road in town?**
Type a town name (or `lat, lon`), pick a search radius, a sustained-stretch
length, and a minimum road length — get a map of roads colored by steepness plus
a ranked bar list of the steepest ones.

Everything runs in the browser against free public APIs; there is no backend and
no database, so it hosts happily on GitHub Pages.

## How it works

1. **Geocoding** — [Nominatim](https://nominatim.org/release-docs/latest/api/Search/)
   turns the place name into coordinates (a `lat, lon` input skips this).
2. **Roads** — the [Overpass API](https://overpass-api.de/) returns all drivable
   OSM ways (`residential` … `trunk`) within the radius. Ways sharing a name and
   an endpoint are stitched into continuous roads — but only when travel
   continues roughly straight through the join (≤ 70° turn) and any TIGER
   `name_base`/`name_type` tags agree, so distinct streets that share a
   TIGER-mangled name don't chain into one fictional road. Bridge and tunnel spans are
   kept for continuity, but their elevations are replaced by a straight-line
   deck between the solid ground at each end — the elevation model reports the
   gorge under a bridge, not the roadway.
3. **Elevation** — each road is resampled every ~25 m, and elevations come from
   [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
   (Mapzen terrarium PNGs, decoded pixel-by-pixel in a canvas — free, global,
   no API key). Elevations get a 3-point moving average to tame DEM noise.
4. **Metrics** — two ranking modes:
   - **Hardest climb** (default): effort rather than grade — each road's best
     continuous climb (in either travel direction), scored by the **effort
     integral** Σ segment length × grade², which equals gain × average grade
     (FIETS-style) on a steady climb: same gain over half the distance scores
     double, and every stretch of real climbing adds. A climb tolerates only
     small counter-slope (≤ max(2 m, 10 % of ascent)), so a genuine dip ends
     one climb and starts another; near-flat tails (< 5 %) aren't part of the
     climb, while adjacent ≥ 5 % climbing is included even when it's gentler
     than the core.
   - **Steepest sustained**: the best average grade a road holds over any
     stretch of the chosen length (default 250 m). The length is a numeric
     input: 25 m degenerates to "steepest single segment" (noisy — treat with
     skepticism), longer windows reward genuinely long climbs. Roads shorter
     than the window are excluded, since the metric is undefined for them.

   Changing mode or window re-ranks instantly from cached elevation profiles.
5. **Caching** — processed results (roads with elevation profiles) are cached
   in IndexedDB per center+radius for two weeks, so repeat searches skip
   Overpass and tile sampling entirely; a "refresh from OSM" link in the status
   line forces a refetch. Geocode lookups are cached in localStorage.
6. **Rendering** — Leaflet (canvas renderer) with a CARTO basemap; roads are
   colored on a fixed 5–25 % single-hue ramp so colors mean the same thing in
   every town. Coloring is localized: each ~25 m segment is colored by the
   steepest window-length stretch it belongs to, and stretches under 5 % get no
   highlight at all — so the map shows where the hills are, and a long road
   fades in and out with its actual climbs instead of wearing its single best
   grade everywhere. Long inclines — stretches of at least 4× the min length,
   mostly monotonic, averaging ≥ 2 % — are drawn as a continuous translucent
   amber underlay beneath the steepness ribbons, so a mile-long 2.5 % incline is
   acknowledged instead of invisible; its width flare accumulates over the
   whole incline, unbroken by whatever steep colors sit on top. In
   hardest-climb mode, the listed (top-25) roads' climbs wear the red ramp
   while all other steep stretches use a contrasting violet ramp (same 5–25 %
   scale), so map color mirrors the ranking; a road's winning climb is
   also kept visibly continuous — its segments are colored at least the climb's
   average grade, so a breather mid-climb doesn't punch a hole in the highlight. The sidebar bar chart shares the ramp and doubles as the ranked
   list; hover to highlight on the map, click to zoom. Searches are encoded in
   the URL hash, so results are shareable. Light and dark themes follow the OS.

## Running locally

Browsers block ES modules from `file://`, so serve the directory:

```sh
npm start          # python3 -m http.server 8080
open http://localhost:8080
```

## Testing

`npm test` runs the full pipeline in Node (real Nominatim/Overpass/terrain-tile
calls, with `pngjs` standing in for the canvas decoder) plus unit checks on the
resampling and metric math. Requires `npm install` once, and network access.

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
