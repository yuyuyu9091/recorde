// player.js — 녹음 재생 + 넘김 위치에서 '띵' + 이어듣기 위치 저장

import { playChime, unlockAudio } from './chime.js';
import { keepScreenOn } from './wakelock.js';
import * as db from './db.js';

const TICK_MS = 100;
const SAVE_EVERY_MS = 2000;

export class Player {
  // onState('playing'|'paused'|'ended'|'blocked'), onTime(current, duration), onChime(index)
  constructor({ onState, onTime, onChime } = {}) {
    this.onState = onState;
    this.onTime = onTime;
    this.onChime = onChime;
    this.audio = null;
  }

  // book: 책 정보, audioBlob: 녹음 파일, startAt: 시작 위치(초), remember: 이어듣기 위치 저장 여부
  async open({ book, audioBlob, coverUrl = '', startAt = 0, remember = true }) {
    this.close();
    this.book = book;
    this.marks = [...(book.marks || [])].sort((a, b) => a - b);
    this.remember = remember;
    this.ended = false;
    this.url = URL.createObjectURL(audioBlob);

    const audio = new Audio();
    audio.preload = 'auto';
    this.audio = audio;
    // 닫힌 뒤 늦게 도착한 이벤트는 무시
    const on = (name, fn) => audio.addEventListener(name, () => { if (audio === this.audio) fn(); });
    on('play', () => this._onPlay());
    on('pause', () => this._onPause());
    on('ended', () => this._onEnded());
    on('seeked', () => { this.lastT = audio.currentTime; this._emitTime(); });

    const ready = new Promise((resolve) => {
      audio.addEventListener('loadedmetadata', resolve, { once: true });
      audio.addEventListener('error', resolve, { once: true });
      setTimeout(resolve, 3000);
    });
    audio.src = this.url;
    await ready;
    if (startAt > 0) {
      try { audio.currentTime = startAt; } catch { /* 처음부터 */ }
    }
    this.lastT = startAt;
    this._setupMediaSession(coverUrl);
    this._emitTime();
  }

  get duration() {
    const d = this.audio?.duration;
    return Number.isFinite(d) && d > 0 ? d : (this.book?.duration || 0);
  }

  get currentTime() {
    return this.audio ? this.audio.currentTime : 0;
  }

  get playing() {
    return !!this.audio && !this.audio.paused && !this.audio.ended;
  }

  async play() {
    if (!this.audio) return;
    unlockAudio();
    if (this.ended) { this.seekTo(0); this.ended = false; }
    try {
      await this.audio.play();
    } catch (err) {
      if (err.name === 'NotAllowedError') this.onState?.('blocked');
      else console.warn(err);
    }
  }

  pause() {
    this.audio?.pause();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  back(seconds = 10) {
    this.seekTo(Math.max(0, this.currentTime - seconds));
  }

  restart() {
    this.seekTo(0);
    this.play();
  }

  seekTo(t) {
    if (!this.audio) return;
    this.audio.currentTime = t;
    this.lastT = t;
    this._emitTime();
  }

  close() {
    if (!this.audio) return;
    if (this.remember && !this.ended) this._savePosition();
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.audio = null;
    clearInterval(this.timer);
    this.timer = null;
    URL.revokeObjectURL(this.url);
    keepScreenOn(false);
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = null;
      for (const a of ['play', 'pause', 'seekbackward']) {
        try { navigator.mediaSession.setActionHandler(a, null); } catch { /* 지원 안 함 */ }
      }
    }
  }

  _onPlay() {
    this.ended = false;
    this.lastT = this.audio.currentTime;
    this.lastSave = performance.now();
    clearInterval(this.timer);
    this.timer = setInterval(() => this._tick(), TICK_MS);
    keepScreenOn(true);
    this.onState?.('playing');
  }

  _onPause() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.audio?.ended) return; // ended 쪽에서 처리
    if (this.remember) this._savePosition();
    keepScreenOn(false);
    this.onState?.('paused');
  }

  _onEnded() {
    clearInterval(this.timer);
    this.timer = null;
    this.ended = true;
    this._checkChimes(this.duration);
    if (this.remember) db.clearPosition(this.book.id);
    keepScreenOn(false);
    this.onState?.('ended');
  }

  _tick() {
    if (!this.audio) return;
    const t = this.audio.currentTime;
    this._checkChimes(t);
    this._emitTime();
    if (this.remember && performance.now() - this.lastSave > SAVE_EVERY_MS) {
      this._savePosition();
      this.lastSave = performance.now();
    }
  }

  // 지난번 확인한 시각(lastT) ~ 지금(t) 사이에 넘김 표시가 있으면 '띵'
  _checkChimes(t) {
    const prev = this.lastT ?? t;
    if (t >= prev && t - prev < 1.5) {
      this.marks.forEach((m, i) => {
        if (m > prev && m <= t) {
          playChime();
          this.onChime?.(i);
        }
      });
    }
    this.lastT = t;
  }

  _emitTime() {
    this.onTime?.(this.currentTime, this.duration);
  }

  _savePosition() {
    if (!this.book || !this.audio) return;
    db.setPosition(this.book.id, this.audio.currentTime);
  }

  _setupMediaSession(coverUrl) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: this.book.title || '목소리 책장',
        artist: '목소리 책장',
        artwork: coverUrl ? [{ src: coverUrl, sizes: '512x512', type: 'image/jpeg' }] : [],
      });
      navigator.mediaSession.setActionHandler('play', () => this.play());
      navigator.mediaSession.setActionHandler('pause', () => this.pause());
      navigator.mediaSession.setActionHandler('seekbackward', () => this.back(10));
    } catch { /* 지원 안 하는 기기 */ }
  }
}
