// The tiny persistence wrapper: one key/value object store, nothing else.
//
// Two implementations with the same four methods, so every piece of logic above this file
// can be driven in Node with the in-memory one (see test/session.test.mjs):
//
//   { available, kind, get(key), set(key, value), remove(key), clear() }
//
// Values go through the structured clone algorithm, which is what IndexedDB does anyway:
// the memory fake clones too, so a value that cannot be stored fails in the tests and not
// only in a browser. Typed arrays (the firmware bytes, the Float64Array of every imported
// wave) survive this unchanged, which is the whole reason the tool state must be plain data.

export const DB_NAME = "syntakt-mods";
export const STORE_NAME = "session";
const DB_VERSION = 1;

const clone = (v) => (typeof structuredClone === "function" ? structuredClone(v) : v);

/** In-memory store: the fallback when IndexedDB is unavailable, and the test double. */
export function createMemoryStore(kind = "memory") {
  const map = new Map();
  return {
    available: kind !== "memory",
    kind,
    async get(key) { return map.has(key) ? clone(map.get(key)) : undefined; },
    async set(key, value) { map.set(key, clone(value)); },
    async remove(key) { map.delete(key); },
    async clear() { map.clear(); },
  };
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB request failed"));
  });
}

function openDb(timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    // An open() queued behind another tab's pending delete or upgrade never settles: give up and work in memory.
    const timer = setTimeout(() => reject(new Error("IndexedDB did not answer")), timeoutMs);
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => {
      clearTimeout(timer);
      const db = req.result;
      db.onversionchange = () => db.close(); // let other tabs upgrade or delete without hanging
      resolve(db);
    };
    req.onerror = () => { clearTimeout(timer); reject(req.error || new Error("IndexedDB could not be opened")); };
    req.onblocked = () => { clearTimeout(timer); reject(new Error("IndexedDB is blocked by another tab")); };
  });
}

function createIdbStore(db) {
  const tx = (mode, fn) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE_NAME, mode);
    let out;
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error || new Error("IndexedDB transaction failed"));
    t.onabort = () => reject(t.error || new Error("IndexedDB transaction aborted"));
    Promise.resolve(fn(t.objectStore(STORE_NAME))).then((v) => { out = v; }, reject);
  });
  return {
    available: true,
    kind: "indexeddb",
    get: (key) => tx("readonly", (s) => request(s.get(key))),
    set: (key, value) => tx("readwrite", (s) => request(s.put(value, key))),
    remove: (key) => tx("readwrite", (s) => request(s.delete(key))),
    clear: () => tx("readwrite", (s) => request(s.clear())),
  };
}

/**
 * The store the page uses: IndexedDB when the browser allows it, otherwise an in-memory one
 * with `available === false` so the page can say so once, unobtrusively. Never throws.
 */
export async function openStore() {
  if (typeof indexedDB === "undefined") return createMemoryStore();
  try {
    const db = await openDb();
    const store = createIdbStore(db);
    await store.get("__probe"); // private mode can open the database and refuse to use it
    return store;
  } catch {
    return createMemoryStore();
  }
}

/** Erase everything this site stored, database included. Safe to call when there is nothing. */
export async function deleteDatabase() {
  if (typeof indexedDB === "undefined" || !indexedDB.deleteDatabase) return;
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}
