// Wrapper mínimo de IndexedDB.

const DB_NAME = 'tarjetas';
const DB_VERSION = 1;
export const STORES = ['decks', 'cards', 'reviews', 'settings'];

let dbPromise;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('decks')) db.createObjectStore('decks', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('cards')) {
        const s = db.createObjectStore('cards', { keyPath: 'id' });
        s.createIndex('deckId', 'deckId');
      }
      if (!db.objectStoreNames.contains('reviews')) {
        const s = db.createObjectStore('reviews', { keyPath: 'id' });
        s.createIndex('cardId', 'cardId');
        s.createIndex('deckId', 'deckId');
      }
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function done(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transacción abortada'));
  });
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAll(store) {
  const db = await openDB();
  return wrap(db.transaction(store).objectStore(store).getAll());
}

export async function get(store, key) {
  const db = await openDB();
  return wrap(db.transaction(store).objectStore(store).get(key));
}

export async function put(store, value) {
  return putMany(store, [value]);
}

export async function putMany(store, values) {
  const db = await openDB();
  const t = db.transaction(store, 'readwrite');
  const s = t.objectStore(store);
  for (const v of values) s.put(v);
  return done(t);
}

export async function delMany(store, keys) {
  const db = await openDB();
  const t = db.transaction(store, 'readwrite');
  const s = t.objectStore(store);
  for (const k of keys) s.delete(k);
  return done(t);
}

export async function del(store, key) {
  return delMany(store, [key]);
}

/** Ejecuta varias operaciones en una sola transacción. ops: [{store, put?:[], del?:[], clear?:true}] */
export async function batch(ops) {
  const db = await openDB();
  const names = [...new Set(ops.map((o) => o.store))];
  const t = db.transaction(names, 'readwrite');
  for (const o of ops) {
    const s = t.objectStore(o.store);
    if (o.clear) s.clear();
    for (const k of o.del || []) s.delete(k);
    for (const v of o.put || []) s.put(v);
  }
  return done(t);
}
