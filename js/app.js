// app.js — 화면과 버튼 동작
// 화면 구성: shelf(아이 책장) → player(아이 듣기)
//            shelf → [비밀번호] → parent(부모 책 관리) → editor(책 추가·수정, 녹음)

import * as db from './db.js';
import { makeCoverImages } from './images.js';
import { Recorder, canRecord } from './recorder.js';
import { Player } from './player.js';
import { exportBackup, importBackup } from './backup.js';
import { unlockAudio, playChime, getChimeVolume, setChimeVolume } from './chime.js';

const APP_VERSION = '1.0.0';
const PIN_KEY = 'vb.pinHash';
const BACKUP_KEY = 'vb.lastBackupAt';
const HOLD_MS = 3000; // 자물쇠 길게 누르는 시간
const PARENT_IDLE_MS = 5 * 60 * 1000; // 부모 화면에서 5분 동안 손대지 않으면 아이 화면으로
const MAX_DOTS = 40;

const $ = (sel) => document.querySelector(sel);

// ═════════════ 공통 도구 ═════════════

function fmtClock(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function fmtLength(sec) {
  const s = Math.round(sec || 0);
  const m = Math.floor(s / 60);
  return m ? `${m}분 ${s % 60}초` : `${s}초`;
}

function fmtBytes(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)}MB`;
  return `${Math.round(n / 1e3)}KB`;
}

function fmtDate(ts) {
  const d = new Date(ts);
  const days = Math.floor((Date.now() - ts) / 86400000);
  const ago = days <= 0 ? '오늘' : `${days}일 전`;
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${ago})`;
}

let toastTimer;
function toast(text, ms = 3200) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// 알림창. buttons: [{ label, value, kind }]
function modal({ title, text = '', buttons, input = null }) {
  return new Promise((resolve) => {
    $('#modalTitle').textContent = title;
    $('#modalText').textContent = text;
    $('#modalText').hidden = !text;
    const inputEl = $('#modalInput');
    inputEl.hidden = !input;
    inputEl.value = '';
    if (input) inputEl.setAttribute('inputmode', input.inputmode || 'text');
    const actions = $('#modalActions');
    actions.innerHTML = '';
    const finish = (value) => {
      $('#modal').hidden = true;
      resolve(value);
    };
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn ${b.kind || ''}`;
      btn.textContent = b.label;
      btn.onclick = () => finish(input && b.value === true ? inputEl.value.trim() : b.value);
      actions.append(btn);
    }
    $('#modal').hidden = false;
    if (input) setTimeout(() => inputEl.focus(), 50);
  });
}

const confirmModal = (title, text, okLabel = '확인', kind = 'primary') =>
  modal({ title, text, buttons: [{ label: '취소', value: false }, { label: okLabel, value: true, kind }] });

const alertModal = (title, text) => modal({ title, text, buttons: [{ label: '확인', value: true, kind: 'primary' }] });

function busy(text, progress = 0) {
  $('#busy').hidden = false;
  $('#busyText').textContent = text;
  $('#busyFill').style.width = `${Math.round(progress * 100)}%`;
}
const busyDone = () => { $('#busy').hidden = true; };

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ═════════════ 화면 전환 (안드로이드 뒤로 가기 버튼 지원) ═════════════

const SCREENS = ['shelf', 'player', 'parent', 'editor'];
let current = 'shelf';
let parentMode = false;

function show(name) {
  for (const s of SCREENS) $(`#${s}`).hidden = s !== name;
  current = name;
  window.scrollTo(0, 0);
}

function depth() {
  return history.state?.depth || 0;
}

function go(name) {
  history.pushState({ screen: name, depth: depth() + 1 }, '');
  enter(name);
}

function enter(name) {
  if (current === 'player' && name !== 'player') leavePlayer();
  if (current === 'editor' && name !== 'editor') leaveEditor();
  if (name === 'shelf') {
    parentMode = false;
    renderShelf();
  }
  if (name === 'parent') renderParent();
  show(name);
}

function exitParent() {
  const d = depth();
  if (d > 0) history.go(-d);
  else enter('shelf');
}

window.addEventListener('popstate', async (e) => {
  const target = e.state?.screen || 'shelf';
  if (target === current) return;

  // 녹음 중에는 뒤로 가기 막기
  if (recorder) {
    history.pushState({ screen: current, depth: depth() + 1 }, '');
    toast("녹음 중이에요. 끝내려면 '녹음 끝'을 눌러 주세요.");
    return;
  }
  // 부모 화면은 비밀번호를 거쳐야만
  if ((target === 'parent' || target === 'editor') && !parentMode) {
    history.replaceState({ screen: 'shelf', depth: depth() }, '');
    enter('shelf');
    return;
  }
  // 저장 안 한 책
  if (current === 'editor' && editor.dirty) {
    history.pushState({ screen: 'editor', depth: depth() + 1 }, '');
    const ok = await confirmModal('저장하지 않고 나갈까요?', '찍은 표지와 녹음이 저장되지 않아요.', '나가기', 'danger');
    if (ok) {
      editor.dirty = false;
      history.back();
    }
    return;
  }
  enter(target);
});

// ═════════════ 아이: 책장 ═════════════

let shelfUrls = [];

async function renderShelf() {
  const books = await db.listBooks();
  shelfUrls.forEach((u) => URL.revokeObjectURL(u));
  shelfUrls = [];
  const grid = $('#shelfGrid');
  grid.innerHTML = '';
  $('#shelfEmpty').hidden = books.length > 0;
  grid.hidden = books.length === 0;

  const thumbs = await Promise.all(books.map((b) => db.getFile(b.id, 'thumb')));
  books.forEach((book, i) => {
    if (!thumbs[i]) return;
    const url = URL.createObjectURL(thumbs[i]);
    shelfUrls.push(url);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'book';
    btn.setAttribute('aria-label', book.title || '책');
    const cover = document.createElement('span');
    cover.className = 'cover';
    const pos = db.getPosition(book.id);
    if (pos > 3 && pos < book.duration - 3) cover.dataset.resume = '';
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.draggable = false;
    cover.append(img);
    btn.append(cover);
    btn.addEventListener('click', () => openBook(book.id));
    grid.append(btn);
  });
}

// 자물쇠를 3초 동안 꾹 누르면 비밀번호 창
(function setupHold() {
  const hold = $('#parentHold');
  let timer = null;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
    hold.classList.remove('holding');
  };
  hold.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    hold.setPointerCapture?.(e.pointerId);
    hold.classList.add('holding');
    timer = setTimeout(() => {
      cancel();
      askPin();
    }, HOLD_MS);
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) hold.addEventListener(ev, cancel);
  hold.addEventListener('click', (e) => e.preventDefault());
})();

// ═════════════ 아이: 듣기 ═════════════

let coverUrl = null;
let dingTimer = null;

const player = new Player({
  onState(state) {
    const btn = $('#playBtn');
    btn.dataset.state = state === 'playing' ? 'playing' : state === 'blocked' ? 'blocked' : 'paused';
    btn.setAttribute('aria-label', state === 'playing' ? '멈춤' : '재생');
    $('#stage').classList.toggle('ended', state === 'ended');
  },
  onTime(t, duration) {
    $('#progressFill').style.width = duration ? `${Math.min(100, (t / duration) * 100)}%` : '0';
    updateDots(t);
  },
  onChime() {
    const stage = $('#stage');
    stage.classList.remove('ding');
    void stage.offsetWidth; // 애니메이션 다시 시작
    stage.classList.add('ding');
    clearTimeout(dingTimer);
    dingTimer = setTimeout(() => stage.classList.remove('ding'), 1400);
  },
});

let dotMarks = [];

function buildDots(marks) {
  dotMarks = marks;
  const dots = $('#pageDots');
  dots.innerHTML = '';
  const useDots = marks.length > 0 && marks.length + 1 <= MAX_DOTS;
  dots.hidden = !useDots;
  $('#progress').hidden = useDots;
  if (!useDots) return;
  for (let i = 0; i <= marks.length; i++) dots.append(document.createElement('i'));
}

function updateDots(t) {
  const dots = $('#pageDots');
  if (dots.hidden) return;
  const page = dotMarks.filter((m) => m <= t).length;
  [...dots.children].forEach((dot, i) => {
    dot.className = i < page ? 'done' : i === page ? 'now' : '';
  });
}

async function openBook(id) {
  unlockAudio(); // 누른 순간에 소리 허락 받기
  const book = await db.getBook(id);
  const [audio, cover] = await Promise.all([db.getFile(id, 'audio'), db.getFile(id, 'cover')]);
  if (!book || !audio) {
    toast('이 책의 녹음을 찾을 수 없어요.');
    return;
  }
  if (coverUrl) URL.revokeObjectURL(coverUrl);
  coverUrl = cover ? URL.createObjectURL(cover) : '';
  $('#playerCover').src = coverUrl;
  $('#stage').classList.remove('ended', 'ding');
  $('#toast').hidden = true;
  buildDots(book.marks || []);
  go('player');

  // 멈춘 곳부터 이어서 (2초 앞에서 시작해 흐름을 잡아 줌)
  const saved = db.getPosition(id);
  const startAt = saved > 3 && saved < book.duration - 3 ? Math.max(0, saved - 2) : 0;
  await player.open({ book, audioBlob: audio, coverUrl, startAt, remember: true });
  if (current === 'player') player.play();
}

function leavePlayer() {
  player.close();
}

$('#homeBtn').addEventListener('click', () => history.back());
$('#playBtn').addEventListener('click', () => player.toggle());
$('#coverBtn').addEventListener('click', () => player.toggle());
$('#backBtn').addEventListener('click', () => player.back(10));
$('#restartBtn').addEventListener('click', () => player.restart());

// 아이 화면에서 길게 눌러 메뉴 뜨는 것 막기
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest('.kid, .rec-overlay')) e.preventDefault();
});

// ═════════════ 비밀번호 ═════════════

async function hashPin(pin) {
  const data = new TextEncoder().encode(`voice-bookshelf:${pin}`);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const FORGOT = Symbol('forgot');

// 숫자 4자리를 받아서 돌려줌. 취소하면 null, '잊었어요'는 FORGOT
function pinPad({ title, hint = '', error = false, showForgot = false }) {
  return new Promise((resolve) => {
    let digits = '';
    const overlay = $('#pinOverlay');
    const dots = [...$('#pinDots').children];
    $('#pinTitle').textContent = title;
    const hintEl = $('#pinHint');
    hintEl.textContent = hint;
    hintEl.classList.toggle('error', error);
    $('#pinForgot').hidden = !showForgot;
    if (error) {
      $('#pinDots').classList.remove('shake');
      void $('#pinDots').offsetWidth;
      $('#pinDots').classList.add('shake');
    }
    const paint = () => dots.forEach((d, i) => d.classList.toggle('on', i < digits.length));
    paint();

    const finish = (value) => {
      overlay.hidden = true;
      $('#pinPad').onclick = null;
      $('#pinForgot').onclick = null;
      resolve(value);
    };
    $('#pinPad').onclick = (e) => {
      const key = e.target.closest('button')?.dataset.key;
      if (!key) return;
      if (key === 'cancel') return finish(null);
      if (key === 'del') digits = digits.slice(0, -1);
      else if (digits.length < 4) digits += key;
      paint();
      if (digits.length === 4) setTimeout(() => finish(digits), 120);
    };
    $('#pinForgot').onclick = () => finish(FORGOT);
    overlay.hidden = false;
  });
}

async function setupPin(title = '비밀번호 정하기') {
  for (;;) {
    const a = await pinPad({ title, hint: '부모 화면에 들어갈 때 쓸 숫자 4자리를 눌러 주세요' });
    if (a === null) return false;
    const b = await pinPad({ title: '한 번 더', hint: '같은 숫자 4자리를 다시 눌러 주세요' });
    if (b === null) return false;
    if (a === b) {
      localStorage.setItem(PIN_KEY, await hashPin(a));
      toast('비밀번호를 정했어요.');
      return true;
    }
    await alertModal('두 번 누른 숫자가 달라요', '처음부터 다시 정해 주세요.');
  }
}

// 비밀번호를 잊었을 때: 어른만 풀 수 있는 곱셈 문제
async function resetPin() {
  const a = 12 + Math.floor(Math.random() * 8);
  const b = 6 + Math.floor(Math.random() * 4);
  const answer = await modal({
    title: '어른 확인',
    text: `${a} × ${b} = ?\n답을 맞히면 새 비밀번호를 정할 수 있어요. 책과 녹음은 그대로 남아요.`,
    input: { inputmode: 'numeric' },
    buttons: [{ label: '취소', value: null }, { label: '확인', value: true, kind: 'primary' }],
  });
  if (answer === null) return false;
  if (parseInt(answer, 10) !== a * b) {
    await alertModal('답이 달라요', '다시 시도해 주세요.');
    return false;
  }
  return setupPin('새 비밀번호 정하기');
}

async function askPin() {
  const stored = localStorage.getItem(PIN_KEY);
  if (!stored) {
    if (await setupPin()) enterParent();
    return;
  }
  let error = false;
  for (;;) {
    const pin = await pinPad({
      title: '비밀번호',
      hint: error ? '비밀번호가 달라요. 다시 눌러 주세요.' : '부모 화면으로 들어가요',
      error,
      showForgot: true,
    });
    if (pin === null) return;
    if (pin === FORGOT) {
      if (await resetPin()) enterParent();
      return;
    }
    if ((await hashPin(pin)) === stored) {
      enterParent();
      return;
    }
    error = true;
  }
}

function enterParent() {
  parentMode = true;
  lastTouch = Date.now();
  go('parent');
}

// 부모 화면에서 오래 손대지 않으면 아이 화면으로
let lastTouch = Date.now();
document.addEventListener('pointerdown', () => { lastTouch = Date.now(); }, { capture: true });
setInterval(() => {
  if (!parentMode || recorder || !$('#busy').hidden) return;
  if (current === 'editor' && editor.dirty) return;
  if (Date.now() - lastTouch > PARENT_IDLE_MS) exitParent();
}, 30_000);

// ═════════════ 부모: 책 목록 ═════════════

let parentUrls = [];

async function renderParent() {
  const books = await db.listBooks();
  parentUrls.forEach((u) => URL.revokeObjectURL(u));
  parentUrls = [];
  $('#bookCount').textContent = `${books.length}권`;
  const list = $('#bookList');
  list.innerHTML = '';

  if (!books.length) {
    const li = document.createElement('li');
    li.className = 'book-list-empty';
    li.textContent = "아직 책이 없어요. '새 책 추가'를 눌러 첫 책을 넣어 보세요.";
    list.append(li);
  }

  const thumbs = await Promise.all(books.map((b) => db.getFile(b.id, 'thumb')));
  books.forEach((book, i) => {
    const li = document.createElement('li');
    li.className = 'book-row';

    const img = document.createElement('img');
    img.alt = '';
    if (thumbs[i]) {
      const url = URL.createObjectURL(thumbs[i]);
      parentUrls.push(url);
      img.src = url;
    }

    const info = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = book.title || '이름 없는 책';
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${fmtLength(book.duration)}, 띵 ${book.marks?.length || 0}번`;
    info.append(title, meta);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const mk = (label, cls, onClick, aria) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn small ${cls}`;
      b.textContent = label;
      if (aria) b.setAttribute('aria-label', aria);
      b.addEventListener('click', onClick);
      actions.append(b);
      return b;
    };
    mk('↑', 'icon-btn', () => moveBook(books, i, -1), '앞으로').disabled = i === 0;
    mk('↓', 'icon-btn', () => moveBook(books, i, 1), '뒤로').disabled = i === books.length - 1;
    mk('수정', '', () => openEditor(book.id));
    mk('삭제', 'danger', () => removeBook(book));

    li.append(img, info, actions);
    list.append(li);
  });

  renderBackupStatus(books);
  renderStorage();
  $('#chimeVolume').value = getChimeVolume();
  $('#versionInfo').textContent = `목소리 책장 ${APP_VERSION}`;
}

async function moveBook(books, index, delta) {
  const ids = books.map((b) => b.id);
  const j = index + delta;
  if (j < 0 || j >= ids.length) return;
  [ids[index], ids[j]] = [ids[j], ids[index]];
  await db.setOrder(ids);
  renderParent();
}

async function removeBook(book) {
  const name = book.title ? `'${book.title}'` : '이 책';
  const ok = await confirmModal(
    `${name}을(를) 지울까요?`,
    '표지와 녹음이 모두 지워지고 되돌릴 수 없어요.\n백업 파일에 들어 있다면 백업 불러오기로 다시 넣을 수 있어요.',
    '지우기',
    'danger',
  );
  if (!ok) return;
  await db.deleteBook(book.id);
  toast('지웠어요.');
  renderParent();
}

function renderBackupStatus(books) {
  const el = $('#backupStatus');
  const last = parseInt(localStorage.getItem(BACKUP_KEY), 10);
  if (!books.length) {
    el.textContent = '책을 넣은 뒤 백업 파일을 만들어 두세요.';
    el.classList.remove('warn');
    return;
  }
  if (!last) {
    el.textContent = '아직 백업한 적이 없어요. 녹음은 이 태블릿에만 있어서 태블릿을 초기화하거나 잃어버리면 사라져요.';
    el.classList.add('warn');
    return;
  }
  const changed = books.filter((b) => b.updatedAt > last).length;
  el.textContent = changed
    ? `마지막 백업: ${fmtDate(last)}. 그 뒤로 ${changed}권이 추가되거나 바뀌었어요. 새로 백업해 두세요.`
    : `마지막 백업: ${fmtDate(last)}. 그 뒤로 바뀐 책은 없어요.`;
  el.classList.toggle('warn', changed > 0);
}

async function renderStorage() {
  const [u, persisted] = await Promise.all([db.usage(), db.isPersisted()]);
  const parts = [];
  if (u) parts.push(`사용 중인 공간 ${fmtBytes(u.used)}`);
  parts.push(persisted
    ? '영구 저장 켜짐: 공간이 부족해도 브라우저가 녹음을 지우지 않아요.'
    : '영구 저장 꺼짐: 홈 화면에 앱으로 설치하면 켜질 수 있어요. 그래도 백업은 꼭 해 두세요.');
  $('#storageInfo').textContent = parts.join('. ');
}

$('#toKidBtn').addEventListener('click', exitParent);
$('#addBookBtn').addEventListener('click', () => openEditor(null));

$('#exportBtn').addEventListener('click', async () => {
  try {
    busy('백업 파일을 만드는 중이에요', 0);
    const { zip, count } = await exportBackup((p) => busy('백업 파일을 만드는 중이에요', p));
    busyDone();
    if (!count) {
      toast('백업할 책이 없어요.');
      return;
    }
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    download(zip, `목소리책장-백업-${stamp}.zip`);
    localStorage.setItem(BACKUP_KEY, String(Date.now()));
    renderParent();
    await alertModal(
      `${count}권을 백업 파일로 저장했어요`,
      `태블릿의 '다운로드' 폴더에 있어요 (${fmtBytes(zip.size)}).\n구글 드라이브나 컴퓨터에 옮겨 두면 태블릿이 고장 나도 되살릴 수 있어요.`,
    );
  } catch (err) {
    busyDone();
    console.error(err);
    alertModal('백업 파일을 만들지 못했어요', String(err.message || err));
  }
});

$('#importInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const ok = await confirmModal(
    '백업을 불러올까요?',
    '백업 파일의 책을 이 태블릿에 넣어요.\n같은 책이 이미 있으면 백업 파일 내용으로 바뀌어요.',
    '불러오기',
  );
  if (!ok) return;
  try {
    busy('백업을 불러오는 중이에요', 0);
    const count = await importBackup(file, (p) => busy('백업을 불러오는 중이에요', p));
    localStorage.setItem(BACKUP_KEY, String(Date.now()));
    await db.requestPersist();
    busyDone();
    renderParent();
    toast(`${count}권을 불러왔어요.`);
  } catch (err) {
    busyDone();
    console.error(err);
    alertModal('불러오지 못했어요', String(err.message || err));
  }
});

$('#chimeVolume').addEventListener('change', (e) => {
  setChimeVolume(parseFloat(e.target.value));
  playChime();
});
$('#chimeTest').addEventListener('click', () => playChime());

$('#changePinBtn').addEventListener('click', async () => {
  const pin = await pinPad({ title: '지금 비밀번호', hint: '바꾸기 전에 지금 비밀번호를 눌러 주세요' });
  if (pin === null) return;
  if ((await hashPin(pin)) !== localStorage.getItem(PIN_KEY)) {
    await alertModal('비밀번호가 달라요', '다시 시도해 주세요.');
    return;
  }
  await setupPin('새 비밀번호 정하기');
});

// ═════════════ 부모: 책 추가·수정 + 녹음 ═════════════

const editor = {
  book: null,
  isNew: true,
  cover: null, // { cover, thumb } 새로 찍은 사진
  recording: null, // { blob, duration, marks, type } 새 녹음
  dirty: false,
  previewUrl: null,
};

const preview = new Player({
  onState(state) {
    $('#previewBtn').textContent = state === 'playing' ? '멈춤' : '들어보기';
  },
  onTime(t, d) {
    $('#previewTime').textContent = `${fmtClock(t)} / ${fmtClock(d)}`;
  },
});
let previewLoaded = false;

async function openEditor(id) {
  editor.cover = null;
  editor.recording = null;
  editor.dirty = false;
  previewLoaded = false;
  if (id) {
    editor.book = await db.getBook(id);
    editor.isNew = false;
    const cover = await db.getFile(id, 'cover');
    setCoverPreview(cover);
  } else {
    editor.book = {
      id: db.newId(),
      title: '',
      order: await db.frontOrder(),
      duration: 0,
      marks: [],
      audioType: '',
      createdAt: Date.now(),
    };
    editor.isNew = true;
    setCoverPreview(null);
  }
  $('#editorTitle').textContent = editor.isNew ? '새 책' : '책 수정';
  $('#titleInput').value = editor.book.title || '';
  renderRecSummary();
  go('editor');
}

function leaveEditor() {
  preview.close();
  previewLoaded = false;
  if (editor.previewUrl) URL.revokeObjectURL(editor.previewUrl);
  editor.previewUrl = null;
}

function setCoverPreview(blob) {
  if (editor.previewUrl) URL.revokeObjectURL(editor.previewUrl);
  editor.previewUrl = blob ? URL.createObjectURL(blob) : null;
  $('#coverPreview').src = editor.previewUrl || '';
  $('#coverPreview').hidden = !blob;
  $('#coverEmpty').hidden = !!blob;
}

function renderRecSummary() {
  const el = $('#recSummary');
  const rec = editor.recording;
  const hasSaved = !editor.isNew && editor.book.duration > 0;
  if (rec) {
    el.textContent = `새 녹음 ${fmtLength(rec.duration)}, 띵 ${rec.marks.length}번. 들어보고 괜찮으면 저장을 눌러 주세요.`;
    el.classList.add('new');
  } else if (hasSaved) {
    el.textContent = `저장된 녹음 ${fmtLength(editor.book.duration)}, 띵 ${editor.book.marks?.length || 0}번`;
    el.classList.remove('new');
  } else {
    el.textContent = '아직 녹음이 없어요.';
    el.classList.remove('new');
  }
  const hasAudio = !!rec || hasSaved;
  $('#recordBtn').textContent = hasAudio ? '다시 녹음' : '녹음 시작';
  $('#previewBtn').hidden = !hasAudio;
  $('#previewBtn').textContent = '들어보기';
  $('#previewTime').hidden = true;
}

async function onCoverPicked(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    busy('표지 사진을 준비하는 중이에요', 0.5);
    editor.cover = await makeCoverImages(file);
    editor.dirty = true;
    setCoverPreview(editor.cover.cover);
  } catch (err) {
    console.error(err);
    alertModal('사진을 읽지 못했어요', '다른 사진으로 다시 시도해 주세요.');
  } finally {
    busyDone();
  }
}
$('#coverCamera').addEventListener('change', onCoverPicked);
$('#coverAlbum').addEventListener('change', onCoverPicked);
$('#titleInput').addEventListener('input', () => { editor.dirty = true; });

$('#previewBtn').addEventListener('click', async () => {
  unlockAudio();
  if (!previewLoaded) {
    const rec = editor.recording;
    const blob = rec ? rec.blob : await db.getFile(editor.book.id, 'audio');
    if (!blob) return;
    const book = rec ? { ...editor.book, duration: rec.duration, marks: rec.marks } : editor.book;
    await preview.open({ book, audioBlob: blob, remember: false });
    previewLoaded = true;
    $('#previewTime').hidden = false;
  }
  preview.toggle();
});

$('#editorBackBtn').addEventListener('click', () => history.back());

$('#saveBtn').addEventListener('click', async () => {
  const { book, isNew, cover, recording } = editor;
  if (isNew && !cover) {
    alertModal('표지 사진이 필요해요', "'사진 찍기'를 눌러 책 표지를 찍어 주세요. 아이가 이 사진을 보고 책을 골라요.");
    return;
  }
  if (isNew && !recording) {
    alertModal('녹음이 필요해요', "'녹음 시작'을 눌러 책을 읽어 주세요.");
    return;
  }
  const updated = { ...book, title: $('#titleInput').value.trim() };
  const files = {};
  if (cover) Object.assign(files, cover);
  if (recording) {
    updated.duration = recording.duration;
    updated.marks = recording.marks;
    updated.audioType = recording.type;
    files.audio = recording.blob;
    db.clearPosition(book.id); // 새 녹음이면 이어듣기 위치 초기화
  }
  try {
    busy('저장하는 중이에요', 0.6);
    await db.saveBook(updated, files);
    await db.requestPersist();
    busyDone();
    editor.dirty = false;
    toast(isNew ? '책장에 꽂았어요.' : '저장했어요.');
    history.back();
  } catch (err) {
    busyDone();
    console.error(err);
    const full = err?.name === 'QuotaExceededError';
    alertModal('저장하지 못했어요', full ? '태블릿 저장 공간이 부족해요. 사진이나 동영상을 정리한 뒤 다시 저장해 주세요.' : String(err.message || err));
  }
});

// ── 녹음 ──

let recorder = null;
let recTimer = null;

$('#recordBtn').addEventListener('click', async () => {
  if (!canRecord()) {
    alertModal('이 브라우저에서는 녹음할 수 없어요', '크롬(Chrome)으로 열어 주세요.');
    return;
  }
  if (editor.recording || (!editor.isNew && editor.book.duration > 0)) {
    const ok = await confirmModal('다시 녹음할까요?', '저장을 누르면 지금 녹음이 새 녹음으로 바뀌어요.', '다시 녹음');
    if (!ok) return;
  }
  preview.close();
  previewLoaded = false;
  startRecording();
});

async function startRecording() {
  recorder = new Recorder({
    onLevel(level) { $('#recLevel').style.width = `${Math.round(level * 100)}%`; },
    onAutoPause() {
      paintRecState();
      toast("화면이 꺼져서 녹음을 잠깐 멈췄어요. '이어서 녹음'을 누르세요.", 5000);
    },
    async onError(err) {
      if (!recorder) return;
      const result = await recorder.stop().catch(() => null);
      finishRecording(result);
      alertModal('녹음이 멈췄어요', `${err.message || err}\n여기까지 녹음된 부분은 남아 있어요.`);
    },
  });
  try {
    await recorder.start();
  } catch (err) {
    recorder = null;
    console.error(err);
    const denied = err?.name === 'NotAllowedError';
    alertModal(
      '마이크를 쓸 수 없어요',
      denied
        ? "마이크 권한이 꺼져 있어요.\n크롬 주소창 왼쪽 아이콘 → 권한 → 마이크를 '허용'으로 바꾼 뒤 다시 눌러 주세요."
        : String(err.message || err),
    );
    return;
  }
  $('#markCount').textContent = '아직 0번';
  $('#recTime').textContent = '0:00';
  $('#recOverlay').hidden = false;
  paintRecState();
  recTimer = setInterval(() => {
    if (recorder) $('#recTime').textContent = fmtClock(recorder.elapsed);
  }, 250);
}

function paintRecState() {
  if (!recorder) return;
  const paused = recorder.state === 'paused';
  $('#recOverlay').classList.toggle('paused', paused);
  $('#recState').textContent = paused ? '일시정지' : '녹음 중';
  $('#pauseRecBtn').textContent = paused ? '이어서 녹음' : '일시정지';
  $('#markBtn').disabled = paused;
}

function finishRecording(result) {
  clearInterval(recTimer);
  recorder = null;
  $('#recOverlay').hidden = true;
  $('#recLevel').style.width = '0';
  if (result && result.blob.size > 0 && result.duration >= 1) {
    editor.recording = result;
    editor.dirty = true;
    previewLoaded = false;
  }
  renderRecSummary();
}

$('#markBtn').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (!recorder || recorder.state !== 'recording') return;
  const n = recorder.mark();
  $('#markCount').textContent = `${n}번`;
  const btn = $('#markBtn');
  btn.classList.remove('flash');
  void btn.offsetWidth;
  btn.classList.add('flash');
  navigator.vibrate?.(30);
});

$('#undoMarkBtn').addEventListener('click', () => {
  if (!recorder) return;
  const n = recorder.undoMark();
  $('#markCount').textContent = n ? `${n}번` : '아직 0번';
  toast('방금 누른 넘김을 지웠어요.', 1800);
});

$('#pauseRecBtn').addEventListener('click', () => {
  if (!recorder) return;
  if (recorder.state === 'recording') recorder.pause();
  else recorder.resume();
  paintRecState();
});

$('#stopRecBtn').addEventListener('click', async () => {
  if (!recorder) return;
  busy('녹음을 정리하는 중이에요', 0.7);
  const result = await recorder.stop();
  busyDone();
  finishRecording(result);
  if (result && result.duration < 1) toast('녹음이 너무 짧아요. 다시 녹음해 주세요.');
  else toast('녹음했어요. 들어보고 저장을 눌러 주세요.', 4000);
});

$('#discardRecBtn').addEventListener('click', async () => {
  if (!recorder) return;
  const wasRecording = recorder.state === 'recording';
  if (wasRecording) { recorder.pause(); paintRecState(); }
  const ok = await confirmModal('녹음을 버릴까요?', '지금까지 녹음한 내용이 사라져요.', '버리기', 'danger');
  if (!ok) {
    if (wasRecording) { recorder.resume(); paintRecState(); }
    return;
  }
  recorder.cancel();
  finishRecording(null);
});

// ═════════════ 시작 ═════════════

history.replaceState({ screen: 'shelf', depth: 0 }, '');
show('shelf');
renderShelf().catch((err) => {
  console.error(err);
  alertModal('책장을 열지 못했어요', String(err.message || err));
});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('오프라인 준비 실패', err));
}
