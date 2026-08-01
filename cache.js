// Best-effort IndexedDB cache of processed search results (roads with sampled
// elevation profiles), so repeat searches skip Overpass and tile sampling.
// Every operation swallows failures — a broken cache (private mode, quota)
// must never break the app.

const DB_NAME = 'steepest';
const STORE = 'searches';
// Bump when the processed-road shape changes: it expires cached searches, and
// test/make-fixture.mjs stamps it into fixtures so a stale one can be spotted.
export const VERSION_TAG = 9;
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
    }
    finally {
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
    }
    catch (err) {
        console.warn('[cache] read failed:', err);
        return null;
    }
}

// -> { count, bytes } for the "Clear cache" control. count is the exact number
// of cached searches; bytes is the origin's storage estimate (dominated by this
// IndexedDB, plus a little localStorage for geocodes) — browser-padded and
// approximate, and null where the Storage API isn't available.
export async function cacheStats() {
    let count = 0, bytes = null;
    try {
        count = (await withStore('readonly', s => s.count())) ?? 0;
    }
    catch (err) {
        console.warn('[cache] count failed:', err);
    }
    try {
        if (navigator.storage?.estimate)
            bytes = (await navigator.storage.estimate()).usage ?? null;
    }
    catch (err) {
        console.warn('[cache] estimate failed:', err);
    }
    return { count, bytes };
}

// Wipe every cached search. -> true on success. The cache rebuilds itself on
// the next search, so this is purely a "reclaim space now" action.
export async function cacheClear() {
    try {
        await withStore('readwrite', s => s.clear());
        return true;
    }
    catch (err) {
        console.warn('[cache] clear failed:', err);
        return false;
    }
}

export async function cachePut(key, roads) {
    try {
        await withStore('readwrite', s => s.put({ version: VERSION_TAG, t: Date.now(), roads }, key));
        await withStore('readwrite', s => {
            s.openCursor().onsuccess = e => {
                const cur = e.target.result;
                if (!cur)
                    return;
                if (expired(cur.value))
                    cur.delete();
                cur.continue();
            };
        });
    }
    catch (err) {
        console.warn('[cache] write failed:', err); // best effort — never fatal
    }
}
