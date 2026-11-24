// wakelock.js — 재생·녹음 중에 화면이 저절로 꺼지지 않게 합니다.

let lock = null;
let wanted = false;

async function acquire() {
  if (!('wakeLock' in navigator) || lock) return;
  try {
    lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', () => { lock = null; });
  } catch { /* 배터리 절약 모드 등에서는 거절될 수 있음 */ }
}

export function keepScreenOn(on) {
  wanted = on;
  if (on) acquire();
  else if (lock) { lock.release(); lock = null; }
}

// 다른 앱에 갔다가 돌아오면 다시 요청
document.addEventListener('visibilitychange', () => {
  if (wanted && document.visibilityState === 'visible') acquire();
});
