// Best-effort IndexedDB cache of processed search results (roads with sampled
// elevation profiles), so repeat searches skip Overpass and tile sampling.
// Every operation swallows failures — a broken cache (private mode, quota)
// must never break the app.

const DB_NAME = 'steepest';
const STORE = 'searches';
const VERSION_TAG = 4;                       // bump when the processed-road shape changes
const TTL_MS = 14 * 24 * 3600 * 1000;        // roads barely change; 2 weeks is safe

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function withStore(mode, fn) {
    const db = await openDb();
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, mode);
            const req = fn(tx.objectStore(STORE));
            tx.oncomplete = () => resolve(req?.result);
            tx.onerror = () => reject(tx.error);
        });
    } finally {
        db.close();
    }
}

// ~111 m rounding: the same town name always geocodes to the same point, and
// nearby lat/lon inputs share an entry.
export function searchKey(center, radiusM) {
    return `${center.lat.toFixed(3)},${center.lon.toFixed(3)},${Math.round(radiusM)}`;
}

const expired = entry => entry.version !== VERSION_TAG || Date.now() - entry.t > TTL_MS;

// -> { roads, t } or null on miss/stale/error.
export async function cacheGet(key) {
    try {
        const entry = await withStore('readonly', s => s.get(key));
        return entry && !expired(entry) ? entry : null;
    } catch (err) {
        console.warn('[cache] read failed:', err);
        return null;
    }
}

export async function cachePut(key, roads) {
    try {
        await withStore('readwrite', s => s.put({ version: VERSION_TAG, t: Date.now(), roads }, key));
        await withStore('readwrite', s => {
            s.openCursor().onsuccess = e => {
                const cur = e.target.result;
                if (!cur) return;
                if (expired(cur.value)) cur.delete();
                cur.continue();
            };
        });
    } catch (err) {
        console.warn('[cache] write failed:', err); // best effort — never fatal
    }
}
