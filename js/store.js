// IndexedDB 저장소
// docs : 문서 메타데이터 {id, name, size, pageCount, created, updated, opened, view, thumb}
// files: PDF 원본 {id, data: Blob}
// pages: 페이지별 필기 {docId, page, items, rev, saved}  (키: [docId, page])
// kv   : 기타 {k, v}  (예: lastDoc)

const DB_NAME = 'flexnote';
const DB_VERSION = 1;
let dbPromise = null;

function req2p(req) {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
function tx2p(tx) {
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error || new Error('transaction error'));
    tx.onabort = () => rej(tx.error || new Error('transaction aborted'));
  });
}

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('이 브라우저는 IndexedDB를 지원하지 않습니다.')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('pages')) {
        const s = db.createObjectStore('pages', { keyPath: ['docId', 'page'] });
        s.createIndex('byDoc', 'docId');
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onblocked = () => console.warn('IndexedDB open blocked');
  });
  return dbPromise;
}

async function store(names, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(names, mode);
}

export async function listDocs() {
  const tx = await store('docs');
  const all = await req2p(tx.objectStore('docs').getAll());
  return all.sort((a, b) => (b.opened || b.updated || 0) - (a.opened || a.updated || 0));
}

export async function getDoc(id) {
  const tx = await store('docs');
  return req2p(tx.objectStore('docs').get(id));
}

export async function putDoc(doc) {
  const tx = await store('docs', 'readwrite');
  tx.objectStore('docs').put(doc);
  return tx2p(tx);
}

/** 문서 메타 일부만 갱신 (다른 필드는 보존) */
export async function patchDoc(id, patch) {
  const tx = await store('docs', 'readwrite');
  const s = tx.objectStore('docs');
  const cur = await req2p(s.get(id));
  if (cur) s.put({ ...cur, ...patch });
  return tx2p(tx);
}

/** PDF 원본과 메타데이터를 하나의 트랜잭션으로 저장 (둘 중 하나만 남는 상황 방지) */
export async function addDocWithFile(doc, blob) {
  const tx = await store(['docs', 'files'], 'readwrite');
  tx.objectStore('files').put({ id: doc.id, data: blob });
  tx.objectStore('docs').put(doc);
  return tx2p(tx);
}

export async function getFile(id) {
  const tx = await store('files');
  const rec = await req2p(tx.objectStore('files').get(id));
  return rec ? rec.data : null;
}

export async function loadPages(docId) {
  const tx = await store('pages');
  const idx = tx.objectStore('pages').index('byDoc');
  return req2p(idx.getAll(IDBKeyRange.only(docId)));
}

/** 변경된 페이지들을 한 번에 저장. records: [{docId, page, items, rev}] */
export async function savePages(docId, records, docPatch) {
  const tx = await store(['pages', 'docs'], 'readwrite');
  const ps = tx.objectStore('pages');
  const t = Date.now();
  for (const r of records) {
    if (r.items.length === 0) ps.delete([docId, r.page]);
    else ps.put({ docId, page: r.page, items: r.items, rev: r.rev, saved: t, v: 1 });
  }
  const ds = tx.objectStore('docs');
  const cur = await req2p(ds.get(docId));
  if (cur) ds.put({ ...cur, ...(docPatch || {}), updated: t });
  return tx2p(tx);
}

/**
 * 페이지 구조 변경(추가/삭제) 저장: PDF 원본 교체 + 필기 레코드 전체 재작성 + 메타 갱신을 한 트랜잭션으로.
 * 중간에 실패하면 아무것도 바뀌지 않는다 (PDF 와 필기 페이지 번호가 어긋나는 일 방지).
 */
export async function replaceDocStructure(docId, blob, records, docPatch) {
  const tx = await store(['docs', 'files', 'pages'], 'readwrite');
  tx.objectStore('files').put({ id: docId, data: blob });
  const ps = tx.objectStore('pages');
  const keys = await req2p(ps.index('byDoc').getAllKeys(IDBKeyRange.only(docId)));
  for (const k of keys) ps.delete(k);
  const t = Date.now();
  for (const r of records) if (r.items.length) ps.put({ docId, page: r.page, items: r.items, rev: r.rev, saved: t, v: 1 });
  const ds = tx.objectStore('docs');
  const cur = await req2p(ds.get(docId));
  if (cur) ds.put({ ...cur, ...docPatch, updated: t });
  return tx2p(tx);
}

export async function deleteDoc(id) {
  const tx = await store(['docs', 'files', 'pages', 'kv'], 'readwrite');
  tx.objectStore('docs').delete(id);
  tx.objectStore('files').delete(id);
  const idx = tx.objectStore('pages').index('byDoc');
  const keys = await req2p(idx.getAllKeys(IDBKeyRange.only(id)));
  for (const k of keys) tx.objectStore('pages').delete(k);
  const last = await req2p(tx.objectStore('kv').get('lastDoc'));
  if (last && last.v === id) tx.objectStore('kv').delete('lastDoc');
  return tx2p(tx);
}

export async function kvGet(k) {
  const tx = await store('kv');
  const r = await req2p(tx.objectStore('kv').get(k));
  return r ? r.v : undefined;
}
export async function kvSet(k, v) {
  const tx = await store('kv', 'readwrite');
  tx.objectStore('kv').put({ k, v });
  return tx2p(tx);
}
export async function kvDel(k) {
  const tx = await store('kv', 'readwrite');
  tx.objectStore('kv').delete(k);
  return tx2p(tx);
}

export async function storageInfo() {
  const out = { usage: NaN, quota: NaN, persisted: null };
  try {
    if (navigator.storage?.estimate) Object.assign(out, await navigator.storage.estimate());
    if (navigator.storage?.persisted) out.persisted = await navigator.storage.persisted();
  } catch { /* 지원 안 함 */ }
  return out;
}

export async function requestPersist() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* 무시 */ }
  return false;
}

export function describeError(err) {
  const name = err?.name || '';
  if (name === 'QuotaExceededError') return '저장 공간이 부족합니다';
  if (name === 'InvalidStateError') return '저장소 연결이 끊어졌습니다';
  if (name === 'UnknownError') return '브라우저 저장소 오류';
  return err?.message || String(err);
}
