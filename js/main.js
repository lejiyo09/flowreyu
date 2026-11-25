// 앱 진입점: 라이브러리 ↔ 편집기, 도구 UI, 설정, 자동 저장 상태 표시를 연결한다.
import { settings, PEN_COLORS, HL_COLORS, GESTURES, GESTURE_ACTIONS } from './settings.js';
import * as store from './store.js';
import { NoteDocument } from './document.js';
import { Viewer, pdfjsLib } from './viewer.js';
import { InputRouter } from './input.js';
import { ToolController } from './tools.js';
import { ThumbPanel } from './thumbs.js';
import { Guides } from './guides.js';
import { AudioRecorder, fmtTime, wavChunks } from './audio.js';
import { Clock, fmtClock, ringSound } from './timer.js';
import { mightHaveGalleryInk, extractGalleryInk } from './gallery.js';
import { askAi, AiError, AI_MODELS, getApiKey, getUserKey, setApiKey, importKeyFromHash, minutesRequest, grammarRequest, translateRequest, transcribeRequest, parseTranscript, unpackTexts, splitExplain, extractTodos, TRANSLATE_LANGS } from './ai.js';
import { InputDebugger } from './debug.js';
import { CanvasEngine } from './canvas-engine.js';
import { prepQuery, buildPdfIndex, findInIndex, findInItems } from './search.js';
import { FONTS, MARGINS, DEFAULT_PAGE, pageGeom } from './typing-page.js';
import { groupItems, ungroupItems, groupInfo, reorder, alignItems, selectionUnits, nudgeItems, cloneItems } from './arrange.js';
import { ScrollEngine, contentBottom } from './scroll-engine.js';
import { uid, debounce, formatBytes, formatDate, escapeHtml, clamp, rectsIntersect } from './util.js';
import { sanitizeItem, TEXT_FONT, textLayout, imageHooks, putImage, NOTE_COLORS, NOTE_PAD, TEXT_LINE, noteIconRect, noteFoldButton, noteDeleteButton, noteAttached, noteHandle, noteTextTop, noteTextBottom, noteResizeHandle, noteMinSize, bbox, checkHeight, tableCtlSize, tableAddRowBtn, tableAddColBtn, tableResizeHandle, tableMinSize, objHandle, objDeleteButton, objBarH, transformItem, drawItem, isHighlighter, foldHidden, layerSorted, layerUsable, layerHidden, setLayerState, layerOf, DEFAULT_LAYER, checkRowAt, checkBox, checkRowH, cellAt, cellRect, tableSize, hitTest, linkHit, inactiveIds, inkTheme } from './ink.js';

const $ = (s) => document.querySelector(s);
const APP_VERSION = '1.4.1';
const PDF_OPTS = {
  cMapUrl: new URL('../vendor/pdfjs/cmaps/', import.meta.url).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('../vendor/pdfjs/standard_fonts/', import.meta.url).href,
  isEvalSupported: false,
  enableXfa: false,
};

const state = {
  doc: null, // NoteDocument
  pdf: null,
  blob: null,
  screen: 'library',
  editing: null, // 텍스트 편집 {page, item, x, y}
};

// ───────────────────────────── 공통 UI ─────────────────────────────

let toastTimer = 0;
function toast(msg, { error = false, ms = 2600 } = {}) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', error);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function busy(text) {
  $('#busy').hidden = !text;
  if (text) $('#busyText').textContent = text;
}

function applyTheme() {
  const pref = settings.get('theme');
  const dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.classList.toggle('glass', !!settings.get('glass'));
  // 투명도 t% → 패널 불투명도. 다크는 흰 PDF 위에서 글자가 읽히도록 절반만 투명해진다 (기본 45% → 라이트 0.55, 다크 0.78)
  const t = settings.get('glassClear') / 100;
  document.documentElement.style.setProperty('--glass-a', (dark ? 1 - t * 0.5 : 1 - t).toFixed(3));
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);
applyTheme();

// ───────────────────────────── 뷰어 · 입력 · 도구 ─────────────────────────────

const viewer = new Viewer($('#viewport'), $('#world'), { bg: $('#cvBg'), hl: $('#cvHl'), ink: $('#cvInk'), live: $('#cvLive') });

const app = {
  doc: () => state.doc,
  isUiTarget: (el, e) => {
    if (!el?.closest) return false;
    if (el.closest('[data-ui]')) return true;
    // 타이핑형 노트의 글 영역 (입력 도구일 때): 마우스·펜은 브라우저 그대로(글자 선택·커서), 손가락은 화면 이동(탭 = 커서 놓기)
    if (typing && settings.get('tool') === 'type' && el.closest('.typing-host')) return !e || e.pointerType === 'mouse' || e.pointerType === 'pen';
    return false;
  },
  runAction: (action, sx, sy, source) => runAction(action, sx, sy, source),
  showZoom: () => showZoomBadge(),
  onSelection: (sel, dragging, m) => { renderSelection(sel, dragging, m); $('#lyMoveSel').hidden = !sel; },
  editText: (page, item, x, y) => startTextEdit(page, item, x, y),
  editLink: (page, item, rect) => editLink(page, item, rect),
  onEraserUsed: () => {
    if (!settings.get('eraser').autoReturn || settings.get('tool') !== 'eraser') return;
    selectTool(toolBeforeEraser || 'pen');
  },
  tap: (sx, sy) => followLinkAt(sx, sy),
  linkAt: (sx, sy) => linkAtScreen(sx, sy), // 마우스: 링크 위에서 손가락 모양 커서, 그리기 모드의 클릭
  hoverAt: (sx, sy) => { $('#viewport').classList.toggle('over-link', !!linkAtScreen(sx, sy)); },
  tapObjectAt: (page, x, y) => tapObjectAt(page, x, y),
  noteDragStart: (sx, sy) => noteDragStart(sx, sy),
  noteDragMove: (sx, sy) => noteDragMove(sx, sy),
  noteDragEnd: (cancel) => noteDragEnd(cancel),
  // 펜 세 번 탭 메뉴: 앞 탭들이 남긴 편집을 기록 없이 되돌리기 위한 표식
  historyMark: () => (state.doc ? { len: state.doc.undoStack.length, top: state.doc.undoStack[state.doc.undoStack.length - 1] } : null),
  revertTo: (mark) => {
    const d = state.doc;
    if (!d || !mark) return;
    while (d.undoStack.length > mark.len) { d.undo(); d.redoStack.pop(); }
    tools.validateSelection();
    updateHistoryButtons();
  },
  toast,
};
app.guides = new Guides(viewer, $('#cvGuide'));
const tools = new ToolController(viewer, app);
const input = new InputRouter(viewer, tools, app);
const thumbs = new ThumbPanel($('#thumbs'), $('#thumbList'), viewer, (i) => { viewer.goToPage(i); });
const dbg = new InputDebugger($('#debugPanel'));
dbg.onClose = () => settings.set('debug', false);
dbg.onToast = toast;
dbg.getState = () => input.stateText();
input.onTrace = (m) => dbg.note(m);

// 텍스트 편집 중 다른 곳을 누르면 확정
$('#viewport').addEventListener('pointerdown', (e) => {
  if (state.editing && e.target !== $('#textEditor')) commitTextEdit();
  if (!$('#toolPopup').hidden && !e.target.closest('#toolPopup')) closeToolPopup();
  if (!$('#quickMenu').hidden && !e.target.closest('#quickMenu')) closeQuickMenu();
}, true);
document.addEventListener('pointerdown', (e) => {
  if (!$('#toolPopup').hidden && !e.target.closest('#toolPopup') && !e.target.closest('#toolbar')) closeToolPopup();
  if (!$('#quickMenu').hidden && !e.target.closest('#quickMenu') && !e.target.closest('#viewport')) closeQuickMenu();
}, true);

// 카메라 이벤트는 제스처 중 매 프레임 오므로 UI 갱신은 프레임당 한 번으로 묶는다
let uiFrame = 0;
viewer.on('camera', () => {
  if (uiFrame) return;
  uiFrame = requestAnimationFrame(() => {
    uiFrame = 0;
    updateZoomLabel();
    updatePageIndicator();
    positionOverlays();
    saveViewSoon();
  });
});
viewer.on('resize', () => { positionOverlays(); });
viewer.on('sized', () => { thumbs.resizeBoxes(); updatePageIndicator(); updateGlassInset(); });

/** 글래스 디자인이면 위쪽 바가 페이지를 덮으므로, 페이지가 바 아래에서 시작하도록 뷰어에 알린다 */
function updateGlassInset() {
  const glass = settings.get('glass') && state.screen === 'editor';
  const topH = $('#editor > .topbar').offsetHeight, bar = $('#tabBar'), fmt = hwp || !$('#hwpBar').hidden ? $('#hwpBar') : $('#fmtBar');
  // 글래스: 위쪽 바처럼 화면 위에 떠 있음 → 탭 줄, 서식 도구 모음 순서로 그 아래에
  const tabH = bar.hidden ? 0 : bar.offsetHeight;
  bar.style.top = glass ? topH + 'px' : '';
  fmt.style.top = glass ? topH + tabH + 'px' : '';
  const inset = glass ? topH + tabH + (fmt.hidden ? 0 : fmt.offsetHeight) : 0;
  $('#hwpHost').style.top = inset + 'px';
  if (inset === viewer.insetTop) return;
  const dy = inset - viewer.insetTop;
  viewer.insetTop = inset;
  if (viewer.pages.length) viewer.setCamera(viewer.cam.tx, viewer.cam.ty + dy, viewer.cam.z); // 보던 위치를 바 높이만큼 내려 같은 내용이 보이게
}

// ───────────────────────────── 라이브러리 ─────────────────────────────

let libEditing = false;
let curFolder = null; // 지금 보고 있는 폴더 id (null = 홈)
let folders = []; // [{id, name, parent}] — kv 'folders' 에 저장

async function loadFolders() {
  const f = await store.kvGet('folders').catch(() => null);
  folders = Array.isArray(f) ? f.filter((x) => x && typeof x.id === 'string' && typeof x.name === 'string') : [];
}
const saveFolders = () => store.kvSet('folders', folders);
const folderById = (id) => folders.find((f) => f.id === id) || null;
/** 폴더 경로 (홈 → … → id) */
function folderPath(id) {
  const out = [];
  for (let f = folderById(id), n = 0; f && n < 50; f = folderById(f.parent), n++) out.unshift(f);
  return out;
}
/** 노트·폴더가 속한 폴더 (지워진 폴더를 가리키면 홈) */
const docFolder = (d) => (d.folder && folderById(d.folder) ? d.folder : null);
const parentOf = (f) => (f.parent && folderById(f.parent) ? f.parent : null);

/** 길게 누르기(손가락·펜)·우클릭 → 메뉴. 돌려주는 함수는 click 에서 "방금 길게 눌렀는지" 확인용 */
function bindCardMenu(card, openMenu) {
  let pressed = null;
  card.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || e.target.closest('button')) return;
    const x = e.clientX, y = e.clientY;
    pressed = { x, y, timer: setTimeout(() => { pressed.fired = true; openMenu({ x, y }); }, 550) };
  });
  card.addEventListener('pointermove', (e) => { if (pressed && Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) > 10) { clearTimeout(pressed.timer); pressed = null; } });
  card.addEventListener('pointerup', () => { if (pressed) clearTimeout(pressed.timer); });
  card.addEventListener('pointercancel', () => { if (pressed) clearTimeout(pressed.timer); pressed = null; });
  card.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!pressed?.fired) openMenu({ x: e.clientX, y: e.clientY }); });
  return () => { const fired = !!pressed?.fired; pressed = null; return fired; };
}

async function renderLibrary() {
  let docs = [];
  try { docs = await store.listDocs(); }
  catch (e) { toast('저장소를 열 수 없습니다: ' + store.describeError(e), { error: true, ms: 6000 }); }
  await loadFolders();
  if (curFolder && !folderById(curFolder)) curFolder = null;
  const last = await store.kvGet('lastDoc').catch(() => null);
  const grid = $('#docGrid');
  grid.innerHTML = '';
  // 경로 표시: 홈 › 폴더 › 하위 폴더
  const crumbs = $('#libCrumbs');
  crumbs.hidden = !curFolder;
  crumbs.innerHTML = '';
  if (curFolder) {
    const parts = [{ id: null, name: '홈' }, ...folderPath(curFolder)];
    parts.forEach((f, k) => {
      if (k) crumbs.insertAdjacentHTML('beforeend', '<span class="sep">›</span>');
      const b = document.createElement('button');
      b.textContent = f.name;
      b.className = k === parts.length - 1 ? 'cur' : '';
      b.addEventListener('click', () => openFolder(f.id));
      crumbs.appendChild(b);
    });
  }
  const subFolders = folders.filter((f) => parentOf(f) === curFolder).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  const here = docs.filter((d) => docFolder(d) === curFolder);
  const empty = !subFolders.length && !here.length;
  $('#libEmpty').hidden = !empty;
  $('#libEmpty p').textContent = curFolder ? '이 폴더는 비어 있습니다. PDF를 열거나 새 노트를 만들면 이 폴더에 들어갑니다.' : 'PDF를 열거나 새 노트를 만들어 시작하세요.';
  if (!docs.length && !folders.length && libEditing) setLibEditing(false);

  for (const f of subFolders) {
    const nDocs = docs.filter((d) => docFolder(d) === f.id).length;
    const nSub = folders.filter((x) => parentOf(x) === f.id).length;
    const card = document.createElement('div');
    card.className = 'doc-card folder-card';
    card.dataset.folder = f.id;
    card.innerHTML = `
      <div class="cover"><svg><use href="#i-folder"/></svg></div>
      <button class="more" data-ui title="메뉴"><svg><use href="#i-more"/></svg></button>
      <div class="card-actions">
        <button data-a="rename">✎ 이름</button><button data-a="move">↪ 이동</button><button data-a="del" class="danger">삭제</button>
      </div>
      <div class="name">${escapeHtml(f.name)}</div>
      <div class="meta">노트 ${nDocs}개${nSub ? ` · 폴더 ${nSub}개` : ''}</div>`;
    const longPressed = bindCardMenu(card, (at) => folderMenu(at, f));
    card.addEventListener('click', (e) => {
      if (longPressed()) return;
      const act = e.target.closest('.card-actions button');
      if (act) { e.stopPropagation(); folderAction(act.dataset.a, f); return; }
      if (e.target.closest('.more')) { e.stopPropagation(); const r = e.target.closest('.more').getBoundingClientRect(); folderMenu({ x: r.right - 160, y: r.bottom + 4 }, f); return; }
      if (libEditing) { folderAction('rename', f); return; }
      openFolder(f.id);
    });
    grid.appendChild(card);
  }

  for (const d of here) {
    const card = document.createElement('div');
    card.className = 'doc-card';
    card.dataset.id = d.id;
    card.innerHTML = `
      <div class="cover">${d.thumb ? `<img src="${d.thumb}" alt="">` : '<svg><use href="#i-file"/></svg>'}</div>
      ${d.id === last ? '<span class="last-badge">최근</span>' : ''}
      <button class="more" data-ui title="메뉴"><svg><use href="#i-more"/></svg></button>
      <div class="card-actions">
        <button data-a="rename">✎ 이름</button><button data-a="move">↪ 이동</button><button data-a="dup">⧉ 사본</button><button data-a="del" class="danger">삭제</button>
      </div>
      <div class="name">${escapeHtml(d.name)}</div>
      <div class="meta">${d.kind === 'hwp' ? `한글 ${d.source?.format === 'hwpx' ? 'HWPX' : 'HWP'}` : d.kind === 'typing' ? `${d.source ? d.source.format.toUpperCase() : '타이핑'} · ${d.pageCount || 1}쪽` : KIND_LABEL[d.kind] || `${d.pageCount || '?'}쪽`} · ${formatDate(d.updated || d.created)}</div>`;
    const longPressed = bindCardMenu(card, (at) => cardMenu(at, d));
    card.addEventListener('click', (e) => {
      if (longPressed()) return; // 길게 누른 뒤 손을 뗀 것은 열기 아님
      const act = e.target.closest('.card-actions button');
      if (act) { e.stopPropagation(); cardAction(act.dataset.a, d); return; }
      if (e.target.closest('.more')) { e.stopPropagation(); const r = e.target.closest('.more').getBoundingClientRect(); cardMenu({ x: r.right - 160, y: r.bottom + 4 }, d); return; }
      if (libEditing) { cardAction('rename', d); return; } // 편집 중에는 카드를 눌러도 열지 않고 이름 바꾸기
      openDoc(d.id);
    });
    grid.appendChild(card);
  }
  const info = await store.storageInfo();
  $('#storageLine').textContent = `저장소 사용량 ${formatBytes(info.usage)} / ${formatBytes(info.quota)}` +
    (info.persisted === true ? ' · 영구 저장 허용됨' : info.persisted === false ? ' · 영구 저장 미허용(브라우저가 공간 부족 시 삭제할 수 있음)' : '');
}

function openFolder(id) {
  curFolder = id;
  store.kvSet('libFolder', id).catch(() => {});
  renderLibrary();
}

// ── 폴더 ──
$('#btnNewFolder').addEventListener('click', async () => {
  const name = prompt('새 폴더 이름', '새 폴더');
  if (!name || !name.trim()) return;
  await loadFolders();
  folders.push({ id: uid('f'), name: name.trim().slice(0, 80), parent: curFolder, created: Date.now() });
  await saveFolders();
  renderLibrary();
});

function popMenu(at, html, onPick) {
  document.querySelector('.card-menu')?.remove();
  const m = document.createElement('div');
  m.className = 'card-menu';
  m.dataset.ui = '';
  m.innerHTML = html;
  document.body.appendChild(m);
  m.style.left = clamp(at.x, 8, innerWidth - 170) + 'px';
  m.style.top = clamp(at.y, 8, innerHeight - 230) + 'px';
  const close = () => { m.remove(); document.removeEventListener('pointerdown', outside, true); };
  const outside = (ev) => { if (!m.contains(ev.target)) close(); };
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  m.addEventListener('click', (ev) => {
    const a = ev.target.closest('button')?.dataset.a;
    if (!a) return;
    close();
    onPick(a);
  });
}
function folderMenu(at, f) {
  popMenu(at, '<button data-a="open">열기</button><button data-a="rename">이름 바꾸기</button><button data-a="move">다른 폴더로 이동</button><button data-a="del" class="danger">폴더 삭제</button>', (a) => folderAction(a, f));
}
async function folderAction(a, f) {
  if (a === 'open') openFolder(f.id);
  else if (a === 'rename') {
    const name = prompt('폴더 이름', f.name);
    if (!name || !name.trim()) return;
    await loadFolders();
    const x = folderById(f.id);
    if (x) { x.name = name.trim().slice(0, 80); await saveFolders(); }
    renderLibrary();
  } else if (a === 'move') {
    const dest = await pickFolder(`"${f.name}" 폴더를 어디로 옮길까요?`, f.id);
    if (dest === undefined) return;
    await loadFolders();
    const x = folderById(f.id);
    if (x) { x.parent = dest; await saveFolders(); toast(`"${f.name}" → ${dest ? folderById(dest).name : '홈'}`); }
    renderLibrary();
  } else if (a === 'del') {
    const docs = await store.listDocs();
    const nDocs = docs.filter((d) => docFolder(d) === f.id).length;
    const nSub = folders.filter((x) => parentOf(x) === f.id).length;
    const up = parentOf(f);
    const where = up ? `"${folderById(up).name}" 폴더` : '홈';
    if (!confirm(`"${f.name}" 폴더를 삭제할까요?${nDocs || nSub ? `\n안의 노트 ${nDocs}개${nSub ? `와 폴더 ${nSub}개` : ''}는 지우지 않고 ${where}(으)로 옮깁니다.` : ''}`)) return;
    for (const d of docs) if (docFolder(d) === f.id) await store.patchDoc(d.id, { folder: up });
    await loadFolders();
    for (const x of folders) if (x.parent === f.id) x.parent = up;
    folders = folders.filter((x) => x.id !== f.id);
    await saveFolders();
    toast('폴더를 삭제했습니다');
    renderLibrary();
  }
}

/**
 * 폴더 고르기 대화상자. 고른 폴더 id (홈은 null), 취소하면 undefined.
 * exclude: 옮기는 폴더 자신 (자기·하위 폴더로는 못 옮김)
 */
function pickFolder(title, exclude = null) {
  return new Promise((resolve) => {
    const dlg = $('#moveDlg');
    $('#moveTitle').textContent = title;
    const list = $('#moveList');
    list.innerHTML = '';
    const banned = new Set();
    if (exclude) { banned.add(exclude); let grew = true; while (grew) { grew = false; for (const f of folders) if (!banned.has(f.id) && banned.has(f.parent)) { banned.add(f.id); grew = true; } } }
    const add = (id, name, depth) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'move-item' + (id === curFolder ? ' cur' : '');
      b.style.paddingLeft = 12 + depth * 18 + 'px';
      b.innerHTML = `<svg><use href="#${id ? 'i-folder' : 'i-home'}"/></svg><span>${escapeHtml(name)}</span>`;
      b.addEventListener('click', () => { done = true; dlg.close(); resolve(id); });
      list.appendChild(b);
    };
    add(null, '홈 (맨 위)', 0);
    const walk = (parent, depth) => {
      for (const f of folders.filter((x) => parentOf(x) === parent && !banned.has(x.id)).sort((a, b) => a.name.localeCompare(b.name, 'ko'))) { add(f.id, f.name, depth); walk(f.id, depth + 1); }
    };
    walk(null, 1);
    let done = false;
    dlg.addEventListener('close', () => { if (!done) resolve(undefined); }, { once: true });
    dlg.showModal();
  });
}

/** 홈 편집 모드: 카드마다 이름 바꾸기·사본·삭제 버튼을 보여 준다 */
function setLibEditing(on) {
  libEditing = on;
  $('#library').classList.toggle('lib-editing', on);
  $('#btnLibEdit span').textContent = on ? '완료' : '편집';
  $('#btnLibEdit').classList.toggle('primary', on);
}
$('#btnLibEdit').addEventListener('click', () => setLibEditing(!libEditing));

function cardMenu(at, d) {
  document.querySelector('.card-menu')?.remove();
  const m = document.createElement('div');
  m.className = 'card-menu';
  m.dataset.ui = '';
  m.innerHTML = '<button data-a="open">열기</button><button data-a="rename">이름 바꾸기</button><button data-a="move">폴더로 이동</button><button data-a="dup">사본 만들기</button><button data-a="del" class="danger">삭제</button>';
  document.body.appendChild(m);
  m.style.left = clamp(at.x, 8, innerWidth - 170) + 'px';
  m.style.top = clamp(at.y, 8, innerHeight - 190) + 'px';
  const close = () => { m.remove(); document.removeEventListener('pointerdown', outside, true); };
  const outside = (ev) => { if (!m.contains(ev.target)) close(); };
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  m.addEventListener('click', (ev) => {
    const a = ev.target.closest('button')?.dataset.a;
    if (!a) return;
    close();
    cardAction(a, d);
  });
}

/** 노트 이름 바꾸기 (홈 카드·편집기 제목 공용). 바꿨으면 새 이름 */
async function renameDoc(id, cur) {
  const name = prompt('노트 이름', cur);
  if (!name || !name.trim() || name.trim() === cur) return null;
  const n = name.trim().slice(0, 120);
  await store.patchDoc(id, { name: n });
  if (state.doc?.id === id) { state.doc.meta.name = n; $('#docTitle').textContent = n; updatePageTitle(); }
  const tab = tabs.find((t) => t.id === id);
  if (tab) { tab.name = n; saveTabs(); renderTabs(); }
  toast('이름을 바꿨습니다');
  return n;
}

async function cardAction(a, d) {
  if (a === 'open') openDoc(d.id);
  else if (a === 'rename') { if (await renameDoc(d.id, d.name)) renderLibrary(); }
  else if (a === 'move') {
    await loadFolders();
    const dest = await pickFolder(`"${d.name}"을(를) 어느 폴더로 옮길까요?`);
    if (dest === undefined) return;
    await store.patchDoc(d.id, { folder: dest });
    toast(`"${d.name}" → ${dest ? folderById(dest).name : '홈'}`);
    renderLibrary();
  }
  else if (a === 'dup') {
    busy('사본 만드는 중…');
    try {
      const id = await store.duplicateDoc(d.id, uid('d'), `${d.name} 사본`, (b) => uid(b.kind === 'audio' ? 'rec' : 'img'));
      busy(null);
      toast(id ? `"${d.name} 사본"을 만들었습니다` : '원본을 찾을 수 없습니다', { error: !id });
    } catch (err) { busy(null); toast('사본 만들기 실패: ' + store.describeError(err), { error: true }); }
    renderLibrary();
  } else if (a === 'del') {
    if (!confirm(`"${d.name}"을(를) 삭제할까요?\nPDF와 모든 필기가 삭제되며 되돌릴 수 없습니다.`)) return;
    try { await store.deleteDoc(d.id); dropTab(d.id); toast('삭제했습니다'); }
    catch (err) { toast('삭제 실패: ' + store.describeError(err), { error: true }); }
    renderLibrary();
  }
}

// 편집기 위쪽 제목을 탭해도 이름 바꾸기
$('#docTitle').addEventListener('click', () => { if (state.doc) renameDoc(state.doc.id, state.doc.meta.name); });

function showScreen(name) {
  state.screen = name;
  $('#library').hidden = name !== 'library';
  $('#editor').hidden = name !== 'editor';
  if (name === 'editor') { applyToolbarPos(); viewer.resize(true); updateGlassInset(); }
  renderTabs();
  if (name !== 'editor') document.documentElement.style.removeProperty('--tb-space');
  updatePageTitle();
}

/** 브라우저 탭·앱 창 제목: 노트를 열면 "FlexNote-노트제목", 아니면 "FlexNote" */
function updatePageTitle() {
  const name = state.screen === 'editor' && state.doc?.meta.name;
  document.title = name ? `FlexNote-${name}` : 'FlexNote';
}

// ───────────────────────────── 가져오기 ─────────────────────────────

async function makeThumb(pdf) {
  try {
    const page = await pdf.getPage(1);
    const vp0 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 300 / vp0.width });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp, background: '#ffffff' }).promise;
    return c.toDataURL('image/jpeg', 0.75);
  } catch { return null; }
}

async function importPdfBytes(bytes, name, extra = {}) {
  const head = new Uint8Array(bytes, 0, Math.min(1024, bytes.byteLength));
  const sig = String.fromCharCode(...head);
  if (!sig.includes('%PDF')) throw new Error('PDF 파일이 아닙니다');
  // pdf.js는 버퍼를 워커로 넘기며 비워 버리므로 복사본을 넘긴다
  const pdf = await pdfjsLib.getDocument({ ...PDF_OPTS, data: bytes.slice(0) }).promise;
  const thumb = await makeThumb(pdf);
  const meta = {
    id: uid('d'), name, size: bytes.byteLength, pageCount: pdf.numPages,
    created: Date.now(), updated: Date.now(), opened: Date.now(), thumb, view: null, folder: curFolder, ...extra, // 지금 보고 있는 폴더에 넣기
  };
  await pdf.destroy();
  await store.addDocWithFile(meta, new Blob([bytes], { type: 'application/pdf' }));
  store.requestPersist();
  return meta.id;
}

/**
 * 크롬북 갤러리에서 쓴 필기가 PDF 에 있으면, 물어보고 편집 가능한 필기로 가져온다 (문서마다 처음 열 때 한 번).
 * 가져오면 갤러리 필기를 지운 PDF 와 (기존 필기 + 가져온 필기)를 한 번에 저장하고 그 PDF 를 돌려준다. 기존 필기는 그대로 둔다.
 */
async function importGalleryInk(meta, blob) {
  const done = async (patch = {}) => { meta.galleryChecked = true; await store.patchDoc(meta.id, { galleryChecked: true, ...patch }).catch(() => {}); };
  const bytes = await blob.arrayBuffer();
  if (!mightHaveGalleryInk(bytes)) { await done(); return null; }
  let res = null;
  const pdf = await pdfjsLib.getDocument({ ...PDF_OPTS, data: bytes.slice(0) }).promise;
  try { res = await extractGalleryInk(bytes, async (i) => (await pdf.getPage(i + 1)).getViewport({ scale: 1 }).transform); }
  catch (e) { console.warn('[gallery] 읽기 실패', e); }
  finally { pdf.destroy(); }
  if (!res) { await done(); return null; }
  if (!confirm(`크롬북 갤러리에서 쓴 필기 ${res.count}개가 있습니다.\n편집할 수 있는 필기로 가져올까요?\n\n가져오면 지우개·올가미로 지우고 옮기고 색을 바꿀 수 있습니다.\n취소하면 지금처럼 PDF 배경의 일부로 남습니다. (이 노트의 기존 필기는 어느 쪽이든 그대로)`)) {
    await done();
    return null;
  }
  const recs = await store.loadPages(meta.id);
  const old = new Map(recs.map((r) => [r.page, r]));
  const records = recs.filter((r) => !res.pages.has(r.page)).map((r) => ({ page: r.page, items: r.items, rev: r.rev || 0 }));
  for (const [p, items] of res.pages) records.push({ page: p, items: [...(old.get(p)?.items || []), ...items], rev: (old.get(p)?.rev || 0) + 1 });
  const cleaned = new Blob([res.cleaned], { type: 'application/pdf' });
  await store.replaceDocStructure(meta.id, cleaned, records, { galleryChecked: true, galleryImported: res.count });
  meta.galleryChecked = true;
  setTimeout(() => toast(`갤러리 필기 ${res.count}개를 가져왔습니다 · 이제 지우개·올가미로 편집할 수 있습니다`, { ms: 4000 }), 300);
  return cleaned;
}

const extOf = (f) => (f.name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
const OPENABLE = (f) => ['pdf', 'docx', 'doc', 'hwp', 'hwpx'].includes(extOf(f)) || /pdf$/i.test(f.type);

/** 아직 직접 열 수 없는 형식: 이유와 대안을 알림 (조용히 무시하지 않음) */
function unsupportedFile(f) {
  const e = extOf(f);
  if (e === 'doc') return '옛 Word 형식(.doc)은 아직 직접 열 수 없습니다. Word·한글에서 .docx 로 다시 저장해 열어 주세요';
  return null;
}

/** 파일 하나 가져오기 → 노트 id (열지는 않음). Word 는 타이핑형 노트로 */
async function importOne(file) {
  const why = unsupportedFile(file);
  if (why) throw Object.assign(new Error(why), { friendly: true });
  if (extOf(file) === 'docx') return importDocxFile(file);
  if (extOf(file) === 'hwp' || extOf(file) === 'hwpx') return importHwpFile(file);
  return importPdfBytes(await file.arrayBuffer(), file.name.replace(/\.pdf$/i, ''));
}

/** Word(.docx) → 타이핑형 노트. 원본 파일은 첨부로 보관 (고치지 않고 저장하면 그대로 내려줌) */
async function importDocxFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { importDocx } = await import('./docx.js');
  const res = importDocx(bytes);
  const t = Date.now();
  const id = uid('d'), srcId = uid('src');
  const name = file.name.replace(/\.docx$/i, '');
  const meta = {
    id, name, kind: 'typing', noteType: 'typing', page: res.page, pageCount: 1, created: t, updated: t, opened: t, thumb: null, view: null, folder: curFolder,
    source: { format: 'docx', name: file.name, blob: srcId, size: bytes.byteLength, imported: t, unchanged: true, warnings: res.warnings, approx: res.approx },
  };
  await store.addDocWithFile(meta, new Blob([JSON.stringify(res.content)], { type: 'application/json' }));
  await store.putBlob({ id: srcId, docId: id, kind: 'source', name: file.name, data: new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }) });
  store.requestPersist();
  return id;
}

/** 한글(.hwp/.hwpx) → 한글 문서 노트. 변환하지 않고 원래 형식 그대로 편집·저장 (원본은 첨부로 보관) */
async function importHwpFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { sniffFormat } = await import('./hwp.js');
  const format = sniffFormat(bytes);
  if (!format) throw Object.assign(new Error(`"${file.name}" 은(는) 올바른 한글 파일이 아닙니다 (손상되었거나 다른 형식)`), { friendly: true });
  const t = Date.now();
  const id = uid('d'), srcId = uid('src');
  const name = file.name.replace(/\.hwpx?$/i, '');
  const type = format === 'hwpx' ? 'application/hwp+zip' : 'application/x-hwp';
  const meta = {
    id, name, kind: 'hwp', noteType: 'typing', created: t, updated: t, opened: t, thumb: null, view: null, folder: curFolder,
    source: { format, name: file.name, blob: srcId, size: bytes.byteLength, imported: t, unchanged: true },
  };
  await store.addDocWithFile(meta, new Blob([bytes], { type }));
  await store.putBlob({ id: srcId, docId: id, kind: 'source', name: file.name, data: new Blob([bytes], { type }) });
  store.requestPersist();
  return id;
}

async function importFile(file) {
  if (!file) return;
  if (extOf(file) !== 'pdf' && !/pdf$/i.test(file.type)) {
    busy(`"${file.name}" 불러오는 중…`);
    try {
      const id = await importOne(file);
      busy(null);
      await openDoc(id);
      if (typing?.meta.source) showDocReport(true);
      else if (hwp) toast('한글 문서를 원래 형식 그대로 편집합니다 · 저장은 위쪽 "한글 저장"', { ms: 3500 });
    } catch (e) {
      busy(null);
      console.error(e);
      toast(e.friendly ? e.message : `"${file.name}" 을(를) 열 수 없습니다: ${e?.message || e}`, { error: true, ms: 7000 });
    }
    return;
  }
  busy(`"${file.name}" 불러오는 중…`);
  try {
    const bytes = await file.arrayBuffer();
    const id = await importPdfBytes(bytes, file.name.replace(/\.pdf$/i, ''));
    busy(null);
    await openDoc(id);
  } catch (e) {
    busy(null);
    console.error(e);
    const msg = e?.name === 'PasswordException' ? '암호가 걸린 PDF는 아직 지원하지 않습니다'
      : e?.name === 'InvalidPDFException' ? '손상되었거나 올바르지 않은 PDF입니다'
      : store.describeError(e);
    toast('PDF를 열 수 없습니다: ' + msg, { error: true, ms: 6000 });
  }
}

$('#btnOpenPdf').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => { const fs = [...e.target.files]; e.target.value = ''; importFiles(fs); });

/** PDF 여러 개를 한 번에: 모두 가져와 탭으로 열어 두고 첫 파일을 보여 줌 */
async function importFiles(files) {
  files = files.filter(OPENABLE);
  if (files.length <= 1) { if (files[0]) importFile(files[0]); return; }
  const ids = [], failed = [];
  for (let i = 0; i < files.length; i++) {
    busy(`파일 불러오는 중… ${i + 1}/${files.length} "${files[i].name}"`);
    try { ids.push(await importOne(files[i])); }
    catch (e) { console.error(e); failed.push(e.friendly ? `${files[i].name} (${extOf(files[i])} 미지원)` : files[i].name); }
  }
  busy(null);
  for (const id of ids) { const m = await store.getDoc(id).catch(() => null); if (m) addTab(m); }
  if (failed.length) toast(`열지 못한 파일: ${failed.join(', ')}`, { error: true, ms: 6000 });
  if (ids.length) { await openDoc(ids[0]); toast(`파일 ${ids.length}개를 탭으로 열었습니다`, { ms: 2200 }); }
}
document.addEventListener('dragover', (e) => { if (state.screen === 'library') { e.preventDefault(); document.body.classList.add('drag-over'); } });
document.addEventListener('dragleave', () => document.body.classList.remove('drag-over'));
document.addEventListener('drop', (e) => {
  document.body.classList.remove('drag-over');
  if (state.screen !== 'library') return;
  e.preventDefault();
  importFiles([...(e.dataTransfer?.files || [])]);
});

// ───────────────────────────── 타이핑형 노트 ─────────────────────────────
// 편집기는 typing.js(+vendor/tiptap) — 타이핑형 노트를 처음 열 때만 읽는다.
// 본문(ProseMirror JSON)은 files 스토어에 자동 저장, 필기 주석은 PDF 노트처럼 쪽별로 pages 스토어에.
let typingMod = null;
let typing = null; // {engine, ed, meta, dirty, saving, error, timer, broken}

async function createTypingDoc(name, page) {
  const t = Date.now();
  const meta = { id: uid('d'), name, kind: 'typing', noteType: 'typing', page, pageCount: 1, created: t, updated: t, opened: t, thumb: null, view: null, folder: curFolder };
  const body = { type: 'doc', content: [{ type: 'paragraph' }] };
  await store.addDocWithFile(meta, new Blob([JSON.stringify(body)], { type: 'application/json' }));
  store.requestPersist();
  return meta.id;
}

async function openTypingDoc(meta) {
  typingMod ||= await import('./typing.js');
  const blob = await store.getFile(meta.id);
  let content = null;
  try { content = blob ? JSON.parse(await blob.text()) : null; } catch { content = null; }
  const broken = !!blob && !content;
  if (content) content = typingMod.migrateContent(content);
  const doc = new NoteDocument(meta);
  const { skipped } = await doc.load();
  state.doc = doc; state.pdf = null; state.blob = null;
  wireDoc(doc);
  initLayers(doc);
  $('#docTitle').textContent = meta.name;
  setSurfaceUi(meta);
  showScreen('editor');
  const engine = new typingMod.TypingEngine(meta.page);
  engine.count = Math.max(1, meta.pageCount || 1); // 처음부터 저장된 쪽 수로 (열 때 출렁이지 않게)
  viewer.openSurface(engine, doc, meta.view);
  typing = { engine, meta, dirty: false, saving: null, error: null, timer: 0, broken };
  typing.ed = typingMod.createEditor(engine.host, {
    content, page: meta.page,
    onPages: (n) => typingPages(n),
    onUpdate: () => typingChanged(),
    onSelection: (moved) => typingSelection(moved),
    onMathEdit: (node, pos, kind) => editMath(node, pos, kind),
  });
  if (settings.get('tool') !== 'type') selectTool('type');
  $('#fmtBar').hidden = false;
  thumbs.clear();
  placeAddPageButton();
  updateHistoryButtons();
  renderSaveState();
  updatePageIndicator();
  updateZoomLabel();
  renderFmtBar();
  updateGlassInset();
  store.kvSet('lastDoc', meta.id).catch(() => {});
  store.patchDoc(meta.id, { opened: Date.now() }).catch(() => {});
  if (broken) toast('문서 본문이 손상되어 읽지 못했습니다. 덮어쓰지 않도록 이 노트는 본문을 저장하지 않습니다', { error: true, ms: 8000 });
  if (skipped) toast(`손상된 필기 데이터 ${skipped}개를 건너뛰었습니다`, { error: true, ms: 5000 });
}

/** 노트를 닫을 때: 편집기 정리 */
function closeTyping() {
  if (!typing) return;
  clearTimeout(typing.timer);
  typing.ed.destroy();
  typing = null;
  $('#fmtBar').hidden = true;
  updateGlassInset();
}

// ───────────────────────────── 한글(HWP·HWPX) 문서 ─────────────────────────────
// 엔진은 hwp.js(+vendor/hwpjs). 고친 내용은 원래 형식의 파일 그대로 files 스토어에 자동 저장 (다시 열면 이어서).
// 내려받기: 고치지 않았으면 원본 파일 그대로, 고쳤으면 "이름 (FlexNote 편집).hwp(x)".
let hwp = null; // {session, meta, dirty, saving, error, timer}

async function openHwpDoc(meta) {
  const blob = await store.getFile(meta.id);
  const fresh = !blob && meta.source?.fresh ? meta.source.format : null; // 새로 만든 빈 한글 문서
  if (!blob && !fresh) throw new Error('한글 문서 파일이 저장소에 없습니다 (브라우저가 데이터를 삭제했을 수 있습니다)');
  const bytes = fresh || new Uint8Array(await blob.arrayBuffer());
  const doc = new NoteDocument(meta);
  await doc.load();
  state.doc = doc; state.pdf = null; state.blob = null;
  wireDoc(doc);
  initLayers(doc);
  $('#docTitle').textContent = meta.name;
  setSurfaceUi(meta);
  showScreen('editor');
  const host = $('#hwpHost');
  host.hidden = false;
  host.innerHTML = '<div class="hwp-root"></div>';
  host.appendChild($('#searchBar')); // 찾기 막대는 한글 화면 위에
  $('#hwpBar').hidden = false;
  fillHwpFonts();
  updateGlassInset();
  const { HwpSession } = await import('./hwp.js');
  const { HwpInk } = await import('./hwp-ink.js');
  const h = { session: null, ink: null, meta, dirty: false, saving: null, error: null, timer: 0 };
  hwp = h;
  try {
    h.session = await HwpSession.open(host.firstChild, bytes, {
      onChange: () => hwpChanged(h),
      onState: () => { if (hwp === h) renderHwpBarSoon(); },
      onShortcut: (cmd, check) => hwpShortcut(cmd, check),
      onError: (e) => console.error('[hwp]', e),
    });
  } catch (e) {
    hwp = null;
    $('#viewport').appendChild($('#searchBar'));
    host.hidden = true; host.innerHTML = '';
    $('#hwpBar').hidden = true;
    throw Object.assign(new Error(`한글 문서를 열 수 없습니다: ${e?.message || e} (암호가 걸렸거나 아직 지원하지 않는 구조일 수 있습니다)`), { friendly: true });
  }
  if (hwp !== h) { h.session.dispose(); return; } // 여는 사이 다른 문서로 바뀜
  h.ink = new HwpInk(host.firstChild, h.session, doc, { getPen: (mode) => settings.get(mode === 'hl' ? 'hl' : 'pen') });
  h.session.onScale = () => { updateZoomLabel(); h.ink?.redraw(); };
  if (meta.view?.hwpScale) h.session.setScale(meta.view.hwpScale);
  if (fresh) { h.dirty = true; await saveHwp(h); delete meta.source.fresh; store.patchDoc(meta.id, { source: meta.source }).catch(() => {}); }
  renderSaveState();
  updateHistoryButtons();
  updateZoomLabel();
  renderHwpBar();
  store.kvSet('lastDoc', meta.id).catch(() => {});
  store.patchDoc(meta.id, { opened: Date.now() }).catch(() => {});
}

/** 새 빈 한글 문서 노트 (엔진이 처음 열 때 만들고 바로 저장) */
async function createHwpDoc(name, format) {
  const t = Date.now(), ext = format === 'hwpx' ? 'hwpx' : 'hwp';
  const meta = { id: uid('d'), name, kind: 'hwp', noteType: 'typing', created: t, updated: t, opened: t, thumb: null, view: null, folder: curFolder,
    source: { format, name: `${name}.${ext}`, size: 0, imported: t, unchanged: false, fresh: true, created: true } };
  await store.addSurfaceDoc(meta);
  store.requestPersist();
  return meta.id;
}

function hwpChanged(h) {
  if (hwp !== h) return;
  h.dirty = true;
  const src = h.meta.source;
  if (src?.unchanged) { src.unchanged = false; store.patchDoc(h.meta.id, { source: src }).catch(() => {}); }
  renderSaveState();
  updateHistoryButtons();
  clearTimeout(h.timer);
  h.timer = setTimeout(() => saveHwp(h), 1200);
}

/** 지금 내용을 한글 파일로 만들어 저장소에. 실패하면 3초 뒤 다시 */
async function saveHwp(h = hwp, flush = false) {
  if (!h?.session) return true;
  while (h.saving) await h.saving.catch(() => {});
  if (!h.dirty) return !h.error;
  h.dirty = false;
  const job = (async () => {
    const { bytes, format } = await h.session.save({ flush });
    await store.putFile(h.meta.id, new Blob([bytes], { type: format === 'hwpx' ? 'application/hwp+zip' : 'application/x-hwp' }), {});
  })();
  h.saving = job;
  if (hwp === h) renderSaveState();
  try {
    await job;
    h.error = null;
    return true;
  } catch (e) {
    console.error('[hwp save]', e);
    h.error = e; h.dirty = true;
    clearTimeout(h.timer);
    h.timer = setTimeout(() => saveHwp(h), 3000);
    return false;
  } finally {
    h.saving = null;
    if (hwp === h) renderSaveState();
  }
}
async function flushHwp() {
  if (!hwp) return true;
  clearTimeout(hwp.timer);
  await hwp.session?.surface.flushComposition?.().catch(() => {}); // 닫기 전: 조합 중인 글자도 넣고 (바뀌면 dirty 가 됨)
  return saveHwp(hwp, true);
}

/** 닫을 때: 표지(보이는 첫 화면) 저장, 엔진 정리 */
async function closeHwp() {
  const h = hwp;
  if (!h) return;
  hwp = null;
  clearTimeout(h.timer);
  try {
    const cv = [...$('#hwpHost').querySelectorAll('canvas')].find((c) => c.width > 50 && c.height > 50);
    if (cv) {
      const c = document.createElement('canvas');
      c.width = 300; c.height = 400;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 300, 400);
      const s = 300 / Math.min(cv.width, cv.height * 0.75);
      ctx.drawImage(cv, (300 - cv.width * s) / 2, 0, cv.width * s, cv.height * s);
      const thumb = c.toDataURL('image/jpeg', 0.7);
      await store.patchDoc(h.meta.id, { thumb, view: { hwpScale: h.session?.scale || 1 } });
    }
  } catch { /* 표지는 없어도 됨 */ }
  h.ink?.dispose();
  await h.session?.dispose();
  $('#viewport').appendChild($('#searchBar'));
  $('#hwpHost').hidden = true;
  $('#hwpHost').innerHTML = '';
  $('#hwpBar').hidden = true;
  updateGlassInset();
}

/** 한글 파일 내려받기 */
async function saveHwpFile() {
  const h = hwp;
  if (!h?.session) return;
  const src = h.meta.source || {};
  const ext = (src.format || h.session.fileFormat) === 'hwpx' ? 'hwpx' : 'hwp';
  if (src.unchanged) {
    const b = src.blob && (await store.getBlob(src.blob).catch(() => null));
    if (b?.data) { downloadBlob(b.data, src.name || `${h.meta.name}.${ext}`); toast('고친 곳이 없어 원본 파일 그대로 저장했습니다', { ms: 2500 }); return; }
  }
  busy('한글 파일 만드는 중…');
  try {
    const { bytes } = await h.session.save();
    const base = (src.name || h.meta.name).replace(/\.hwpx?$/i, '');
    downloadBlob(new Blob([bytes], { type: ext === 'hwpx' ? 'application/hwp+zip' : 'application/x-hwp' }), `${base} (FlexNote 편집).${ext}`);
    toast(`${ext.toUpperCase()} 로 저장했습니다 · 원본 파일은 그대로 두었습니다 (줄 배치는 한글에서 열 때 다시 맞춰집니다)`, { ms: 4500 });
  } catch (e) {
    console.error(e);
    toast('한글 파일을 만들지 못했습니다: ' + (e?.message || e), { error: true, ms: 6000 });
  } finally { busy(null); }
}

// ── 한글 도구 모음 ──
const HWP_FONTS = ['함초롬바탕', '함초롬돋움', '맑은 고딕', '바탕', '돋움', '굴림', '궁서', '나눔고딕', '나눔명조', '휴먼명조', 'HY헤드라인M', 'Arial', 'Times New Roman'];
function fillHwpFonts() {
  const sel = $('#hbFont');
  if (sel.options.length) return;
  sel.innerHTML = '<option value="">글꼴</option>' + HWP_FONTS.map((f) => `<option>${escapeHtml(f)}</option>`).join('');
}
let hwpBarRaf = 0;
function renderHwpBarSoon() { if (!hwpBarRaf) hwpBarRaf = requestAnimationFrame(() => { hwpBarRaf = 0; renderHwpBar(); updateHistoryButtons(); }); }
/** 지금 선택·커서의 서식을 버튼에 (굵게 켜짐, 글꼴·크기, 정렬) */
function renderHwpBar() {
  if (!hwp?.session) return;
  const f = hwp.session.formatting();
  for (const k of ['bold', 'italic', 'underline', 'strike']) $(`#hwpBar [data-hb=${k}]`).classList.toggle('on', !!f[k]);
  for (const k of ['left', 'center', 'right', 'justify']) $(`#hwpBar [data-hb=${k}]`).classList.toggle('on', f.align === k);
  const size = $('#hbSize'), font = $('#hbFont');
  if (document.activeElement !== size) {
    const v = f.size ? String(Math.round(f.size * 10) / 10) : '';
    if (v && ![...size.options].some((o) => o.value === v || o.text === v)) size.add(new Option(v, v));
    size.value = v;
  }
  if (document.activeElement !== font) {
    if (f.font && ![...font.options].some((o) => o.text === f.font)) font.add(new Option(f.font, f.font));
    font.value = f.font || '';
  }
  for (const m of ['pen', 'hl', 'eraser']) $(`#hwpBar [data-hb=ink-${m}]`).classList.toggle('on', hwp.ink?.mode === m);
}

async function hwpFormat(kind, value) {
  if (!hwp?.session) return;
  const why = kind === 'align' ? await hwp.session.align(value) : await hwp.session.setFormat(kind, value);
  if (why) toast(why, { ms: 2500 });
  renderHwpBar();
  hwp?.session.focus();
}
async function hwpDo(promise, okMsg) {
  const why = await promise;
  if (why) toast(why, { ms: 3200 }); else if (okMsg) toast(okMsg, { ms: 1500 });
  hwp?.session.focus();
  return !why;
}
function hwpInkMode(mode) {
  if (!hwp?.ink) return;
  hwp.ink.setMode(hwp.ink.mode === mode ? null : mode);
  if (hwp.ink.mode) toast(hwp.ink.mode === 'eraser' ? '필기 지우개: 지울 획을 문지르세요 · 다시 누르면 글쓰기로' : '펜 필기: 손가락은 넘기기 · 다시 누르면 글쓰기로', { ms: 2500 });
  renderHwpBar();
  updateHistoryButtons();
}
async function hwpAction(a) {
  const s = hwp?.session;
  if (!s) return;
  if (a === 'undo') doUndo();
  else if (a === 'redo') doRedo();
  else if (a === 'bold' || a === 'italic' || a === 'underline' || a === 'strike') hwpFormat(a, !s.formatting()[a]);
  else if (['left', 'center', 'right', 'justify'].includes(a)) hwpFormat('align', a);
  else if (a === 'table') {
    const dlg = $('#hwpTableDlg');
    dlg.showModal();
    if (await dialogResult(dlg) !== 'ok') return;
    await hwpDo(s.insertTable(clamp(+$('#htRows').value || 3, 1, 200), clamp(+$('#htCols').value || 3, 1, 60)), '표를 넣었습니다');
  }
  else if (a === 'rowAfter') hwpDo(s.tableGrid('insert-row'));
  else if (a === 'colAfter') hwpDo(s.tableGrid('insert-column'));
  else if (a === 'rowDel') hwpDo(s.tableGrid('delete-row'));
  else if (a === 'colDel') hwpDo(s.tableGrid('delete-column'));
  else if (a === 'blockRight' || a === 'blockDown') { if (!(await s.extendCellBlock(a === 'blockRight' ? 'ArrowRight' : 'ArrowDown'))) toast('먼저 표의 칸을 누르세요', { ms: 1800 }); }
  else if (a === 'merge') hwpDo(s.mergeCells(), '셀을 합쳤습니다');
  else if (a === 'split') {
    const dlg = $('#hwpSplitDlg');
    dlg.showModal();
    if (await dialogResult(dlg) !== 'ok') return;
    await hwpDo(s.splitCell(clamp(+$('#hsRows').value || 1, 1, 50), clamp(+$('#hsCols').value || 2, 1, 50)), '셀을 나눴습니다');
  }
  else if (a === 'image') $('#hwpImageInput').click();
  else if (a === 'equation') hwpEquationDlg();
  else if (a === 'footnote' || a === 'endnote') {
    const kind = a === 'footnote' ? 'foot' : 'end';
    $('#hnTitle').textContent = kind === 'foot' ? '각주 넣기' : '미주 넣기';
    $('#hnBody').value = '';
    const dlg = $('#hwpNoteDlg');
    dlg.showModal();
    $('#hnBody').focus();
    if (await dialogResult(dlg) !== 'ok') { s.focus(); return; }
    await hwpDo(hwpWithReload(() => s.insertNote(kind, $('#hnBody').value)), kind === 'foot' ? '각주를 넣었습니다' : '미주를 넣었습니다');
  }
  else if (a === 'page') hwpPageSetup();
  else if (a === 'find') openSearch(true);
  else if (a === 'ink-pen') hwpInkMode('pen');
  else if (a === 'ink-hl') hwpInkMode('hl');
  else if (a === 'ink-eraser') hwpInkMode('eraser');
  else if (a === 'save') saveHwpFile();
  else if (a === 'pdf') exportHwpPdf();
  else if (a === 'print') printHwp();
  else if (a === 'info') showHwpInfo();
}
/**
 * 엔진이 방금 넣은 개체(주석 등) 근처에서 글 위치를 못 맞추면(TextMismatch) 계속 거절함 →
 * 묻고 나서 문서를 저장·다시 열어(커서 자리 유지) 한 번 더 (그 전 실행 취소 기록은 비워짐)
 */
async function hwpWithReload(fn) {
  const why = await fn();
  if (!why || !/Mismatch/.test(why)) return why;
  if (!confirm('엔진이 방금 넣은 개체 근처의 글 위치를 다시 맞춰야 합니다.\n문서를 한 번 저장해 다시 열고 계속할까요? (내용은 그대로, 그 전 실행 취소 기록은 사라집니다)')) return '취소했습니다';
  await hwp.session.reload();
  return fn();
}
/** 수식 창: 새 수식 넣기, 또는 (HWP5) 기존 수식 골라 고치기 */
async function hwpEquationDlg() {
  const s = hwp?.session;
  if (!s) return;
  const list = s.equations();
  const which = $('#heWhich');
  which.innerHTML = '<option value="new">새 수식 넣기 (커서 자리)</option>' + list.map((x, k) => `<option value="${k}">기존 수식 ${k + 1} 고치기</option>`).join('');
  $('#heWhichRow').hidden = !list.length;
  $('#heScript').value = '';
  let cap = null;
  which.onchange = async () => {
    s.releaseEquation(cap); cap = null;
    $('#heScript').value = '';
    if (which.value === 'new') return;
    try { cap = await s.readEquation(list[+which.value].row); $('#heScript').value = cap.script; }
    catch (e) { toast('이 수식은 고칠 수 없습니다: ' + (e?.message || e), { ms: 3000 }); which.value = 'new'; }
  };
  const dlg = $('#hwpEqDlg');
  dlg.showModal();
  $('#heScript').focus();
  const ok = await dialogResult(dlg) === 'ok';
  if (!ok) { s.releaseEquation(cap); s.focus(); return; }
  if (cap) await hwpDo(s.editEquation(cap, $('#heScript').value), '수식을 고쳤습니다');
  else await hwpDo(hwpWithReload(() => s.insertEquation($('#heScript').value)), '수식을 넣었습니다');
}
function dialogResult(dlg) { return new Promise((res) => dlg.addEventListener('close', () => res(dlg.returnValue), { once: true })); }

$('#hwpBar').addEventListener('pointerdown', (e) => { if (e.target.closest('button')) e.preventDefault(); }); // 누를 때 글 선택이 풀리지 않게
$('#hwpBar').addEventListener('click', (e) => { const b = e.target.closest('button[data-hb]'); if (b && hwp) hwpAction(b.dataset.hb); });
$('#hbSize').addEventListener('change', (e) => { const v = parseFloat(e.target.value); if (v) hwpFormat('size', v); });
$('#hbFont').addEventListener('change', (e) => { if (e.target.value) hwpFormat('font', e.target.value); });
$('#hbColor').addEventListener('change', (e) => hwpFormat('color', e.target.value));
$('#hwpImageInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || !hwp?.session) return;
  try {
    let bytes = new Uint8Array(await f.arrayBuffer());
    const bmp = await createImageBitmap(f);
    const w = bmp.width, hgt = bmp.height;
    if (!/png|jpe?g/i.test(f.type)) { // 다른 형식은 PNG 로
      const c = document.createElement('canvas'); c.width = w; c.height = hgt; c.getContext('2d').drawImage(bmp, 0, 0);
      bytes = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer());
    }
    bmp.close?.();
    await hwpDo(hwp.session.insertImageFresh(bytes, w, hgt), '그림을 넣었습니다');
  } catch (err) { toast('그림을 읽지 못했습니다: ' + (err?.message || err), { error: true }); }
});

/** 엔진 단축키 → 앱 동작. check=true 면 할 수 있는지만 */
function hwpShortcut(cmd, check) {
  const map = { bold: 'bold', italic: 'italic', underline: 'underline', 'align-left': 'left', 'align-center': 'center', 'align-right': 'right', 'align-justify': 'justify', 'insert-table': 'table', find: 'find', replace: 'find', save: 'save', undo: 'undo', redo: 'redo' };
  const special = { copy: 1, cut: 1, paste: 1, 'table-cell-block': 1, 'table-cell-block-extend': 1, 'block-selection': 1 };
  if (check) return !!(map[cmd] || special[cmd]);
  if (cmd === 'copy' || cmd === 'cut') { hwp?.session.copy(cmd === 'cut').then((why) => why && toast(why, { ms: 1800 })); return; }
  if (cmd === 'paste') { hwp?.session.surface.focusForPaste?.(); return; }
  if (cmd === 'table-cell-block' || cmd === 'table-cell-block-extend') { if (!hwp?.session.cellBlock(cmd.endsWith('extend'))) toast('표의 칸 안에서 F5 를 누르세요', { ms: 1800 }); return; } // F5: 칸 블록 (합치기용)
  if (cmd === 'block-selection') { hwp?.session.surface.requestBlockSelection?.(); return; }
  if (cmd === 'replace') { openSearch(true); return; }
  if (map[cmd]) hwpAction(map[cmd]);
}

async function hwpPageSetup() {
  const s = hwp?.session;
  if (!s) return;
  let r;
  try { r = await s.pageSettings(); } catch (e) { r = { error: e?.message || String(e) }; }
  if (r.error) { toast('쪽 설정을 읽지 못했습니다: ' + r.error, { error: true, ms: 4000 }); return; }
  const v = r.values, m = v.margin;
  $('#hpW').value = v.width; $('#hpH').value = v.height; $('#hpOrient').value = v.orientation || 'widely';
  $('#hpT').value = m.top ?? 20; $('#hpB').value = m.bottom ?? 15; $('#hpL').value = m.left ?? 30; $('#hpR').value = m.right ?? 30; $('#hpHd').value = m.header ?? 15; $('#hpFt').value = m.footer ?? 15;
  const key = `${v.width}x${v.height}`;
  $('#hpPaper').value = [...$('#hpPaper').options].some((o) => o.value === key) ? key : '';
  $('#hpScope').options[1].disabled = r.sections < 2;
  const dlg = $('#hwpPageDlg');
  dlg.showModal();
  if (await dialogResult(dlg) !== 'ok') return;
  const num = (id, d) => { const x = parseFloat($(id).value); return Number.isFinite(x) && x >= 0 ? x : d; };
  const values = { orientation: $('#hpOrient').value, gutter_type: v.gutter_type, width: num('#hpW', v.width), height: num('#hpH', v.height),
    margin: { ...m, top: num('#hpT', 20), bottom: num('#hpB', 15), left: num('#hpL', 30), right: num('#hpR', 30), header: num('#hpHd', 15), footer: num('#hpFt', 15), gutter: m.gutter ?? 0 } };
  s.reloaded = false;
  const ok = await hwpDo(s.setPageSettings(r.read, values, $('#hpScope').value, {
    confirmReload: async () => confirm('이번에 새로 넣은 표·그림이 있어, 쪽 설정을 바꾸려면 문서를 한 번 저장해 다시 열어야 합니다.\n그 전까지의 실행 취소 기록은 사라집니다 (내용은 그대로). 계속할까요?'),
  }), '쪽 설정을 바꿨습니다');
  if (ok && s.reloaded) toast('쪽 설정을 바꿨습니다 · 새로 넣은 표·그림을 정리하려고 문서를 다시 열어서, 그 전 실행 취소 기록은 비워졌습니다', { ms: 4500 });
  updateHistoryButtons();
}
$('#hpPaper').addEventListener('change', (e) => { const [w, hh] = e.target.value.split('x').map(Number); if (w) { const land = $('#hpOrient').value === 'narrowly'; $('#hpW').value = land ? hh : w; $('#hpH').value = land ? w : hh; } });

/** 쪽 그림(엔진 인쇄 이미지) + 필기 → 쪽마다 캔버스 */
async function hwpPageImages(scale = 2) {
  const s = hwp.session;
  const job = await s.printPages(scale);
  const pages = job.pages;
  const first = pages[0];
  const boxes = hwp.ink.pageBoxes(pages.length, first.widthCssPx, first.heightCssPx);
  const out = [];
  for (let k = 0; k < pages.length; k++) {
    const p = pages[k];
    const bmp = await createImageBitmap(p.png);
    const c = document.createElement('canvas');
    c.width = p.pixelWidth; c.height = p.pixelHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const box = boxes[k], items = hwp.ink.itemsOnPage(box);
    if (items.length) {
      const k2 = c.width / p.widthCssPx;
      ctx.setTransform(k2, 0, 0, k2, -box.x * k2, -box.y * k2);
      ctx.globalCompositeOperation = 'multiply';
      for (const it of items) if (isHighlighter(it)) drawItem(ctx, it, { print: true });
      ctx.globalCompositeOperation = 'source-over';
      for (const it of items) if (!isHighlighter(it)) drawItem(ctx, it, { print: true });
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    out.push({ canvas: c, wPt: p.widthCssPx * 0.75, hPt: p.heightCssPx * 0.75 });
  }
  return out;
}
async function exportHwpPdf() {
  if (!hwp?.session) return;
  busy('PDF 만드는 중…');
  try {
    const imgs = await hwpPageImages(2);
    const { PDFDocument } = await import('../vendor/pdf-lib/pdf-lib.esm.min.js');
    const pdf = await PDFDocument.create();
    for (const im of imgs) {
      const jpg = await new Promise((r) => im.canvas.toBlob(r, 'image/jpeg', 0.92));
      const emb = await pdf.embedJpg(new Uint8Array(await jpg.arrayBuffer()));
      const pg = pdf.addPage([im.wPt, im.hPt]);
      pg.drawImage(emb, { x: 0, y: 0, width: im.wPt, height: im.hPt });
    }
    const bytes = await pdf.save();
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), `${hwp.meta.name}.pdf`);
    toast(`PDF ${imgs.length}쪽을 내보냈습니다 (필기 포함)`, { ms: 2500 });
  } catch (e) {
    console.error(e);
    toast('PDF 를 만들지 못했습니다: ' + (e?.message || e), { error: true, ms: 5000 });
  } finally { busy(null); }
}
async function printHwp() {
  if (!hwp?.session) return;
  busy('인쇄 준비 중…');
  try {
    const imgs = await hwpPageImages(2);
    let root = $('#printRoot');
    if (!root) { root = document.createElement('div'); root.id = 'printRoot'; document.body.appendChild(root); }
    root.innerHTML = `<style>@page { size: ${imgs[0].wPt}pt ${imgs[0].hPt}pt; margin: 0 }</style>`;
    for (const im of imgs) {
      const pg = document.createElement('div');
      pg.className = 'print-page';
      pg.style.cssText = `width:${im.wPt}pt;height:${im.hPt}pt`;
      const img = document.createElement('img');
      img.src = im.canvas.toDataURL('image/png');
      img.style.cssText = 'width:100%;height:100%;display:block';
      pg.appendChild(img);
      root.appendChild(pg);
    }
    const done = () => { root.innerHTML = ''; window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    busy(null);
    await new Promise((r) => setTimeout(r, 50));
    window.print();
  } catch (e) {
    console.error(e);
    toast('인쇄를 준비하지 못했습니다: ' + (e?.message || e), { error: true, ms: 5000 });
  } finally { busy(null); }
}

function showHwpInfo() {
  const src = hwp?.meta.source || {};
  alert([
    src.created ? `FlexNote 에서 새로 만든 ${src.format === 'hwpx' ? 'HWPX' : 'HWP'} 문서` : `원본: ${src.name || '-'} (${src.format === 'hwpx' ? 'HWPX' : 'HWP'}, ${Math.round((src.size || 0) / 1024)}KB)`,
    src.created ? '' : src.unchanged ? '아직 고친 곳 없음 → 저장하면 원본 그대로' : '고친 내용이 있음 → "한글 저장"은 새 이름으로 내려받음 (원본은 보관)',
    '',
    '한글 형식 그대로 편집합니다 (다른 형식으로 바꾸지 않음).',
    '글자: 글꼴·크기·굵게·기울임·밑줄·취소선·글자색 (선택한 글자, 또는 커서에서 다음에 칠 글자)',
    '문단: 정렬 / 표: 넣기·행·열 추가·삭제·셀 합치기(HWPX)·나누기 / 그림 넣기(본문) / 쪽 설정 / 찾기·바꾸기 / 복사·붙여넣기',
    '펜·형광펜 필기는 노트에 따로 보관 (한글 파일은 그대로), PDF·인쇄에 함께 나옵니다.',
    '알아 둘 점: 줄 배치 정보(조판 캐시)는 한글이 열 때 다시 맞춥니다. 엔진이 지원하지 않는 개체·위치는 이유를 알려 줍니다.',
  ].filter((x, i) => x || i === 2).join('\n'));
}

const saveTypingPages = debounce(() => { if (typing) store.patchDoc(typing.meta.id, { pageCount: typing.meta.pageCount }).catch(() => {}); }, 1000);
function typingPages(n) {
  if (!typing) return;
  typing.engine.setCount(viewer, n);
  if (typing.meta.pageCount !== n) { typing.meta.pageCount = n; saveTypingPages(); }
  updatePageIndicator();
}

function typingChanged() {
  if (!typing) return;
  typing.dirty = true;
  if (!$('#searchBar').hidden && $('#searchInput').value) searchSoon(); // 찾기 중 글이 바뀌면 결과 다시 (보던 자리 유지)
  const src = typing.meta.source;
  if (src?.unchanged) { src.unchanged = false; store.patchDoc(typing.meta.id, { source: src }).catch(() => {}); }
  renderSaveState();
  clearTimeout(typing.timer);
  typing.timer = setTimeout(() => saveTyping(), 700);
}

/** 본문 저장. 실패하면 내용은 메모리에 두고 3초 뒤 다시 */
async function saveTyping() {
  const t = typing;
  if (!t || t.broken) return true;
  while (t.saving) await t.saving.catch(() => {});
  if (!t.dirty) return !t.error;
  t.dirty = false;
  const body = new Blob([JSON.stringify(t.ed.editor.getJSON())], { type: 'application/json' });
  t.saving = store.putFile(t.meta.id, body, { pageCount: t.meta.pageCount });
  renderSaveState();
  try {
    await t.saving;
    t.error = null;
    return true;
  } catch (e) {
    console.error('[typing save]', e);
    t.error = e;
    t.dirty = true;
    clearTimeout(t.timer);
    t.timer = setTimeout(() => saveTyping(), 3000);
    return false;
  } finally {
    t.saving = null;
    if (typing === t) renderSaveState();
  }
}
async function flushTyping() {
  if (!typing) return true;
  clearTimeout(typing.timer);
  return saveTyping();
}

/** 손가락 탭 → 그 자리에 커서 (글자 위 링크면 열기) */
function typingTap(sx, sy) {
  const ed = typing.ed.editor;
  const hit = ed.view.posAtCoords({ left: sx + viewer.rect.left, top: sy + viewer.rect.top });
  if (!hit) { ed.chain().focus('end', { scrollIntoView: false }).run(); return; }
  ed.chain().focus(undefined, { scrollIntoView: false }).setTextSelection(hit.pos).run();
  const link = ed.state.doc.resolve(hit.pos).marks().find((m) => m.type.name === 'link');
  if (link?.attrs.href) followTarget({ url: link.attrs.href });
}

let fmtRaf = 0, followCaret = false;
/** moved: 글이 바뀌었거나 커서가 움직임 → 커서를 화면 안으로. 그 밖(쪽 나눔 갱신 등)은 도구 모음만 */
function typingSelection(moved) {
  if (moved) followCaret = true;
  if (fmtRaf) return;
  fmtRaf = requestAnimationFrame(() => {
    fmtRaf = 0;
    renderFmtBar();
    updateHistoryButtons();
    if (followCaret) { followCaret = false; keepCaretVisible(); }
  });
}

/** 글을 쓰는 동안 커서가 화면 밖(또는 키보드·도구 모음 뒤)으로 가면 화면을 따라 옮긴다 (뷰포트는 스크롤되지 않으므로 직접) */
function keepCaretVisible() {
  const ed = typing?.ed.editor;
  if (!ed?.isFocused) return;
  let c;
  try { c = ed.view.coordsAtPos(ed.state.selection.head); } catch { return; }
  const vr = $('#viewport').getBoundingClientRect();
  const vv = window.visualViewport;
  const bottomLimit = Math.min(vr.bottom, vv ? vv.offsetTop + vv.height : vr.bottom) - 70; // 화면 키보드·아래 도구 모음 위로
  const topLimit = vr.top + viewer.insetTop + 24;
  let dy = 0, dx = 0;
  if (c.bottom > bottomLimit) dy = c.bottom - bottomLimit;
  else if (c.top < topLimit) dy = c.top - topLimit;
  if (c.left < vr.left + 16) dx = c.left - vr.left - 16;
  else if (c.right > vr.right - 16) dx = c.right - vr.right + 16;
  if (dx || dy) viewer.setCamera(viewer.cam.tx - dx, viewer.cam.ty - dy, viewer.cam.z);
}
window.visualViewport?.addEventListener('resize', () => { if (typing) keepCaretVisible(); });

// ── 흑백 반전(어두운 종이) ──
function applyPaper() {
  const dark = !!settings.get('paperDark');
  if (inkTheme.dark === dark && $('#editor').classList.contains('paper-dark') === dark) return;
  inkTheme.dark = dark;
  $('#editor').classList.toggle('paper-dark', dark);
  $('#btnPaper').classList.toggle('on', dark);
  viewer.requestInk(true);
}
$('#btnPaper').addEventListener('click', () => {
  settings.set('paperDark', !settings.get('paperDark'));
  toast(settings.get('paperDark') ? '흑백 반전: 검은 종이·흰 글씨 (다른 색은 그대로 · 인쇄·내보내기는 원래대로)' : '흰 종이로 보기', { ms: 2600 });
});
settings.on('change', ({ path }) => { if (path === 'paperDark' || path === '*') applyPaper(); });
applyPaper();

// ── 글자색 프리셋 + Ctrl+K (타이핑형·Word) ──
function renderColorPresets() {
  const box = $('#fbPresets'), cols = settings.get('typingColors'), act = settings.get('typingColorActive');
  box.innerHTML = '';
  cols.forEach((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.style.background = c;
    b.dataset.i = i;
    b.className = i === act ? 'active' : '';
    b.title = `${c}${i === act ? ' · Ctrl+K 색' : ''} — 누르면 칠하기, 길게 누르면 색 바꾸기`;
    box.appendChild(b);
  });
}
/** 프리셋 색 칠하기. toggle: 이미 그 색이면 색 지우기 (Ctrl+K 를 한 번 더) */
function applyPresetColor(i, toggle = false) {
  const ed = typing?.ed.editor;
  if (!ed) return;
  const c = settings.get('typingColors')[i];
  const cur = (ed.getAttributes('textStyle').color || '').toLowerCase();
  const chain = ed.chain().focus(undefined, { scrollIntoView: false });
  if (toggle && cur === c.toLowerCase()) chain.unsetColor().run(); else chain.setColor(c).run();
  $('#fbColor').value = c;
  $('#fbColor').parentNode.style.setProperty('--fbc', c);
}
function editPreset(i) {
  const inp = document.createElement('input');
  inp.type = 'color';
  inp.value = settings.get('typingColors')[i];
  inp.style.cssText = 'position:fixed;left:-100px;top:0;opacity:0';
  document.body.appendChild(inp);
  inp.addEventListener('change', () => {
    const cols = [...settings.get('typingColors')];
    cols[i] = inp.value;
    settings.set('typingColors', cols);
    settings.set('typingColorActive', i);
    renderColorPresets(); // 프리셋만 바꿈 (선택한 글은 그대로 — 칠하려면 누르거나 Ctrl+K)
    inp.remove();
  });
  inp.addEventListener('blur', () => setTimeout(() => inp.remove(), 300));
  inp.click();
}
{
  const box = $('#fbPresets');
  let hold = 0, held = false;
  box.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    e.preventDefault(); // 글 선택이 풀리지 않게
    held = false;
    clearTimeout(hold);
    hold = setTimeout(() => { held = true; editPreset(+b.dataset.i); }, 550);
  });
  box.addEventListener('pointerup', () => clearTimeout(hold));
  box.addEventListener('pointerleave', () => clearTimeout(hold));
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || held) return;
    settings.set('typingColorActive', +b.dataset.i);
    renderColorPresets();
    applyPresetColor(+b.dataset.i);
  });
  box.addEventListener('contextmenu', (e) => { const b = e.target.closest('button'); if (!b) return; e.preventDefault(); clearTimeout(hold); editPreset(+b.dataset.i); });
  renderColorPresets();
}
// Ctrl+K: 지금 프리셋 색으로 (다시 누르면 색 지우기). 편집기 안에서만 — 다른 곳의 K 는 링크 도구 그대로
document.addEventListener('keydown', (e) => {
  if (!typing || !(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 'k') return;
  if (!e.target.closest?.('.typing-doc')) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.shiftKey) { // Ctrl+Shift+K: 다음 프리셋으로 바꿔 칠하기
    settings.set('typingColorActive', (settings.get('typingColorActive') + 1) % 5);
    renderColorPresets();
  }
  applyPresetColor(settings.get('typingColorActive'), !e.shiftKey);
}, true);

// ── 서식 도구 모음 ──
(function buildFmtBar() {
  const fonts = FONTS.map(([v, n]) => `<option value="${escapeHtml(v)}">${escapeHtml(n)}</option>`).join('');
  $('#fbFont').innerHTML = '<option value="">글꼴</option>' + fonts;
  $('#fbSize').innerHTML = '<option value="">크기</option>' + [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72].map((n) => `<option value="${n}">${n}</option>`).join('');
  $('#nnTFont').innerHTML = fonts;
  $('#psFont').innerHTML = fonts;
})();

function renderFmtBar() {
  const ed = typing?.ed.editor;
  if (!ed) return;
  const bar = $('#fmtBar');
  const on = (k, v) => bar.querySelector(`[data-fb=${k}]`).classList.toggle('on', !!v);
  for (const m of ['bold', 'italic', 'underline', 'strike', 'superscript', 'subscript']) on(m, ed.isActive(m));
  for (const a of ['left', 'center', 'right', 'justify']) on(a, ed.isActive({ textAlign: a }));
  on('bullet', ed.isActive('bulletList'));
  on('ordered', ed.isActive('orderedList'));
  const para = ed.getAttributes(ed.isActive('heading') ? 'heading' : 'paragraph');
  on('hanging', para.hanging > 0);
  $('#fbStyle').value = ed.isActive('heading', { level: 1 }) ? 'h1' : ed.isActive('heading', { level: 2 }) ? 'h2' : ed.isActive('heading', { level: 3 }) ? 'h3' : 'p';
  const ts = ed.getAttributes('textStyle');
  $('#fbFont').value = FONTS.some(([v]) => v === ts.fontFamily) ? ts.fontFamily : '';
  const size = parseFloat(ts.fontSize);
  $('#fbSize').value = [...$('#fbSize').options].some((o) => +o.value === size) ? String(size) : '';
  $('#fbLine').value = para.lineHeight ? String(para.lineHeight) : '';
  $('#fbSpace').value = para.spaceAfter != null ? String(para.spaceAfter) : '';
  $('#fbTable').hidden = !ed.isActive('table');
  bar.querySelector('[data-fb=report]').hidden = !typing.meta.source;
}

// 버튼을 눌러도 편집기의 선택(커서)이 풀리지 않게
$('#fmtBar').addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
$('#fmtBar').addEventListener('click', (e) => {
  const a = e.target.closest('[data-fb]')?.dataset.fb;
  const ed = typing?.ed.editor;
  if (!a || !ed) return;
  if (settings.get('tool') !== 'type') selectTool('type');
  const c = () => ed.chain().focus(undefined, { scrollIntoView: false });
  const cmds = {
    bold: () => c().toggleBold().run(), italic: () => c().toggleItalic().run(), underline: () => c().toggleUnderline().run(),
    strike: () => c().toggleStrike().run(), superscript: () => c().toggleSuperscript().run(), subscript: () => c().toggleSubscript().run(),
    left: () => c().setTextAlign('left').run(), center: () => c().setTextAlign('center').run(), right: () => c().setTextAlign('right').run(), justify: () => c().setTextAlign('justify').run(),
    indent: () => c().indentMore().run(), outdent: () => c().indentLess().run(),
    hanging: () => { const p = ed.getAttributes(ed.isActive('heading') ? 'heading' : 'paragraph'); c().setParagraphFormat({ hanging: p.hanging > 0 ? 0 : 20 }).run(); },
    bullet: () => c().toggleBulletList().run(), ordered: () => c().toggleOrderedList().run(),
    table: () => c().insertTable({ rows: 3, cols: 3, withHeaderRow: false }).run(),
    image: () => $('#typingImageInput').click(),
    math: () => { const latex = prompt('수식 (LaTeX)  예: \\frac{a}{b}, x^2, \\sqrt{x}', ''); if (latex && latex.trim()) c().insertInlineMath({ latex: latex.trim() }).run(); },
    link: () => {
      const cur = ed.getAttributes('link').href || '';
      const url = prompt('링크 주소 (비우면 링크 해제)', cur || 'https://');
      if (url === null) return;
      const u = url.trim();
      if (!u || u === 'https://') { c().extendMarkRange('link').unsetLink().run(); return; }
      const href = /^[a-z][a-z0-9+.-]*:/i.test(u) ? u : 'https://' + u;
      if (!/^(https?:|mailto:|tel:)/i.test(href)) { toast('http(s), mailto, tel 주소만 쓸 수 있습니다', { error: true }); return; }
      if (ed.state.selection.empty && !ed.isActive('link')) c().insertContent({ type: 'text', text: u, marks: [{ type: 'link', attrs: { href } }] }).run();
      else c().extendMarkRange('link').setLink({ href }).run();
    },
    pagebreak: () => { if (!c().setPageBreak().run()) toast('표 안에서는 쪽을 나눌 수 없습니다. 표 아래 문단에서 나누세요'); },
    setup: () => openPageSetup(),
    saveDocx: () => saveTypingDocx(),
    report: () => showDocReport(false),
    rowAfter: () => c().addRowAfter().run(), colAfter: () => c().addColumnAfter().run(),
    rowDel: () => c().deleteRow().run(), colDel: () => c().deleteColumn().run(),
    merge: () => { if (!c().mergeCells().run()) toast('합칠 칸들을 끌어서 함께 선택하세요'); },
    split: () => { if (!c().splitCell().run()) toast('합쳐진 칸에서만 나눌 수 있습니다'); },
    tableDel: () => c().deleteTable().run(),
  };
  cmds[a]?.();
  renderFmtBar();
});
$('#fbStyle').addEventListener('change', (e) => {
  const ed = typing?.ed.editor; if (!ed) return;
  const v = e.target.value, c = ed.chain().focus(undefined, { scrollIntoView: false });
  if (v === 'p') c.setParagraph().run(); else c.setHeading({ level: +v.slice(1) }).run();
});
$('#fbFont').addEventListener('change', (e) => { const ed = typing?.ed.editor; if (ed && e.target.value) ed.chain().focus(undefined, { scrollIntoView: false }).setFontFamily(e.target.value).run(); });
$('#fbSize').addEventListener('change', (e) => { const ed = typing?.ed.editor; if (ed && e.target.value) ed.chain().focus(undefined, { scrollIntoView: false }).setFontSize(e.target.value + 'px').run(); });
$('#fbLine').addEventListener('change', (e) => { const ed = typing?.ed.editor; if (ed) ed.chain().focus(undefined, { scrollIntoView: false }).setParagraphFormat({ lineHeight: e.target.value ? +e.target.value : null }).run(); });
$('#fbSpace').addEventListener('change', (e) => { const ed = typing?.ed.editor; if (ed) ed.chain().focus(undefined, { scrollIntoView: false }).setParagraphFormat({ spaceAfter: e.target.value === '' ? null : +e.target.value }).run(); });
$('#fbColor').addEventListener('input', (e) => { const ed = typing?.ed.editor; e.target.parentNode.style.setProperty('--fbc', e.target.value); if (ed) ed.chain().focus(undefined, { scrollIntoView: false }).setColor(e.target.value).run(); });
$('#fbHl').addEventListener('input', (e) => { const ed = typing?.ed.editor; e.target.parentNode.style.setProperty('--fbc', e.target.value); if (ed) ed.chain().focus(undefined, { scrollIntoView: false }).setHighlight({ color: e.target.value }).run(); });
$('#typingImageInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  const ed = typing?.ed.editor;
  if (!f || !ed) return;
  try {
    const { src } = await typingMod.imageToDataUrl(f);
    ed.chain().focus(undefined, { scrollIntoView: false }).setImage({ src, alt: f.name }).run();
  } catch (err) { toast('그림을 넣을 수 없습니다: ' + (err?.message || err), { error: true }); }
});

/** 수식 누르면 고치기 (비우면 삭제) */
function editMath(node, pos, kind) {
  const ed = typing?.ed.editor;
  if (!ed) return;
  const latex = prompt('수식 고치기 (LaTeX, 비우면 삭제)', node.attrs.latex || '');
  if (latex === null) return;
  const c = ed.chain().focus(undefined, { scrollIntoView: false }).setNodeSelection(pos);
  if (!latex.trim()) (kind === 'block' ? c.deleteBlockMath() : c.deleteInlineMath()).run();
  else (kind === 'block' ? c.updateBlockMath({ latex }) : c.updateInlineMath({ latex })).run();
}

// ── 가져온 원본 · DOCX 저장 ──
/** 가져오기 결과: 옮기지 못한 요소 / 근사로 옮긴 요소 (fresh: 방금 가져옴 — 문제없으면 알림만) */
function showDocReport(fresh) {
  const src = typing?.meta.source;
  if (!src) return;
  const w = src.warnings || [], a = src.approx || [];
  if (fresh && !w.length && !a.length) { toast(`"${src.name}" 을(를) 열었습니다 · 옮기지 못한 요소 없음`, { ms: 3000 }); return; }
  $('#drTitle').textContent = fresh ? `"${src.name}" 을(를) 가져왔습니다` : '원본 파일 정보';
  $('#drSummary').textContent = `${src.format.toUpperCase()} · ${formatBytes(src.size || 0)} · ${src.unchanged ? '아직 고치지 않음 (저장하면 원본 그대로)' : '고친 내용 있음 (저장하면 새 파일)'}`;
  const fill = (ul, list) => { ul.innerHTML = list.map((x) => `<li>${escapeHtml(x)}</li>`).join(''); };
  fill($('#drWarn'), w);
  fill($('#drApprox'), a);
  $('#docReportDlg').showModal();
}
$('#docReportDlg').addEventListener('close', () => { if ($('#docReportDlg').returnValue === 'original') downloadSource(); });

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename.replace(/[\\/:*?"<>|]/g, '_');
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
async function downloadSource() {
  const src = typing?.meta.source;
  const rec = src && (await store.getBlob(src.blob).catch(() => null));
  if (!rec) { toast('보관된 원본 파일을 찾을 수 없습니다', { error: true }); return false; }
  downloadBlob(rec.data, src.name);
  return true;
}

/**
 * DOCX 로 저장: 가져온 뒤 고치지 않았으면 원본 파일 그대로. 고쳤거나 새로 만든 노트는 새로 만든 DOCX —
 * 원본에서 옮기지 못한 요소나 저장 중 근사한 것이 있으면 먼저 알리고, 가져온 문서는 원본과 다른 이름으로.
 */
async function saveTypingDocx() {
  if (!typing) return;
  const src = typing.meta.source;
  if (src?.format === 'docx' && src.unchanged) {
    if (await downloadSource()) toast('고친 내용이 없어 원본 Word 파일을 그대로 내려받았습니다', { ms: 3000 });
    return;
  }
  busy('DOCX 만드는 중…');
  try {
    await flushTyping();
    const { exportDocx } = await import('./docx.js');
    const { bytes, lost } = exportDocx(typing.ed.editor.getJSON(), typing.meta.page, { title: typing.meta.name });
    busy(null);
    const fromOriginal = src ? [...(src.warnings || [])] : [];
    const issues = [...fromOriginal.map((x) => '원본에서 옮기지 못함: ' + x), ...lost.map((x) => '저장 중 근사: ' + x)];
    if (issues.length && !confirm(`DOCX 로 저장합니다. 다음은 저장되지 않거나 바뀝니다:\n\n- ${issues.join('\n- ')}\n\n계속할까요?`)) return;
    const base = src ? src.name.replace(/\.[^.]+$/, '') + ' (FlexNote 편집)' : typing.meta.name;
    downloadBlob(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), base + '.docx');
    toast(src ? '새 이름으로 저장했습니다 (원본 파일은 바뀌지 않음)' : 'DOCX 로 저장했습니다', { ms: 3000 });
  } catch (e) {
    busy(null);
    console.error(e);
    toast('DOCX 저장 실패: ' + (e?.message || e), { error: true, ms: 6000 });
  }
}

// ── 쪽 설정 ──
function openPageSetup() {
  if (!typing) return;
  const p = pageGeom(typing.meta.page).page;
  $('#psSize').value = p.size; $('#psOrient').value = p.orient;
  $('#psMt').value = p.margin.t; $('#psMb').value = p.margin.b; $('#psMl').value = p.margin.l; $('#psMr').value = p.margin.r;
  $('#psHeader').value = p.header || ''; $('#psFooter').value = p.footer || ''; $('#psPageNum').value = p.pageNum || 'center';
  $('#psFont').value = p.font; $('#psFontSize').value = String(p.fontSize);
  $('#pageSetupDlg').showModal();
}
$('#pageSetupDlg').addEventListener('close', () => {
  if ($('#pageSetupDlg').returnValue !== 'ok' || !typing) return;
  const n = (id, d) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? clamp(v, 0, 80) : d; };
  const old = pageGeom(typing.meta.page).page;
  const page = {
    size: $('#psSize').value, orient: $('#psOrient').value,
    margin: { t: n('#psMt', old.margin.t), b: n('#psMb', old.margin.b), l: n('#psMl', old.margin.l), r: n('#psMr', old.margin.r) },
    header: $('#psHeader').value.trim(), footer: $('#psFooter').value.trim(), pageNum: $('#psPageNum').value,
    font: $('#psFont').value, fontSize: +$('#psFontSize').value || old.fontSize,
  };
  const g = pageGeom(page);
  if (g.contentW < 72 || g.contentH < 72) { toast('여백이 너무 넓어 글을 쓸 자리가 없습니다', { error: true }); return; }
  typing.meta.page = page;
  store.patchDoc(typing.meta.id, { page }).catch(() => {});
  typing.engine.setPage(page);
  typing.engine.layout(viewer);
  viewer.clampCamera(); viewer.applyCamera(); viewer.emit('sized');
  typing.ed.setPage(page);
  toast('쪽 설정을 바꿨습니다');
});

// ── 인쇄 · PDF ──
/** 쪽마다 한 장: 그 쪽 글(쪽 나눔 빈 칸 덕분에 쪽 경계에 걸친 것이 없음) + 머리글·바닥글 + 필기 */
function printTyping() {
  if (!typing) return;
  const { engine, ed } = typing, g = engine.g, n = engine.count;
  let root = $('#printRoot');
  if (!root) { root = document.createElement('div'); root.id = 'printRoot'; document.body.appendChild(root); }
  root.innerHTML = `<style>@page { size: ${g.W}pt ${g.H}pt; margin: 0 }</style>`;
  const host = engine.host;
  for (let k = 0; k < n; k++) {
    const pg = document.createElement('div');
    pg.className = 'print-page';
    pg.style.cssText = `width:${g.W}pt;height:${g.H}pt`;
    const inner = document.createElement('div');
    inner.style.cssText = `position:absolute;left:0;top:0;width:${g.W}px;height:${g.H}px;zoom:${96 / 72}`; // 월드 1 = 1pt
    inner.innerHTML = engine.decor(k, n);
    const clip = document.createElement('div');
    clip.className = 'print-clip typing-host';
    clip.style.cssText = `left:${g.ml}px;top:${g.mt}px;width:${g.contentW}px;height:${g.contentH}px;font-family:${host.style.fontFamily};font-size:${host.style.fontSize};pointer-events:none;position:absolute`;
    const body = ed.editor.view.dom.cloneNode(true);
    body.removeAttribute('contenteditable');
    // 편집 중에만 보이는 것 빼기: 그림 크기 손잡이, 선택 표시, 열 너비 손잡이
    body.querySelectorAll('[data-resize-handle], .column-resize-handle, .ProseMirror-gapcursor').forEach((el) => el.remove());
    body.querySelectorAll('.ProseMirror-selectednode, .selectedCell').forEach((el) => el.classList.remove('ProseMirror-selectednode', 'selectedCell'));
    body.style.cssText = `position:absolute;left:0;top:${-k * g.stride}px;width:100%`;
    clip.appendChild(body);
    inner.appendChild(clip);
    // 필기 (형광펜은 곱하기)
    const items = layerSorted(state.doc.items(k));
    const folded = foldHidden(items);
    const vis = items.filter((it) => !folded?.has(it.id));
    if (vis.length) {
      const cv = document.createElement('canvas');
      cv.className = 'print-ink';
      cv.width = Math.round(g.W * 3); cv.height = Math.round(g.H * 3);
      const ctx = cv.getContext('2d');
      ctx.setTransform(3, 0, 0, 3, 0, 0);
      ctx.globalCompositeOperation = 'multiply';
      for (const it of vis) if (isHighlighter(it)) drawItem(ctx, it, { print: true });
      ctx.globalCompositeOperation = 'source-over';
      for (const it of vis) if (!isHighlighter(it)) drawItem(ctx, it, { print: true });
      const img = document.createElement('img');
      img.className = 'print-ink';
      img.src = cv.toDataURL('image/png');
      inner.appendChild(img);
    }
    pg.appendChild(inner);
    root.appendChild(pg);
  }
  const done = () => { root.innerHTML = ''; window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  toast('인쇄 창에서 대상을 "PDF로 저장"으로 고르면 PDF 파일이 됩니다', { ms: 4000 });
  setTimeout(() => window.print(), 50);
}

// ───────────────────────────── 탭: 여러 노트를 열어 두고 오가기 ─────────────────────────────
// 탭 목록은 저장해 두어 다시 켜도 유지. 탭을 바꾸면 지금 노트는 저장하고 닫은 뒤 다른 노트를 연다
// (실행 취소 기록은 노트마다 따로라 탭을 바꾸면 이어지지 않음). 최근 PDF 몇 개는 읽은 결과를 기억해 바로 열림.
let tabs = []; // [{id, name}]
const pdfCache = new Map(); // id → {pdf, blob} (지금 안 보는 탭의 PDF)
const MAX_PDF_CACHE = 3; // 메모리 4GB 크롬북 고려

function saveTabs() { store.kvSet('tabs', tabs).catch(() => {}); }
function addTab(meta) {
  const t = tabs.find((x) => x.id === meta.id);
  if (t) t.name = meta.name; else tabs.push({ id: meta.id, name: meta.name });
  saveTabs();
}
function cachePdf(id, pdf, blob) {
  pdfCache.set(id, { pdf, blob });
  while (pdfCache.size > MAX_PDF_CACHE) {
    const [old, v] = pdfCache.entries().next().value;
    pdfCache.delete(old);
    v.pdf.destroy().catch(() => {});
  }
}
/** 탭 목록에서 빼기 (노트 삭제 등) */
function dropTab(id) {
  tabs = tabs.filter((t) => t.id !== id);
  const c = pdfCache.get(id);
  if (c) { pdfCache.delete(id); c.pdf.destroy().catch(() => {}); }
  saveTabs();
  renderTabs();
}
function renderTabs() {
  // 편집 화면: 탭 2개 이상일 때. 노트 목록 화면: 열어 둔 노트가 하나라도 있으면 (눌러서 바로 이어서)
  const bar = $('#tabBar'), lib = $('#libTabs');
  bar.hidden = state.screen !== 'editor' || tabs.length < 2;
  lib.hidden = state.screen !== 'library' || tabs.length < 1;
  fillTabs(bar, state.doc?.id, true);
  fillTabs(lib, null, false);
  updateGlassInset();
}
function fillTabs(bar, activeId, withAdd) {
  bar.innerHTML = '';
  if (bar.hidden) return;
  if (!withAdd) {
    const lbl = document.createElement('span');
    lbl.className = 'tab-label';
    lbl.textContent = '열어 둔 노트';
    bar.appendChild(lbl);
  }
  for (const t of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (activeId === t.id ? ' on' : '');
    el.dataset.id = t.id;
    el.title = t.name;
    el.innerHTML = `<span class="tab-name">${escapeHtml(t.name)}</span><button class="tab-x" title="탭 닫기">×</button>`;
    el.addEventListener('click', (e) => {
      if (e.target.closest('.tab-x')) { closeTab(t.id); return; }
      if (state.doc?.id !== t.id || state.screen !== 'editor') openDoc(t.id);
    });
    bar.appendChild(el);
  }
  if (withAdd) {
    const add = document.createElement('button');
    add.className = 'tab-add';
    add.title = '파일 열기: PDF · Word · 한글 (여러 개 고를 수 있음)';
    add.textContent = '+';
    add.addEventListener('click', () => $('#fileInput').click());
    bar.appendChild(add);
  }
  bar.querySelector('.tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
/** 탭 닫기: 지금 보는 탭이면 옆 탭으로 (마지막이면 홈으로) */
async function closeTab(id) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  if (state.doc?.id !== id) { dropTab(id); return; }
  const next = tabs[i + 1] || tabs[i - 1];
  if (next) {
    await openDoc(next.id);
    if (state.doc?.id === next.id) dropTab(id); // 저장 실패로 못 옮겼으면 탭도 그대로
  } else if (await closeDoc()) {
    dropTab(id);
    showScreen('library');
    renderLibrary();
  }
}

const KIND_LABEL = { canvas: '무한 캔버스', scroll: '무한 스크롤' };
/** 새 노트 종류에 따라 필요한 칸만: 페이지 수는 PDF 노트만, 크기(폭)는 PDF·스크롤만 */
/** 노트 유형은 필기형·타이핑형 두 가지. 필기형은 형태(페이지·무한 스크롤·무한 캔버스)와 속지, 타이핑형은 용지·방향·여백·글꼴 */
let nnType = 'handwriting';
function syncNewNoteForm() {
  const typed = nnType === 'typing';
  document.querySelectorAll('#nnType button').forEach((b) => b.classList.toggle('on', b.value === nnType));
  document.querySelectorAll('#newNoteDlg .nn-hw').forEach((r) => { r.hidden = typed; });
  document.querySelectorAll('#newNoteDlg .nn-ty').forEach((r) => { r.hidden = !typed; });
  const k = $('#nnKind').value;
  $('#nnPagesRow').hidden = typed || k !== 'pdf';
  $('#nnSizeRow').hidden = typed || k === 'canvas';
}
document.querySelectorAll('#nnType button').forEach((b) => b.addEventListener('click', () => { nnType = b.value; syncNewNoteForm(); }));
$('#nnKind').addEventListener('change', syncNewNoteForm);
$('#btnNewNote').addEventListener('click', () => { syncNewNoteForm(); $('#newNoteDlg').showModal(); });

/** 무한 캔버스·무한 스크롤 문서 만들기 (PDF 원본 없음) */
async function createSurfaceDoc(kind, name, bg, size) {
  const t = Date.now();
  const meta = { id: uid('d'), name, kind, bg, size, pageCount: 0, created: t, updated: t, opened: t, thumb: null, view: null, folder: curFolder };
  await store.addSurfaceDoc(meta);
  store.requestPersist();
  return meta.id;
}

$('#newNoteDlg').addEventListener('close', async () => {
  if ($('#newNoteDlg').returnValue !== 'ok') return;
  const name = $('#nnName').value.trim() || '새 노트';
  if (nnType === 'typing' && $('#nnTFormat').value !== 'flex') {
    try { await openDoc(await createHwpDoc(name, $('#nnTFormat').value)); }
    catch (e) { console.error(e); toast('노트를 만들 수 없습니다: ' + (e?.friendly ? e.message : store.describeError(e)), { error: true }); }
    return;
  }
  if (nnType === 'typing') {
    const page = { ...DEFAULT_PAGE, size: $('#nnTSize').value, orient: $('#nnTOrient').value, margin: { ...MARGINS[$('#nnTMargin').value] }, font: $('#nnTFont').value, fontSize: +$('#nnTFontSize').value || DEFAULT_PAGE.fontSize };
    try { await openDoc(await createTypingDoc(name, page)); }
    catch (e) { console.error(e); toast('노트를 만들 수 없습니다: ' + store.describeError(e), { error: true }); }
    return;
  }
  const kind = $('#nnKind').value;
  if (kind !== 'pdf') {
    try { await openDoc(await createSurfaceDoc(kind, name, $('#nnTemplate').value, $('#nnSize').value)); }
    catch (e) { console.error(e); toast('노트를 만들 수 없습니다: ' + store.describeError(e), { error: true }); }
    return;
  }
  const n = clamp(parseInt($('#nnPages').value, 10) || 20, 1, 500);
  busy('노트 만드는 중…');
  try {
    const { createBlankPdf } = await import('./export.js');
    const bytes = await createBlankPdf(n, $('#nnTemplate').value, $('#nnSize').value);
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const id = await importPdfBytes(buf, name, { template: $('#nnTemplate').value });
    busy(null);
    await openDoc(id);
  } catch (e) {
    busy(null);
    console.error(e);
    toast('노트를 만들 수 없습니다: ' + store.describeError(e), { error: true });
  }
});

// ───────────────────────────── 문서 열기 / 닫기 ─────────────────────────────

/**
 * 닫기 전에 필기가 모두 저장됐는지 확인. 저장에 실패하면 다시 시도 / 백업 내려받기 / 저장하지 않고 닫기 / 계속 편집 중에서 고른다.
 * 닫아도 되면 true (저장 성공, 또는 사용자가 버리기로 함)
 */
async function ensureSaved(doc) {
  for (;;) {
    const inkOk = await doc.flush().catch(() => false);
    if (inkOk && (await flushTyping()) && (await flushHwp())) return true;
    const dlg = $('#saveFailDlg');
    $('#sfReason').textContent = store.describeError(inkOk ? typing?.error || hwp?.error : doc.saveError);
    dlg.showModal();
    const choice = await new Promise((res) => dlg.addEventListener('close', () => res(dlg.returnValue), { once: true }));
    if (choice === 'backup') {
      if (hwp && inkOk) await saveHwpFile(); // 한글 문서: 지금 내용을 한글 파일로 내려받기
      else await exportBackup(doc).catch((e) => toast('백업 실패: ' + (e?.message || e), { error: true }));
      continue;
    }
    if (choice === 'discard') { if (confirm('저장하지 못한 필기는 사라집니다. 그래도 닫을까요?')) return true; continue; }
    if (choice === 'retry') continue;
    return false; // 계속 편집
  }
}

/** 문서 닫기. 저장하지 못해 닫지 않았으면 false (화면 그대로) */
async function closeDoc() {
  if (recorder.recording) await stopRecording(); // 녹음 중이면 먼저 저장
  commitTextEdit();
  if (state.doc && !(await ensureSaved(state.doc))) return false;
  closeSearch();
  stopPlayback(true);
  tools.cancel();
  tools.clearSelection();
  input.resetAll('close');
  closeQuickMenu(); closeToolPopup();
  $('#layerPanel').hidden = true;
  const doc = state.doc;
  if (doc) {
    saveView.flush();
    if (viewer.surface && viewer.surface.kind !== 'typing' && (doc.undoStack.length || !doc.meta.thumb)) await saveSurfaceThumb(doc).catch(() => {});
    await doc.close({ force: true }).catch(() => false); // 위에서 저장을 확인했거나 버리기로 한 경우
  }
  closeTyping();
  await closeHwp();
  viewer.close();
  thumbs.clear();
  $('#backChip').hidden = true;
  backAnchor = null;
  if (state.pdf) {
    if (doc && tabs.some((t) => t.id === doc.id)) cachePdf(doc.id, state.pdf, state.blob); // 탭으로 다시 올 때 바로 열리게
    else state.pdf.destroy().catch(() => {});
  }
  state.doc = null; state.pdf = null; state.blob = null;
  return true;
}

/** 무한 캔버스·무한 스크롤 문서 열기 */
async function openSurfaceDoc(meta) {
  const doc = new NoteDocument(meta);
  const { skipped } = await doc.load();
  state.doc = doc; state.pdf = null; state.blob = null;
  wireDoc(doc);
  initLayers(doc);
  $('#docTitle').textContent = meta.name;
  setSurfaceUi(meta);
  showScreen('editor');
  const engine = meta.kind === 'canvas' ? new CanvasEngine({ bg: meta.bg }) : new ScrollEngine({ size: meta.size, bg: meta.bg });
  viewer.openSurface(engine, doc, meta.view);
  thumbs.clear();
  placeAddPageButton();
  updateHistoryButtons();
  renderSaveState();
  updatePageIndicator();
  updateZoomLabel();
  store.kvSet('lastDoc', meta.id).catch(() => {});
  store.patchDoc(meta.id, { opened: Date.now() }).catch(() => {});
  if (skipped) toast(`손상된 필기 데이터 ${skipped}개를 건너뛰었습니다`, { error: true, ms: 5000 });
}

/** 문서 종류에 따라 위쪽 바: 페이지 패널·페이지 표시는 PDF 노트용, 배경 선택은 무한 캔버스·스크롤용 */
function setSurfaceUi(meta) {
  $('#editor').classList.toggle('hwp-mode', meta?.kind === 'hwp'); // 한글 문서: 필기 도구·PDF 전용 버튼 숨김
  const typed = meta?.kind === 'typing';
  document.querySelectorAll('[data-tool=type]').forEach((b) => { b.hidden = !typed; });
  if (!typed && settings.get('tool') === 'type') selectTool('pen');
  const surf = !!KIND_LABEL[meta?.kind] || typed || meta?.kind === 'hwp'; // 타이핑형도 페이지 패널·페이지 추가 없음 (쪽은 글을 따라 저절로)
  $('#btnThumbs').hidden = surf;
  if (surf && thumbs.open) { thumbs.show(false); $('#btnThumbs').classList.remove('on'); }
  $('#pageInd').hidden = meta?.kind === 'canvas';
  $('#btnAddPageTop').hidden = surf; // 무한 캔버스·스크롤은 페이지가 없음
  $('#surfBg').hidden = !KIND_LABEL[meta?.kind];
  if (KIND_LABEL[meta?.kind]) $('#surfBg').value = meta.bg || 'blank';
}

$('#surfBg').addEventListener('change', (e) => {
  const d = state.doc, eng = viewer.surface;
  if (!d || !eng) return;
  eng.bg = d.meta.bg = e.target.value;
  eng._tpl = null;
  store.patchDoc(d.id, { bg: d.meta.bg }).catch(() => {});
  viewer.requestInk();
});

/** 무한 캔버스·스크롤 문서의 라이브러리 표지: 스크롤은 첫 시트, 캔버스는 내용 전체 */
async function saveSurfaceThumb(doc) {
  const eng = viewer.surface;
  const items = layerSorted(doc.items(0));
  const folded = foldHidden(items);
  const vis = folded ? items.filter((it) => !folded.has(it.id)) : items;
  let box;
  if (eng.kind === 'scroll') box = { x: 0, y: 0, w: eng.W, h: eng.sheetH };
  else {
    if (!vis.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of vis) { const b = bbox(it); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
    const w = Math.max(x1 - x0, (y1 - y0) * 0.75) + 40, h = w / 0.75; // 표지 비율 3:4
    box = { x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - h / 2, w, h };
  }
  const c = document.createElement('canvas');
  c.width = 300; c.height = 400;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  const s = Math.min(c.width / box.w, c.height / box.h);
  ctx.setTransform(s, 0, 0, s, -box.x * s, -box.y * s);
  for (const it of vis) if (rectsIntersect(bbox(it), box)) drawItem(ctx, it, { print: true });
  const thumb = c.toDataURL('image/jpeg', 0.75);
  doc.meta.thumb = thumb;
  await store.patchDoc(doc.id, { thumb });
}

async function openDoc(id) {
  busy('문서 여는 중…');
  try {
    if (!(await closeDoc())) { busy(null); return; }
    const meta = await store.getDoc(id);
    if (!meta) throw new Error('문서를 찾을 수 없습니다');
    addTab(meta);
    if (meta.kind === 'typing') { await openTypingDoc(meta); renderTabs(); busy(null); return; }
    if (meta.kind === 'hwp') { await openHwpDoc(meta); renderTabs(); busy(null); return; }
    if (KIND_LABEL[meta.kind]) { await openSurfaceDoc(meta); renderTabs(); busy(null); return; }
    setSurfaceUi(meta);
    let blob, pdf;
    const cached = pdfCache.get(id);
    if (cached) { pdfCache.delete(id); ({ blob, pdf } = cached); } // 탭 전환: 이미 읽은 PDF
    else {
      blob = await store.getFile(id);
      if (!blob) throw new Error('PDF 원본이 저장소에 없습니다 (브라우저가 데이터를 삭제했을 수 있습니다)');
      if (!meta.galleryChecked) blob = (await importGalleryInk(meta, blob)) || blob; // 처음 열 때 한 번: 크롬북 갤러리 필기
      const bytes = await blob.arrayBuffer();
      pdf = await pdfjsLib.getDocument({ ...PDF_OPTS, data: bytes }).promise;
    }
    const doc = new NoteDocument(meta);
    const { skipped } = await doc.load();
    state.doc = doc; state.pdf = pdf; state.blob = blob;
    wireDoc(doc);
    initLayers(doc);
    $('#docTitle').textContent = meta.name;
    showScreen('editor');
    await viewer.open(pdf, doc, meta.view);
    thumbs.build();
    if (thumbs.open) thumbs.show(true);
    placeAddPageButton();
    updateHistoryButtons();
    renderSaveState();
    updatePageIndicator();
    updateZoomLabel();
    store.kvSet('lastDoc', id).catch(() => {});
    store.patchDoc(id, { opened: Date.now(), pageCount: pdf.numPages }).catch(() => {});
    renderTabs();
    if (skipped) toast(`손상된 필기 데이터 ${skipped}개를 건너뛰었습니다`, { error: true, ms: 5000 });
    busy(null);
  } catch (e) {
    busy(null);
    console.error(e);
    toast('문서를 열 수 없습니다: ' + store.describeError(e), { error: true, ms: 6000 });
    showScreen('library');
    renderLibrary();
  }
}

function wireDoc(doc) {
  doc.on('change', ({ page, appended }) => {
    viewer.relayout(); // 무한 스크롤: 내용에 맞춰 길이 조절
    if (!$('#searchBar').hidden) searchSoon(); // 직접 쓴 글이 바뀌면 결과도
    // 새 획 하나만 추가된 경우는 그 획만 덧그리고, 그 밖의 변경은 전체를 다시 그린다
    if (!(appended && viewer.appendItem(page, appended))) viewer.requestInk();
    thumbs.markInk(page);
  });
  doc.on('history', () => updateHistoryButtons());
  doc.on('save', () => renderSaveState());
}

$('#btnBack').addEventListener('click', async () => {
  if (!(await closeDoc())) return; // 저장 실패 → 편집 화면에 그대로
  await store.kvDel('lastDoc').catch(() => {});
  showScreen('library');
  renderLibrary();
});

// 보기 위치 저장
const saveView = debounce(() => {
  const doc = state.doc;
  if (!doc || !viewer.pages.length) return;
  const view = viewer.anchor();
  doc.meta.view = view;
  store.patchDoc(doc.id, { view }).catch(() => {});
}, 800);
function saveViewSoon() { if (state.doc) saveView(); }

// 백그라운드 전환·종료 시 즉시 저장
document.addEventListener('visibilitychange', () => { if (document.hidden && state.doc) { state.doc.flush(); saveView.flush(); } });
window.addEventListener('pagehide', () => { if (state.doc) { state.doc.flush(); saveView.flush(); } });
window.addEventListener('beforeunload', (e) => {
  const d = state.doc;
  if (d && (d.dirty.size || d.saveState === 'saving')) { d.flush(); e.preventDefault(); e.returnValue = ''; }
});

// ───────────────────────────── 저장 상태 ─────────────────────────────

function renderSaveState() {
  const el = $('#saveState');
  const d = state.doc;
  let s = d ? d.saveState : 'saved';
  let err = d?.saveError;
  // 타이핑형: 문서 본문 저장 상태도 합침 (실패 > 저장 중 > 변경됨)
  if (typing && s !== 'error') {
    if (typing.error) { s = 'error'; err = typing.error; }
    else if (typing.saving) s = 'saving';
    else if (typing.dirty && s === 'saved') s = 'pending';
  }
  if (hwp && s !== 'error') {
    if (hwp.error) { s = 'error'; err = hwp.error; }
    else if (hwp.saving) s = 'saving';
    else if (hwp.dirty && s === 'saved') s = 'pending';
  }
  el.dataset.state = s;
  const label = { saved: '저장됨', pending: '변경됨', saving: '저장 중…', error: '저장 실패 · 다시 시도' }[s];
  el.querySelector('span').textContent = label;
  el.title = s === 'error' ? store.describeError(err) : '자동 저장';
  if (s === 'error' && !renderSaveState.warned) {
    renderSaveState.warned = true;
    toast('저장 실패: ' + store.describeError(err) + ' — 자동으로 다시 시도합니다', { error: true, ms: 6000 });
  }
  if (s === 'saved') renderSaveState.warned = false;
}
$('#saveState').addEventListener('click', () => { state.doc?.flush(); flushTyping(); flushHwp(); });

// ───────────────────────────── 상단 바 ─────────────────────────────

function updateZoomLabel() {
  if (hwp) { $('#zoomVal').textContent = Math.round((hwp.session?.scale || 1) * 100) + '%'; return; }
  $('#zoomVal').textContent = Math.round(viewer.relZoom() * 100) + '%';
}
let zoomBadgeTimer = 0;
function showZoomBadge() {
  const b = $('#zoomBadge');
  b.textContent = Math.round(viewer.relZoom() * 100) + '%';
  b.hidden = false;
  clearTimeout(zoomBadgeTimer);
  zoomBadgeTimer = setTimeout(() => { b.hidden = true; }, 700);
}
function updatePageIndicator() {
  if (!viewer.pages.length) return;
  if (viewer.surface && viewer.surface.kind !== 'typing') { // 타이핑형은 실제 쪽이 있어 아래 일반 처리
    // 무한 스크롤: 인쇄 페이지(시트) 기준
    if (viewer.surface.kind === 'scroll') $('#pageInd').textContent = `${viewer.surface.currentSheet(viewer) + 1} / ${Math.max(viewer.surface.sheetCount(viewer), viewer.surface.currentSheet(viewer) + 1)}`;
    return;
  }
  const cur = viewer.currentPage();
  $('#pageInd').textContent = `${cur + 1} / ${viewer.pages.length}`;
  thumbs.setCurrent(cur, false);
}
$('#btnZoomIn').addEventListener('click', () => { if (hwp) { hwp.session?.zoomStep(1); updateZoomLabel(); return; } viewer.zoomBy(1.25); showZoomBadge(); });
$('#btnZoomOut').addEventListener('click', () => { if (hwp) { hwp.session?.zoomStep(-1); updateZoomLabel(); return; } viewer.zoomBy(0.8); showZoomBadge(); });
$('#zoomVal').addEventListener('click', () => {
  if (hwp) { hwp.session?.setScale(1); updateZoomLabel(); return; }
  if (Math.abs(viewer.relZoom() - 1) < 0.02) viewer.fitPage(); else viewer.fitWidth();
  showZoomBadge();
});
$('#btnThumbs').addEventListener('click', () => {
  thumbs.show(!thumbs.open);
  $('#btnThumbs').classList.toggle('on', thumbs.open);
  requestAnimationFrame(() => viewer.resize());
});
$('#pageInd').addEventListener('click', () => {
  if (viewer.surface?.kind === 'scroll') {
    const eng = viewer.surface, n = Math.round(viewer.pages[0].h / eng.sheetH); // 종이 전체 (빈 시트 포함)
    const v = parseInt(prompt(`이동할 페이지 (1~${n})`, String(eng.currentSheet(viewer) + 1)) || '', 10);
    if (v >= 1) eng.goToSheet(viewer, Math.min(v, n) - 1);
    return;
  }
  if (!thumbs.open) { thumbs.show(true); $('#btnThumbs').classList.add('on'); requestAnimationFrame(() => viewer.resize()); }
  $('#gotoPage').focus();
});
$('#gotoPage').addEventListener('change', (e) => {
  const n = parseInt(e.target.value, 10);
  if (n >= 1) { viewer.goToPage(n - 1); thumbs.setCurrent(n - 1, true); }
  e.target.value = '';
});
$('#btnExport').addEventListener('click', () => (hwp ? exportHwpPdf() : exportPdf()));
$('#btnSettings').addEventListener('click', () => openSettings());
$('#btnLibSettings').addEventListener('click', () => openSettings());
$('#btnDebug').addEventListener('click', () => { dbg.enable(!dbg.on); });

/** 무한 스크롤 → 시트(인쇄 페이지)마다 한 장, 무한 캔버스 → 내용 전체를 담은 한 장 */
async function surfacePdfBytes(doc) {
  const eng = viewer.surface;
  const items = doc.items(0);
  const { exportSurfacePdf } = await import('./export.js');
  const opts = { getBlob: (id) => store.getBlob(id), gallery: !!settings.get('exportGallery') };
  const progress = (i, n) => busy(`PDF 만드는 중… ${i}/${n}`);
  if (eng.kind === 'scroll') {
    const n = eng.sheetCount(viewer);
    const sheets = Array.from({ length: n }, (_, i) => ({ w: eng.W, h: eng.sheetH, template: eng.bg, ox: 0, oy: i * eng.sheetH }));
    const band = (i) => ({ x: -1e6, y: i * eng.sheetH, w: 2e6, h: eng.sheetH });
    return exportSurfacePdf(sheets, (i) => items.filter((it) => rectsIntersect(bbox(it), band(i))), progress, opts);
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of items) { const b = bbox(it); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
  if (!items.length) { x0 = y0 = 0; x1 = 595.28; y1 = 841.89; }
  const pad = 36, w = x1 - x0 + pad * 2, h = y1 - y0 + pad * 2;
  const s = Math.min(1, 14400 / w, 14400 / h); // PDF 페이지 최대 크기(200인치)를 넘으면 줄여서
  return exportSurfacePdf([{ w: w * s, h: h * s, ox: x0 - pad, oy: y0 - pad, s }], () => items, progress, opts);
}

async function exportPdf() {
  const doc = state.doc;
  if (!doc) return;
  commitTextEdit();
  await doc.flush();
  if (typing) { busy(null); printTyping(); return; } // 타이핑형: 인쇄 창(미리 보기 → PDF로 저장)
  busy('PDF 만드는 중…');
  try {
    if (viewer.surface) {
      downloadPdf(await surfacePdfBytes(doc), doc.meta.name);
      toast('필기를 PDF로 내보냈습니다');
      return;
    }
    // 모든 페이지 변환 행렬이 필요하므로 아직 안 읽은 페이지는 읽는다
    for (const p of viewer.pages) {
      if (!p.vt && doc.items(p.index).length) p.vt = (await state.pdf.getPage(p.index + 1)).getViewport({ scale: 1 }).transform;
    }
    const { exportAnnotatedPdf } = await import('./export.js');
    const bytes = await exportAnnotatedPdf(await state.blob.arrayBuffer(), viewer.pages.map((p) => p.vt), (i) => doc.items(i),
      (i, n) => busy(`PDF 만드는 중… ${i}/${n}`), { getBlob: (id) => store.getBlob(id), gallery: !!settings.get('exportGallery') });
    downloadPdf(bytes, doc.meta.name);
    toast(settings.get('exportGallery') ? '필기가 포함된 PDF를 내보냈습니다 (크롬북 갤러리 호환)' : '필기가 포함된 PDF를 내보냈습니다');
  } catch (e) {
    console.error(e);
    toast('내보내기 실패: ' + (e?.message || e), { error: true, ms: 6000 });
  } finally { busy(null); }
}

function downloadPdf(bytes, name) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name}_필기.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ───────────────────────────── 페이지 추가 / 삭제 ─────────────────────────────
// PDF 자체를 고친 뒤(pdf-lib) 필기의 페이지 번호를 옮기고, PDF·필기·메타를 한 트랜잭션으로 저장한다.

async function restructure(label, editPdf, map, focusPage) {
  const doc = state.doc;
  if (!doc) return;
  commitTextEdit();
  tools.cancel();
  tools.clearSelection();
  busy(label);
  try {
    if (!(await doc.flush())) throw new Error('저장되지 않은 필기가 있어 진행할 수 없습니다');
    const ex = await import('./export.js');
    const bytes = await editPdf(ex, await state.blob.arrayBuffer());
    const newPdf = await pdfjsLib.getDocument({ ...PDF_OPTS, data: bytes.slice() }).promise;
    const blob = new Blob([bytes], { type: 'application/pdf' });
    // 저장이 성공한 뒤에만 메모리 상태를 바꾼다 (실패하면 원래 상태 그대로)
    const backup = { pages: doc.pages, rev: doc.rev, undo: doc.undoStack, redo: doc.redoStack };
    doc.remapPages(map);
    try {
      await store.replaceDocStructure(doc.id, blob, doc.allRecords(), { pageCount: newPdf.numPages, size: bytes.byteLength });
    } catch (err) {
      Object.assign(doc, { pages: backup.pages, rev: backup.rev, undoStack: backup.undo, redoStack: backup.redo });
      await newPdf.destroy();
      throw err;
    }
    doc.markAllSaved();
    doc.meta.pageCount = newPdf.numPages;
    const old = state.pdf;
    state.pdf = newPdf;
    state.blob = blob;
    const view = { page: Math.min(focusPage, newPdf.numPages - 1), fx: 0.5, fy: -0.02, zr: viewer.relZoom() };
    await viewer.open(newPdf, doc, view);
    old?.destroy().catch(() => {});
    thumbs.build();
    if (thumbs.open) thumbs.show(true);
    placeAddPageButton();
    updateHistoryButtons();
    updatePageIndicator();
    return true;
  } catch (e) {
    console.error(e);
    toast('페이지를 바꾸지 못했습니다: ' + store.describeError(e), { error: true, ms: 6000 });
    return false;
  } finally { busy(null); }
}

async function addPages(where, template, count = 1) {
  const cur = viewer.currentPage();
  const ref = viewer.pages[cur] || viewer.pages[0];
  const at = where === 'before' ? cur : where === 'end' ? viewer.pages.length : cur + 1;
  const ok = await restructure(`페이지 ${count}장 추가 중…`, async (ex, bytes) => {
    let b = bytes;
    for (let i = 0; i < count; i++) b = await ex.insertBlankPage(b, at, { template, width: ref.w, height: ref.h });
    return b;
  }, (i) => (i >= at ? i + count : i), at);
  if (ok) toast(`${at + 1}쪽에 페이지 ${count}장을 추가했습니다`);
}

async function deleteCurrentPage() {
  const cur = viewer.currentPage();
  if (viewer.pages.length <= 1) { toast('마지막 한 페이지는 삭제할 수 없습니다'); return; }
  const n = state.doc.items(cur).length;
  if (!confirm(`${cur + 1}쪽을 삭제할까요?${n ? `\n이 페이지의 필기 ${n}개도 함께 삭제됩니다.` : ''}\n페이지 삭제는 실행 취소할 수 없습니다.`)) return;
  const ok = await restructure('페이지 삭제 중…', (ex, bytes) => ex.removePage(bytes, cur),
    (i) => (i === cur ? -1 : i > cur ? i - 1 : i), Math.max(0, cur - (cur === viewer.pages.length - 1 ? 1 : 0)));
  if (ok) toast(`${cur + 1}쪽을 삭제했습니다`);
}

function openAddPageDlg() {
  if (!state.doc || viewer.surface) return;
  $('#apTemplate').value = state.doc?.meta.template || 'blank';
  syncAddPageForm();
  $('#addPageDlg').showModal();
}
/** 빈 페이지면 속지·개수, PDF 면 안내만 */
function syncAddPageForm() {
  const pdf = $('#apSource').value === 'pdf';
  $('#apTemplateRow').hidden = pdf;
  $('#apCountRow').hidden = pdf;
  $('#apPdfHint').hidden = !pdf;
  $('#apOk').textContent = pdf ? 'PDF 고르기…' : '추가';
}
$('#apSource').addEventListener('change', syncAddPageForm);
$('#btnAddPage').addEventListener('click', openAddPageDlg);
$('#btnAddPageTop').addEventListener('click', openAddPageDlg);
let insertWhere = 'after';
$('#addPageDlg').addEventListener('close', () => {
  if ($('#addPageDlg').returnValue !== 'ok') return;
  if ($('#apSource').value === 'pdf') { insertWhere = $('#apWhere').value; $('#insertPdfInput').click(); return; }
  addPages($('#apWhere').value, $('#apTemplate').value, clamp(parseInt($('#apCount').value, 10) || 1, 1, 50));
});
$('#insertPdfInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) insertPdfFile(insertWhere, f); });

/** 다른 PDF 의 모든 페이지를 지금 노트에 끼워 넣기 (기존 필기는 자기 페이지를 따라 번호가 옮겨짐, 한 번에 저장) */
async function insertPdfFile(where, file) {
  const cur = viewer.currentPage();
  const at = where === 'before' ? cur : where === 'end' ? viewer.pages.length : cur + 1;
  let srcBytes, n;
  try {
    srcBytes = await file.arrayBuffer();
    const src = await pdfjsLib.getDocument({ ...PDF_OPTS, data: srcBytes.slice(0) }).promise; // 먼저 열어 보고 쪽수 확인
    n = src.numPages;
    await src.destroy();
  } catch (e) {
    toast(e?.name === 'PasswordException' ? '암호가 걸린 PDF는 끼워 넣을 수 없습니다' : `PDF를 열 수 없습니다: ${e?.message || e}`, { error: true, ms: 5000 });
    return;
  }
  const ok = await restructure(`"${file.name}" ${n}쪽 끼워 넣는 중…`, (ex, bytes) => ex.insertPdfPages(bytes, at, srcBytes), (i) => (i >= at ? i + n : i), at);
  if (ok) toast(`${at + 1}쪽부터 "${file.name}" ${n}쪽을 넣었습니다`);
}
$('#btnDelPage').addEventListener('click', deleteCurrentPage);

// 마지막 페이지 아래 "페이지 추가" 버튼 (월드 좌표에 붙어 함께 움직인다)
const addEndBtn = document.createElement('button');
addEndBtn.className = 'add-page-end';
addEndBtn.dataset.ui = '';
addEndBtn.innerHTML = '<svg><use href="#i-plus"/></svg><span>페이지 추가</span>';
addEndBtn.addEventListener('click', () => addPages('end', state.doc?.meta.template || 'blank', 1));
function placeAddPageButton() {
  const last = viewer.pages[viewer.pages.length - 1];
  if (!last || viewer.surface) { addEndBtn.remove(); return; } // 무한 캔버스·스크롤은 페이지 추가 없음
  if (addEndBtn.parentNode !== $('#world')) $('#world').appendChild(addEndBtn);
  // 화면에서 약 44px 높이가 되도록 월드 단위로 크기를 잡되, 버튼 글자는 transform 으로 보정
  Object.assign(addEndBtn.style, { left: last.x + 'px', top: last.y + last.h + 16 + 'px', width: last.w + 'px', height: '40px' });
}
viewer.on('sized', placeAddPageButton);

// ───────────────────────────── 그림 · 포스트잇 ─────────────────────────────

// 그림은 blobs 스토어에서 읽어 ImageBitmap 으로 캐시 (ink.js 가 그릴 때 요청)
imageHooks.load = async (id) => {
  const rec = await store.getBlob(id);
  return rec ? createImageBitmap(rec.data) : null;
};
imageHooks.ready = (id) => {
  viewer.requestInk();
  const d = state.doc;
  if (d) for (const [p, items] of d.pages) if (items.some((i) => i.t === 'im' && i.blob === id)) thumbs.markInk(p);
};

function blobToDataUrl(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
}

const MAX_IMAGE_SIDE = 2400; // 저장 공간을 아끼기 위해 긴 변을 이 크기로 줄인다

/** 그림 파일 → (필요하면 축소·재압축) → 저장 → 현재 화면 가운데에 배치 */
async function insertImageFile(file, at, into) {
  const doc = state.doc;
  if (!doc || !file || !/^image\//.test(file.type)) return;
  const tn = into !== undefined ? into : targetNote(at ? viewer.pageAtScreen(at.x, at.y) : null);
  busy('그림 넣는 중…');
  try {
    let bmp = await createImageBitmap(file);
    let blob = file, w = bmp.width, h = bmp.height;
    const big = Math.max(w, h) > MAX_IMAGE_SIDE;
    const odd = !/^image\/(png|jpeg)$/.test(file.type); // PDF 내보내기는 PNG/JPEG 만 직접 넣을 수 있음
    if (big || odd) {
      const k = Math.min(1, MAX_IMAGE_SIDE / Math.max(w, h));
      w = Math.round(w * k); h = Math.round(h * k);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(bmp, 0, 0, w, h);
      const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
      blob = await new Promise((r) => c.toBlob(r, type, 0.9));
      bmp.close?.();
      bmp = await createImageBitmap(blob);
    }
    const id = uid('img');
    await store.putBlob({ id, docId: doc.id, data: blob, w, h });
    putImage(id, bmp);
    // 놓을 위치: 지정 위치(붙여넣기/끌어놓기) 또는 화면 가운데의 페이지
    if (tn) {
      const item = addIntoNote(tn, (r) => { const k = Math.min(1, r.w / w); return { id: uid('im'), t: 'im', x: r.x, y: r.y + objBarH({}), w: w * k, h: h * k, blob: id }; });
      if (item) selectAfterInsert(tn.page, item.id);
      toast('포스트잇 안에 그림을 넣었습니다', { ms: 2000 });
      return;
    }
    const hit = (at && viewer.pageAtScreen(at.x, at.y)) || viewer.pageAtScreen(viewer.vw / 2, viewer.vh / 2) || { page: viewer.currentPage(), x: 50, y: 50 };
    const p = viewer.pages[hit.page];
    const s = Math.min((p.w * 0.6) / w, (p.h * 0.5) / h, 1); // 페이지 폭 60%·높이 50% 안, 원본보다 키우지 않음
    const iw = w * s, ih = h * s;
    const bh = objBarH({}); // 위쪽 손잡이 띠가 페이지 밖으로 나가지 않게
    const x = clamp(hit.x - iw / 2, 0, Math.max(0, p.w - iw)), y = clamp(hit.y - ih / 2, bh, Math.max(bh, p.h - ih));
    const item = { id: uid('im'), t: 'im', x, y, w: iw, h: ih, blob: id };
    doc.add(hit.page, item);
    selectAfterInsert(hit.page, item.id);
    toast('그림을 넣었습니다 · 끌어서 옮기고 오른쪽 아래 점으로 크기 조절', { ms: 2500 });
  } catch (e) {
    console.error(e);
    toast('그림을 넣을 수 없습니다: ' + store.describeError(e), { error: true });
  } finally { busy(null); }
}

/** 넣은 개체를 올가미 선택 상태로 → 바로 옮기기·크기 조절 */
function selectAfterInsert(page, id) {
  selectTool('lasso');
  tools.setSelection({ page, ids: new Set([id]) });
}

// 포스트잇 접기/펼치기 (실행 취소 가능). 접으면 작은 아이콘이 되고 위에 쓴 필기도 함께 숨는다
function setNotesFold(page, ids, fold) {
  const d = state.doc;
  if (!d) return;
  d.setItems(page, d.items(page).map((i) => (i.t === 'nt' && ids.has(i.id) ? (fold ? { ...i, fold: true } : (({ fold: _f, ...rest }) => rest)(i)) : i)));
}

const inside = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/**
 * 탭 한 번으로 바뀌는 개체: 접힌 포스트잇 아이콘(펼침), 포스트잇 접기 버튼(접음), 체크리스트 상자(완료 표시).
 * 해당하면 처리하고 true (펜 탭은 점을 찍지 않고, 손가락 탭은 링크보다 먼저)
 */
function tapObjectAt(page, x, y) {
  const d = state.doc;
  const items = d?.items(page) || [];
  const folded = foldHidden(items);
  for (let i = items.length - 1; i >= 0; i--) {
    const n = items[i];
    if (!layerUsable(n) || folded?.has(n.id)) continue; // 숨기거나 잠근 레이어, 접힌 포스트잇 안
    if (n.t === 'tb' && (inside(tableAddRowBtn(n), x, y) || inside(tableAddColBtn(n), x, y))) {
      tableEdit(page, n.id, inside(tableAddRowBtn(n), x, y) ? 'tb-addRow' : 'tb-addCol');
      return true;
    }
    if ((n.t === 'cl' || n.t === 'tb' || n.t === 'im') && inside(objDeleteButton(n), x, y)) {
      commitTextEdit();
      tools.clearSelection();
      // 표·체크리스트·그림과 그 위에 쓴 필기를 함께 삭제 (실행 취소 가능)
      const ids = new Set([n.id, ...noteAttached(items, n)]);
      d.setItems(page, items.filter((it) => !ids.has(it.id)));
      toast(`${{ cl: '체크리스트', tb: '표', im: '그림' }[n.t]}을(를) 삭제했습니다 · 실행 취소로 되돌릴 수 있음`);
      return true;
    }
    if (n.t === 'cl') {
      const r = checkRowAt(n, x, y);
      if (r < 0) continue;
      const b = checkBox(n, r), slop = n.fs * 0.35;
      if (x <= b.x + b.w + slop && y >= b.y - slop && y <= b.y + b.h + slop) {
        d.setItems(page, items.map((it) => (it.id === n.id ? { ...it, rows: it.rows.map((row, k) => (k === r ? { ...row, done: !row.done } : row)) } : it)));
        return true;
      }
      continue;
    }
    if (n.t !== 'nt') continue;
    if (n.fold && inside(noteIconRect(n), x, y)) { setNotesFold(page, new Set([n.id]), false); return true; }
    if (!n.fold && inside(noteFoldButton(n), x, y)) { setNotesFold(page, new Set([n.id]), true); return true; }
    if (!n.fold && inside(noteDeleteButton(n), x, y)) {
      commitTextEdit();
      tools.clearSelection();
      // 포스트잇과 그 위에 쓴 필기를 함께 삭제 (실행 취소 가능)
      const ids = new Set([n.id, ...noteAttached(items, n)]);
      d.setItems(page, items.filter((it) => !ids.has(it.id)));
      toast('포스트잇을 삭제했습니다 · 실행 취소로 되돌릴 수 있음');
      return true;
    }
  }
  return false;
}

// ── 포스트잇·표 끌어 옮기기: 어두운 띠(또는 접힌 아이콘)를 펜·손가락으로 잡고 끌기 ──
let noteDrag = null; // {page, ids, sx0, sy0, m}

/** 화면 점이 포스트잇·표 손잡이 위면 끌기 시작 (도구와 무관). 시작했으면 {page}, 아니면 false */
function noteDragStart(sx, sy) {
  if (noteDrag) return false;
  const d = state.doc;
  const hit = d && viewer.pageAtScreen(sx, sy, true);
  if (!hit) return false;
  const items = d.items(hit.page);
  const folded = foldHidden(items);
  for (let i = items.length - 1; i >= 0; i--) {
    const n = items[i];
    if (!layerUsable(n) || folded?.has(n.id)) continue;
    // 표·포스트잇 오른쪽 아래 모서리: 끌어서 가로·세로 크기 조절 (글자 크기는 그대로)
    const rh = n.t === 'tb' ? tableResizeHandle(n) : n.t === 'nt' && !n.fold ? noteResizeHandle(n) : null;
    if (rh && inside(rh, hit.x, hit.y)) {
      commitTextEdit();
      tools.clearSelection();
      const cur = d.items(hit.page).find((it) => it.id === n.id) || n;
      const min = n.t === 'tb' ? tableMinSize(cur) : noteMinSize(d.items(hit.page), cur);
      noteDrag = { kind: 'resize', page: hit.page, item: cur, min, sx0: sx, sy0: sy, moved: false };
      return { page: hit.page };
    }
    const handle = n.t === 'nt' ? noteHandle(n) : n.t === 'tb' || n.t === 'cl' || n.t === 'im' ? objHandle(n) : null;
    if (!handle || !inside(handle, hit.x, hit.y)) continue;
    commitTextEdit();
    tools.clearSelection();
    const ids = new Set([n.id, ...noteAttached(items, n)]);
    noteDrag = { page: hit.page, ids, sx0: sx, sy0: sy, m: { s: 1, ox: n.x, oy: n.y, dx: 0, dy: 0 }, moved: false };
    viewer.selection = { page: hit.page, ids, m: noteDrag.m };
    return { page: hit.page };
  }
  return false;
}
function noteDragMove(sx, sy) {
  const g = noteDrag;
  if (!g) return;
  const z = viewer.cam.z;
  if (Math.hypot(sx - g.sx0, sy - g.sy0) > 6) g.moved = true;
  if (g.kind === 'resize') {
    const it = g.item, min = g.min;
    g.w = Math.max(min.w, it.w + (sx - g.sx0) / z);
    g.h = Math.max(min.h, it.h + (sy - g.sy0) / z);
    viewer.preview = { ...it, w: g.w, h: g.h };
    viewer.requestInk();
    return;
  }
  g.m.dx = (sx - g.sx0) / z;
  g.m.dy = (sy - g.sy0) / z;
  viewer.selection = { page: g.page, ids: g.ids, m: { ...g.m } };
  viewer.requestInk();
}
/** 끝: 움직였으면 위치 확정(실행 취소 가능), 안 움직였으면 탭으로 보고 false (접힌 아이콘은 펼침) */
function noteDragEnd(cancel) {
  const g = noteDrag;
  noteDrag = null;
  viewer.selection = null;
  if (!g) return false;
  const d = state.doc;
  if (g.kind === 'resize') {
    viewer.preview = null;
    if (!cancel && g.moved && d && g.w) d.setItems(g.page, d.items(g.page).map((it) => (it.id === g.item.id ? { ...it, w: g.w, h: g.h } : it)));
    else viewer.requestInk();
    return g.moved;
  }
  if (!cancel && g.moved && d) {
    d.setItems(g.page, d.items(g.page).map((it) => (g.ids.has(it.id) ? transformItem(it, g.m) : it)));
  } else viewer.requestInk();
  return g.moved;
}

function insertNote(at) {
  const doc = state.doc;
  if (!doc) return;
  const hit = (at && viewer.pageAtScreen(at.x, at.y)) || viewer.pageAtScreen(viewer.vw / 2, viewer.vh / 2) || { page: viewer.currentPage(), x: 50, y: 50 };
  const p = viewer.pages[hit.page];
  const z = viewer.cam.z;
  const size = Math.min(200 / z, p.w * 0.6), fs = 16 / z;
  const x = clamp(hit.x - size / 2, 0, Math.max(0, p.w - size)), y = clamp(hit.y - size / 2, 0, Math.max(0, p.h - size));
  const item = { id: uid('nt'), t: 'nt', x, y, w: size, h: size, c: settings.get('note').color, fs, text: '' };
  doc.add(hit.page, item);
  startTextEdit(hit.page, item);
}

/** 화면 가운데(또는 지정 위치)의 페이지 좌표 */
function placeAt(at) {
  return (at && viewer.pageAtScreen(at.x, at.y)) || viewer.pageAtScreen(viewer.vw / 2, viewer.vh / 2) || { page: viewer.currentPage(), x: 50, y: 50 };
}

let lastNoteEdit = null; // {page, id, t} 마지막으로 글을 쓴 포스트잇
/** 그 자리의 펼친 포스트잇 (맨 위) */
function noteAtPoint(page, x, y) {
  const items = state.doc.items(page), folded = foldHidden(items);
  for (let i = items.length - 1; i >= 0; i--) {
    const n = items[i];
    if (n.t === 'nt' && !n.fold && layerUsable(n) && !folded?.has(n.id) && inside(n, x, y)) return n;
  }
  return null;
}

/** 넣을 포스트잇: 글을 쓰고 있는 포스트잇 → 올가미로 선택한 포스트잇 하나 → 넣을 자리의 포스트잇 */
function targetNote(hit) {
  const d = state.doc, ed = state.editing;
  if (ed?.kind === 'note') { const n = d.items(ed.page).find((i) => i.id === ed.item.id); if (n) return { page: ed.page, note: n }; }
  // 도구 모음 버튼을 누르면 입력칸이 먼저 닫히므로, 방금(2초 안) 글을 쓰던 포스트잇도 대상
  if (lastNoteEdit && performance.now() - lastNoteEdit.t < 2000) {
    const n = d.items(lastNoteEdit.page).find((i) => i.id === lastNoteEdit.id && !i.fold);
    if (n) return { page: lastNoteEdit.page, note: n };
  }
  const sel = tools.selection;
  if (sel) {
    const ns = d.items(sel.page).filter((i) => sel.ids.has(i.id) && i.t === 'nt' && !i.fold);
    if (ns.length === 1) return { page: sel.page, note: ns[0] };
  }
  const n = hit && noteAtPoint(hit.page, hit.x, hit.y);
  return n ? { page: hit.page, note: n } : null;
}

/**
 * 포스트잇 안에 표·체크리스트·그림 넣기: 글과 이미 넣은 것 아래에 포스트잇 폭에 맞춰 놓고,
 * 모자라면 포스트잇을 늘린다 (한 번에 실행 취소). make({x, y, w}) → 개체 (y 는 손잡이 띠 위쪽)
 */
function addIntoNote(t, make) {
  commitTextEdit();
  const d = state.doc;
  const items = d.items(t.page);
  const n = items.find((i) => i.id === t.note.id);
  if (!n) return null;
  let top = noteTextBottom(n) + 4;
  const att = new Set(noteAttached(items, n));
  for (const it of items) if (att.has(it.id)) { const b = bbox(it); top = Math.max(top, b.y + b.h + 4); }
  const item = { ...make({ x: n.x + NOTE_PAD, y: top, w: n.w - NOTE_PAD * 2 }), ly: layerOf(n) };
  const bottom = item.y + (item.t === 'cl' ? checkHeight(item) : item.h) + (item.t === 'tb' ? tableCtlSize(item) + 3 : 0) + NOTE_PAD;
  d.begin();
  if (bottom > n.y + n.h) d.setItems(t.page, items.map((i) => (i.id === n.id ? { ...i, h: bottom - n.y } : i)));
  d.add(t.page, item);
  d.commit();
  return item;
}

function insertChecklist(at) {
  const doc = state.doc;
  if (!doc) return;
  const tn = targetNote(at ? viewer.pageAtScreen(at.x, at.y) : null);
  if (tn) {
    const fs = Math.min(15 / viewer.cam.z, tn.note.fs);
    const item = addIntoNote(tn, (r) => ({ id: uid('cl'), t: 'cl', x: r.x, y: r.y + objBarH({ fs }), w: r.w, fs, c: '#1c1f24', rows: [{ text: '', done: false }] }));
    if (item) startTextEdit(tn.page, item, undefined, undefined, { isNew: true });
    return;
  }
  const hit = placeAt(at), p = viewer.pages[hit.page], z = viewer.cam.z;
  const w = Math.min(260 / z, p.w * 0.8), fs = 15 / z;
  const bh = objBarH({ fs }); // 위쪽 손잡이 띠가 페이지 밖으로 나가지 않게
  const item = { id: uid('cl'), t: 'cl', x: clamp(hit.x - w / 2, 0, p.w - w), y: clamp(hit.y - fs * 2, bh, Math.max(bh, p.h - fs * 3)), w, fs, c: '#1c1f24', rows: [{ text: '', done: false }] };
  doc.add(hit.page, item);
  startTextEdit(hit.page, item, undefined, undefined, { isNew: true });
}

function insertTable(rows, cols, at, into) {
  const doc = state.doc;
  if (!doc) return;
  const tn = into !== undefined ? into : targetNote(at ? viewer.pageAtScreen(at.x, at.y) : null);
  if (tn) {
    const fs = Math.min(13 / viewer.cam.z, tn.note.fs);
    const cells = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ''));
    const item = addIntoNote(tn, (r) => ({ id: uid('tb'), t: 'tb', x: r.x, y: r.y + objBarH({ fs }), w: r.w - tableCtlSize({ fs }) - 3, h: rows * fs * 2.2, fs, cells }));
    if (item) startTextEdit(tn.page, item, undefined, undefined, { cell: { r: 0, c: 0 } });
    return;
  }
  const hit = placeAt(at), p = viewer.pages[hit.page], z = viewer.cam.z;
  const fs = 13 / z;
  const w = Math.min(cols * 110 / z, p.w * 0.9), h = Math.min(rows * fs * 2.2, p.h * 0.8);
  const cells = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ''));
  const bh = objBarH({ fs }); // 위쪽 손잡이 띠가 페이지 밖으로 나가지 않게
  const item = { id: uid('tb'), t: 'tb', x: clamp(hit.x - w / 2, 0, p.w - w), y: clamp(hit.y - h / 2, bh, Math.max(bh, p.h - h)), w, h, fs, cells };
  doc.add(hit.page, item);
  startTextEdit(hit.page, item, undefined, undefined, { cell: { r: 0, c: 0 } });
}

$('#btnChecklist').addEventListener('click', () => insertChecklist());
let tableInto = null; // 표를 넣을 포스트잇 (대화상자를 열 때 정함)
$('#btnTable').addEventListener('click', () => { tableInto = state.doc ? targetNote(null) : null; $('#tableDlg').showModal(); });
$('#tableDlg').addEventListener('close', () => {
  const into = tableInto;
  tableInto = null;
  if ($('#tableDlg').returnValue !== 'ok') return;
  insertTable(clamp(parseInt($('#tbRows').value, 10) || 3, 1, 30), clamp(parseInt($('#tbCols').value, 10) || 3, 1, 12), undefined, into);
});

let imageInto = null; // 그림을 넣을 포스트잇 (파일 고르기 전에 정함)
$('#btnImage').addEventListener('click', () => { imageInto = state.doc ? targetNote(null) : null; $('#imageInput').click(); });
$('#imageInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; const into = imageInto; imageInto = null; insertImageFile(f, undefined, into); });
$('#btnNote').addEventListener('click', () => insertNote());
// 붙여넣기(Ctrl+V)와 끌어 놓기로도 그림 넣기
document.addEventListener('paste', (e) => {
  if (state.screen !== 'editor' || state.editing || e.target.closest?.('input, textarea')) return;
  const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
  if (f) { e.preventDefault(); pendingClipPaste = false; insertImageFile(f); }
});
$('#viewport').addEventListener('dragover', (e) => { if (state.doc) e.preventDefault(); });
$('#viewport').addEventListener('drop', (e) => {
  const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('image/'));
  if (!f || !state.doc) return;
  e.preventDefault();
  e.stopPropagation();
  insertImageFile(f, viewer.clientToScreen(e.clientX, e.clientY));
});

// ───────────────────────────── 음성 녹음 · 필기 따라가기 ─────────────────────────────

const recorder = new AudioRecorder();
app.recStamp = () => recorder.stamp();
const audioEl = $('#apAudio');
let player = null; // {rec(저장 레코드), url, marks:[{page, t}]}
let recTimer = 0, playRaf = 0, lastFollow = 0;

function openAudioPanel() {
  closeToolPopup();
  $('#clockPanel').hidden = true;
  $('#layerPanel').hidden = true;
  $('#audioPanel').hidden = false;
  renderRecList();
}
$('#btnRec').addEventListener('click', () => { if ($('#audioPanel').hidden) openAudioPanel(); else $('#audioPanel').hidden = true; });
$('#recChip').addEventListener('click', openAudioPanel);
$('#apClose').addEventListener('click', () => { $('#audioPanel').hidden = true; stopPlayback(); });
$('#apRecBtn').addEventListener('click', () => toggleRecording());

async function toggleRecording() {
  if (!state.doc) return;
  if (recorder.recording) { await stopRecording(); return; }
  try {
    await recorder.start({ stt: $('#apStt').checked });
  } catch (e) {
    const why = e?.name === 'NotAllowedError' ? '마이크 권한이 거부되었습니다' : e?.name === 'NotFoundError' ? '마이크를 찾을 수 없습니다' : (e?.message || e);
    toast('녹음을 시작할 수 없습니다: ' + why, { error: true, ms: 5000 });
    return;
  }
  stopPlayback(true);
  const btn = $('#apRecBtn');
  btn.classList.add('recording');
  btn.querySelector('span').textContent = '녹음 정지';
  $('#recChip').hidden = false;
  $('#btnRec').classList.add('on');
  const tick = () => {
    const t = fmtTime(recorder.elapsed());
    $('#recChip span').textContent = t;
    $('#apRecInfo').textContent = `녹음 중 ${t} · 지금 쓰는 필기가 녹음과 연결됩니다`;
  };
  tick();
  recTimer = setInterval(tick, 500);
  toast('녹음을 시작했습니다', { ms: 1200 });
}

async function stopRecording() {
  clearInterval(recTimer);
  const r = await recorder.stop();
  const btn = $('#apRecBtn');
  btn.classList.remove('recording');
  btn.querySelector('span').textContent = '녹음 시작';
  $('#recChip').hidden = true;
  $('#btnRec').classList.remove('on');
  $('#apInterim').textContent = '';
  $('#apRecInfo').textContent = '';
  if (!r || !state.doc) return;
  try {
    const name = `녹음 ${formatDate(r.created)}`;
    await store.putBlob({ id: r.id, docId: state.doc.id, kind: 'audio', data: r.blob, duration: r.duration, mime: r.mime, created: r.created, segments: r.segments, name });
    toast(`녹음을 저장했습니다 (${fmtTime(r.duration)})`);
    if (!$('#audioPanel').hidden) { await renderRecList(); loadRecording(r.id); }
  } catch (e) {
    toast('녹음을 저장하지 못했습니다: ' + store.describeError(e), { error: true, ms: 6000 });
  }
}

recorder.on('interim', ({ text }) => { $('#apInterim').textContent = text; });
recorder.on('transcript', ({ segments }) => { $('#apInterim').textContent = '✓ ' + segments[segments.length - 1].text; });
recorder.on('stt', ({ available, error }) => {
  if (!available) $('#apInterim').textContent = '이 브라우저는 받아쓰기를 지원하지 않아 녹음만 합니다';
  else if (error === 'not-allowed') $('#apInterim').textContent = '받아쓰기 권한이 없어 녹음만 합니다';
  else if (error === 'network') $('#apInterim').textContent = '받아쓰기는 인터넷이 필요합니다 (녹음은 계속됨)';
});

async function renderRecList() {
  const box = $('#apList');
  box.innerHTML = '';
  if (!state.doc) return;
  const list = (await store.listBlobs(state.doc.id, 'audio').catch(() => [])).sort((a, b) => b.created - a.created);
  if (!list.length) { box.innerHTML = '<p class="muted small" style="margin:0">아직 녹음이 없습니다. 녹음하면서 쓴 필기는 재생할 때 녹음에 맞춰 나타납니다.</p>'; return; }
  for (const r of list) {
    const b = document.createElement('button');
    b.className = 'ap-item' + (player?.rec.id === r.id ? ' on' : '');
    b.innerHTML = `<span>🎙 ${escapeHtml(r.name || '녹음')}</span><span class="muted">${fmtTime(r.duration)}${r.segments?.length ? (r.sttAi ? ' · AI 받아쓰기' : ' · 받아쓰기') : ''}</span>`;
    b.addEventListener('click', () => loadRecording(r.id));
    box.appendChild(b);
  }
}

/** 이 녹음과 연결된 필기 위치 목록 (시간순) */
function recMarks(recId) {
  const marks = [];
  for (const [page, items] of state.doc.pages) for (const it of items) if (it.rt?.rec === recId) marks.push({ page, t: it.rt.t });
  return marks.sort((a, b) => a.t - b.t);
}

async function loadRecording(id) {
  const rec = await store.getBlob(id);
  if (!rec) return;
  stopPlayback(true);
  const url = URL.createObjectURL(rec.data);
  audioEl.src = url;
  audioEl.playbackRate = +$('#apSpeed').value;
  player = { rec, url, marks: recMarks(id) };
  $('#apPlayer').hidden = false;
  $('#apTitle').textContent = `${rec.name || '녹음'} · 연결된 필기 ${player.marks.length}개`;
  renderTranscript();
  renderRecList();
  setReplayTime(0);
  updatePlayUi();
}

const recDuration = () => (player ? (Number.isFinite(audioEl.duration) && audioEl.duration > 0 ? audioEl.duration * 1000 : player.rec.duration) : 0);

function setReplayTime(t) {
  if (!player) return;
  viewer.replay = $('#apFollowInk').checked ? { rec: player.rec.id, t } : null;
  viewer.requestInk();
  const dur = recDuration();
  $('#apTime').textContent = `${fmtTime(t)} / ${fmtTime(dur)}`;
  $('#apSeek').value = dur ? Math.round((t / dur) * 1000) : 0;
  // 받아쓰기 현재 문장 표시
  const segs = player.rec.segments || [];
  let cur = -1;
  for (let i = 0; i < segs.length; i++) if (segs[i].t <= t) cur = i;
  $('#apTranscript').querySelectorAll('button').forEach((b, i) => b.classList.toggle('now', i === cur));
  // 페이지 따라가기: 지금까지 쓴 마지막 필기의 페이지가 안 보이면 이동
  if ($('#apFollowPage').checked && !audioEl.paused && performance.now() - lastFollow > 600) {
    lastFollow = performance.now();
    let last = null;
    for (const m of player.marks) { if (m.t <= t) last = m; else break; }
    if (last && !viewer.visiblePages().some((p) => p.index === last.page)) viewer.goToPage(last.page);
  }
}

function playLoop() {
  if (!player) return;
  setReplayTime(audioEl.currentTime * 1000);
  if (!audioEl.paused) playRaf = requestAnimationFrame(playLoop);
}

function updatePlayUi() { $('#apPlay use').setAttribute('href', audioEl.paused ? '#i-play' : '#i-pause'); }

function seekTo(ms, play) {
  if (!player) return;
  audioEl.currentTime = Math.max(0, ms) / 1000;
  setReplayTime(Math.max(0, ms));
  if (play) audioEl.play().catch(() => {});
}

/** 재생 중 필기를 탭하면 그 필기를 쓰던 순간(조금 앞)부터 재생 */
function seekToInkAt(page, x, y) {
  const items = state.doc.items(page);
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.rt?.rec === player.rec.id && !layerHidden(it) && hitTest(it, x, y, 10 / viewer.cam.z)) { seekTo(it.rt.t - 800, true); return true; }
  }
  return false;
}

/** 재생 멈춤. full=true 면 불러온 녹음도 내리고 필기를 원래대로 */
function stopPlayback(full = true) {
  if (full) sttJob?.abort();
  cancelAnimationFrame(playRaf);
  audioEl.pause();
  if (full) {
    if (player?.url) URL.revokeObjectURL(player.url);
    player = null;
    audioEl.removeAttribute('src');
    $('#apPlayer').hidden = true;
    if (viewer.replay) { viewer.replay = null; viewer.requestInk(); }
  }
  updatePlayUi();
}

$('#apPlay').addEventListener('click', () => {
  if (!player) return;
  if (audioEl.paused) audioEl.play().catch((e) => toast('재생할 수 없습니다: ' + e.message, { error: true })); else audioEl.pause();
});
audioEl.addEventListener('play', () => { updatePlayUi(); cancelAnimationFrame(playRaf); playRaf = requestAnimationFrame(playLoop); });
audioEl.addEventListener('pause', () => { updatePlayUi(); setReplayTime(audioEl.currentTime * 1000); });
audioEl.addEventListener('ended', () => { updatePlayUi(); setReplayTime(recDuration()); });
$('#apSeek').addEventListener('input', (e) => seekTo((+e.target.value / 1000) * recDuration(), false));
$('#apSpeed').addEventListener('change', (e) => { audioEl.playbackRate = +e.target.value; });
$('#apFollowInk').addEventListener('change', () => setReplayTime(audioEl.currentTime * 1000));

function renderTranscript() {
  const box = $('#apTranscript');
  box.innerHTML = '';
  const segs = player?.rec.segments || [];
  $('#apInsertText').disabled = !segs.length;
  if (!segs.length) { box.innerHTML = '<p class="muted small" style="margin:0">받아쓴 글이 없습니다.</p>'; return; }
  segs.forEach((sg) => {
    const b = document.createElement('button');
    b.innerHTML = `<b>${fmtTime(sg.t)}</b>${escapeHtml(sg.text)}`;
    b.addEventListener('click', () => seekTo(sg.t, true));
    box.appendChild(b);
  });
}

$('#apInsertText').addEventListener('click', () => {
  const segs = player?.rec.segments || [];
  if (!segs.length || !state.doc) return;
  const text = segs.map((s) => `[${fmtTime(s.t)}] ${s.text}`).join('\n');
  const hit = placeAt(), p = viewer.pages[hit.page], z = viewer.cam.z;
  const w = Math.min(300 / z, p.w * 0.8), fs = 13 / z;
  const h = Math.min(Math.max(120 / z, (segs.length * 2 + 2) * fs * 1.3), p.h * 0.8);
  const item = { id: uid('nt'), t: 'nt', x: clamp(hit.x - w / 2, 0, p.w - w), y: clamp(hit.y - h / 2, 0, p.h - h), w, h, c: '#b3e5fc', fs, text };
  state.doc.add(hit.page, item);
  toast('받아쓴 글을 포스트잇으로 붙였습니다');
});
// AI 받아쓰기: 녹음을 4분 조각(16kHz WAV)으로 나눠 Gemini 에 보내고, 문장별 시각을 조각 시작 시각에 더해 합친다.
// 끝나면 브라우저 받아쓰기 결과를 바꿔 저장 (실패하면 그대로 둠). 진행 중에 다시 누르면 중지
let sttJob = null;
$('#apAiStt').addEventListener('click', async () => {
  if (sttJob) { sttJob.abort(); return; }
  if (!player) return;
  const rec = player.rec, btn = $('#apAiStt'), label = btn.textContent;
  const ctrl = new AbortController();
  sttJob = ctrl;
  btn.textContent = '■ 받아쓰기 중지';
  const info = (t) => { $('#apInterim').textContent = t; };
  const segs = [];
  try {
    info('녹음 파일 준비 중…');
    for await (const ch of wavChunks(rec.data)) {
      if (ctrl.signal.aborted) throw new AiError('abort', '중지했습니다.');
      info(`AI 받아쓰는 중… ${fmtTime(ch.startMs)} / ${fmtTime(ch.totalMs)}`);
      const { system, parts } = transcribeRequest({ wav: ch.wav, startMs: ch.startMs });
      const res = await askAi({ system, parts, model: settings.get('ai').model, effort: 'low', json: true, maxTokens: 32000, signal: ctrl.signal });
      const got = parseTranscript(res.text, ch.startMs, ch.durMs);
      if (!got) throw new AiError('format', 'AI 답을 읽지 못했습니다. 다시 시도하세요.');
      segs.push(...got);
    }
    if (!segs.length) { info('들리는 말이 없습니다 (받아쓰기는 그대로 둠)'); return; }
    const updated = { ...rec, segments: segs, sttAi: true };
    await store.putBlob(updated);
    if (player?.rec.id === rec.id) { player.rec = updated; renderTranscript(); setReplayTime(audioEl.currentTime * 1000); }
    renderRecList();
    info(`✓ AI 받아쓰기 완료 · ${segs.length}문장`);
  } catch (e) {
    info('');
    if (e?.code !== 'abort') toast(e instanceof AiError ? e.message : 'AI 받아쓰기 실패: ' + (e?.message || e), { error: true, ms: 6000 });
  } finally {
    sttJob = null;
    btn.textContent = label;
  }
});
$('#apDownload').addEventListener('click', () => {
  if (!player) return;
  const ext = /mp4/.test(player.rec.mime) ? 'm4a' : /ogg/.test(player.rec.mime) ? 'ogg' : 'webm';
  const a = document.createElement('a');
  a.href = player.url;
  a.download = `${state.doc?.meta.name || '노트'}_${player.rec.name || '녹음'}.${ext}`.replace(/[\\/:*?"<>|]/g, '_');
  a.click();
});
$('#apDelete').addEventListener('click', async () => {
  if (!player || !confirm('이 녹음을 삭제할까요? (필기는 그대로 남습니다)')) return;
  const id = player.rec.id;
  stopPlayback(true);
  await store.deleteBlob(id).catch(() => {});
  renderRecList();
});

// ───────────────────────────── AI 도우미 (회의록·맞춤법·번역) ─────────────────────────────

let aiKind = 'minutes';
let aiJob = null; // {ctrl, kind, page, pieces, outs, text, done}
for (const [id, name] of TRANSLATE_LANGS) $('#aiLang').insertAdjacentHTML('beforeend', `<option value="${id}">${escapeHtml(name)}</option>`);

async function openAiPanel() {
  closeToolPopup();
  $('#audioPanel').hidden = true;
  $('#layerPanel').hidden = true;
  $('#clockPanel').hidden = true;
  $('#aiPanel').hidden = false;
  $('#aiLang').value = settings.get('ai').lang;
  $('#aiNoKey').hidden = !!getApiKey();
  await fillAiRecSelect();
  updateAiTarget();
}
function closeAiPanel() { $('#aiPanel').hidden = true; }
$('#btnAi').addEventListener('click', () => { if ($('#aiPanel').hidden) openAiPanel(); else closeAiPanel(); });
$('#aiClose').addEventListener('click', closeAiPanel);
// AI 창에서 바로 키 저장
$('#aiKeySave').addEventListener('click', () => {
  const k = $('#aiKeyInput').value.trim();
  if (!k) { $('#aiKeyInput').focus(); return; }
  setApiKey(k);
  $('#aiKeyInput').value = '';
  $('#aiNoKey').hidden = !!getApiKey();
  toast('Gemini API 키를 저장했습니다. 이제 실행을 누르세요');
});
$('#aiKeyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#aiKeySave').click(); } });
$('#aiTabs').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
  aiKind = b.value;
  $('#aiTabs').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  updateAiTarget();
}));
$('#aiLang').addEventListener('change', (e) => settings.set('ai', { ...settings.get('ai'), lang: e.target.value }));

async function fillAiRecSelect() {
  const sel = $('#aiRec');
  const list = state.doc ? (await store.listBlobs(state.doc.id, 'audio').catch(() => [])).filter((r) => r.segments?.length).sort((a, b) => b.created - a.created) : [];
  sel.innerHTML = '<option value="">사용 안 함</option>' + list.map((r) => `<option value="${r.id}">${escapeHtml(r.name || '녹음')} · ${fmtTime(r.duration)} · ${r.segments.length}문장</option>`).join('');
  sel.value = (player && list.some((r) => r.id === player.rec.id)) ? player.rec.id : (list[0]?.id || '');
}

/** AI 에 보낼 글 조각: 선택한 객체(없으면 현재 페이지)의 글상자·포스트잇·체크리스트 항목·표 칸 */
function aiTextPieces(useSelection = true) {
  const sel = useSelection ? tools.selection : null;
  const page = sel ? sel.page : viewer.currentPage();
  const pieces = [];
  for (const it of state.doc?.items(page) || []) {
    if (sel && !sel.ids.has(it.id)) continue;
    if ((it.t === 'tx' || it.t === 'nt') && it.text?.trim()) pieces.push({ id: it.id, path: null, text: it.text });
    else if (it.t === 'cl') it.rows.forEach((r, i) => { if (r.text.trim()) pieces.push({ id: it.id, path: ['rows', i], text: r.text }); });
    else if (it.t === 'tb') it.cells.forEach((row, r) => row.forEach((cell, c) => { if (cell.trim()) pieces.push({ id: it.id, path: ['cells', r, c], text: cell }); }));
  }
  return { page, pieces, fromSel: !!sel };
}

function updateAiTarget() {
  $('#aiOptMinutes').hidden = aiKind !== 'minutes';
  $('#aiOptTranslate').hidden = aiKind !== 'translate';
  if (!state.doc) return;
  if (aiKind === 'minutes') {
    $('#aiTarget').textContent = `${viewer.currentPage() + 1}쪽의 글·손글씨와 선택한 녹음의 받아쓰기로 회의록을 만듭니다.`;
  } else {
    const { page, pieces, fromSel } = aiTextPieces();
    $('#aiTarget').textContent = pieces.length
      ? `${fromSel ? '선택한 객체' : `${page + 1}쪽`}의 글 ${pieces.length}개 (글상자·포스트잇·체크리스트·표). 손글씨는 대상이 아닙니다.`
      : `${fromSel ? '선택한 객체에' : `${page + 1}쪽에`} 글이 없습니다. 글상자·포스트잇·체크리스트·표의 글을 검사합니다.`;
  }
}

/** 현재 페이지를 필기까지 그린 JPEG (base64). 긴 변 1568px 이하 */
async function pageImageBase64(i) {
  if (viewer.surface) return surfaceImageBase64();
  const p = viewer.pages[i];
  const scale = Math.min(1568 / Math.max(p.w, p.h), 2.5);
  const page = await viewer.pdf.getPage(i + 1);
  const vp = page.getViewport({ scale: scale * (p.w / page.getViewport({ scale: 1 }).width) });
  const c = document.createElement('canvas');
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const ctx = c.getContext('2d');
  await page.render({ canvasContext: ctx, viewport: vp, background: '#ffffff' }).promise;
  const items = layerSorted(state.doc.items(i));
  const folded = foldHidden(items);
  const vis = folded ? items.filter((it) => !folded.has(it.id)) : items;
  const s = c.width / p.w;
  ctx.setTransform(s, 0, 0, s, 0, 0);
  ctx.globalCompositeOperation = 'multiply';
  for (const it of vis) if (isHighlighter(it)) drawItem(ctx, it, { print: true });
  ctx.globalCompositeOperation = 'source-over';
  for (const it of vis) if (!isHighlighter(it)) drawItem(ctx, it, { print: true });
  return c.toDataURL('image/jpeg', 0.88).split(',')[1]; // PNG 는 사진 많은 PDF 에서 이미지 한도(5MB)를 넘을 수 있음
}

/** 무한 캔버스·스크롤: 지금 화면에 보이는 영역(스크롤은 지금 시트)을 필기까지 그린 JPEG */
function surfaceImageBase64() {
  const eng = viewer.surface;
  const w0 = viewer.toWorld(0, viewer.insetTop), w1 = viewer.toWorld(viewer.vw, viewer.vh);
  const box = eng.kind === 'scroll' ? { x: 0, y: eng.currentSheet(viewer) * eng.sheetH, w: eng.W, h: eng.sheetH } : { x: w0.x, y: w0.y, w: w1.x - w0.x, h: w1.y - w0.y };
  const s = Math.min(1568 / Math.max(box.w, box.h), 2.5);
  const c = document.createElement('canvas');
  c.width = Math.ceil(box.w * s); c.height = Math.ceil(box.h * s);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.setTransform(s, 0, 0, s, -box.x * s, -box.y * s);
  const items = layerSorted(state.doc.items(0));
  const folded = foldHidden(items);
  const vis = items.filter((it) => !folded?.has(it.id) && rectsIntersect(bbox(it), box));
  ctx.globalCompositeOperation = 'multiply';
  for (const it of vis) if (isHighlighter(it)) drawItem(ctx, it, { print: true });
  ctx.globalCompositeOperation = 'source-over';
  for (const it of vis) if (!isHighlighter(it)) drawItem(ctx, it, { print: true });
  return c.toDataURL('image/jpeg', 0.88).split(',')[1];
}

function aiShow(text, { error = false, explain = '' } = {}) {
  const out = $('#aiOut');
  out.hidden = false;
  out.classList.toggle('err', error);
  out.textContent = text;
  if (explain) { const e = document.createElement('span'); e.className = 'ai-explain'; e.textContent = explain; out.appendChild(e); }
  out.scrollTop = out.scrollHeight;
}

async function runAi() {
  if (!state.doc || aiJob?.running) return;
  if (!getApiKey()) { $('#aiNoKey').hidden = false; return; }
  const kind = aiKind;
  const job = { kind, ctrl: new AbortController(), running: true };
  aiJob = job;
  $('#aiRun').disabled = true; $('#aiStop').hidden = false; $('#aiResultActions').hidden = true;
  try {
    let req;
    if (kind === 'minutes') {
      const page = viewer.currentPage();
      const recId = $('#aiRec').value;
      const rec = recId ? await store.getBlob(recId) : null;
      const segments = rec?.segments || [];
      const pageText = aiTextPieces(false).pieces.map((p) => p.text).join('\n');
      const image = $('#aiImage').checked ? await pageImageBase64(page) : null;
      if (!segments.length && !pageText.trim() && !image) throw new AiError('empty', '정리할 내용이 없습니다. 녹음 받아쓰기나 페이지 이미지를 포함하세요.');
      req = minutesRequest({ segments, pageText, image, title: state.doc.meta.name, date: formatDate(rec?.created || Date.now()) });
    } else {
      const { page, pieces } = aiTextPieces();
      if (!pieces.length) throw new AiError('empty', '검사할 글이 없습니다. 글상자·포스트잇·체크리스트·표를 올가미로 선택하거나 글이 있는 페이지에서 실행하세요.');
      Object.assign(job, { page, pieces });
      req = kind === 'grammar' ? grammarRequest(pieces.map((p) => p.text)) : translateRequest(pieces.map((p) => p.text), $('#aiLang').value);
    }
    // 무료 키는 응답이 수십 초 걸리기도 하므로 기다린 시간을 보여 준다
    const t0 = Date.now();
    let streamed = false;
    const tick = () => { if (aiJob === job && !streamed) aiShow(`생각하는 중… ${Math.round((Date.now() - t0) / 1000)}초`); };
    tick();
    job.timer = setInterval(tick, 1000);
    // 맞춤법·번역은 단순한 작업이라 한 단계 낮은 생각 깊이로 (속도·사용량 절약)
    const effort = settings.get('ai').effort;
    const res = await askAi({
      ...req,
      model: settings.get('ai').model,
      effort: kind === 'minutes' ? effort : (effort === 'high' ? 'medium' : 'low'),
      signal: job.ctrl.signal,
      onText: (_d, all) => { streamed = true; if (aiJob === job) aiShow(all); },
    });
    if (aiJob !== job) return;
    job.text = res.text;
    if (kind === 'minutes') {
      aiShow(res.text + (res.truncated ? '\n\n(길이 제한으로 잘렸습니다)' : ''));
      job.todos = extractTodos(res.text);
    } else {
      const { body, explain } = splitExplain(res.text);
      job.outs = unpackTexts(body, job.pieces.length);
      job.explain = explain;
      if (job.outs) aiShow(job.outs.join('\n\n'), { explain });
      else aiShow(res.text);
    }
    $('#aiResultActions').hidden = false;
    $('#aiApply').hidden = !job.outs;
    $('#aiApply').textContent = kind === 'grammar' ? '고친 글로 바꾸기' : '번역으로 바꾸기';
    $('#aiTodos').hidden = !(kind === 'minutes' && job.todos?.length);
  } catch (e) {
    if (aiJob === job) aiShow(e.message || String(e), { error: true });
  } finally {
    clearInterval(job.timer);
    job.running = false;
    if (aiJob === job) { $('#aiRun').disabled = false; $('#aiStop').hidden = true; }
  }
}
$('#aiRun').addEventListener('click', runAi);
$('#aiStop').addEventListener('click', () => aiJob?.ctrl.abort());

/** 결과를 원래 객체에 반영 (그 사이 사용자가 고친 조각은 건너뜀). 실행 취소 한 번으로 되돌릴 수 있다 */
$('#aiApply').addEventListener('click', () => {
  const job = aiJob, d = state.doc;
  if (!job?.outs || !d) return;
  const changes = new Map();
  job.pieces.forEach((p, i) => { if (!changes.has(p.id)) changes.set(p.id, []); changes.get(p.id).push([p, job.outs[i]]); });
  let n = 0, skipped = 0;
  const items = d.items(job.page).map((it) => {
    const ch = changes.get(it.id);
    if (!ch) return it;
    let next = it;
    for (const [p, out] of ch) {
      if (!p.path) {
        if (it.text !== p.text) { skipped++; continue; }
        next = { ...next, text: out };
      } else if (p.path[0] === 'rows') {
        if (it.rows[p.path[1]]?.text !== p.text) { skipped++; continue; }
        const rows = next.rows === it.rows ? it.rows.map((r) => ({ ...r })) : next.rows;
        rows[p.path[1]].text = out.replace(/\s*\n\s*/g, ' ');
        next = { ...next, rows };
      } else {
        const [, r, c] = p.path;
        if (it.cells[r]?.[c] !== p.text) { skipped++; continue; }
        const cells = next.cells === it.cells ? it.cells.map((row) => [...row]) : next.cells;
        cells[r][c] = out;
        next = { ...next, cells };
      }
      n++;
    }
    return next;
  });
  if (n) d.setItems(job.page, items);
  $('#aiApply').hidden = true;
  toast(`${n}개를 바꿨습니다${skipped ? ` (그 사이 고친 ${skipped}개는 건너뜀)` : ''} · 실행 취소로 되돌릴 수 있음`);
});

/** 긴 글을 포스트잇으로 붙이기 (내용 길이에 맞춰 높이 계산) */
function addTextNote(text, color = '#e1f5fe') {
  const d = state.doc;
  if (!d) return;
  const hit = placeAt(), p = viewer.pages[hit.page], z = viewer.cam.z;
  const w = Math.min(380 / z, p.w * 0.85), fs = 12 / z;
  const perLine = Math.max(8, Math.floor((w - fs * 2) / (fs * 0.95)));
  const lines = text.split('\n').reduce((s, l) => s + Math.max(1, Math.ceil(l.length / perLine)), 0);
  const h = Math.min(Math.max(120 / z, (lines + 2) * fs * TEXT_LINE + noteTextTop({ h: 200 })), p.h * 0.95);
  const item = { id: uid('nt'), t: 'nt', x: clamp(hit.x - w / 2, 0, p.w - w), y: clamp(hit.y - h / 2, 0, p.h - h), w, h, c: color, fs, text };
  d.add(hit.page, item);
  toast('포스트잇으로 붙였습니다');
}
$('#aiAsNote').addEventListener('click', () => {
  const job = aiJob;
  if (!job?.text) return;
  addTextNote(job.outs ? job.outs.join('\n\n') : job.text, job.kind === 'minutes' ? '#e1f5fe' : '#f1f8e9');
});
$('#aiTodos').addEventListener('click', () => {
  const todos = aiJob?.todos, d = state.doc;
  if (!todos?.length || !d) return;
  const hit = placeAt(), p = viewer.pages[hit.page], z = viewer.cam.z;
  const w = Math.min(300 / z, p.w * 0.8), fs = 14 / z;
  const bh = objBarH({ fs });
  const item = { id: uid('cl'), t: 'cl', x: clamp(hit.x - w / 2, 0, p.w - w), y: clamp(hit.y - fs * 2, bh, Math.max(bh, p.h - fs * 3)), w, fs, c: '#1c1f24', rows: todos.map((text) => ({ text, done: false })) };
  d.add(hit.page, item);
  toast(`할 일 ${todos.length}개를 체크리스트로 넣었습니다`);
});
$('#aiCopy').addEventListener('click', async () => {
  const job = aiJob;
  if (!job?.text) return;
  try { await navigator.clipboard.writeText(job.outs ? job.outs.join('\n\n') : job.text); toast('복사했습니다'); }
  catch { toast('복사할 수 없습니다 (브라우저 권한)'); }
});

// ───────────────────────────── 레이어 ─────────────────────────────
// 노트 전체 공통 레이어 목록 (아래 → 위 순서). 문서 메타(layers, activeLayer)에 저장된다.

const defaultLayers = () => [{ id: DEFAULT_LAYER, name: '레이어 1', visible: true, locked: false }];
let layers = defaultLayers();
let activeLayer = DEFAULT_LAYER;

function initLayers(doc) {
  const saved = Array.isArray(doc.meta.layers) ? doc.meta.layers.filter((l) => l && typeof l.id === 'string' && /^L\w{1,40}$/.test(l.id)) : [];
  layers = saved.length ? saved.map((l) => ({ id: l.id, name: String(l.name || '레이어'), visible: l.visible !== false, locked: !!l.locked })) : defaultLayers();
  activeLayer = layers.some((l) => l.id === doc.meta.activeLayer) ? doc.meta.activeLayer : layers[layers.length - 1].id;
  applyLayers(false);
}

/** 레이어 상태를 그리기·도구·저장에 반영 */
function applyLayers(save = true) {
  if (!layers.some((l) => l.id === activeLayer)) activeLayer = layers[layers.length - 1].id;
  setLayerState(layers, activeLayer);
  const d = state.doc;
  if (d) d.activeLayer = activeLayer === DEFAULT_LAYER ? null : activeLayer;
  viewer.requestInk();
  if (d) for (const p of d.pages.keys()) thumbs.markInk(p);
  $('#btnLayers').classList.toggle('on', layers.length > 1);
  updateLayerChip();
  if (save && d) {
    d.meta.layers = layers;
    d.meta.activeLayer = activeLayer;
    store.patchDoc(d.id, { layers, activeLayer }).catch(() => {});
  }
  if (!$('#layerPanel').hidden) renderLayers();
}

const layerById = (id) => layers.find((l) => l.id === id);

/** 하단 표시: 지금 쓰고 있는 레이어 이름 (레이어가 여러 개면 위에서 몇 번째인지도) */
function updateLayerChip() {
  const l = layerById(activeLayer);
  if (!l) return;
  const pos = layers.length > 1 ? ` <small>(${layers.length - layers.indexOf(l)}/${layers.length})</small>` : '';
  $('#layerChip span').innerHTML = `<b>${escapeHtml(l.name)}</b>${pos}`;
  $('#layerChip').title = `현재 레이어: ${l.name} (탭하면 레이어 패널)`;
}
/** 숨기거나 잠근 레이어가 현재 레이어면 쓸 수 있는 다른 레이어로 바꾼다 */
function ensureUsableActive() {
  const cur = layerById(activeLayer);
  if (cur && cur.visible && !cur.locked) return;
  const alt = [...layers].reverse().find((l) => l.visible && !l.locked);
  if (alt) { activeLayer = alt.id; toast(`현재 레이어를 "${alt.name}"(으)로 바꿨습니다`); }
  else toast('쓸 수 있는(보이고 잠기지 않은) 레이어가 없습니다', { error: true });
}

function layerCounts() {
  const n = new Map();
  for (const items of state.doc?.pages.values() || []) for (const it of items) { const l = layerOf(it); n.set(l, (n.get(l) || 0) + 1); }
  return n;
}

function renderLayers() {
  const box = $('#lyList');
  box.innerHTML = '';
  const counts = layerCounts();
  const icon = (id) => `<svg><use href="#${id}"/></svg>`;
  [...layers].reverse().forEach((l) => {
    const i = layers.indexOf(l);
    const row = document.createElement('div');
    row.className = 'ly-row' + (l.id === activeLayer ? ' on' : '') + (l.visible ? '' : ' off');
    row.dataset.id = l.id;
    row.innerHTML = `<button data-a="vis" title="${l.visible ? '숨기기' : '보이기'}">${icon(l.visible ? 'i-eye' : 'i-eye-off')}</button>`
      + `<button data-a="lock" title="${l.locked ? '잠금 풀기' : '잠그기 (지우개·올가미·편집 막기)'}">${icon(l.locked ? 'i-lock' : 'i-unlock')}</button>`
      + `<button data-a="pick" class="ly-name" title="현재 레이어로">${escapeHtml(l.name)} <small>${counts.get(l.id) || 0}개</small></button>`
      + `<button data-a="up" title="위로" ${i === layers.length - 1 ? 'disabled' : ''}>▲</button>`
      + `<button data-a="down" title="아래로" ${i === 0 ? 'disabled' : ''}>▼</button>`
      + `<button data-a="ren" title="이름 바꾸기">✎</button>`
      + `<button data-a="del" class="ly-del" title="레이어 삭제" ${layers.length === 1 ? 'disabled' : ''}>${icon('i-close')}</button>`;
    box.appendChild(row);
  });
  $('#lyMoveSel').hidden = !tools.selection;
}

$('#lyList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-a]');
  const row = b?.closest('.ly-row');
  if (!b || !row) return;
  const l = layerById(row.dataset.id);
  if (!l) return;
  const i = layers.indexOf(l);
  switch (b.dataset.a) {
    case 'pick':
      activeLayer = l.id;
      if (!l.visible || l.locked) { l.visible = true; l.locked = false; toast(`"${l.name}"을(를) 보이게 하고 잠금을 풀었습니다`); }
      break;
    case 'vis':
      l.visible = !l.visible;
      tools.clearSelection();
      if (l.id === activeLayer && !l.visible) ensureUsableActive();
      break;
    case 'lock':
      l.locked = !l.locked;
      tools.clearSelection();
      if (l.id === activeLayer && l.locked) ensureUsableActive();
      break;
    case 'up': if (i < layers.length - 1) [layers[i], layers[i + 1]] = [layers[i + 1], layers[i]]; break;
    case 'down': if (i > 0) [layers[i], layers[i - 1]] = [layers[i - 1], layers[i]]; break;
    case 'ren': {
      const name = prompt('레이어 이름', l.name);
      if (!name || !name.trim()) return;
      l.name = name.trim().slice(0, 40);
      break;
    }
    case 'del': {
      if (layers.length === 1) return;
      const n = layerCounts().get(l.id) || 0;
      if (n && !confirm(`"${l.name}" 레이어와 그 안의 객체 ${n}개를 모든 페이지에서 삭제할까요?`)) return;
      const d = state.doc;
      tools.clearSelection();
      if (d && n) {
        // 객체 삭제는 한 번의 실행 취소로 되돌릴 수 있다 (되돌린 객체는 맨 아래 레이어로 들어감)
        d.begin();
        for (const [p, items] of [...d.pages]) if (items.some((it) => layerOf(it) === l.id)) d.setItems(p, items.filter((it) => layerOf(it) !== l.id));
        d.commit();
      }
      layers.splice(i, 1);
      if (activeLayer === l.id) activeLayer = layers[Math.min(i, layers.length - 1)].id;
      toast(`"${l.name}" 레이어를 삭제했습니다${n ? ' · 실행 취소하면 객체는 맨 아래 레이어로 돌아옵니다' : ''}`);
      break;
    }
  }
  applyLayers();
});

$('#lyAdd').addEventListener('click', () => {
  const nums = layers.map((l) => +(/^레이어 (\d+)$/.exec(l.name)?.[1] || 0));
  const l = { id: 'L' + uid('').replace(/\W/g, '').slice(-10), name: `레이어 ${Math.max(layers.length, ...nums) + 1}`, visible: true, locked: false };
  // 현재 레이어 바로 위에 추가하고 현재 레이어로
  const i = layers.findIndex((x) => x.id === activeLayer);
  layers.splice(i + 1, 0, l);
  activeLayer = l.id;
  applyLayers();
});

$('#lyMoveSel').addEventListener('click', () => {
  const sel = tools.selection, d = state.doc;
  if (!sel || !d) return;
  const ly = activeLayer === DEFAULT_LAYER ? null : activeLayer;
  d.setItems(sel.page, d.items(sel.page).map((it) => {
    if (!sel.ids.has(it.id)) return it;
    if (ly) return { ...it, ly };
    const { ly: _old, ...rest } = it;
    return rest;
  }));
  toast(`선택한 객체 ${sel.ids.size}개를 "${layerById(activeLayer).name}"(으)로 옮겼습니다`);
  renderLayers();
});

function openLayerPanel() {
  closeToolPopup();
  $('#audioPanel').hidden = true;
  $('#aiPanel').hidden = true;
  $('#clockPanel').hidden = true;
  $('#layerPanel').hidden = false;
  renderLayers();
}
$('#btnLayers').addEventListener('click', () => { if ($('#layerPanel').hidden) openLayerPanel(); else $('#layerPanel').hidden = true; });
$('#lyClose').addEventListener('click', () => { $('#layerPanel').hidden = true; });
$('#layerChip').addEventListener('click', () => { if ($('#layerPanel').hidden) openLayerPanel(); else $('#layerPanel').hidden = true; });

// ───────────────────────────── 스톱워치 · 타이머 ─────────────────────────────

const clock = new Clock();
let clockTab = 'sw', clockTimer = { ms: 0, id: 0 };
for (const m of [1, 3, 5, 10, 15, 25, 30, 60]) {
  const b = document.createElement('button');
  b.textContent = `${m}분`;
  b.addEventListener('click', () => { clock.tmSet(m * 60000); syncTmInputs(); });
  $('#tmPresets').appendChild(b);
}
function syncTmInputs() {
  const t = clock.tm.total;
  $('#tmMin').value = Math.floor(t / 60000);
  $('#tmSec').value = Math.floor(t / 1000) % 60;
}

/** 화면 갱신: 패널이 열려 있으면 0.1초, 닫혀 있으면 위쪽 표시만 1초마다 (도는 게 없으면 멈춤) */
function renderClock() {
  const open = !$('#clockPanel').hidden;
  const sw = clock.sw, tm = clock.tm;
  if (open) {
    $('#swTime').textContent = fmtClock(clock.swElapsed(), true);
    $('#swStart').textContent = sw.running ? '일시정지' : (clock.swElapsed() ? '계속' : '시작');
    $('#tmTime').textContent = tm.done ? '끝!' : fmtClock(clock.tmLeft());
    $('#tmTime').classList.toggle('done', tm.done);
    $('#tmStart').textContent = tm.running ? '일시정지' : (tm.left > 0 && tm.left < tm.total ? '계속' : '시작');
  }
  // 위쪽 표시: 타이머 우선, 없으면 스톱워치
  const chip = $('#clockChip');
  const showTm = tm.running || tm.done, showSw = sw.running && !showTm;
  chip.hidden = !(showTm || showSw);
  chip.classList.toggle('done', tm.done);
  if (showTm) chip.querySelector('span').textContent = tm.done ? '타이머 끝' : fmtClock(clock.tmLeft());
  else if (showSw) chip.querySelector('span').textContent = fmtClock(clock.swElapsed());
  const running = sw.running || tm.running;
  const want = running ? (open ? 100 : 1000) : 0;
  if (want !== clockTimer.ms) {
    clearInterval(clockTimer.id);
    clockTimer = want ? { ms: want, id: setInterval(renderClock, want) } : { ms: 0, id: 0 };
  }
}
function renderLaps() {
  const laps = clock.sw.laps;
  $('#swLaps').innerHTML = laps.map((t, i) => {
    const split = t - (laps[i + 1] || 0);
    return `<li value="${laps.length - i}">${fmtClock(t, true)}<small>+${fmtClock(split, true)}</small></li>`;
  }).join('');
}
clock.on('change', () => { renderClock(); renderLaps(); });
clock.on('ring', ({ late }) => {
  renderClock();
  if (late) { toast('⏰ 앱이 꺼져 있는 동안 타이머가 끝났습니다'); return; }
  ringSound();
  try { navigator.vibrate?.([300, 150, 300, 150, 300]); } catch { /* */ }
  toast('⏰ 타이머가 끝났습니다', { ms: 6000 });
});
// 백그라운드에 있다 돌아오면 끝났는지 확인 (백그라운드 탭은 타이머가 늦게 울림)
document.addEventListener('visibilitychange', () => { if (!document.hidden) clock.check(); });

function setClockTab(tab) {
  clockTab = tab;
  $('#ckTabs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.value === tab));
  $('#ckSw').hidden = tab !== 'sw';
  $('#ckTm').hidden = tab !== 'tm';
}
function openClockPanel() {
  closeToolPopup();
  for (const id of ['#audioPanel', '#aiPanel', '#layerPanel']) $(id).hidden = true;
  $('#clockPanel').hidden = false;
  // 타이머가 돌거나 끝났으면 타이머 탭부터
  setClockTab(clock.tm.running || clock.tm.done ? 'tm' : clockTab);
  syncTmInputs();
  renderLaps();
  renderClock();
}
function closeClockPanel() { $('#clockPanel').hidden = true; clock.ackDone(); renderClock(); }
$('#btnClock').addEventListener('click', () => { if ($('#clockPanel').hidden) openClockPanel(); else closeClockPanel(); });
$('#clockChip').addEventListener('click', openClockPanel);
$('#ckClose').addEventListener('click', closeClockPanel);
$('#ckTabs').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setClockTab(b.value)));
$('#swStart').addEventListener('click', () => clock.swToggle());
$('#swLap').addEventListener('click', () => clock.swLap());
$('#swReset').addEventListener('click', () => clock.swReset());
$('#tmStart').addEventListener('click', () => clock.tmToggle());
$('#tmPlus').addEventListener('click', () => clock.tmAdd(60000));
$('#tmReset').addEventListener('click', () => clock.tmReset());
$('#tmApply').addEventListener('click', () => {
  const ms = ((parseInt($('#tmMin').value, 10) || 0) * 60 + (parseInt($('#tmSec').value, 10) || 0)) * 1000;
  if (ms < 1000) { toast('1초 이상으로 정하세요'); return; }
  clock.tmSet(ms);
});
clock.schedule();
clock.check(true); // 앱이 꺼져 있던 동안 끝났는지
renderClock();

// ───────────────────────────── 글자 찾기 (Ctrl+F) ─────────────────────────────

const pdfIndex = { pdf: null, pages: new Map() }; // 페이지 글자 색인 캐시 (PDF 가 바뀌면 비움)
let searchJob = 0;
let searchHits = []; // [{page, rects}] 문서 순서
let searchCur = -1;

function openSearch(replace = false) {
  if (!state.doc) return;
  const bar = $('#searchBar'), inp = $('#searchInput');
  $('#searchReplace').hidden = !hwp; // 바꾸기는 한글 문서에서
  inp.placeholder = hwp ? '한글 문서에서 찾기' : 'PDF 글자·직접 쓴 글 찾기';
  if (hwp && replace && inp.value) setTimeout(() => $('#replaceInput').focus(), 0);
  commitTextEdit();
  bar.hidden = false;
  $('#btnSearch').classList.add('on');
  inp.focus();
  inp.select();
  if (inp.value) runSearch();
}
function closeSearch() {
  searchJob++;
  $('#searchBar').hidden = true;
  $('#btnSearch').classList.remove('on');
  searchHits = []; searchCur = -1;
  if (viewer.search) { viewer.search = null; viewer.requestInk(); }
  if (typing && typingFind.hits.length) { typingFind = { hits: [], cur: -1 }; typingMod.setSearchHits(typing.ed.editor, []); }
  $('#searchInput').blur();
}
const searchSoon = debounce(() => runSearch({ keepPlace: true }), 250);

async function pageTextIndex(i) {
  if (pdfIndex.pdf !== state.pdf) { pdfIndex.pdf = state.pdf; pdfIndex.pages.clear(); }
  let idx = pdfIndex.pages.get(i);
  if (!idx) {
    const pg = await state.pdf.getPage(i + 1);
    const tc = await pg.getTextContent();
    idx = buildPdfIndex(tc.items, pg.getViewport({ scale: 1 }).transform, tc.styles);
    pdfIndex.pages.set(i, idx);
  }
  return idx;
}

/** 모든 페이지를 차례로 찾는다 (긴 PDF 도 화면이 멈추지 않게 나눠서, 찾는 중에도 개수가 늘어남) */
async function runSearch({ keepPlace = false } = {}) {
  if (hwp) return hwpRunSearch();
  if (typing) return typingRunSearch(keepPlace);
  const job = ++searchJob, d = state.doc;
  const q = prepQuery($('#searchInput').value);
  const prevCur = searchHits[searchCur];
  searchHits = []; searchCur = -1;
  const count = $('#searchCount');
  count.classList.remove('none');
  if (!q || !d) { count.textContent = ''; viewer.search = null; viewer.requestInk(); return; }
  const n = viewer.pages.length, start = viewer.currentPage();
  let pdfChars = 0;
  for (let i = 0; i < n; i++) {
    let hits = [];
    if (state.pdf) {
      try { const idx = await pageTextIndex(i); pdfChars += idx.text.length; hits = findInIndex(idx, q); } catch (e) { console.warn('[search] page', i, e); }
    }
    if (job !== searchJob) return; // 그사이 검색어가 바뀜
    hits.push(...findInItems(d.items(i), q, bbox));
    hits.sort((a, b) => a.rects[0].y - b.rects[0].y || a.rects[0].x - b.rects[0].x); // 위에서 아래, 왼쪽에서 오른쪽
    for (const hm of hits) searchHits.push({ page: i, rects: hm.rects });
    // 처음 결과: 지금 보는 페이지(또는 그 뒤)의 첫 결과로 바로 이동
    if (searchCur < 0 && !keepPlace && searchHits.length && (i >= start || i === n - 1)) {
      searchCur = Math.max(0, searchHits.findIndex((hm) => hm.page >= start));
      showSearchHit(true);
    }
    if (i % 8 === 7 || i === n - 1) { updateSearchView(n, i + 1); await new Promise((r) => setTimeout(r, 0)); if (job !== searchJob) return; }
  }
  if (keepPlace && searchHits.length) {
    // 글이 바뀌어 다시 찾은 경우: 보던 결과 근처 유지 (화면은 움직이지 않음)
    const k = prevCur ? searchHits.findIndex((hm) => hm.page > prevCur.page || (hm.page === prevCur.page && hm.rects[0].y >= prevCur.rects[0].y - 1)) : 0;
    searchCur = k < 0 ? searchHits.length - 1 : k;
  }
  if (searchCur < 0 && searchHits.length) { searchCur = 0; showSearchHit(true); }
  updateSearchView(n, n);
  if (!searchHits.length) {
    count.classList.add('none');
    count.textContent = state.pdf && !pdfChars ? '없음 · 이 PDF는 글자 정보가 없어요(스캔본)' : '없음';
  }
}

function updateSearchView(n, done) {
  const by = new Map();
  searchHits.forEach((hm) => { if (!by.has(hm.page)) by.set(hm.page, []); by.get(hm.page).push(hm); });
  const cur = searchHits[searchCur];
  viewer.search = { hits: by, cur: cur ? { page: cur.page, i: by.get(cur.page).indexOf(cur) } : null };
  viewer.requestInk();
  if (searchHits.length) $('#searchCount').textContent = `${searchCur + 1} / ${searchHits.length}${done < n ? '…' : ''}`;
  else if (done < n) $('#searchCount').textContent = `찾는 중… ${done}/${n}쪽`;
}

function showSearchHit(move) {
  const hm = searchHits[searchCur];
  if (!hm) return;
  updateSearchView(1, 1);
  if (move) {
    const r = hm.rects[0];
    viewer.revealRect(hm.page, r);
  }
}
function stepSearch(dir) {
  if (hwp) { hwpFind(dir > 0 ? 'forward' : 'backward'); return; }
  if (typing) { typingStepSearch(dir); return; }
  if (!searchHits.length) { runSearch(); return; }
  searchCur = (searchCur + dir + searchHits.length) % searchHits.length;
  showSearchHit(true);
  $('#searchCount').textContent = `${searchCur + 1} / ${searchHits.length}`;
}

$('#btnSearch').addEventListener('click', () => ($('#searchBar').hidden ? openSearch() : closeSearch()));

// 타이핑형·Word 문서 본문 찾기: 편집기 글에서 (찾은 곳 노랑, 지금 결과 주황), 결과로 화면 이동
let typingFind = { hits: [], cur: -1 };
function typingRunSearch(keepPlace) {
  const ed = typing.ed.editor, count = $('#searchCount');
  const q = prepQuery($('#searchInput').value);
  count.classList.remove('none');
  const hits = q ? typingMod.findText(ed.state.doc, q) : [];
  let cur = -1;
  if (hits.length) {
    if (keepPlace && typingFind.hits[typingFind.cur]) { const was = typingFind.hits[typingFind.cur].from; cur = hits.findIndex((x) => x.from >= was); }
    else { const at = ed.state.selection.from; cur = hits.findIndex((x) => x.from >= at); } // 커서 뒤 첫 결과부터
    if (cur < 0) cur = 0;
  }
  typingFind = { hits, cur };
  typingMod.setSearchHits(ed, hits, cur);
  if (!q) count.textContent = '';
  else if (!hits.length) { count.textContent = '없음'; count.classList.add('none'); }
  else { count.textContent = `${cur + 1} / ${hits.length}`; if (!keepPlace) revealTypingPos(hits[cur].from); }
}
function typingStepSearch(dir) {
  const { hits } = typingFind;
  if (!hits.length) { typingRunSearch(false); return; }
  const cur = (typingFind.cur + dir + hits.length) % hits.length;
  typingFind.cur = cur;
  typingMod.setSearchHits(typing.ed.editor, hits, cur);
  $('#searchCount').textContent = `${cur + 1} / ${hits.length}`;
  revealTypingPos(hits[cur].from);
}
/** 문서 위치가 화면 안(찾기 막대·도구 모음에 가리지 않게)에 오도록 화면 이동 */
function revealTypingPos(pos) {
  let c;
  try { c = typing.ed.editor.view.coordsAtPos(pos); } catch { return; }
  const vr = $('#viewport').getBoundingClientRect();
  const top = vr.top + viewer.insetTop + 70, bottom = vr.bottom - 90;
  let dy = 0, dx = 0;
  if (c.top < top || c.bottom > bottom) dy = c.top - (top + (bottom - top) / 3);
  if (c.left < vr.left + 16) dx = c.left - vr.left - 40;
  else if (c.right > vr.right - 16) dx = c.right - vr.right + 40;
  if (dx || dy) viewer.setCamera(viewer.cam.tx - dx, viewer.cam.ty - dy, viewer.cam.z);
}

// 한글 문서 찾기·바꾸기: 엔진의 문서 전체 색인으로 (찾으면 문서에서 그 글자를 선택)
let hwpSearchJob = 0;
async function hwpRunSearch() {
  const job = ++hwpSearchJob, q = $('#searchInput').value, count = $('#searchCount');
  count.classList.remove('none');
  if (!q || !hwp?.session) { count.textContent = ''; return; }
  try {
    const n = await hwp.session.count(q);
    if (job !== hwpSearchJob) return;
    count.textContent = n ? `${n}개` : '없음';
    count.classList.toggle('none', !n);
  } catch (e) { console.warn('[hwp search]', e); count.textContent = ''; }
}
async function hwpFind(dir) {
  const q = $('#searchInput').value;
  if (!q || !hwp?.session) return;
  try {
    const r = await hwp.session.find(q, dir);
    if (r !== 'selected') { $('#searchCount').textContent = '없음'; $('#searchCount').classList.add('none'); }
  } catch (e) { console.warn('[hwp find]', e); toast('찾지 못했습니다: ' + (e?.message || e), { ms: 2500 }); }
}
$('#replaceOne').addEventListener('click', async () => {
  const q = $('#searchInput').value, r = $('#replaceInput').value;
  if (!q || !hwp?.session) return;
  const done = await hwp.session.replaceSelection(q, r).catch(() => false);
  if (!done) { await hwpFind('forward'); return; } // 먼저 찾아서 선택
  await hwpFind('forward');
  hwpRunSearch();
});
$('#replaceAll').addEventListener('click', async () => {
  const q = $('#searchInput').value, r = $('#replaceInput').value;
  if (!q || !hwp?.session) return;
  const n = await hwp.session.count(q).catch(() => 0);
  const res = await hwp.session.replaceAll(q, r).catch((e) => e?.message || String(e));
  if (res === 'done') toast(`${n}곳을 바꿨습니다`, { ms: 2200 });
  else if (res === 'none') toast('바꿀 곳이 없습니다', { ms: 1800 });
  else toast(res, { error: true, ms: 3500 });
  hwpRunSearch();
});
$('#replaceInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); $('#replaceOne').click(); } else if (e.key === 'Escape') closeSearch(); });
$('#searchClose').addEventListener('click', closeSearch);
$('#searchNext').addEventListener('click', () => stepSearch(1));
$('#searchPrev').addEventListener('click', () => stepSearch(-1));
$('#searchInput').addEventListener('input', debounce(() => runSearch(), 250));
$('#searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); stepSearch(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
});

// ───────────────────────────── 링크 ─────────────────────────────

let backAnchor = null;

/** 화면 점의 사용자 링크(맨 위) 또는 이미 읽어 둔 PDF 링크. 없으면 null (마우스 커서·클릭용, 동기) */
function linkAtScreen(sx, sy) {
  if (!state.doc) return null;
  const hit = viewer.pageAtScreen(sx, sy, true);
  if (!hit) return null;
  const u = userLinkAt(hit.page, hit.x, hit.y);
  if (u) return { to: u.to };
  const pl = viewer.pages[hit.page]?.links; // pdfLinks() 가 읽어 둔 결과
  if (!pl && !viewer.surface) viewer.pdfLinks(hit.page); // 다음 조회부터 쓰도록 읽기 시작
  const l = pl?.find((r) => hit.x >= r.x && hit.x <= r.x + r.w && hit.y >= r.y && hit.y <= r.y + r.h);
  return l ? { pdf: l, page: hit.page } : null;
}

/** 페이지 좌표의 사용자 링크 (점선 사각형 또는 위쪽 이름표) */
function userLinkAt(page, x, y) {
  const items = state.doc.items(page);
  const folded = foldHidden(items);
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.t === 'ln' && !layerHidden(it) && !folded?.has(it.id) && linkHit(it, x, y)) return it;
  }
  return null;
}

async function followLinkAt(sx, sy) {
  if (!state.doc) return;
  if (typing && settings.get('tool') === 'type') { typingTap(sx, sy); return; } // 타이핑형: 손가락 탭 = 그 자리에 커서
  const hit = viewer.pageAtScreen(sx, sy, true);
  if (!hit) return;
  if (tapObjectAt(hit.page, hit.x, hit.y)) return; // 손가락 탭으로도 포스트잇 접기/펼치기·체크
  if (player && seekToInkAt(hit.page, hit.x, hit.y)) return; // 녹음 재생 중: 탭한 필기를 쓰던 순간으로
  const inside = (r) => hit.x >= r.x && hit.x <= r.x + r.w && hit.y >= r.y && hit.y <= r.y + r.h;
  const u = userLinkAt(hit.page, hit.x, hit.y);
  if (u) { followTarget(u.to); return; }
  if (viewer.surface) return; // 무한 캔버스·스크롤에는 PDF 링크가 없음
  const links = await viewer.pdfLinks(hit.page);
  const l = links.find(inside);
  if (!l) return;
  if (l.url) { followTarget({ url: l.url }); return; }
  const d = await viewer.resolveDest(l.dest).catch(() => null);
  if (d) followTarget(d); else toast('이 링크의 목적지를 찾을 수 없습니다');
}

function followTarget(to) {
  if (to?.url) {
    if (confirm(`외부 링크를 열까요?\n${to.url}`)) window.open(to.url, '_blank', 'noopener');
    return;
  }
  if (!Number.isInteger(to?.page) || !viewer.pages[to.page]) { toast('링크 대상 페이지가 없습니다 (삭제되었을 수 있음)'); return; }
  const eng = viewer.surface;
  backAnchor = viewer.anchor();
  const from = eng?.kind === 'scroll' ? eng.currentSheet(viewer) + 1 : viewer.currentPage() + 1;
  viewer.goToPage(to.page, to.y || 0);
  const chip = $('#backChip');
  chip.querySelector('span').textContent = `돌아가기 (${from}쪽)`;
  chip.hidden = false;
}
$('#backChip').addEventListener('click', () => {
  if (backAnchor) { if (viewer.surface) viewer.restoreView(backAnchor); else viewer.restoreAnchor(backAnchor); }
  backAnchor = null;
  $('#backChip').hidden = true;
});

const lnDlg = $('#linkDlg');
let lnEditing = null;
function setLinkKind(kind) {
  lnDlg.querySelectorAll('#lnKind button').forEach((b) => b.classList.toggle('on', b.value === kind));
  $('#lnPageRow').hidden = kind !== 'page';
  $('#lnUrlRow').hidden = kind !== 'url';
  lnEditing.kind = kind;
  linkError(null);
}
/** 링크로 갈 수 있는 페이지 수: PDF 노트는 페이지, 무한 스크롤은 시트(인쇄 페이지), 무한 캔버스는 없음 */
function linkPageCount() {
  const eng = viewer.surface;
  if (!eng || eng.kind === 'typing') return viewer.pages.length;
  return eng.kind === 'scroll' ? Math.round(viewer.pages[0].h / eng.sheetH) : 0;
}
function linkError(msg, input) {
  const el = $('#lnErr');
  el.textContent = msg || '';
  el.hidden = !msg;
  for (const i of [$('#lnPage'), $('#lnUrl')]) i.classList.toggle('err', !!msg && i === input);
  if (msg && input) input.focus();
}
/** 입력 확인 → 링크 대상 {url} | {page[, sheet, y]}. 틀리면 오류를 보여 주고 null */
function linkTarget() {
  if (lnEditing.kind === 'url') {
    let u = $('#lnUrl').value.trim();
    if (!u) { linkError('주소를 입력하세요', $('#lnUrl')); return null; }
    if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
    if (!/^(https?:|mailto:|tel:)/i.test(u)) { linkError('http(s), mailto, tel 주소만 쓸 수 있습니다', $('#lnUrl')); return null; }
    if (/^https?:/i.test(u)) { try { if (!new URL(u).hostname.includes('.') && !/^https?:\/\/localhost/i.test(u)) throw 0; } catch { linkError('올바른 웹 주소가 아닙니다 (예: example.com)', $('#lnUrl')); return null; } }
    return { url: u };
  }
  const max = linkPageCount();
  const n = Number($('#lnPage').value);
  if (!Number.isInteger(n) || n < 1 || n > max) { linkError(`1~${max} 사이의 페이지 번호를 입력하세요`, $('#lnPage')); return null; }
  const eng = viewer.surface;
  if (eng?.kind === 'scroll') return { page: 0, sheet: n - 1, y: (n - 1) * eng.sheetH };
  return { page: n - 1 };
}
lnDlg.querySelectorAll('#lnKind button').forEach((b) => b.addEventListener('click', () => setLinkKind(b.value)));
function editLink(page, item, rect) {
  const pages = linkPageCount();
  lnEditing = { page, item, rect, kind: item?.to?.url || !pages ? 'url' : 'page' };
  lnDlg.querySelector('#lnKind button[value=page]').hidden = !pages; // 무한 캔버스: 웹 주소만
  $('#lnPage').max = pages;
  $('#lnPage').value = Number.isInteger(item?.to?.sheet) ? item.to.sheet + 1 : Number.isInteger(item?.to?.page) ? item.to.page + 1 : '';
  $('#lnUrl').value = item?.to?.url || '';
  $('#lnDelete').hidden = !item;
  setLinkKind(lnEditing.kind);
  lnDlg.showModal();
}
// 저장: 입력이 틀리면 창을 닫지 않는다 (입력한 내용·기존 링크 그대로)
lnDlg.querySelector('form').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'ok' || !lnEditing) return;
  const to = linkTarget();
  if (!to) { e.preventDefault(); return; }
  lnEditing.to = to;
});
// 입력칸에서 Enter = 저장 (form 의 첫 버튼은 닫기라 기본 동작은 취소가 됨)
for (const i of [$('#lnPage'), $('#lnUrl')]) {
  i.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); lnDlg.querySelector('button[value=ok]').click(); } });
  i.addEventListener('input', () => linkError(null));
}
lnDlg.addEventListener('close', () => {
  const ed = lnEditing, doc = state.doc;
  lnEditing = null;
  linkError(null);
  if (!ed || !doc) return;
  const rv = lnDlg.returnValue;
  const items = doc.items(ed.page);
  if (rv === 'delete' && ed.item) { doc.setItems(ed.page, items.filter((i) => i.id !== ed.item.id)); return; }
  if (rv !== 'ok' || !ed.to) return;
  const to = ed.to;
  if (ed.item) doc.setItems(ed.page, items.map((i) => (i.id === ed.item.id ? { ...i, to } : i)));
  else {
    // 포스트잇 위에 만든 링크는 포스트잇과 같은 레이어로 (포스트잇에 가려지지 않고 함께 움직이게)
    const n = noteAtPoint(ed.page, ed.rect.x, ed.rect.y);
    doc.add(ed.page, { id: uid('ln'), t: 'ln', ...ed.rect, to, ...(n ? { ly: layerOf(n) } : {}) });
  }
});

// ───────────────────────────── Undo / Redo ─────────────────────────────

function doUndo() {
  if (!state.doc) return;
  if (hwp && !hwp.ink?.mode) { hwp.session?.undo(); setTimeout(updateHistoryButtons, 300); return; } // 필기 중이면 아래(노트 필기) 실행 취소
  if (typing && settings.get('tool') === 'type') { typing.ed.editor.chain().focus().undo().run(); return; }
  commitTextEdit();
  const page = state.doc.undo();
  if (page == null) { toast('더 이상 실행 취소할 수 없습니다', { ms: 1200 }); return; }
  tools.validateSelection();
  toast('실행 취소', { ms: 900 });
}
function doRedo() {
  if (!state.doc) return;
  if (hwp && !hwp.ink?.mode) { hwp.session?.redo(); setTimeout(updateHistoryButtons, 300); return; }
  if (typing && settings.get('tool') === 'type') { typing.ed.editor.chain().focus().redo().run(); return; }
  const page = state.doc.redo();
  if (page == null) { toast('다시 실행할 항목이 없습니다', { ms: 1200 }); return; }
  tools.validateSelection();
  toast('다시 실행', { ms: 900 });
}
function updateHistoryButtons() {
  const d = state.doc;
  if (hwp) {
    const inkMode = !!hwp.ink?.mode;
    const u = inkMode ? !d?.canUndo() : !hwp.session?.canUndo(), r = inkMode ? !d?.canRedo() : !hwp.session?.canRedo();
    $('#btnUndo').disabled = u; $('#btnRedo').disabled = r;
    $('#hwpBar [data-hb=undo]').disabled = u; $('#hwpBar [data-hb=redo]').disabled = r;
    return;
  }
  if (typing && settings.get('tool') === 'type') {
    const ed = typing.ed.editor;
    $('#btnUndo').disabled = !ed.can().undo();
    $('#btnRedo').disabled = !ed.can().redo();
    return;
  }
  $('#btnUndo').disabled = !d?.canUndo();
  $('#btnRedo').disabled = !d?.canRedo();
}
// 손가락 쓰기: 펜이 없는 휴대폰용. 켜면 한 손가락은 필기, 두 손가락은 이동·확대
function renderFingerBtn() { $('#btnFinger').classList.toggle('on', settings.get('fingerDraw')); }
$('#btnFinger').addEventListener('click', () => {
  settings.set('fingerDraw', !settings.get('fingerDraw'));
  toast(settings.get('fingerDraw') ? '손가락으로 쓰기: 한 손가락 필기, 두 손가락으로 이동·확대' : '손가락은 화면 이동만 (필기는 펜으로)', { ms: 2500 });
});
settings.on('change', ({ path }) => { if (path === 'fingerDraw' || path === '*') renderFingerBtn(); });
renderFingerBtn();

$('#btnRuler').addEventListener('click', () => {
  const on = app.guides.toggleRuler();
  $('#btnRuler').classList.toggle('on', on);
  if (on) toast('자: 손가락으로 끌어 이동, 두 손가락으로 회전. 모서리를 따라 펜으로 그으면 직선', { ms: 3500 });
});
$('#btnProt').addEventListener('click', () => {
  const on = app.guides.toggleProtractor();
  $('#btnProt').classList.toggle('on', on);
  if (on) toast('각도기: 손가락으로 이동·회전. 호/밑변을 따라 그리기, 펜 위치의 각도 표시', { ms: 3500 });
});
$('#btnUndo').addEventListener('click', doUndo);
$('#btnRedo').addEventListener('click', doRedo);

document.addEventListener('keydown', (e) => {
  if (state.screen !== 'editor') return;
  // Ctrl+F: 브라우저 찾기 대신 앱 검색 (PDF 글자는 그림으로 그려져 브라우저가 못 찾음)
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && e.target.id !== 'textEditor') { e.preventDefault(); openSearch(!!hwp); return; }
  if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) {
    if (e.target.id === 'textEditor' && e.key === 'Escape') { e.preventDefault(); commitTextEdit(); }
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (hwp) { // 한글 문서: 글 입력은 엔진이 받음. 밖(도구 모음 등)에 초점이 있을 때 실행 취소만
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(); }
    return;
  }
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && tools.selection) { e.preventDefault(); tools.deleteSelection(); }
  else if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); }
  else if (mod && e.key.toLowerCase() === 'c' && tools.selection) { e.preventDefault(); copySelection(false); }
  else if (mod && e.key.toLowerCase() === 'x' && tools.selection) { e.preventDefault(); copySelection(true); }
  else if (mod && e.key.toLowerCase() === 'v' && clip) {
    // 시스템 클립보드에 그림이 있으면 그 그림(paste 이벤트)이 먼저, 없으면 앱 안에서 복사한 객체
    pendingClipPaste = true;
    setTimeout(() => { if (pendingClipPaste) { pendingClipPaste = false; pasteClip(); } }, 40);
  }
  else if (mod && e.key.toLowerCase() === 'd' && tools.selection) { e.preventDefault(); tools.duplicateSelection(); }
  else if (mod && e.key.toLowerCase() === 'g' && tools.selection) { e.preventDefault(); arrangeSelection(e.shiftKey ? 'ungroup' : 'group'); }
  else if (mod && (e.code === 'BracketRight' || e.code === 'BracketLeft') && tools.selection) {
    e.preventDefault();
    const up = e.code === 'BracketRight';
    arrangeSelection(e.shiftKey ? (up ? 'z-front' : 'z-back') : (up ? 'z-forward' : 'z-backward'));
  }
  else if (e.key.startsWith('Arrow') && tools.selection) {
    // 화살표: 1pt, Shift+화살표: 10pt
    e.preventDefault();
    const k = e.shiftKey ? 10 : 1, sel = tools.selection;
    const dx = e.key === 'ArrowLeft' ? -k : e.key === 'ArrowRight' ? k : 0, dy = e.key === 'ArrowUp' ? -k : e.key === 'ArrowDown' ? k : 0;
    state.doc.setItems(sel.page, nudgeItems(state.doc.items(sel.page), sel.ids, dx, dy));
    tools.setSelection({ page: sel.page, ids: new Set(sel.ids) });
  }
  else if (e.key === 'Escape') { tools.clearSelection(); closeQuickMenu(); closeToolPopup(); }
  else if (e.key === 'PageDown') viewer.goToPage(viewer.currentPage() + 1);
  else if (e.key === 'PageUp') viewer.goToPage(viewer.currentPage() - 1);
  else if (!mod && !e.altKey) {
    const map = { p: 'pen', h: 'hl', e: 'eraser', l: 'lasso', t: 'text', s: 'shape', k: 'link' };
    if (map[e.key]) selectTool(map[e.key]);
  }
});

// ───────────────────────────── 도구 모음 ─────────────────────────────

const TOOL_NAMES = { type: '입력', pen: '펜', hl: '형광펜', eraser: '지우개', lasso: '올가미', text: '텍스트', shape: '도형', link: '링크' };

function toolCfgKey(tool) { return ['pen', 'hl', 'text', 'shape'].includes(tool) ? tool : null; }

// 지우개로 바꾸기 직전의 도구 (지우개 "한 번 쓰고 돌아가기"용)
let toolBeforeEraser = settings.get('tool') === 'eraser' ? 'pen' : settings.get('tool');
// 직전에 쓰던 도구 ("직전에 쓴 도구로" 제스처용)
let previousTool = settings.get('tool') === 'pen' ? 'hl' : 'pen';

function selectTool(tool) {
  const prev = settings.get('tool');
  if (prev !== tool) {
    if (tool === 'eraser') toolBeforeEraser = prev;
    previousTool = prev;
    commitTextEdit();
    if (tool !== 'lasso') tools.clearSelection();
    settings.set('tool', tool);
  }
  renderToolbar();
}

function renderToolbar() {
  const tool = settings.get('tool');
  $('#viewport').classList.toggle('tool-type', tool === 'type');
  if (tool !== 'type' && typing?.ed.editor.isFocused) typing.ed.editor.commands.blur(); // 펜으로 바꾸면 키보드 내림
  if (typing) updateHistoryButtons();
  for (const b of document.querySelectorAll('#toolbar [data-tool], #quickMenu [data-tool]')) b.classList.toggle('on', b.dataset.tool === tool);
  for (const k of ['pen', 'hl']) { const m = settings.get(k).mode; for (const b of document.querySelectorAll(`#toolbar [data-tool=${k}]`)) b.dataset.mode = m === 'free' ? '' : m; } // 직선·도형 모드 표시
  const key = toolCfgKey(tool);
  const qc = $('#quickColors');
  qc.innerHTML = '';
  if (key) {
    const cfg = settings.get(key);
    const recent = key === 'pen' || key === 'hl' ? cfg.recent : [cfg.color];
    for (const c of recent) qc.appendChild(swatch(c, c === cfg.color, () => setColor(key, c)));
  }
  qc.hidden = !key;
  const wd = $('#widthDot');
  wd.hidden = !(key === 'pen' || key === 'hl' || key === 'shape');
  if (!wd.hidden) {
    const cfg = settings.get(key);
    const px = clamp(cfg.width * (key === 'hl' ? 0.9 : 2.2), 3, 26);
    const i = wd.querySelector('i');
    i.style.width = i.style.height = px + 'px';
    i.style.background = cfg.color;
    i.style.boxShadow = 'inset 0 0 0 1px rgba(0,0,0,.2)';
  }
}

function swatch(color, on, onClick) {
  const b = document.createElement('button');
  b.className = 'swatch' + (on ? ' on' : '');
  b.style.background = color;
  b.title = color;
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}

function setColor(key, color) {
  const cfg = { ...settings.get(key), color };
  if (cfg.recent) cfg.recent = [color, ...cfg.recent.filter((c) => c !== color)].slice(0, 3);
  settings.set(key, cfg);
  if (state.editing && key === 'text') { $('#textEditor').style.color = color; }
  renderToolbar();
  if (!$('#toolPopup').hidden) renderToolPopup(settings.get('tool'));
}

for (const b of document.querySelectorAll('#toolbar [data-tool]')) {
  b.addEventListener('click', () => {
    const t = b.dataset.tool;
    if (settings.get('tool') === t) {
      if ($('#toolPopup').hidden) openToolPopup(t); else closeToolPopup();
    } else { selectTool(t); closeToolPopup(); }
  });
}
$('#widthDot').addEventListener('click', () => { if ($('#toolPopup').hidden) openToolPopup(settings.get('tool')); else closeToolPopup(); });

function openToolPopup(tool) {
  renderToolPopup(tool);
  const pop = $('#toolPopup');
  pop.hidden = false;
  const tb = $('#toolbar').getBoundingClientRect();
  const ed = $('#editor').getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  // 도구 모음 옆에 띄운다: 세로면 화면 안쪽(왼쪽 모음 → 오른쪽에), 가로면 위·아래 중 넓은 쪽
  if ($('#toolbar').classList.contains('vertical')) {
    const right = tb.left + tb.width / 2 < ed.left + ed.width / 2;
    pop.style.left = clamp(right ? tb.right - ed.left + 10 : tb.left - ed.left - w - 10, 8, ed.width - w - 8) + 'px';
    pop.style.top = clamp(tb.top + tb.height / 2 - h / 2 - ed.top, 60, ed.height - h - 8) + 'px';
  } else {
    pop.style.left = clamp(tb.left + tb.width / 2 - w / 2 - ed.left, 8, ed.width - w - 8) + 'px';
    const above = tb.top - ed.top > ed.bottom - tb.bottom;
    pop.style.top = (above ? tb.top - ed.top - h - 10 : tb.bottom - ed.top + 10) + 'px';
  }
}
function closeToolPopup() { $('#toolPopup').hidden = true; }

// ── 도구 모음 옮기기·방향 (플렉슬처럼) ──
// 손잡이(⋮⋮)를 끌어 놓으면 가장자리 가까이면 붙고(위·아래 = 가로, 왼쪽·오른쪽 = 세로), 아니면 그 자리에 떠 있다.
// 손잡이를 탭하면 가로/세로가 바뀐다. 위치는 settings.toolbar 에 저장.
const DOCK_SNAP = 90; // 손가락(펜)을 가장자리에서 이 거리(px) 안에서 놓으면 그쪽에 붙임
function applyToolbarPos() {
  const tbEl = $('#toolbar'), ed = $('#editor');
  const t = settings.get('toolbar');
  const vertical = t.dock === 'left' || t.dock === 'right' ? true : t.dock === 'float' ? !!t.vertical : false;
  tbEl.classList.remove('dock-bottom', 'dock-top', 'dock-left', 'dock-right', 'float');
  tbEl.classList.add(t.dock === 'float' ? 'float' : `dock-${t.dock}`);
  tbEl.classList.toggle('vertical', vertical);
  ed.dataset.tb = t.dock;
  layoutToolbar();
  if (t.dock === 'float') {
    const er = ed.getBoundingClientRect();
    const w = tbEl.offsetWidth, h = tbEl.offsetHeight;
    const topMin = $('#editor > .topbar').offsetHeight + 4;
    tbEl.style.left = clamp(t.x, 4, Math.max(4, er.width - w - 4)) + 'px';
    tbEl.style.top = clamp(t.y, topMin, Math.max(topMin, er.height - h - 4)) + 'px';
  } else { tbEl.style.left = ''; tbEl.style.top = ''; }
  // 아래에 붙은 모음이 여러 줄이면 레이어 표시를 그 위로 올린다
  const chip = $('#layerChip');
  if (t.dock === 'bottom') {
    const er = ed.getBoundingClientRect(), r = tbEl.getBoundingClientRect();
    chip.style.bottom = Math.max(0, er.bottom - r.top) + 10 + 'px';
    document.documentElement.style.setProperty('--tb-space', Math.max(0, er.bottom - r.top) + 12 + 'px'); // 알림도 그 위에
  } else { chip.style.bottom = ''; document.documentElement.style.removeProperty('--tb-space'); }
}
/**
 * 도구 모음이 화면에 다 안 들어가면 여러 줄(가로)·여러 열(세로)로 나눈다.
 * 스크롤 + 고정 버튼은 버튼끼리 겹쳐 가려지므로 쓰지 않는다.
 */
function layoutToolbar() {
  const tbEl = $('#toolbar'), ed = $('#editor');
  if (ed.hidden) return;
  tbEl.classList.remove('wrap');
  tbEl.style.removeProperty('--lines');
  const vertical = tbEl.classList.contains('vertical');
  const topH = $('#editor > .topbar').offsetHeight;
  const avail = vertical ? ed.clientHeight - topH - 24 : ed.clientWidth - (tbEl.classList.contains('dock-bottom') || tbEl.classList.contains('dock-top') ? 8 : 16);
  const need = vertical ? tbEl.scrollHeight : tbEl.scrollWidth;
  if (need <= avail + 1) return;
  const lines = Math.max(2, Math.min(4, Math.ceil(need / Math.max(avail, 1))));
  tbEl.style.setProperty('--lines', String(lines));
  // 가로 모음은 왼쪽→오른쪽으로 채우고 줄을 바꾼다: 한 줄에 들어갈 칸 수
  const cells = [...tbEl.querySelectorAll(':scope > :not(.sep):not(.tools):not(.quick-colors), .tools > *, .quick-colors > *')].length;
  tbEl.style.setProperty('--cols', String(Math.ceil(cells / lines)));
  tbEl.classList.add('wrap');
}

{
  const grip = $('#tbGrip'), tbEl = $('#toolbar');
  let drag = null;
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    grip.setPointerCapture?.(e.pointerId);
    const r = tbEl.getBoundingClientRect();
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, offX: e.clientX - r.left, offY: e.clientY - r.top, moved: false };
  });
  grip.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 6) return;
    if (!drag.moved) { drag.moved = true; closeToolPopup(); tbEl.classList.add('dragging'); }
    const er = $('#editor').getBoundingClientRect();
    // 끄는 동안은 떠 있는 상태로 손가락을 따라간다 (방향은 그대로)
    tbEl.classList.remove('dock-bottom', 'dock-top', 'dock-left', 'dock-right');
    tbEl.classList.add('float');
    tbEl.style.left = e.clientX - drag.offX - er.left + 'px';
    tbEl.style.top = e.clientY - drag.offY - er.top + 'px';
  });
  const finish = (e, cancel) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    tbEl.classList.remove('dragging');
    const t = { ...settings.get('toolbar') };
    const er = $('#editor').getBoundingClientRect(), r = tbEl.getBoundingClientRect();
    if (cancel) { applyToolbarPos(); return; }
    if (!d.moved) {
      // 탭: 가로 ↔ 세로 (붙어 있으면 그 자리에 띄워서 바꿈)
      const vertical = tbEl.classList.contains('vertical');
      settings.set('toolbar', { dock: 'float', vertical: !vertical, x: r.left - er.left, y: r.top - er.top });
      return;
    }
    // 붙일 곳은 도구 모음 크기가 아니라 손가락을 놓은 자리로 판단 (가로 모음은 화면 폭만큼 넓으므로)
    const topH = $('#editor > .topbar').offsetHeight;
    const dist = { left: e.clientX - er.left, right: er.right - e.clientX, top: e.clientY - er.top - topH, bottom: er.bottom - e.clientY };
    const [edge, gap] = Object.entries(dist).sort((a, b) => a[1] - b[1])[0];
    if (gap < DOCK_SNAP) settings.set('toolbar', { ...t, dock: edge });
    else settings.set('toolbar', { ...t, dock: 'float', vertical: tbEl.classList.contains('vertical'), x: r.left - er.left, y: r.top - er.top });
  };
  grip.addEventListener('pointerup', (e) => finish(e, false));
  grip.addEventListener('pointercancel', (e) => finish(e, true));
  // 눌렀다 떼면 click 도 오므로 다른 동작이 없게 막는다
  grip.addEventListener('click', (e) => e.stopPropagation());
}
addEventListener('resize', () => { if (state.screen === 'editor') applyToolbarPos(); }); // 화면 회전·크기 변경: 줄 나눔·위치 다시
$('#btnTbReset').addEventListener('click', () => { settings.set('toolbar', { dock: 'bottom', vertical: false, x: 0, y: 0 }); toast('도구 모음을 아래로 되돌렸습니다'); });

function renderToolPopup(tool) {
  const pop = $('#toolPopup');
  pop.innerHTML = '';
  const h = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; };
  pop.appendChild(h(`<h4>${TOOL_NAMES[tool]}</h4>`));
  const key = toolCfgKey(tool);
  if (key) {
    const cfg = settings.get(key);
    const pal = document.createElement('div');
    pal.className = 'palette';
    for (const c of (key === 'hl' ? HL_COLORS : PEN_COLORS)) pal.appendChild(swatch(c, c === cfg.color, () => setColor(key, c)));
    const custom = h(`<label class="custom-color" title="사용자 색"><input type="color" value="${/^#[0-9a-f]{6}$/i.test(cfg.color) ? cfg.color : '#000000'}"></label>`);
    custom.querySelector('input').addEventListener('change', (e) => setColor(key, e.target.value));
    pal.appendChild(custom);
    pop.appendChild(pal);
  }
  const slider = (label, path, min, max, step, fmt) => {
    const v = path.split('.').reduce((o, k) => o[k], settings.v);
    const row = h(`<div class="row"><span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${v}"><b style="min-width:44px;text-align:right">${fmt(v)}</b></div>`);
    const inp = row.querySelector('input'), out = row.querySelector('b');
    inp.addEventListener('input', () => {
      const [k, f] = path.split('.');
      settings.set(k, { ...settings.get(k), [f]: +inp.value });
      out.textContent = fmt(+inp.value);
      renderToolbar();
      drawPreview();
    });
    return row;
  };
  let preview = null;
  const drawPreview = () => {
    if (!preview) return;
    const c = preview.querySelector('canvas');
    const dpr = devicePixelRatio || 1;
    c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr;
    const ctx = c.getContext('2d');
    ctx.scale(dpr, dpr);
    const cfg = settings.get(key);
    const z = viewer.cam.z || 1;
    ctx.strokeStyle = cfg.color; ctx.lineCap = 'round'; ctx.lineWidth = cfg.width * z;
    if (key === 'hl') ctx.globalCompositeOperation = 'multiply';
    ctx.beginPath();
    const W = c.clientWidth, H = c.clientHeight;
    ctx.moveTo(20, H / 2 + 6);
    ctx.bezierCurveTo(W * 0.35, -4, W * 0.6, H + 4, W - 20, H / 2 - 6);
    ctx.stroke();
  };
  if (tool === 'pen' || tool === 'hl' || tool === 'shape') {
    preview = h('<div class="preview"><canvas style="width:100%;height:40px"></canvas></div>');
    pop.appendChild(preview);
    pop.appendChild(slider('굵기', `${key}.width`, tool === 'hl' ? 4 : 0.3, tool === 'hl' ? 40 : 12, tool === 'hl' ? 1 : 0.1, (v) => (+v).toFixed(1)));
    if (tool === 'pen' || tool === 'hl') {
      // 필기 방식 (플렉슬의 일직선·도형 자동 생성처럼): 자유 / 직선 / 도형
      const mode = settings.get(key).mode || 'free';
      const seg = h(`<div class="row"><span>방식</span><div class="seg pen-mode">${[['free', '자유'], ['line', '직선'], ['shape', '도형']].map(([m, l]) => `<button value="${m}" class="${mode === m ? 'on' : ''}">${l}</button>`).join('')}</div></div>`);
      seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        settings.set(key, { ...settings.get(key), mode: b.value });
        renderToolPopup(tool); renderToolbar();
        toast({ free: '자유 필기', line: '직선: 누른 곳부터 뗀 곳까지 곧은 선 (수평·수직·45° 근처면 맞춤)', shape: '도형: 대충 그리면 원·삼각형·사각형·화살표 등으로 정돈 (못 알아보면 그대로)' }[b.value], { ms: 2600 });
      }));
      pop.appendChild(seg);
    }
    if (tool === 'pen') {
      const row = h(`<div class="row"><span>필압</span><input type="checkbox" class="switch" ${settings.get('pressure') ? 'checked' : ''}></div>`);
      row.querySelector('input').addEventListener('change', (e) => settings.set('pressure', e.target.checked));
      pop.appendChild(row);
    }
  }
  if (tool === 'shape') {
    const kinds = [['line', '직선'], ['arrow', '화살표'], ['rect', '사각형'], ['ellipse', '원']];
    const seg = h(`<div class="row"><span>모양</span><div class="seg">${kinds.map(([k, l]) => `<button value="${k}" class="${settings.get('shape').kind === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>`);
    seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { settings.set('shape', { ...settings.get('shape'), kind: b.value }); renderToolPopup('shape'); }));
    pop.appendChild(seg);
  }
  if (tool === 'text') pop.appendChild(slider('글자 크기', 'text.size', 8, 72, 1, (v) => `${v}pt`));
  if (tool === 'eraser') {
    const er = settings.get('eraser');
    const seg = h(`<div class="row"><span>방식</span><div class="seg"><button value="stroke" class="${er.mode === 'stroke' ? 'on' : ''}">획 지우개</button><button value="area" class="${er.mode === 'area' ? 'on' : ''}">부분 지우개</button></div></div>`);
    seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { settings.set('eraser', { ...settings.get('eraser'), mode: b.value }); renderToolPopup('eraser'); }));
    pop.appendChild(seg);
    pop.appendChild(slider('크기', 'eraser.size', 4, 80, 1, (v) => `${v}px`));
    const ar = h(`<div class="row"><span>한 번 지우면 이전 도구로</span><input type="checkbox" class="switch" ${er.autoReturn ? 'checked' : ''}></div>`);
    ar.querySelector('input').addEventListener('change', (e) => settings.set('eraser', { ...settings.get('eraser'), autoReturn: e.target.checked }));
    pop.appendChild(ar);
    const tx = h(`<div class="row"><span>텍스트·링크·그림·포스트잇도 지우기<small class="muted" style="display:block;font-size:11px">끄면 이런 개체는 지우개에 지워지지 않음 (올가미로 삭제)</small></span><input type="checkbox" class="switch" ${er.text ? 'checked' : ''}></div>`);
    tx.querySelector('input').addEventListener('change', (e) => settings.set('eraser', { ...settings.get('eraser'), text: e.target.checked }));
    pop.appendChild(tx);
    const clr = h('<div class="row"><span>현재 페이지</span><button class="btn sm danger">페이지 필기 모두 지우기</button></div>');
    clr.querySelector('button').addEventListener('click', () => {
      const d = state.doc; if (!d) return;
      const p = viewer.currentPage();
      if (!d.items(p).length) { toast('지울 필기가 없습니다'); return; }
      if (confirm(`${p + 1}쪽의 필기를 모두 지울까요? (실행 취소 가능)`)) { d.setItems(p, []); tools.validateSelection(); }
    });
    pop.appendChild(clr);
  }
  if (tool === 'link') {
    pop.appendChild(h('<p class="muted small" style="margin:0">펜으로 사각형을 그려 링크 영역을 만들고 이동할 페이지나 웹 주소를 정하세요. 만든 링크를 펜으로 탭하면 수정, <b>손가락으로 탭하면 이동</b>합니다. PDF에 원래 있는 링크(목차 등)도 손가락 탭으로 열립니다.</p>'));
  }
  if (tool === 'lasso') {
    pop.appendChild(h('<p class="muted small" style="margin:0">펜으로 둘러싸서 선택 → 상자 안을 끌어 이동, 오른쪽 아래 점을 끌어 크기 조절. 탭하면 객체 하나 선택.</p>'));
  }
  requestAnimationFrame(drawPreview);
}

// ───────────────────────────── 제스처 동작 ─────────────────────────────
// 설정 → 제스처 동작에서 각 제스처(펜 꾹 누르기, 펜 세 번 탭, 두 손가락 탭 …)에 지정한 동작을 실행한다.

function runAction(action, sx, sy, source) {
  if (state.screen !== 'editor') return;
  const brief = (msg) => toast(msg, { ms: 900 });
  if (action.startsWith('tool:')) {
    const t = action.slice(5);
    selectTool(t);
    brief(TOOL_NAMES[t]);
    return;
  }
  switch (action) {
    case 'menu': openQuickMenu(sx, sy, source); break;
    case 'undo': doUndo(); break;
    case 'redo': doRedo(); break;
    case 'toggleEraser': {
      const to = settings.get('tool') === 'eraser' ? (toolBeforeEraser || 'pen') : 'eraser';
      selectTool(to);
      brief(TOOL_NAMES[to]);
      break;
    }
    case 'prevTool': {
      const to = previousTool && previousTool !== settings.get('tool') ? previousTool : 'pen';
      selectTool(to);
      brief(TOOL_NAMES[to]);
      break;
    }
    case 'insertImage': $('#imageInput').click(); break;
    case 'insertNote': insertNote({ x: sx, y: sy }); break;
    case 'insertChecklist': insertChecklist({ x: sx, y: sy }); break;
    case 'insertTable': $('#tableDlg').showModal(); break;
    case 'toggleRecord': toggleRecording(); break;
    case 'aiPanel': openAiPanel(); break;
    case 'layers': openLayerPanel(); break;
    case 'clock': openClockPanel(); break;
    case 'toggleFinger': $('#btnFinger').click(); break;
    case 'toggleRuler': $('#btnRuler').click(); break;
    case 'toggleProt': $('#btnProt').click(); break;
    case 'thumbs': $('#btnThumbs').click(); break;
    case 'fitWidth': viewer.fitWidth(); showZoomBadge(); break;
    default: break;
  }
}

// ───────────────────────────── S Pen 빠른 메뉴 ─────────────────────────────

let qmAt = null; // 빠른 메뉴를 연 화면 위치 (붙여넣기 자리)
function openQuickMenu(sx, sy, source) {
  if (state.screen !== 'editor') return;
  qmAt = { x: sx, y: sy };
  closeToolPopup();
  commitTextEdit();
  const m = $('#quickMenu');
  renderQuickMenu();
  $('#qmSrc').textContent = settings.get('debug') ? `열린 경로: ${source}` : '';
  m.hidden = false;
  const vp = $('#viewport').getBoundingClientRect(), ed = $('#editor').getBoundingClientRect();
  const w = m.offsetWidth, h = m.offsetHeight;
  // 펜 끝을 가리지 않도록 위쪽(공간 없으면 아래쪽)에 표시
  let x = vp.left - ed.left + sx - w / 2;
  let y = vp.top - ed.top + sy - h - 24;
  if (y < vp.top - ed.top + 8) y = vp.top - ed.top + sy + 24;
  m.style.left = clamp(x, 8, ed.width - w - 8) + 'px';
  m.style.top = clamp(y, 8, ed.height - h - 8) + 'px';
  if (navigator.vibrate) try { navigator.vibrate(12); } catch { /* */ }
}
function closeQuickMenu() { $('#quickMenu').hidden = true; }

function renderQuickMenu() {
  const tool = settings.get('tool');
  for (const b of document.querySelectorAll('#quickMenu [data-tool]')) b.classList.toggle('on', b.dataset.tool === tool);
  const box = document.querySelector('#quickMenu .qm-colors');
  box.innerHTML = '';
  const key = toolCfgKey(tool) || 'pen';
  const cfg = settings.get(key);
  for (const c of (key === 'hl' ? HL_COLORS : PEN_COLORS)) {
    box.appendChild(swatch(c, c === cfg.color, () => {
      if (!toolCfgKey(tool)) selectTool('pen');
      setColor(key, c); closeQuickMenu();
    }));
  }
  document.querySelector('[data-qm=undo]').disabled = !state.doc?.canUndo();
  document.querySelector('[data-qm=redo]').disabled = !state.doc?.canRedo();
  document.querySelector('[data-qm=paste]').hidden = !clip;
}
for (const b of document.querySelectorAll('#quickMenu [data-tool]')) {
  b.addEventListener('click', () => { selectTool(b.dataset.tool); closeQuickMenu(); });
}
document.querySelector('[data-qm=undo]').addEventListener('click', () => { doUndo(); renderQuickMenu(); });
document.querySelector('[data-qm=redo]').addEventListener('click', () => { doRedo(); renderQuickMenu(); });
document.querySelector('[data-qm=paste]').addEventListener('click', () => { closeQuickMenu(); pasteClip(qmAt); });

// ───────────────────────────── 선택 상자 ─────────────────────────────

let selState = null;
function renderSelection(sel, dragging, m) {
  selState = sel ? { sel, dragging, m } : null;
  if (!sel) $('#selSub').hidden = true; // 순서·정렬 줄은 선택이 끝나면 접음
  positionOverlays();
}

function positionOverlays() {
  const box = $('#selBox'), menu = $('#selMenu');
  if (!selState || !state.doc) { box.hidden = true; menu.hidden = true; }
  else {
    const b = tools.selectionBBox();
    if (!b) { box.hidden = true; menu.hidden = true; }
    else {
      const { sel, dragging, m } = selState;
      let x = b.x, y = b.y, w = b.w, hh = b.h;
      if (m) { x = m.ox + (b.x - m.ox) * m.s + m.dx; y = m.oy + (b.y - m.oy) * m.s + m.dy; w *= m.s; hh *= m.s; }
      const a = viewer.pageToScreen(sel.page, x, y), z = viewer.cam.z;
      Object.assign(box.style, { left: a.x + 'px', top: a.y + 'px', width: w * z + 'px', height: hh * z + 'px', transform: m?.r ? `rotate(${m.r}rad)` : '' });
      // 돌리는 중: 각도 표시 (글자는 똑바로)
      const ang = box.querySelector('.sel-angle');
      ang.hidden = !m?.r;
      if (m?.r) { ang.textContent = `${Math.round((m.r * 180) / Math.PI)}°`; ang.style.transform = `translateX(-50%) rotate(${-m.r}rad)`; }
      box.hidden = false;
      menu.hidden = !!dragging;
      if (!dragging) {
        const colors = menu.querySelector('.sel-colors');
        const pageItems = state.doc.items(sel.page);
        const selItems = pageItems.filter((i) => sel.ids.has(i.id));
        // 포스트잇(+그 위에 쓴 필기)만 골랐으면 포스트잇 색, 그 밖은 펜 색
        const selNotes = selItems.filter((i) => i.t === 'nt');
        const onNotes = new Set(selNotes.flatMap((n) => noteAttached(pageItems, n)));
        const kind = selNotes.length && selItems.every((i) => i.t === 'nt' || onNotes.has(i.id)) ? 'note' : 'ink';
        if (colors.dataset.kind !== kind) {
          colors.dataset.kind = kind;
          colors.innerHTML = '';
          for (const c of kind === 'note' ? NOTE_COLORS.slice(0, 5) : PEN_COLORS.slice(0, 5)) colors.appendChild(swatch(c, false, () => tools.recolorSelection(c, kind)));
        }
        // 글상자/포스트잇 하나만 선택했으면 "편집" 버튼
        const editable = selItems.filter((i) => ['tx', 'nt', 'cl', 'tb'].includes(i.t));
        menu.querySelector('[data-sel=edit]').hidden = !(editable.length === 1 && !selItems.some((i) => i.t === 'nt' && i.fold));
        const texty = selItems.filter((i) => TEXTY.has(i.t));
        menu.querySelectorAll('[data-sel=fs-up], [data-sel=fs-dn], [data-sel=bold], [data-sel=ital]').forEach((b) => { b.hidden = !texty.length; });
        menu.querySelector('[data-sel=bold]').classList.toggle('on', texty.length > 0 && texty.every((i) => i.b));
        menu.querySelector('[data-sel=ital]').classList.toggle('on', texty.length > 0 && texty.every((i) => i.i));
        const oneTable = selItems.length === 1 && selItems[0].t === 'tb';
        menu.querySelectorAll('[data-sel^=tb-]').forEach((b) => { b.hidden = !oneTable; });
        // 개수·추가 모드·묶기·정렬 (정렬은 덩어리 2개 이상, 간격은 3개 이상)
        $('#selCount').textContent = `${selItems.length}개`;
        menu.querySelector('[data-sel=add]').classList.toggle('on', tools.addMode);
        const gi = groupInfo(pageItems, sel.ids);
        menu.querySelector('[data-sel=group]').hidden = !gi.canGroup;
        menu.querySelector('[data-sel=ungroup]').hidden = !gi.grouped;
        const units = selectionUnits(pageItems, sel.ids).length;
        menu.querySelectorAll('.sel-sub .al').forEach((b) => { b.hidden = units < (b.classList.contains('dist') ? 3 : 2); });
        menu.querySelector('[data-sel=more]').classList.toggle('on', !$('#selSub').hidden);
        const notes = selItems.filter((i) => i.t === 'nt');
        const fb = menu.querySelector('[data-sel=fold]');
        fb.hidden = !notes.length;
        fb.title = notes.some((n) => !n.fold) ? '포스트잇 접기' : '포스트잇 펼치기';
        const mw = menu.offsetWidth, mh = menu.offsetHeight;
        let top = a.y - mh - 48; // 상자 위 회전 손잡이(↻)를 가리지 않도록 그만큼 더 위에
        if (top < 6) top = a.y + hh * z + 14;
        menu.style.left = clamp(a.x + (w * z) / 2 - mw / 2, 6, viewer.vw - mw - 6) + 'px';
        menu.style.top = clamp(top, 6, viewer.vh - mh - 6) + 'px';
      }
    }
  }
  if (state.editing) positionTextEditor();
}
$('#selMenu').addEventListener('click', (e) => {
  const a = e.target.closest('[data-sel]')?.dataset.sel;
  if (a === 'delete') tools.deleteSelection();
  if (a === 'dup') tools.duplicateSelection();
  if (a === 'clear') tools.clearSelection();
  if (a === 'add') {
    tools.addMode = !tools.addMode;
    if (tools.addMode) toast('선택 추가: 객체를 탭하면 넣고 빼고, 올가미로 둘러싸면 더합니다', { ms: 2200 });
    renderSelection(tools.selection);
  }
  if (a === 'copy') copySelection(false);
  if (a === 'more') { $('#selSub').hidden = !$('#selSub').hidden; renderSelection(tools.selection); }
  if (a === 'group' || a === 'ungroup' || a?.startsWith('z-') || a?.startsWith('al-')) arrangeSelection(a);
  if (a === 'fold') {
    const sel = tools.selection;
    if (!sel) return;
    const notes = state.doc.items(sel.page).filter((i) => i.t === 'nt' && sel.ids.has(i.id));
    const fold = notes.some((n) => !n.fold);
    tools.clearSelection();
    setNotesFold(sel.page, new Set(notes.map((n) => n.id)), fold);
  }
  if (a?.startsWith('tb-')) {
    const sel = tools.selection;
    const t = sel && state.doc.items(sel.page).find((i) => sel.ids.has(i.id) && i.t === 'tb');
    if (!t) return;
    tableEdit(sel.page, t.id, a);
    renderSelection(tools.selection);
  }
  if (['fs-up', 'fs-dn', 'bold', 'ital'].includes(a)) styleSelectedText(a);
  if (a === 'edit') {
    const sel = tools.selection;
    const it = sel && state.doc.items(sel.page).find((i) => sel.ids.has(i.id) && ['tx', 'nt', 'cl', 'tb'].includes(i.t));
    if (it) { tools.clearSelection(); startTextEdit(sel.page, it, undefined, undefined, it.t === 'tb' ? { cell: { r: 0, c: 0 } } : {}); }
  }
});

/** 묶기·풀기·순서·정렬: 선택은 그대로 두고 배열만 바꿈 (실행 취소 한 번) */
function arrangeSelection(a) {
  const sel = tools.selection;
  if (!sel) return;
  const items = state.doc.items(sel.page);
  let next = items;
  if (a === 'group') next = groupItems(items, sel.ids);
  else if (a === 'ungroup') next = ungroupItems(items, sel.ids);
  else if (a.startsWith('z-')) next = reorder(items, sel.ids, a.slice(2));
  else if (a.startsWith('al-')) next = alignItems(items, sel.ids, a.slice(3));
  if (next !== items) state.doc.setItems(sel.page, next);
  tools.setSelection({ page: sel.page, ids: new Set(sel.ids) });
  if (a === 'group') toast('묶었습니다 · 하나를 고르면 함께 선택됩니다', { ms: 1600 });
}

// ── 앱 안 클립보드: 다른 페이지·다른 노트에 붙여넣기 ──
let clip = null; // {docId, page, items, box, n(같은 자리에 붙여 넣은 횟수)}
let pendingClipPaste = false;
function copySelection(cut) {
  const sel = tools.selection;
  if (!sel) return;
  const items = state.doc.items(sel.page).filter((i) => sel.ids.has(i.id));
  if (!items.length) return;
  const box = tools.selectionBBox();
  clip = { docId: state.doc.id, page: sel.page, items, box, n: 0 };
  if (cut) tools.deleteSelection();
  toast(`${items.length}개를 ${cut ? '잘라냈' : '복사했'}습니다 · Ctrl+V 또는 길게 눌러 "붙여넣기"`, { ms: 1800 });
}
/** at: 화면 좌표(그 자리 가운데에) — 없으면 원래 자리에서 조금 비켜서, 다른 페이지·노트면 화면 가운데 */
async function pasteClip(at) {
  const d = state.doc;
  if (!clip || !d) return;
  let page, dx, dy;
  const cx = clip.box.x + clip.box.w / 2, cy = clip.box.y + clip.box.h / 2;
  const hit = at ? viewer.pageAtScreen(at.x, at.y) : null;
  if (hit) { page = hit.page; dx = hit.x - cx; dy = hit.y - cy; }
  else if (clip.docId === d.id && viewer.visiblePages().some((p) => p.index === clip.page)) { page = clip.page; clip.n++; dx = dy = 16 * clip.n; }
  else { const c = placeAt(); page = c.page; dx = c.x - cx; dy = c.y - cy; }
  let copies = cloneItems(clip.items, dx, dy);
  // 다른 노트의 그림: 그림 파일도 이 노트 것으로 복사 (원래 노트를 지워도 남도록)
  if (clip.docId !== d.id) {
    const map = new Map();
    for (const it of copies) {
      if (it.t !== 'im' || map.has(it.blob)) continue;
      const rec = await store.getBlob(it.blob).catch(() => null);
      if (!rec) continue;
      const nid = uid('img');
      await store.putBlob({ ...rec, id: nid, docId: d.id });
      map.set(it.blob, nid);
    }
    copies = copies.filter((it) => it.t !== 'im' || map.has(it.blob)).map((it) => (it.t === 'im' ? { ...it, blob: map.get(it.blob) } : it));
  }
  if (d.activeLayer) copies = copies.map((it) => ({ ...it, ly: d.activeLayer })); // 지금 레이어에
  d.setItems(page, [...d.items(page), ...copies]);
  selectAfterInsert(page, copies[0].id);
  tools.setSelection({ page, ids: new Set(copies.map((c) => c.id)) });
}

/** 지금 페이지의 (숨김·잠금 레이어가 아닌) 객체 모두 선택 */
function selectAll() {
  const d = state.doc;
  if (!d) return;
  const page = viewer.currentPage();
  const items = d.items(page);
  const off = inactiveIds(items);
  const ids = new Set(items.filter((i) => !off?.has(i.id)).map((i) => i.id));
  if (!ids.size) return;
  selectTool('lasso');
  tools.setSelection({ page, ids });
}

/** 표 행·열 추가/삭제 (칸 크기 유지: 표가 그만큼 커지거나 작아짐). 실행 취소 가능 */
function tableEdit(page, id, a) {
  const items = state.doc.items(page);
  const t = items.find((i) => i.id === id);
  if (!t) return;
  const { rows, cols } = tableSize(t);
  let cells = t.cells, w = t.w, h = t.h;
  if (a === 'tb-addRow') { cells = [...cells, Array(cols).fill('')]; h += h / rows; }
  if (a === 'tb-delRow' && rows > 1) { cells = cells.slice(0, -1); h -= h / rows; }
  if (a === 'tb-addCol') { cells = cells.map((r) => [...r, '']); w += w / cols; }
  if (a === 'tb-delCol' && cols > 1) { cells = cells.map((r) => r.slice(0, -1)); w -= w / cols; }
  if (cells === t.cells) return;
  state.doc.setItems(page, items.map((i) => (i.id === id ? { ...i, cells, w, h } : i)));
}

const TEXTY = new Set(['tx', 'nt', 'cl', 'tb']);
/** 선택한 글(글상자·포스트잇·체크리스트·표)의 글자 크기·굵게·기울임 바꾸기. 실행 취소 가능 */
function styleSelectedText(a) {
  const sel = tools.selection;
  if (!sel) return;
  const items = state.doc.items(sel.page);
  const targets = items.filter((i) => sel.ids.has(i.id) && TEXTY.has(i.t));
  if (!targets.length) return;
  const allBold = targets.every((i) => i.b), allItal = targets.every((i) => i.i);
  const k = a === 'fs-up' ? 1.15 : a === 'fs-dn' ? 1 / 1.15 : 1;
  const flag = (i, key, on) => { if (on) return { ...i, [key]: true }; const { [key]: _x, ...rest } = i; return rest; };
  state.doc.setItems(sel.page, items.map((i) => {
    if (!sel.ids.has(i.id) || !TEXTY.has(i.t)) return i;
    if (k !== 1) return { ...i, fs: Math.round(clamp(i.fs * k, 4, 200) * 100) / 100 };
    if (a === 'bold') return flag(i, 'b', !allBold);
    return flag(i, 'i', !allItal);
  }));
  renderSelection(tools.selection);
}

// ───────────────────────────── 텍스트 편집 ─────────────────────────────

const te = $('#textEditor');
for (const el of [$('#viewport'), $('#overlay'), $('#world')]) {
  el.addEventListener('scroll', () => { if (el.scrollLeft || el.scrollTop) { el.scrollLeft = 0; el.scrollTop = 0; } });
}
/**
 * 글 편집 상자. kind: text(글상자) | note(포스트잇) | check(체크리스트, 한 줄 = 한 항목) | cell(표의 한 칸)
 * opts: { cell:{r,c} 표 칸, isNew: 방금 만든 개체(비우면 삭제) }
 */
function startTextEdit(page, item, x, y, opts = {}) {
  commitTextEdit();
  const cfg = settings.get('text');
  let ed;
  if (!item) ed = { kind: 'text', page, item: null, x, y: y - cfg.size * 0.65, fs: cfg.size, c: cfg.color, rt: recorder.stamp() };
  else if (item.t === 'nt') ed = { kind: 'note', page, item, fs: item.fs, c: '#2b2b2b' };
  else if (item.t === 'cl') ed = { kind: 'check', page, item, fs: item.fs, c: item.c, isNew: !!opts.isNew };
  else if (item.t === 'tb') {
    const cell = opts.cell || (x != null ? cellAt(item, x, y) : null) || { r: 0, c: 0 };
    ed = { kind: 'cell', page, item, cell, fs: item.fs, c: '#1c1f24' };
  } else ed = { kind: 'text', page, item, x: item.x, y: item.y, fs: item.fs, c: item.c };
  state.editing = ed;
  te.classList.toggle('note-editor', ed.kind !== 'text');
  // 편집하는 동안 그 개체(글)는 화면에서 숨기고 입력칸만 보이게 (표·체크리스트는 칸/상자가 보이도록 그대로)
  if (item && ed.kind === 'text') { viewer.hidden = new Set([item.id]); viewer.requestInk(); }
  te.value = ed.kind === 'check' ? item.rows.map((r) => r.text).join('\n')
    : ed.kind === 'cell' ? item.cells[ed.cell.r][ed.cell.c]
    : item ? item.text : '';
  te.hidden = false;
  previewChecklist();
  positionTextEditor();
  // 화면 키보드가 뜨도록 포커스 (펜 탭 직후). 바로 한 번 + 이벤트 처리 뒤 한 번
  const focusEnd = () => { if (state.editing !== ed) return; te.focus({ preventScroll: true }); te.setSelectionRange(te.value.length, te.value.length); };
  focusEnd();
  setTimeout(focusEnd, 0);
}

/** 글 입력칸 위치·크기. 보이는 화면 밖으로는 키우지 않는다 (넘치는 글은 입력칸 안에서 스크롤) */
function positionTextEditor() {
  placeTextEditor();
  if (!state.editing) return;
  // 크게 확대했거나 글이 길면 입력칸이 화면 전체를 덮어 다른 곳을 눌러도(펜·손가락) 입력칸이 받아 버린다 → 보이는 영역까지만
  const left = parseFloat(te.style.left) || 0, top = parseFloat(te.style.top) || 0;
  const maxW = Math.max(60, viewer.vw - Math.max(left, 0) - 8), maxH = Math.max(40, viewer.vh - Math.max(top, 0) - 8);
  if (parseFloat(te.style.width) > maxW) te.style.width = maxW + 'px';
  if (parseFloat(te.style.height) > maxH) te.style.height = maxH + 'px';
}

function placeTextEditor() {
  const ed = state.editing;
  if (!ed) return;
  const z = viewer.cam.z;
  const base = { fontSize: ed.fs * z + 'px', color: ed.c, fontFamily: TEXT_FONT, lineHeight: TEXT_LINE, background: '', fontWeight: ed.item?.b ? 'bold' : 'normal', fontStyle: ed.item?.i ? 'italic' : 'normal' };
  // 편집 중에도 문서가 바뀔 수 있으니 최신 개체로 위치 계산
  const it = ed.item && (state.doc?.items(ed.page).find((i) => i.id === ed.item.id) || ed.item);
  if (ed.kind === 'note') {
    const a = viewer.pageToScreen(ed.page, it.x, it.y);
    Object.assign(te.style, base, {
      left: a.x + NOTE_PAD * z + 'px', top: a.y + noteTextTop(it) * z + 'px',
      width: (it.w - NOTE_PAD * 2) * z + 'px', height: (it.h - noteTextTop(it) - NOTE_PAD) * z + 'px',
    });
    return;
  }
  if (ed.kind === 'check') {
    // 체크 상자 오른쪽에 줄 높이를 맞춘 입력칸 (줄 = 항목)
    const b = checkBox(it, 0), rh = checkRowH(it);
    const left = b.x + b.w + it.fs * 0.5;
    const lines = Math.max(1, te.value.split('\n').length);
    const a = viewer.pageToScreen(ed.page, left, it.y + 4);
    Object.assign(te.style, base, {
      left: a.x + 'px', top: a.y + 'px', lineHeight: String(rh / it.fs), whiteSpace: 'pre', background: 'rgba(255,255,255,0.85)',
      width: (it.x + it.w - left) * z + 'px', height: lines * rh * z + 4 + 'px',
    });
    return;
  }
  if (ed.kind === 'cell') {
    const r = cellRect(it, ed.cell.r, ed.cell.c);
    const a = viewer.pageToScreen(ed.page, r.x, r.y);
    const pad = it.fs * 0.35;
    Object.assign(te.style, base, {
      left: a.x + 'px', top: a.y + 'px', padding: pad * z + 'px', background: 'rgba(255,255,255,0.95)',
      width: r.w * z + 'px', height: r.h * z + 'px', fontWeight: ed.cell.r === 0 || it.b ? 'bold' : 'normal',
    });
    return;
  }
  const a = viewer.pageToScreen(ed.page, ed.x, ed.y);
  const L = textLayout({ text: te.value || ' ', fs: ed.fs, b: ed.item?.b, i: ed.item?.i });
  Object.assign(te.style, base, {
    left: a.x - 2 + 'px', top: a.y - 2 + 'px', padding: '0', whiteSpace: '',
    width: Math.max(L.w * z + ed.fs * z * 1.5, 60) + 'px', height: L.h * z + 4 + 'px',
  });
}
te.addEventListener('input', () => { previewChecklist(); positionTextEditor(); });

/** 체크리스트 편집 중: 지금 입력한 줄 수만큼 상자를 바로 그려 보여 준다 (저장·실행 취소 기록은 확정할 때) */
function previewChecklist() {
  const ed = state.editing;
  if (ed?.kind === 'note') {
    // 포스트잇: 종이(배경)·띠·안에 넣은 것은 그대로 그리고 글만 빼서 입력칸 글과 겹치지 않게
    const cur = state.doc?.items(ed.page).find((i) => i.id === ed.item.id);
    if (cur && viewer.preview?.id !== cur.id) { viewer.preview = { ...cur, text: '' }; viewer.requestInk(); }
    return;
  }
  if (ed?.kind !== 'check') { if (viewer.preview) { viewer.preview = null; viewer.requestInk(); } return; }
  const cur = state.doc?.items(ed.page).find((i) => i.id === ed.item.id);
  if (!cur) return;
  const pool = [...cur.rows];
  const rows = te.value.split('\n').map((l) => {
    const j = pool.findIndex((r) => r.text === l.replace(/\s+$/, ''));
    return { text: '', done: j >= 0 ? pool.splice(j, 1)[0].done : false }; // 글은 입력칸이 보여 주므로 상자만
  });
  viewer.preview = { ...cur, rows };
  viewer.requestInk();
}
// 다른 곳을 누르면 확정. 단, 그사이 다른 편집(표의 다음 칸 등)이 시작됐으면 그것은 건드리지 않는다
te.addEventListener('blur', () => {
  const ed = state.editing;
  setTimeout(() => { if (ed && state.editing === ed && document.activeElement !== te) commitTextEdit(); }, 0);
});
// 표: Tab / Shift+Tab 으로 다음·이전 칸
te.addEventListener('keydown', (e) => {
  const ed = state.editing;
  // 체크리스트: Enter·Shift+Enter·Ctrl+Enter 모두 새 항목 (한글 조합 중 Enter 는 조합 확정이므로 건드리지 않음)
  if (ed?.kind === 'check' && e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey)) {
    e.preventDefault();
    te.setRangeText('\n', te.selectionStart, te.selectionEnd, 'end');
    te.dispatchEvent(new Event('input'));
    return;
  }
  if (e.key !== 'Tab' || ed?.kind !== 'cell') return;
  e.preventDefault();
  const { rows, cols } = tableSize(ed.item);
  let n = ed.cell.r * cols + ed.cell.c + (e.shiftKey ? -1 : 1);
  n = (n + rows * cols) % (rows * cols);
  const page = ed.page, id = ed.item.id;
  commitTextEdit({ keepFocus: true }); // 키보드가 내려갔다 올라오지 않도록 포커스 유지
  const t = state.doc.items(page).find((i) => i.id === id);
  if (t) startTextEdit(page, t, undefined, undefined, { cell: { r: Math.floor(n / cols), c: n % cols } });
});

function commitTextEdit({ keepFocus = false } = {}) {
  const ed = state.editing;
  if (!ed) return;
  state.editing = null;
  if (ed.kind === 'note') lastNoteEdit = { page: ed.page, id: ed.item.id, t: performance.now() };
  te.hidden = true;
  if (viewer.preview) { viewer.preview = null; viewer.requestInk(); }
  te.style.padding = '0';
  te.style.whiteSpace = '';
  te.style.fontWeight = 'normal';
  te.style.fontStyle = 'normal';
  viewer.hidden = null;
  const doc = state.doc;
  const raw = te.value;
  const text = raw.replace(/\s+$/, '');
  te.value = '';
  if (!keepFocus) te.blur();
  if (!doc) return;
  const items = doc.items(ed.page);
  const cur = ed.item && items.find((i) => i.id === ed.item.id);
  const replace = (fn) => doc.setItems(ed.page, items.map((i) => (i.id === ed.item.id ? fn(i) : i)));
  if (ed.kind === 'note') {
    // 포스트잇은 글이 비어도 남겨 둔다 (펜으로 쓰는 메모지로도 사용)
    if (cur && cur.text !== text) replace((i) => ({ ...i, text }));
  } else if (ed.kind === 'check') {
    if (!cur) return;
    const lines = raw.split('\n').map((l) => l.replace(/\s+$/, ''));
    while (lines.length > 1 && !lines[lines.length - 1]) lines.pop();
    if (!lines.some((l) => l)) { doc.setItems(ed.page, items.filter((i) => i.id !== cur.id)); return; } // 다 비우면 삭제
    // 완료 표시는 같은 글의 항목을 따라간다 (줄 순서를 바꿔도 유지)
    const pool = [...cur.rows];
    const rows = lines.map((l) => {
      const j = pool.findIndex((r) => r.text === l);
      return { text: l, done: j >= 0 ? pool.splice(j, 1)[0].done : false }; // 새로 쓰거나 고친 항목은 미완료
    });
    if (JSON.stringify(rows) !== JSON.stringify(cur.rows)) replace((i) => ({ ...i, rows }));
  } else if (ed.kind === 'cell') {
    if (!cur) return;
    const { r, c } = ed.cell;
    if (cur.cells[r][c] !== text) replace((i) => ({ ...i, cells: i.cells.map((row, ri) => (ri === r ? row.map((v, ci) => (ci === c ? text : v)) : row)) }));
  } else if (ed.item) {
    if (!text) doc.setItems(ed.page, items.filter((i) => i.id !== ed.item.id));
    else if (cur && text !== cur.text) replace((i) => ({ ...i, text }));
  } else if (text) {
    doc.add(ed.page, { id: uid('tx'), t: 'tx', x: ed.x, y: ed.y, c: ed.c, fs: ed.fs, text, ...(ed.rt ? { rt: ed.rt } : {}) });
  }
  viewer.requestInk();
}

// ───────────────────────────── 설정 ─────────────────────────────

const dlg = $('#settingsDlg');
function openSettings() {
  syncSettingsForm();
  refreshStorageInfo();
  $('#aboutLine').textContent = `FlexNote ${APP_VERSION} · PDF.js ${pdfjsLib.version} · ${window.isSecureContext ? '보안 컨텍스트' : '비보안(http) 컨텍스트: 일부 기능 제한'}`;
  $('#btnBackupExport').disabled = $('#btnBackupImport').disabled = !state.doc;
  dlg.showModal();
}
// 붙여 넣는 즉시 저장 (모바일에서 창을 바로 닫아도 남도록)
$('#setAiKey').addEventListener('input', (e) => { setApiKey(e.target.value); $('#aiNoKey').hidden = !!getApiKey(); });
$('#btnAiKeyClear').addEventListener('click', () => { setApiKey(''); $('#setAiKey').value = ''; toast('API 키를 지웠습니다'); });
// 주소 #gk=키 로 키 저장 (처음 열 때 + 이미 열린 앱의 주소만 바꿨을 때)
const takeHashKey = () => { if (importKeyFromHash()) { toast('Gemini API 키를 이 기기에 저장했습니다'); $('#aiNoKey').hidden = true; } };
setTimeout(takeHashKey, 300);
window.addEventListener('hashchange', takeHashKey);
for (const [id, name, hint] of AI_MODELS) $('#setAiModel').insertAdjacentHTML('beforeend', `<option value="${id}" title="${escapeHtml(hint)}">${escapeHtml(name)}</option>`);
$('#setAiModel').addEventListener('change', (e) => settings.set('ai', { ...settings.get('ai'), model: e.target.value }));
$('#setAiEffort').addEventListener('change', (e) => settings.set('ai', { ...settings.get('ai'), effort: e.target.value }));
$('#setEraserReturn').addEventListener('change', (e) => settings.set('eraser', { ...settings.get('eraser'), autoReturn: e.target.checked }));

// 제스처 동작 선택 칸 (설정 → 제스처 동작)
for (const [key, label, hint, extra] of GESTURES) {
  const row = document.createElement('div');
  row.className = 'row';
  const opts = [...extra, ...GESTURE_ACTIONS].map(([id, name]) => `<option value="${id}">${escapeHtml(name)}</option>`).join('');
  row.innerHTML = `<span>${escapeHtml(label)}${hint ? `<small>${escapeHtml(hint)}</small>` : ''}</span><select data-gesture="${key}">${opts}</select>`;
  row.querySelector('select').addEventListener('change', (e) => settings.set(`gestures.${key}`, e.target.value));
  $('#gestureRows').appendChild(row);
}

function syncSettingsForm() {
  for (const sel of dlg.querySelectorAll('[data-gesture]')) sel.value = settings.get('gestures')[sel.dataset.gesture];
  $('#setEraserReturn').checked = !!settings.get('eraser').autoReturn;
  $('#setAiKey').value = getUserKey();
  $('#setAiEffort').value = settings.get('ai').effort;
  $('#setAiModel').value = settings.get('ai').model;
  for (const el of dlg.querySelectorAll('[data-setting]')) {
    const k = el.dataset.setting, v = settings.get(k);
    if (el.classList.contains('seg')) el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.value === v));
    else if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  }
  const fmt = { smoothing: (v) => v, holdMs: (v) => `${v}ms`, holdTolerance: (v) => `${v}px`, palmSize: (v) => `${v}px`, penGuardMs: (v) => `${v}ms`, glassClear: (v) => `${v}%` };
  for (const o of dlg.querySelectorAll('[data-out]')) o.textContent = fmt[o.dataset.out](settings.get(o.dataset.out));
}
for (const el of dlg.querySelectorAll('[data-setting]')) {
  const k = el.dataset.setting;
  if (el.classList.contains('seg')) {
    el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { settings.set(k, b.value); syncSettingsForm(); }));
  } else {
    el.addEventListener(el.type === 'range' ? 'input' : 'change', () => {
      const v = el.type === 'checkbox' ? el.checked : el.type === 'range' || el.type === 'number' ? +el.value : el.value;
      settings.set(k, v);
      syncSettingsForm();
    });
  }
}
async function refreshStorageInfo() {
  const i = await store.storageInfo();
  $('#storageInfo').textContent = `사용 ${formatBytes(i.usage)} / ${formatBytes(i.quota)} · 영구 저장: ${i.persisted === true ? '허용됨' : i.persisted === false ? '미허용' : '알 수 없음'}`;
  $('#btnPersist').disabled = i.persisted === true;
}
$('#btnPersist').addEventListener('click', async () => {
  const ok = await store.requestPersist();
  toast(ok ? '영구 저장이 허용되었습니다' : '브라우저가 영구 저장을 허용하지 않았습니다 (홈 화면에 앱을 추가하면 허용될 수 있습니다)');
  refreshStorageInfo();
});
$('#btnResetSettings').addEventListener('click', () => {
  if (confirm('설정을 기본값으로 되돌릴까요? (문서와 필기는 유지됩니다)')) { settings.reset(); syncSettingsForm(); }
});
$('#btnBackupExport').addEventListener('click', async () => {
  const d = state.doc;
  if (!d) return;
  await d.flush();
  await exportBackup(d);
});
/** 필기 백업(JSON) 내려받기. 메모리의 필기로 만드므로 저장소에 쓰지 못하는 상태에서도 쓸 수 있다 */
async function exportBackup(d) {
  const pages = {};
  for (const [p, items] of d.pages) if (items.length) pages[p] = items;
  // 첨부 그림도 백업 파일 안에 넣는다 (다른 기기로 옮겨도 그림이 따라가도록)
  const images = {};
  for (const items of Object.values(pages)) for (const it of items) {
    if (it.t !== 'im' || images[it.blob]) continue;
    const rec = await store.getBlob(it.blob).catch(() => null);
    if (rec) images[it.blob] = { w: rec.w, h: rec.h, data: await blobToDataUrl(rec.data) };
  }
  const data = { format: 'flexnote-ink', version: 2, name: d.meta.name, pageCount: viewer.pages.length, exported: new Date().toISOString(), pages, images, layers };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  a.download = `${d.meta.name}_필기백업.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
$('#btnBackupImport').addEventListener('click', () => $('#backupInput').click());
$('#backupInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  const d = state.doc;
  if (!f || !d) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.format !== 'flexnote-ink' || typeof data.pages !== 'object') throw new Error('FlexNote 필기 백업 파일이 아닙니다');
    if (!confirm(`백업의 필기를 현재 문서에 덮어쓸까요? (실행 취소 가능)`)) return;
    // 1) 필기를 먼저 검사해 두고 (실패하면 아무것도 바뀌지 않음)
    let n = 0, bad = 0;
    const parsed = [];
    for (let p = 0; p < viewer.pages.length; p++) {
      const raw = data.pages[p];
      const items = Array.isArray(raw) ? raw.map(sanitizeItem).filter((x) => x || (bad++, false)) : [];
      n += items.length;
      parsed.push(items);
    }
    // 2) 첨부 그림은 새 id 로 저장 (백업의 id 를 그대로 쓰면 같은 id 를 가진 다른 노트의 그림을 덮어쓸 수 있음).
    //    하나라도 실패하면 이번에 넣은 그림을 지우고 중단
    const idMap = new Map(), added = [];
    try {
      for (const [id, im] of Object.entries(data.images || {})) {
        const blob = await (await fetch(im.data)).blob();
        const nid = uid('img');
        await store.putBlob({ id: nid, docId: d.id, data: blob, w: im.w, h: im.h });
        added.push(nid);
        idMap.set(id, nid);
      }
    } catch (err) {
      for (const id of added) await store.deleteBlob(id).catch(() => {});
      throw new Error('그림을 저장하지 못해 가져오기를 취소했습니다 (' + store.describeError(err) + ')');
    }
    // 3) 필기의 그림 참조를 새 id 로 바꿔 한 번에 반영 (실행 취소 한 번으로 되돌림)
    if (Array.isArray(data.layers) && data.layers.length) { d.meta.layers = data.layers; d.meta.activeLayer = null; initLayers(d); applyLayers(); }
    d.begin();
    parsed.forEach((items, p) => {
      const fixed = items.map((it) => (it.t === 'im' && idMap.has(it.blob) ? { ...it, blob: idMap.get(it.blob) } : it));
      if (fixed.length || d.items(p).length) d.setItems(p, fixed);
    });
    d.commit();
    toast(`필기 ${n}개를 복원했습니다` + (bad ? ` (손상된 ${bad}개 제외)` : ''));
  } catch (err) { toast('백업을 읽을 수 없습니다: ' + err.message, { error: true }); }
});

settings.on('change', ({ path }) => {
  if (path === 'theme' || path === 'glass' || path === 'glassClear' || path === '*') { applyTheme(); updateGlassInset(); }
  if (path === 'debug' || path === '*') { dbg.enable(settings.get('debug')); $('#btnDebug').hidden = !settings.get('debug'); }
  if (path === 'tool' || path === '*') renderToolbar();
  if (path === 'toolbar' || path === '*') applyToolbarPos();
});

// ───────────────────────────── 시작 ─────────────────────────────

async function boot() {
  renderToolbar();
  dbg.enable(settings.get('debug'));
  $('#btnDebug').hidden = !settings.get('debug');
  if (!settings.persistOk) toast('설정을 저장할 수 없는 환경입니다 (사생활 보호 모드?)', { error: true });
  try {
    await store.openDB();
  } catch (e) {
    toast('브라우저 저장소(IndexedDB)를 사용할 수 없어 자동 저장이 동작하지 않습니다: ' + store.describeError(e), { error: true, ms: 10000 });
  }
  // 펜(정밀 포인터)이 없는 터치 기기: 처음 한 번 손가락 쓰기 안내
  try {
    if (!matchMedia('(any-pointer: fine)').matches && navigator.maxTouchPoints > 0 && !localStorage.getItem('flexnote.fingerHint')) {
      localStorage.setItem('flexnote.fingerHint', '1');
      setTimeout(() => toast('펜이 없다면 아래 도구 모음의 ✋(손가락으로 쓰기)를 켜세요', { ms: 5000 }), 1500);
    }
  } catch { /* */ }
  curFolder = (await store.kvGet('libFolder').catch(() => null)) || null; // 마지막으로 보던 폴더
  const saved = (await store.kvGet('tabs').catch(() => null)) || [];
  const known = new Map((await store.listDocs().catch(() => [])).map((d) => [d.id, d.name]));
  tabs = saved.filter((t) => known.has(t.id)).map((t) => ({ id: t.id, name: known.get(t.id) })); // 지워진 노트는 빼고 이름은 최신으로
  const last = await store.kvGet('lastDoc').catch(() => null);
  if (last && (await store.getDoc(last).catch(() => null))) await openDoc(last);
  else { showScreen('library'); renderLibrary(); }

}

// ───────────────────────────── 오프라인 (서비스 워커) ─────────────────────────────
// 첫 접속 때 앱 파일 전체를 캐시해 두면 이후에는 와이파이 없이도 켜진다.
// 새 버전이 받아지면 바로 바꾸지 않고 "업데이트" 버튼을 보여 준다 (작업 중 코드가 섞이지 않도록).
function setupServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  if (new URLSearchParams(location.search).has('nosw')) return;
  let userAskedUpdate = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (userAskedUpdate) location.reload();
  });
  const offerUpdate = (worker) => {
    const bar = $('#updateBar');
    bar.hidden = false;
    bar.querySelector('button').onclick = async () => {
      bar.hidden = true;
      await state.doc?.flush();
      userAskedUpdate = true;
      worker.postMessage('SKIP_WAITING');
    };
  };
  navigator.serviceWorker.register('sw.js').then((reg) => {
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state !== 'installed') return;
        if (navigator.serviceWorker.controller) offerUpdate(w);
        else toast('오프라인에서도 쓸 수 있도록 준비했습니다 (와이파이 없이 실행 가능)', { ms: 4000 });
      });
    });
    // 앱으로 돌아올 때마다 새 버전 확인 (온라인일 때만 의미 있음)
    document.addEventListener('visibilitychange', () => { if (!document.hidden && navigator.onLine) reg.update().catch(() => {}); });
  }).catch((e) => console.warn('서비스 워커 등록 실패', e));
}

if (location.protocol === 'file:') {
  document.body.innerHTML = '<div style="padding:32px;font:16px system-ui;line-height:1.6"><h2>로컬 서버로 실행해 주세요</h2><p>file:// 로 직접 열면 브라우저 보안 정책 때문에 모듈과 PDF.js 워커를 불러올 수 없습니다.</p><p>폴더에서 <code>node server.js</code> 또는 <code>python3 -m http.server 8080</code> 실행 후 <code>http://localhost:8080</code> 으로 접속하세요.</p></div>';
} else {
  setupServiceWorker();
  boot();
}

// 테스트/진단용 핸들 (콘솔에서 상태 확인)
window.__flexnote = { viewer, tools, input, settings, state, store, get hwp() { return hwp; } };
