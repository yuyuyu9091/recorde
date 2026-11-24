// webm-duration.js
// 크롬의 녹음기(MediaRecorder)가 만든 webm 파일에는 '전체 길이' 정보가 비어 있어서
// 10초 뒤로 가기나 이어듣기처럼 중간으로 이동하는 기능이 제대로 안 될 수 있어요.
// 녹음이 끝나면 이 함수로 파일 머리 부분(Info)에 길이(Duration)를 넣어 줍니다.
// 파일 모양이 예상과 다르면 아무것도 바꾸지 않고 원래 파일을 그대로 돌려줍니다.

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Cluster: 0x1f43b675,
};

function readId(bytes, pos) {
  const first = bytes[pos];
  if (first === undefined) throw new Error('파일 끝');
  let len = 1;
  let mask = 0x80;
  while (len <= 4 && !(first & mask)) { len++; mask >>= 1; }
  if (len > 4) throw new Error('잘못된 ID');
  let value = 0;
  for (let i = 0; i < len; i++) value = value * 256 + bytes[pos + i];
  return { len, value };
}

function readSize(bytes, pos) {
  const first = bytes[pos];
  if (first === undefined) throw new Error('파일 끝');
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
  if (len > 8) throw new Error('잘못된 크기');
  const low = mask - 1;
  let value = first & low;
  let allOnes = value === low;
  for (let i = 1; i < len; i++) {
    const b = bytes[pos + i];
    value = value * 256 + b;
    if (b !== 0xff) allOnes = false;
  }
  return { len, value, unknown: allOnes };
}

function readElement(bytes, pos) {
  const id = readId(bytes, pos);
  const size = readSize(bytes, pos + id.len);
  const dataStart = pos + id.len + size.len;
  return {
    id: id.value,
    start: pos,
    sizePos: pos + id.len,
    sizeLen: size.len,
    size: size.value,
    unknown: size.unknown,
    dataStart,
    end: size.unknown ? Infinity : dataStart + size.value,
  };
}

function encodeSize(value, len) {
  const max = 2 ** (7 * len) - 2; // 모든 비트가 1인 값은 '크기 모름' 표시라 쓸 수 없음
  if (value > max) return null;
  const out = new Uint8Array(len);
  let v = value;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] |= 1 << (8 - len);
  return out;
}

function readUInt(bytes, start, length) {
  let v = 0;
  for (let i = 0; i < length; i++) v = v * 256 + bytes[start + i];
  return v;
}

export async function fixWebmDuration(blob, durationSeconds) {
  if (!blob || !(durationSeconds > 0)) return blob;
  try {
    const headLen = Math.min(blob.size, 256 * 1024);
    const head = new Uint8Array(await blob.slice(0, headLen).arrayBuffer());

    const ebml = readElement(head, 0);
    if (ebml.id !== ID.EBML || ebml.unknown) return blob;
    const segment = readElement(head, ebml.end);
    if (segment.id !== ID.Segment) return blob;

    let pos = segment.dataStart;
    while (pos < head.length) {
      const el = readElement(head, pos);
      if (el.id === ID.Cluster) return blob; // Info를 못 찾고 실제 소리 부분에 도달
      if (el.unknown) return blob;
      if (el.id === ID.Info) {
        if (el.end > head.length) return blob;

        let scale = 1_000_000; // 기본값: 1ms 단위
        const keep = [];
        let p = el.dataStart;
        while (p < el.end) {
          const child = readElement(head, p);
          if (child.end > el.end) return blob;
          if (child.id === ID.TimecodeScale) scale = readUInt(head, child.dataStart, child.size) || scale;
          if (child.id !== ID.Duration) keep.push(head.subarray(child.start, child.end));
          p = child.end;
        }

        const durationEl = new Uint8Array(11);
        durationEl.set([0x44, 0x89, 0x88]); // Duration ID + 크기(8바이트)
        new DataView(durationEl.buffer).setFloat64(3, (durationSeconds * 1e9) / scale);

        const contentLen = keep.reduce((n, part) => n + part.length, 0) + durationEl.length;
        const sizeBytes = encodeSize(contentLen, 8);
        const newInfo = new Uint8Array(4 + 8 + contentLen);
        newInfo.set([0x15, 0x49, 0xa9, 0x66], 0);
        newInfo.set(sizeBytes, 4);
        let offset = 12;
        for (const part of keep) { newInfo.set(part, offset); offset += part.length; }
        newInfo.set(durationEl, offset);

        let prefix = head.slice(0, el.start);
        if (!segment.unknown) {
          // Segment 크기가 적혀 있는 파일이면 늘어난 만큼 고쳐 줍니다.
          const delta = newInfo.length - (el.end - el.start);
          const newSegSize = encodeSize(segment.size + delta, segment.sizeLen);
          if (!newSegSize) return blob;
          prefix.set(newSegSize, segment.sizePos);
        }
        return new Blob([prefix, newInfo, blob.slice(el.end)], { type: blob.type });
      }
      pos = el.end;
    }
    return blob;
  } catch (err) {
    console.warn('webm 길이 보정을 건너뜀:', err);
    return blob;
  }
}
