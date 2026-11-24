// db.js — 저장소
// 지금은 모든 책(표지, 녹음, 넘김 위치)을 태블릿 브라우저 안(IndexedDB)에 저장합니다.
// 나중에 인터넷 저장소(예: Supabase)로 바꾸고 싶으면 이 파일의 export 함수들만
// 같은 이름·같은 모양으로 다시 만들면 나머지 코드는 그대로 둘 수 있어요.
//
// 책 한 권(book)의 모양:
// {
//   id: 'abc123',            // 고유 번호
//   title: '구름빵',          // 부모 화면에서만 보이는 이름 (비워도 됨)
//   order: 0,                // 책장 순서 (작을수록 앞)
//   duration: 312.4,         // 녹음 길이(초)
//   marks: [12.3, 30.1],     // 띵 소리가 날 위치(초)
//   audioType: 'audio/webm;codecs=opus',
//   createdAt: 1700000000000,
//   updatedAt: 1700000000000,
// }
// 파일(Blob)은 'files' 저장소에 `${id}/audio`, `${id}/cover`, `${id}/thumb` 이름으로 따로 저장합니다.

const DB_NAME = 'voice-bookshelf';
const DB_VERSION = 1;
const FILE_KINDS = ['audio', 'cover', 'thumb'];

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('저장소가 다른 탭에서 사용 중이에요. 다른 탭을 닫고 다시 열어 주세요.'));
    });
  }
  return dbPromise;
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// 여러 작업을 한 번에(전부 성공하거나 전부 실패) 처리합니다.
async function runTransaction(stores, mode, work) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result;
    try {
      result = work(tx);
    } catch (err) {
      tx.abort();
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('저장에 실패했어요.'));
  });
}

const fileKey = (id, kind) => `${id}/${kind}`;

export function newId() {
  if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export async function listBooks() {
  const db = await openDb();
  const books = await promisify(db.transaction('books').objectStore('books').getAll());
  return books.sort((a, b) => (a.order - b.order) || (b.createdAt - a.createdAt));
}

export async function getBook(id) {
  const db = await openDb();
  return promisify(db.transaction('books').objectStore('books').get(id));
}

export async function getFile(id, kind) {
  const db = await openDb();
  return promisify(db.transaction('files').objectStore('files').get(fileKey(id, kind)));
}

// files: { audio?: Blob, cover?: Blob, thumb?: Blob } — 바뀐 파일만 넘기면 됩니다.
export async function saveBook(book, files = {}) {
  const record = { ...book, updatedAt: Date.now() };
  await runTransaction(['books', 'files'], 'readwrite', (tx) => {
    tx.objectStore('books').put(record);
    const fileStore = tx.objectStore('files');
    for (const kind of FILE_KINDS) {
      if (files[kind]) fileStore.put(files[kind], fileKey(book.id, kind));
    }
  });
  return record;
}

export async function deleteBook(id) {
  await runTransaction(['books', 'files'], 'readwrite', (tx) => {
    tx.objectStore('books').delete(id);
    const fileStore = tx.objectStore('files');
    for (const kind of FILE_KINDS) fileStore.delete(fileKey(id, kind));
  });
  clearPosition(id);
}

// ids 순서대로 책장 순서를 다시 매깁니다.
export async function setOrder(ids) {
  const books = await listBooks();
  const byId = new Map(books.map((b) => [b.id, b]));
  await runTransaction(['books'], 'readwrite', (tx) => {
    const store = tx.objectStore('books');
    ids.forEach((id, index) => {
      const book = byId.get(id);
      if (book && book.order !== index) store.put({ ...book, order: index });
    });
  });
}

// 새 책을 맨 앞에 두기 위한 순서 번호
export async function frontOrder() {
  const books = await listBooks();
  return books.length ? Math.min(...books.map((b) => b.order)) - 1 : 0;
}

// ── 저장 공간 ─────────────────────────────────────────────

// 브라우저가 공간이 부족할 때 데이터를 임의로 지우지 않도록 요청합니다.
export async function requestPersist() {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}

export async function isPersisted() {
  return navigator.storage?.persisted ? navigator.storage.persisted() : false;
}

export async function usage() {
  if (!navigator.storage?.estimate) return null;
  const { usage: used, quota } = await navigator.storage.estimate();
  return { used, quota };
}

// ── 이어듣기 위치 (기기 안에만 간단히 저장) ─────────────────

const POS_PREFIX = 'vb.pos.';

export function getPosition(id) {
  const value = parseFloat(localStorage.getItem(POS_PREFIX + id));
  return Number.isFinite(value) ? value : 0;
}

export function setPosition(id, seconds) {
  localStorage.setItem(POS_PREFIX + id, String(Math.round(seconds * 10) / 10));
}

export function clearPosition(id) {
  localStorage.removeItem(POS_PREFIX + id);
}
