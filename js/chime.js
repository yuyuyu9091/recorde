// chime.js — 책장 넘길 때 나는 '띵' 소리
// 소리 파일 없이 브라우저에서 직접 만들어요. 소리를 바꾸고 싶으면 PARTIALS 값을 고치면 됩니다.

const VOLUME_KEY = 'vb.chimeVolume';

// [주파수(Hz), 크기, 사라지는 시간(초)] — 작은 실로폰/종 느낌
const PARTIALS = [
  [1318.5, 1.0, 1.6],
  [1318.5 * 2.756, 0.28, 0.6],
  [1318.5 * 5.404, 0.09, 0.25],
];

let ctx = null;

function getContext() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// 브라우저는 사용자가 화면을 누른 순간에만 소리를 켤 수 있어서, 버튼을 누를 때 미리 불러 둡니다.
export function unlockAudio() {
  try { getContext(); } catch { /* 소리 장치 없음 */ }
}

export function getChimeVolume() {
  const v = parseFloat(localStorage.getItem(VOLUME_KEY));
  return Number.isFinite(v) ? v : 0.6;
}

export function setChimeVolume(v) {
  localStorage.setItem(VOLUME_KEY, String(v));
}

export function playChime(volume = getChimeVolume()) {
  if (volume <= 0) return;
  let ac;
  try { ac = getContext(); } catch { return; }
  const t = ac.currentTime + 0.01;
  const master = ac.createGain();
  master.gain.value = volume * 0.5;
  master.connect(ac.destination);
  for (const [freq, amp, decay] of PARTIALS) {
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(amp, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + decay + 0.05);
  }
  setTimeout(() => master.disconnect(), 2000);
}
