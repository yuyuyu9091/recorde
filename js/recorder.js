// recorder.js — 부모님 목소리 녹음 + 책장 넘김(띵) 위치 기록

import { fixWebmDuration } from './webm-duration.js';
import { keepScreenOn } from './wakelock.js';

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

function pickMime() {
  if (!window.MediaRecorder?.isTypeSupported) return '';
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

export function canRecord() {
  return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
}

export class Recorder {
  // onLevel(0~1): 목소리 크기, onAutoPause(): 화면이 꺼져서 자동으로 멈췄을 때, onError(err)
  constructor({ onLevel, onAutoPause, onError } = {}) {
    this.onLevel = onLevel;
    this.onAutoPause = onAutoPause;
    this.onError = onError;
    this.state = 'idle'; // idle | recording | paused | stopped
    this.marks = [];
    this.chunks = [];
    this._handleVisibility = () => {
      if (document.visibilityState === 'hidden' && this.state === 'recording') {
        this.pause();
        this.onAutoPause?.();
      }
    };
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false, // 녹음 중엔 스피커 소리가 없어서 꺼도 됨 (목소리가 더 자연스러움)
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const mimeType = pickMime();
    this.mediaRecorder = new MediaRecorder(this.stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: 64000,
    });
    this.chunks = [];
    this.marks = [];
    this.mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.mediaRecorder.onerror = (e) => this.onError?.(e.error || new Error('녹음 중 오류'));
    this.stream.getAudioTracks().forEach((track) => {
      track.onended = () => {
        if (this.state === 'recording' || this.state === 'paused') this.onError?.(new Error('마이크 연결이 끊겼어요.'));
      };
    });

    this.mediaRecorder.start(1000);
    this.elapsedBefore = 0;
    this.segmentStart = performance.now();
    this.state = 'recording';
    this._startMeter();
    keepScreenOn(true);
    document.addEventListener('visibilitychange', this._handleVisibility);
  }

  // 지금까지 녹음된 길이(초) — 일시정지한 시간은 빼고 계산
  get elapsed() {
    const running = this.state === 'recording' ? (performance.now() - this.segmentStart) / 1000 : 0;
    return (this.elapsedBefore || 0) + running;
  }

  // 책장 넘김 표시
  mark() {
    if (this.state !== 'recording') return this.marks.length;
    const t = Math.round(this.elapsed * 100) / 100;
    const last = this.marks[this.marks.length - 1];
    if (last === undefined || t - last > 0.8) this.marks.push(t); // 실수로 두 번 누른 건 무시
    return this.marks.length;
  }

  undoMark() {
    this.marks.pop();
    return this.marks.length;
  }

  pause() {
    if (this.state !== 'recording') return;
    this.mediaRecorder.pause();
    this.elapsedBefore = this.elapsed;
    this.state = 'paused';
  }

  resume() {
    if (this.state !== 'paused') return;
    this.mediaRecorder.resume();
    this.segmentStart = performance.now();
    this.state = 'recording';
  }

  // 녹음을 끝내고 { blob, duration, marks, type } 를 돌려줍니다.
  async stop() {
    if (this.state === 'idle' || this.state === 'stopped') return null;
    const duration = this.elapsed;
    this.elapsedBefore = duration;
    this.state = 'stopped';
    const mr = this.mediaRecorder;
    const stopped = new Promise((resolve) => { mr.onstop = resolve; });
    mr.stop();
    await stopped;
    this._cleanup();
    const type = mr.mimeType || this.chunks[0]?.type || 'audio/webm';
    let blob = new Blob(this.chunks, { type });
    if (type.includes('webm')) blob = await fixWebmDuration(blob, duration);
    const marks = this.marks.filter((m) => m < duration - 0.3);
    return { blob, duration, marks, type };
  }

  cancel() {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try { this.mediaRecorder.stop(); } catch { /* 이미 멈춤 */ }
    }
    this.state = 'stopped';
    this.chunks = [];
    this._cleanup();
  }

  _startMeter() {
    try {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = this.audioCtx.createMediaStreamSource(this.stream);
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const data = new Float32Array(analyser.fftSize);
      this.meterTimer = setInterval(() => {
        if (this.state !== 'recording') { this.onLevel?.(0); return; }
        analyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length);
        this.onLevel?.(Math.min(1, rms * 4));
      }, 80);
    } catch { /* 소리 크기 표시는 없어도 녹음은 됨 */ }
  }

  _cleanup() {
    clearInterval(this.meterTimer);
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    keepScreenOn(false);
    document.removeEventListener('visibilitychange', this._handleVisibility);
  }
}
