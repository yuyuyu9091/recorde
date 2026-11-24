// sw.js — 앱 설치 + 인터넷이 잠깐 끊겨도 화면이 열리게 해 주는 서비스 워커
// '항상 인터넷에서 먼저 받아 오고, 안 되면 저장해 둔 것'을 씁니다.
// 그래서 GitHub에서 코드를 고치면 다음에 앱을 열 때 바로 반영돼요.
// (녹음과 표지는 여기가 아니라 IndexedDB에 저장됩니다)

const CACHE = 'voice-bookshelf-shell-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './js/db.js',
  './js/images.js',
  './js/recorder.js',
  './js/player.js',
  './js/chime.js',
  './js/backup.js',
  './js/wakelock.js',
  './js/webm-duration.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(req, { ignoreSearch: true })) || caches.match('./index.html')),
  );
});
