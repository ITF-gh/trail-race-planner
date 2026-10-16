// aidocs.js: the AI docs, every AI answer kept on this device (account menu > AI docs).
//
// One doc per AI call: when, which race and mode, what was sent (the INPUT), what came back
// (the raw OUTPUT), the tokens, and the summary the referee made of it (status, finish, legs,
// texts). The raw output is what lets Your race play a doc again later: the code rebuilds the
// plan from it each time (airace.js), so a doc never holds a plan that could go out of date.
//
// Stored in IndexedDB (database "trp-ai-docs", store "docs", one record per id), like the run log
// of account.js: far roomier than localStorage, and each doc can weigh 50 to 200 KB. Kept on this
// device only for now; the online account will keep them too once it opens.
//
// The helpers never reject: a blocked database resolves with [] or null, and the app goes on.

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
