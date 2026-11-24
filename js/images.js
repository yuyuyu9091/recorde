// images.js — 찍은 표지 사진을 알맞은 크기의 JPEG로 줄입니다.
// 원본 사진(수 MB)을 그대로 저장하면 50권만 돼도 용량이 커지고 책장이 느려져요.

async function loadBitmap(file) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch { /* 아래 방법으로 다시 시도 */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function toJpeg(source, maxSide, quality) {
  const w = source.width;
  const h = source.height;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('사진 변환 실패'))), 'image/jpeg', quality);
  });
}

// 큰 표지(재생 화면용)와 작은 표지(책장용)를 함께 만듭니다.
export async function makeCoverImages(file) {
  const bitmap = await loadBitmap(file);
  const cover = await toJpeg(bitmap, 1400, 0.85);
  const thumb = await toJpeg(bitmap, 520, 0.8);
  if (bitmap.close) bitmap.close();
  return { cover, thumb };
}
