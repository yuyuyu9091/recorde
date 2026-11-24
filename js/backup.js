// backup.js — 전체 책을 zip 파일 하나로 내보내고 다시 불러옵니다.
// zip 안에는 books.json(책 정보), audio/(녹음), covers/·thumbs/(표지 사진)가 들어가요.
// 녹음과 사진은 이미 압축된 형식이라 zip은 '압축 없이 묶기만' 합니다.

import * as db from './db.js';

const APP_TAG = 'voice-bookshelf';

// ── CRC32 (zip 파일 검사값) ──────────────────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

// entries: [{ name: 'audio/x.webm', data: Blob }]
export async function buildZip(entries, onProgress) {
  const encoder = new TextEncoder();
  const { time, day } = dosDateTime(new Date());
  const parts = [];
  const central = [];
  let offset = 0;

  for (let i = 0; i < entries.length; i++) {
    const { name, data } = entries[i];
    const nameBytes = encoder.encode(name);
    const bytes = new Uint8Array(await data.arrayBuffer());
    const crc = crc32(bytes);
    const size = bytes.length;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // 파일 이름 UTF-8
    local.setUint16(8, 0, true); // 압축 안 함
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    parts.push(local.buffer, nameBytes, data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, day, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    central.push(cd.buffer, nameBytes);

    offset += 30 + nameBytes.length + size;
    onProgress?.((i + 1) / entries.length);
  }

  const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

// 이 앱이 만든 zip(압축 없음)만 읽습니다.
export async function readZip(file) {
  const decoder = new TextDecoder();
  const files = new Map();
  let offset = 0;
  while (offset + 30 <= file.size) {
    const h = new DataView(await file.slice(offset, offset + 30).arrayBuffer());
    if (h.getUint32(0, true) !== 0x04034b50) break; // 파일 목록 부분에 도달
    const flags = h.getUint16(6, true);
    const method = h.getUint16(8, true);
    const size = h.getUint32(18, true);
    const nameLen = h.getUint16(26, true);
    const extraLen = h.getUint16(28, true);
    if (method !== 0 || flags & 0x08) {
      throw new Error('이 앱에서 만든 백업 파일이 아니거나, 다시 압축된 파일이에요. 처음 받은 백업 파일을 그대로 골라 주세요.');
    }
    const name = decoder.decode(await file.slice(offset + 30, offset + 30 + nameLen).arrayBuffer());
    const dataStart = offset + 30 + nameLen + extraLen;
    files.set(name, file.slice(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  return files;
}

function audioExt(type = '') {
  if (type.includes('webm')) return 'webm';
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('mp4') || type.includes('aac')) return 'm4a';
  return 'bin';
}

export async function exportBackup(onProgress) {
  const books = await db.listBooks();
  const entries = [];
  const meta = [];
  for (const book of books) {
    const files = {
      audio: `audio/${book.id}.${audioExt(book.audioType)}`,
      cover: `covers/${book.id}.jpg`,
      thumb: `thumbs/${book.id}.jpg`,
    };
    for (const kind of Object.keys(files)) {
      const blob = await db.getFile(book.id, kind);
      if (blob) entries.push({ name: files[kind], data: blob });
      else delete files[kind];
    }
    meta.push({ ...book, files });
  }
  const info = { app: APP_TAG, format: 1, exportedAt: new Date().toISOString(), books: meta };
  entries.unshift({ name: 'books.json', data: new Blob([JSON.stringify(info, null, 2)], { type: 'application/json' }) });
  const zip = await buildZip(entries, onProgress);
  return { zip, count: books.length };
}

// 같은 책(같은 id)이 이미 있으면 백업 내용으로 덮어씁니다. 없는 책은 새로 추가돼요.
export async function importBackup(file, onProgress) {
  const files = await readZip(file);
  const metaBlob = files.get('books.json');
  if (!metaBlob) throw new Error('백업 파일 안에 책 정보(books.json)가 없어요.');
  const info = JSON.parse(await metaBlob.text());
  if (info.app !== APP_TAG || !Array.isArray(info.books)) throw new Error('목소리 책장 백업 파일이 아니에요.');

  let done = 0;
  for (const item of info.books) {
    const { files: names = {}, ...book } = item;
    const audio = names.audio && files.get(names.audio);
    const cover = names.cover && files.get(names.cover);
    const thumb = names.thumb && files.get(names.thumb);
    if (!book.id || !audio || !cover) continue;
    await db.saveBook(book, {
      audio: new Blob([audio], { type: book.audioType || 'audio/webm' }),
      cover: new Blob([cover], { type: 'image/jpeg' }),
      thumb: new Blob([thumb || cover], { type: 'image/jpeg' }),
    });
    done++;
    onProgress?.(done / info.books.length);
  }
  // 순서 번호 정리
  const all = await db.listBooks();
  await db.setOrder(all.map((b) => b.id));
  return done;
}
