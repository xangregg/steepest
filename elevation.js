// Elevation sampling from AWS Terrain Tiles (Mapzen "terrarium" encoding).
// Free, global, no API key, no database: elevation is decoded from PNG pixels.
// https://registry.opendata.aws/terrain-tiles/

const TILE_SIZE = 256;
const tileUrl = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

const tileCache = new Map(); // "z/x/y" -> Promise<RGBA byte array>

// Browser tile decoder: PNG -> flat RGBA bytes via canvas. A Node test can pass
// its own decoder (e.g. pngjs) to elevatePoints instead.
async function decodeTileBrowser(url, signal) {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`Elevation tile HTTP ${res.status}`);
    const bmp = await createImageBitmap(await res.blob());
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = TILE_SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    return ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
}

// Fractional web-mercator tile coordinates.
function lonLatToTile(lat, lon, z) {
    const n = 2 ** z;
    const x = ((lon + 180) / 360) * n;
    const latR = (lat * Math.PI) / 180;
    const y = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n;
    return { x, y };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// terrarium: elevation (m) = R*256 + G + B/256 - 32768
function elevAtPixel(rgba, x, y) {
    const i = (y * TILE_SIZE + x) * 4;
    return rgba[i] * 256 + rgba[i + 1] + rgba[i + 2] / 256 - 32768;
}

function bilinear(rgba, px, py) {
    const fx = clamp(px - 0.5, 0, TILE_SIZE - 1);
    const fy = clamp(py - 0.5, 0, TILE_SIZE - 1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(TILE_SIZE - 1, x0 + 1), y1 = Math.min(TILE_SIZE - 1, y0 + 1);
    const wx = fx - x0, wy = fy - y0;
    const top = elevAtPixel(rgba, x0, y0) * (1 - wx) + elevAtPixel(rgba, x1, y0) * wx;
    const bot = elevAtPixel(rgba, x0, y1) * (1 - wx) + elevAtPixel(rgba, x1, y1) * wx;
    return top * (1 - wy) + bot * wy;
}

async function runPool(jobs, limit) {
    const queue = [...jobs];
    const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
        while (queue.length) await queue.shift()();
    });
    await Promise.all(workers);
}

// points: [{lat, lon}, ...] -> Float64Array of elevations (m), same order.
// Tiles are fetched once each (module-level cache persists across runs).
export async function elevatePoints(points, { zoom = 13, decodeTile = decodeTileBrowser, onProgress, concurrency = 8, signal } = {}) {
    const n = 2 ** zoom;
    const locs = points.map(p => {
        const t = lonLatToTile(p.lat, p.lon, zoom);
        const tx = clamp(Math.floor(t.x), 0, n - 1);
        const ty = clamp(Math.floor(t.y), 0, n - 1);
        return { key: `${zoom}/${tx}/${ty}`, url: tileUrl(zoom, tx, ty), px: (t.x - tx) * TILE_SIZE, py: (t.y - ty) * TILE_SIZE };
    });

    const needed = new Map(); // key -> url, only tiles not already cached
    for (const l of locs) if (!tileCache.has(l.key) && !needed.has(l.key)) needed.set(l.key, l.url);
    let done = 0;
    const total = needed.size;
    onProgress?.(0, total);
    await runPool([...needed].map(([key, url]) => async () => {
        const promise = decodeTile(url, signal);
        tileCache.set(key, promise);
        try {
            await promise;
        } catch (err) {
            tileCache.delete(key); // don't cache failures
            throw err;
        }
        onProgress?.(++done, total);
    }), concurrency);

    const out = new Float64Array(points.length);
    for (let i = 0; i < locs.length; i++) {
        out[i] = bilinear(await tileCache.get(locs[i].key), locs[i].px, locs[i].py);
    }
    return out;
}
