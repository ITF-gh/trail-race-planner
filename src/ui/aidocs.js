// aidocs.js: the AI docs, every AI answer kept on this device (account menu > AI docs).

const AD_DB = "trp-ai-docs", AD_STORE = "docs";
let adCache = null; // the docs, once read; also the fallback when IndexedDB is blocked

/** Open (and on first use create) the database; null when the browser blocks it. */
function adOpen() {
  return new Promise((ok) => {
    try {
      const req = indexedDB.open(AD_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(AD_STORE, { keyPath: "id" });
      req.onsuccess = () => ok(req.result);
      req.onerror = () => ok(null);
    } catch (e) {
      ok(null);
    }
  });
}
/** One transaction: `fn(store)` returns a request (or null); resolves with its result. */
async function adTx(mode, fn) {
  const db = await adOpen();
  if (!db) return null;
  return new Promise((ok) => {
    try {
      const tx = db.transaction(AD_STORE, mode);
      const req = fn(tx.objectStore(AD_STORE));
      tx.oncomplete = () => ok(req ? req.result : true);
      tx.onerror = () => ok(null);
    } catch (e) {
      ok(null);
    }
  });
}

/** Every doc, newest first. */
export async function aiDocsAll() {
  if (!adCache) adCache = (await adTx("readonly", (s) => s.getAll())) || [];
  return [...adCache].sort((a, b) => (a.at < b.at ? 1 : -1));
}
/** Keep one doc (a new id each call). */
export async function aiDocsPut(doc) {
  adCache = [...(adCache || (await adTx("readonly", (s) => s.getAll())) || []).filter((d) => d.id !== doc.id), doc];
  await adTx("readwrite", (s) => s.put(doc));
}
/** One doc by id, or null. */
export async function aiDocsGet(id) {
  return (await aiDocsAll()).find((d) => d.id === id) || null;
}
/** Delete one doc. */
export async function aiDocsDelete(id) {
  adCache = (adCache || []).filter((d) => d.id !== id);
  await adTx("readwrite", (s) => s.delete(id));
}
