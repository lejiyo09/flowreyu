// 앱 진입점: 라이브러리 ↔ 편집기, 도구 UI, 설정, 자동 저장 상태 표시를 연결한다.
import { settings, PEN_COLORS, HL_COLORS, GESTURES, GESTURE_ACTIONS } from './settings.js';
import * as store from './store.js';
import { NoteDocument } from './document.js';
import { Viewer, pdfjsLib } from './viewer.js';
import { InputRouter } from './input.js';
import { ToolController } from './tools.js';
import { ThumbPanel } from './thumbs.js';
import { Guides } from './guides.js';
import { AudioRecorder, fmtTime } from './audio.js';
import { askAi, AiError, AI_MODELS, getApiKey, getUserKey, setApiKey, importKeyFromHash, minutesRequest, grammarRequest, translateRequest, unpackTexts, splitExplain, extractTodos, TRANSLATE_LANGS } from './ai.js';
import { InputDebugger } from './debug.js';
import { uid, debounce, formatBytes, formatDate, escapeHtml, clamp } from './util.js';
import { sanitizeItem, TEXT_FONT, textLayout, imageHooks, putImage, NOTE_COLORS, NOTE_PAD, TEXT_LINE, noteIconRect, noteFoldButton, noteDeleteButton, noteAttached, noteHandle, noteTextTop, objHandle, objDeleteButton, objBarH, transformItem, drawItem, isHighlighter, foldHidden, layerSorted, layerUsable, layerHidden, setLayerState, layerOf, DEFAULT_LAYER, checkRowAt, checkBox, checkRowH, cellAt, cellRect, tableSize, hitTest } from './ink.js';

const $ = (s) => document.querySelector(s);
const APP_VERSION = '1.0.0';
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
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);
applyTheme();

// ───────────────────────────── 뷰어 · 입력 · 도구 ─────────────────────────────

const viewer = new Viewer($('#viewport'), $('#world'), { hl: $('#cvHl'), ink: $('#cvInk'), live: $('#cvLive') });

const app = {
  doc: () => state.doc,
  isUiTarget: (el) => !!(el && el.closest && el.closest('[data-ui]')),
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
  tapObjectAt: (page, x, y) => tapObjectAt(page, x, y),
  noteDragStart: (sx, sy) => noteDragStart(sx, sy),
  noteDragMove: (sx, sy) => noteDragMove(sx, sy),
  noteDragEnd: (cancel) => noteDragEnd(cancel),
  // 펜 두 번 탭 메뉴: 첫 탭이 남긴 편집을 기록 없이 되돌리기 위한 표식
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
viewer.on('sized', () => { thumbs.resizeBoxes(); updatePageIndicator(); });

// ───────────────────────────── 라이브러리 ─────────────────────────────

async function renderLibrary() {
  let docs = [];
  try { docs = await store.listDocs(); }
  catch (e) { toast('저장소를 열 수 없습니다: ' + store.describeError(e), { error: true, ms: 6000 }); }
  const last = await store.kvGet('lastDoc').catch(() => null);
  const grid = $('#docGrid');
  grid.innerHTML = '';
  $('#libEmpty').hidden = docs.length > 0;
  for (const d of docs) {
    const card = document.createElement('div');
    card.className = 'doc-card';
    card.innerHTML = `
      <div class="cover">${d.thumb ? `<img src="${d.thumb}" alt="">` : '<svg><use href="#i-file"/></svg>'}</div>
      ${d.id === last ? '<span class="last-badge">최근</span>' : ''}
      <button class="more" data-ui title="메뉴"><svg><use href="#i-more"/></svg></button>
      <div class="name">${escapeHtml(d.name)}</div>
      <div class="meta">${d.pageCount || '?'}쪽 · ${formatDate(d.updated || d.created)}</div>`;
    card.addEventListener('click', (e) => {
      if (e.target.closest('.more')) { e.stopPropagation(); cardMenu(e, d); return; }
      openDoc(d.id);
    });
    grid.appendChild(card);
  }
  const info = await store.storageInfo();
  $('#storageLine').textContent = `저장소 사용량 ${formatBytes(info.usage)} / ${formatBytes(info.quota)}` +
    (info.persisted === true ? ' · 영구 저장 허용됨' : info.persisted === false ? ' · 영구 저장 미허용(브라우저가 공간 부족 시 삭제할 수 있음)' : '');
}

function cardMenu(e, d) {
  document.querySelector('.card-menu')?.remove();
  const m = document.createElement('div');
  m.className = 'card-menu';
  m.dataset.ui = '';
  m.innerHTML = '<button data-a="open">열기</button><button data-a="rename">이름 바꾸기</button><button data-a="del" class="danger">삭제</button>';
  document.body.appendChild(m);
  const r = e.target.closest('.more').getBoundingClientRect();
  m.style.left = clamp(r.right - 160, 8, innerWidth - 170) + 'px';
  m.style.top = clamp(r.bottom + 4, 8, innerHeight - 150) + 'px';
  const close = () => { m.remove(); document.removeEventListener('pointerdown', outside, true); };
  const outside = (ev) => { if (!m.contains(ev.target)) close(); };
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  m.addEventListener('click', async (ev) => {
    const a = ev.target.dataset.a;
    close();
    if (a === 'open') openDoc(d.id);
    if (a === 'rename') {
      const name = prompt('새 이름', d.name);
      if (name && name.trim()) { await store.patchDoc(d.id, { name: name.trim() }); renderLibrary(); }
    }
    if (a === 'del') {
      if (!confirm(`"${d.name}"을(를) 삭제할까요?\nPDF와 모든 필기가 삭제되며 되돌릴 수 없습니다.`)) return;
      try { await store.deleteDoc(d.id); toast('삭제했습니다'); }
      catch (err) { toast('삭제 실패: ' + store.describeError(err), { error: true }); }
      renderLibrary();
    }
  });
}

function showScreen(name) {
  state.screen = name;
  $('#library').hidden = name !== 'library';
  $('#editor').hidden = name !== 'editor';
  if (name === 'editor') viewer.resize(true);
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
    created: Date.now(), updated: Date.now(), opened: Date.now(), thumb, view: null, ...extra,
  };
  await pdf.destroy();
  await store.addDocWithFile(meta, new Blob([bytes], { type: 'application/pdf' }));
  store.requestPersist();
  return meta.id;
}

async function importFile(file) {
  if (!file) return;
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
$('#fileInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; importFile(f); });
document.addEventListener('dragover', (e) => { if (state.screen === 'library') { e.preventDefault(); document.body.classList.add('drag-over'); } });
document.addEventListener('dragleave', () => document.body.classList.remove('drag-over'));
document.addEventListener('drop', (e) => {
  document.body.classList.remove('drag-over');
  if (state.screen !== 'library') return;
  e.preventDefault();
  const f = [...(e.dataTransfer?.files || [])].find((x) => /pdf$/i.test(x.type) || /\.pdf$/i.test(x.name));
  if (f) importFile(f);
});

$('#btnNewNote').addEventListener('click', () => $('#newNoteDlg').showModal());
$('#newNoteDlg').addEventListener('close', async () => {
  if ($('#newNoteDlg').returnValue !== 'ok') return;
  const name = $('#nnName').value.trim() || '새 노트';
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

async function closeDoc() {
  if (recorder.recording) await stopRecording(); // 녹음 중이면 먼저 저장
  stopPlayback(true);
  commitTextEdit();
  tools.cancel();
  tools.clearSelection();
  input.resetAll('close');
  closeQuickMenu(); closeToolPopup();
  $('#layerPanel').hidden = true;
  const doc = state.doc;
  if (doc) {
    saveView.flush();
    const ok = await doc.close().catch(() => false);
    if (!ok && doc.saveState === 'error') toast('일부 필기를 저장하지 못했습니다', { error: true });
  }
  viewer.close();
  thumbs.clear();
  $('#backChip').hidden = true;
  backAnchor = null;
  if (state.pdf) { state.pdf.destroy().catch(() => {}); }
  state.doc = null; state.pdf = null; state.blob = null;
}

async function openDoc(id) {
  busy('문서 여는 중…');
  try {
    await closeDoc();
    const meta = await store.getDoc(id);
    if (!meta) throw new Error('문서를 찾을 수 없습니다');
    const blob = await store.getFile(id);
    if (!blob) throw new Error('PDF 원본이 저장소에 없습니다 (브라우저가 데이터를 삭제했을 수 있습니다)');
    const bytes = await blob.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ ...PDF_OPTS, data: bytes }).promise;
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
    // 새 획 하나만 추가된 경우는 그 획만 덧그리고, 그 밖의 변경은 전체를 다시 그린다
    if (!(appended && viewer.appendItem(page, appended))) viewer.requestInk();
    thumbs.markInk(page);
  });
  doc.on('history', () => updateHistoryButtons());
  doc.on('save', () => renderSaveState());
}

$('#btnBack').addEventListener('click', async () => {
  await closeDoc();
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
  const s = d ? d.saveState : 'saved';
  el.dataset.state = s;
  const label = { saved: '저장됨', pending: '변경됨', saving: '저장 중…', error: '저장 실패 · 다시 시도' }[s];
  el.querySelector('span').textContent = label;
  el.title = s === 'error' ? store.describeError(d.saveError) : '자동 저장';
  if (s === 'error' && !renderSaveState.warned) {
    renderSaveState.warned = true;
    toast('저장 실패: ' + store.describeError(d.saveError) + ' — 자동으로 다시 시도합니다', { error: true, ms: 6000 });
  }
  if (s === 'saved') renderSaveState.warned = false;
}
$('#saveState').addEventListener('click', () => state.doc?.flush());

// ───────────────────────────── 상단 바 ─────────────────────────────

function updateZoomLabel() {
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
  const cur = viewer.currentPage();
  $('#pageInd').textContent = `${cur + 1} / ${viewer.pages.length}`;
  thumbs.setCurrent(cur, false);
}
$('#btnZoomIn').addEventListener('click', () => { viewer.zoomBy(1.25); showZoomBadge(); });
$('#btnZoomOut').addEventListener('click', () => { viewer.zoomBy(0.8); showZoomBadge(); });
$('#zoomVal').addEventListener('click', () => {
  if (Math.abs(viewer.relZoom() - 1) < 0.02) viewer.fitPage(); else viewer.fitWidth();
  showZoomBadge();
});
$('#btnThumbs').addEventListener('click', () => {
  thumbs.show(!thumbs.open);
  $('#btnThumbs').classList.toggle('on', thumbs.open);
  requestAnimationFrame(() => viewer.resize());
});
$('#pageInd').addEventListener('click', () => {
  if (!thumbs.open) { thumbs.show(true); $('#btnThumbs').classList.add('on'); requestAnimationFrame(() => viewer.resize()); }
  $('#gotoPage').focus();
});
$('#gotoPage').addEventListener('change', (e) => {
  const n = parseInt(e.target.value, 10);
  if (n >= 1) { viewer.goToPage(n - 1); thumbs.setCurrent(n - 1, true); }
  e.target.value = '';
});
$('#btnExport').addEventListener('click', () => exportPdf());
$('#btnSettings').addEventListener('click', () => openSettings());
$('#btnLibSettings').addEventListener('click', () => openSettings());
$('#btnDebug').addEventListener('click', () => { dbg.enable(!dbg.on); });

async function exportPdf() {
  const doc = state.doc;
  if (!doc) return;
  commitTextEdit();
  await doc.flush();
  busy('PDF 만드는 중…');
  try {
    // 모든 페이지 변환 행렬이 필요하므로 아직 안 읽은 페이지는 읽는다
    for (const p of viewer.pages) {
      if (!p.vt && doc.items(p.index).length) p.vt = (await state.pdf.getPage(p.index + 1)).getViewport({ scale: 1 }).transform;
    }
    const { exportAnnotatedPdf } = await import('./export.js');
    const bytes = await exportAnnotatedPdf(await state.blob.arrayBuffer(), viewer.pages.map((p) => p.vt), (i) => doc.items(i),
      (i, n) => busy(`PDF 만드는 중… ${i}/${n}`), { getBlob: (id) => store.getBlob(id) });
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${doc.meta.name}_필기.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast('필기가 포함된 PDF를 내보냈습니다');
  } catch (e) {
    console.error(e);
    toast('내보내기 실패: ' + (e?.message || e), { error: true, ms: 6000 });
  } finally { busy(null); }
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

$('#btnAddPage').addEventListener('click', () => {
  $('#apTemplate').value = state.doc?.meta.template || 'blank';
  $('#addPageDlg').showModal();
});
$('#addPageDlg').addEventListener('close', () => {
  if ($('#addPageDlg').returnValue !== 'ok') return;
  addPages($('#apWhere').value, $('#apTemplate').value, clamp(parseInt($('#apCount').value, 10) || 1, 1, 50));
});
$('#btnDelPage').addEventListener('click', deleteCurrentPage);

// 마지막 페이지 아래 "페이지 추가" 버튼 (월드 좌표에 붙어 함께 움직인다)
const addEndBtn = document.createElement('button');
addEndBtn.className = 'add-page-end';
addEndBtn.dataset.ui = '';
addEndBtn.innerHTML = '<svg><use href="#i-plus"/></svg><span>페이지 추가</span>';
addEndBtn.addEventListener('click', () => addPages('end', state.doc?.meta.template || 'blank', 1));
function placeAddPageButton() {
  const last = viewer.pages[viewer.pages.length - 1];
  if (!last) { addEndBtn.remove(); return; }
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
async function insertImageFile(file, at) {
  const doc = state.doc;
  if (!doc || !file || !/^image\//.test(file.type)) return;
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
  for (let i = items.length - 1; i >= 0; i--) {
    const n = items[i];
    if (!layerUsable(n)) continue; // 숨기거나 잠근 레이어
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
  for (let i = items.length - 1; i >= 0; i--) {
    const n = items[i];
    if (!layerUsable(n)) continue;
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
  g.m.dx = (sx - g.sx0) / z;
  g.m.dy = (sy - g.sy0) / z;
  if (Math.hypot(sx - g.sx0, sy - g.sy0) > 6) g.moved = true;
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

function insertChecklist(at) {
  const doc = state.doc;
  if (!doc) return;
  const hit = placeAt(at), p = viewer.pages[hit.page], z = viewer.cam.z;
  const w = Math.min(260 / z, p.w * 0.8), fs = 15 / z;
  const bh = objBarH({ fs }); // 위쪽 손잡이 띠가 페이지 밖으로 나가지 않게
  const item = { id: uid('cl'), t: 'cl', x: clamp(hit.x - w / 2, 0, p.w - w), y: clamp(hit.y - fs * 2, bh, Math.max(bh, p.h - fs * 3)), w, fs, c: '#1c1f24', rows: [{ text: '', done: false }] };
  doc.add(hit.page, item);
  startTextEdit(hit.page, item, undefined, undefined, { isNew: true });
}

function insertTable(rows, cols, at) {
  const doc = state.doc;
  if (!doc) return;
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
$('#btnTable').addEventListener('click', () => $('#tableDlg').showModal());
$('#tableDlg').addEventListener('close', () => {
  if ($('#tableDlg').returnValue !== 'ok') return;
  insertTable(clamp(parseInt($('#tbRows').value, 10) || 3, 1, 30), clamp(parseInt($('#tbCols').value, 10) || 3, 1, 12));
});

$('#btnImage').addEventListener('click', () => $('#imageInput').click());
$('#imageInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; insertImageFile(f); });
$('#btnNote').addEventListener('click', () => insertNote());
// 붙여넣기(Ctrl+V)와 끌어 놓기로도 그림 넣기
document.addEventListener('paste', (e) => {
  if (state.screen !== 'editor' || state.editing || e.target.closest?.('input, textarea')) return;
  const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
  if (f) { e.preventDefault(); insertImageFile(f); }
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
    b.innerHTML = `<span>🎙 ${escapeHtml(r.name || '녹음')}</span><span class="muted">${fmtTime(r.duration)}${r.segments?.length ? ' · 받아쓰기' : ''}</span>`;
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
  for (const it of vis) if (isHighlighter(it)) drawItem(ctx, it);
  ctx.globalCompositeOperation = 'source-over';
  for (const it of vis) if (!isHighlighter(it)) drawItem(ctx, it);
  return c.toDataURL('image/jpeg', 0.88).split(',')[1]; // PNG 는 사진 많은 PDF 에서 이미지 한도(5MB)를 넘을 수 있음
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
  setLayerState(layers);
  if (!layers.some((l) => l.id === activeLayer)) activeLayer = layers[layers.length - 1].id;
  const d = state.doc;
  if (d) d.activeLayer = activeLayer === DEFAULT_LAYER ? null : activeLayer;
  viewer.requestInk();
  if (d) for (const p of d.pages.keys()) thumbs.markInk(p);
  $('#btnLayers').classList.toggle('on', layers.length > 1);
  if (save && d) {
    d.meta.layers = layers;
    d.meta.activeLayer = activeLayer;
    store.patchDoc(d.id, { layers, activeLayer }).catch(() => {});
  }
  if (!$('#layerPanel').hidden) renderLayers();
}

const layerById = (id) => layers.find((l) => l.id === id);
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
  $('#layerPanel').hidden = false;
  renderLayers();
}
$('#btnLayers').addEventListener('click', () => { if ($('#layerPanel').hidden) openLayerPanel(); else $('#layerPanel').hidden = true; });
$('#lyClose').addEventListener('click', () => { $('#layerPanel').hidden = true; });

// ───────────────────────────── 링크 ─────────────────────────────

let backAnchor = null;
async function followLinkAt(sx, sy) {
  if (!state.doc) return;
  const hit = viewer.pageAtScreen(sx, sy, true);
  if (!hit) return;
  if (tapObjectAt(hit.page, hit.x, hit.y)) return; // 손가락 탭으로도 포스트잇 접기/펼치기·체크
  if (player && seekToInkAt(hit.page, hit.x, hit.y)) return; // 녹음 재생 중: 탭한 필기를 쓰던 순간으로
  const inside = (r) => hit.x >= r.x && hit.x <= r.x + r.w && hit.y >= r.y && hit.y <= r.y + r.h;
  const items = state.doc.items(hit.page);
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].t === 'ln' && !layerHidden(items[i]) && inside(items[i])) { followTarget(items[i].to); return; }
  }
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
  backAnchor = viewer.anchor();
  viewer.goToPage(to.page, to.y || 0);
  const chip = $('#backChip');
  chip.querySelector('span').textContent = `돌아가기 (${backAnchor.page + 1}쪽)`;
  chip.hidden = false;
}
$('#backChip').addEventListener('click', () => {
  if (backAnchor) viewer.restoreAnchor(backAnchor);
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
}
lnDlg.querySelectorAll('#lnKind button').forEach((b) => b.addEventListener('click', () => setLinkKind(b.value)));
function editLink(page, item, rect) {
  lnEditing = { page, item, rect, kind: item?.to?.url ? 'url' : 'page' };
  $('#lnPage').max = viewer.pages.length;
  $('#lnPage').value = Number.isInteger(item?.to?.page) ? item.to.page + 1 : '';
  $('#lnUrl').value = item?.to?.url || '';
  $('#lnDelete').hidden = !item;
  setLinkKind(lnEditing.kind);
  lnDlg.showModal();
}
lnDlg.addEventListener('close', () => {
  const ed = lnEditing, doc = state.doc;
  lnEditing = null;
  if (!ed || !doc) return;
  const rv = lnDlg.returnValue;
  const items = doc.items(ed.page);
  if (rv === 'delete' && ed.item) { doc.setItems(ed.page, items.filter((i) => i.id !== ed.item.id)); return; }
  if (rv !== 'ok') return;
  let to;
  if (ed.kind === 'url') {
    let u = $('#lnUrl').value.trim();
    if (!u) { toast('주소를 입력하세요'); return; }
    if (!/^[a-z]+:/i.test(u)) u = 'https://' + u;
    if (!/^(https?:|mailto:|tel:)/i.test(u)) { toast('http(s), mailto, tel 주소만 쓸 수 있습니다'); return; }
    to = { url: u };
  } else {
    const n = parseInt($('#lnPage').value, 10);
    if (!(n >= 1 && n <= viewer.pages.length)) { toast(`1~${viewer.pages.length} 사이의 페이지 번호를 입력하세요`); return; }
    to = { page: n - 1 };
  }
  if (ed.item) doc.setItems(ed.page, items.map((i) => (i.id === ed.item.id ? { ...i, to } : i)));
  else doc.add(ed.page, { id: uid('ln'), t: 'ln', ...ed.rect, to });
});

// ───────────────────────────── Undo / Redo ─────────────────────────────

function doUndo() {
  if (!state.doc) return;
  commitTextEdit();
  const page = state.doc.undo();
  if (page == null) { toast('더 이상 실행 취소할 수 없습니다', { ms: 1200 }); return; }
  tools.validateSelection();
  toast('실행 취소', { ms: 900 });
}
function doRedo() {
  if (!state.doc) return;
  const page = state.doc.redo();
  if (page == null) { toast('다시 실행할 항목이 없습니다', { ms: 1200 }); return; }
  tools.validateSelection();
  toast('다시 실행', { ms: 900 });
}
function updateHistoryButtons() {
  const d = state.doc;
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
  if (e.target.closest?.('input, textarea, select')) {
    if (e.target.id === 'textEditor' && e.key === 'Escape') { e.preventDefault(); commitTextEdit(); }
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && tools.selection) { e.preventDefault(); tools.deleteSelection(); }
  else if (e.key === 'Escape') { tools.clearSelection(); closeQuickMenu(); closeToolPopup(); }
  else if (e.key === 'PageDown') viewer.goToPage(viewer.currentPage() + 1);
  else if (e.key === 'PageUp') viewer.goToPage(viewer.currentPage() - 1);
  else if (!mod && !e.altKey) {
    const map = { p: 'pen', h: 'hl', e: 'eraser', l: 'lasso', t: 'text', s: 'shape', k: 'link' };
    if (map[e.key]) selectTool(map[e.key]);
  }
});

// ───────────────────────────── 도구 모음 ─────────────────────────────

const TOOL_NAMES = { pen: '펜', hl: '형광펜', eraser: '지우개', lasso: '올가미', text: '텍스트', shape: '도형', link: '링크' };

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
  for (const b of document.querySelectorAll('#toolbar [data-tool], #quickMenu [data-tool]')) b.classList.toggle('on', b.dataset.tool === tool);
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
  pop.style.left = clamp(tb.left + tb.width / 2 - w / 2 - ed.left, 8, ed.width - w - 8) + 'px';
  pop.style.top = (tb.top - ed.top - h - 10) + 'px';
}
function closeToolPopup() { $('#toolPopup').hidden = true; }

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
// 설정 → 제스처 동작에서 각 제스처(펜 꾹 누르기, 펜 두 번 탭, 두 손가락 탭 …)에 지정한 동작을 실행한다.

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
    case 'toggleFinger': $('#btnFinger').click(); break;
    case 'toggleRuler': $('#btnRuler').click(); break;
    case 'toggleProt': $('#btnProt').click(); break;
    case 'thumbs': $('#btnThumbs').click(); break;
    case 'fitWidth': viewer.fitWidth(); showZoomBadge(); break;
    default: break;
  }
}

// ───────────────────────────── S Pen 빠른 메뉴 ─────────────────────────────

function openQuickMenu(sx, sy, source) {
  if (state.screen !== 'editor') return;
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
}
for (const b of document.querySelectorAll('#quickMenu [data-tool]')) {
  b.addEventListener('click', () => { selectTool(b.dataset.tool); closeQuickMenu(); });
}
document.querySelector('[data-qm=undo]').addEventListener('click', () => { doUndo(); renderQuickMenu(); });
document.querySelector('[data-qm=redo]').addEventListener('click', () => { doRedo(); renderQuickMenu(); });

// ───────────────────────────── 선택 상자 ─────────────────────────────

let selState = null;
function renderSelection(sel, dragging, m) {
  selState = sel ? { sel, dragging, m } : null;
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
      Object.assign(box.style, { left: a.x + 'px', top: a.y + 'px', width: w * z + 'px', height: hh * z + 'px' });
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
        const oneTable = selItems.length === 1 && selItems[0].t === 'tb';
        menu.querySelectorAll('[data-sel^=tb-]').forEach((b) => { b.hidden = !oneTable; });
        const notes = selItems.filter((i) => i.t === 'nt');
        const fb = menu.querySelector('[data-sel=fold]');
        fb.hidden = !notes.length;
        fb.title = notes.some((n) => !n.fold) ? '포스트잇 접기' : '포스트잇 펼치기';
        const mw = menu.offsetWidth, mh = menu.offsetHeight;
        let top = a.y - mh - 10;
        if (top < 6) top = a.y + hh * z + 10;
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
  if (a === 'fold') {
    const sel = tools.selection;
    if (!sel) return;
    const notes = state.doc.items(sel.page).filter((i) => i.t === 'nt' && sel.ids.has(i.id));
    const fold = notes.some((n) => !n.fold);
    tools.clearSelection();
    setNotesFold(sel.page, new Set(notes.map((n) => n.id)), fold);
  }
  if (a?.startsWith('tb-')) {
    // 표 행·열 추가/삭제 (높이·폭은 칸 크기 유지)
    const sel = tools.selection;
    const items = state.doc.items(sel.page);
    const t = items.find((i) => sel.ids.has(i.id) && i.t === 'tb');
    if (!t) return;
    const { rows, cols } = tableSize(t);
    let cells = t.cells, w = t.w, h = t.h;
    if (a === 'tb-addRow') { cells = [...cells, Array(cols).fill('')]; h += h / rows; }
    if (a === 'tb-delRow' && rows > 1) { cells = cells.slice(0, -1); h -= h / rows; }
    if (a === 'tb-addCol') { cells = cells.map((r) => [...r, '']); w += w / cols; }
    if (a === 'tb-delCol' && cols > 1) { cells = cells.map((r) => r.slice(0, -1)); w -= w / cols; }
    state.doc.setItems(sel.page, items.map((i) => (i.id === t.id ? { ...i, cells, w, h } : i)));
    renderSelection(tools.selection);
  }
  if (a === 'edit') {
    const sel = tools.selection;
    const it = sel && state.doc.items(sel.page).find((i) => sel.ids.has(i.id) && ['tx', 'nt', 'cl', 'tb'].includes(i.t));
    if (it) { tools.clearSelection(); startTextEdit(sel.page, it, undefined, undefined, it.t === 'tb' ? { cell: { r: 0, c: 0 } } : {}); }
  }
});

// ───────────────────────────── 텍스트 편집 ─────────────────────────────

const te = $('#textEditor');
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
  if (item && (ed.kind === 'text' || ed.kind === 'note')) { viewer.hidden = new Set([item.id]); viewer.requestInk(); }
  te.value = ed.kind === 'check' ? item.rows.map((r) => r.text).join('\n')
    : ed.kind === 'cell' ? item.cells[ed.cell.r][ed.cell.c]
    : item ? item.text : '';
  te.hidden = false;
  positionTextEditor();
  // 화면 키보드가 뜨도록 포커스 (펜 탭 직후). 바로 한 번 + 이벤트 처리 뒤 한 번
  const focusEnd = () => { if (state.editing !== ed) return; te.focus({ preventScroll: true }); te.setSelectionRange(te.value.length, te.value.length); };
  focusEnd();
  setTimeout(focusEnd, 0);
}

function positionTextEditor() {
  const ed = state.editing;
  if (!ed) return;
  const z = viewer.cam.z;
  const base = { fontSize: ed.fs * z + 'px', color: ed.c, fontFamily: TEXT_FONT, lineHeight: TEXT_LINE, background: '' };
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
      width: r.w * z + 'px', height: r.h * z + 'px', fontWeight: ed.cell.r === 0 ? 'bold' : 'normal',
    });
    return;
  }
  const a = viewer.pageToScreen(ed.page, ed.x, ed.y);
  const L = textLayout({ text: te.value || ' ', fs: ed.fs });
  Object.assign(te.style, base, {
    left: a.x - 2 + 'px', top: a.y - 2 + 'px', padding: '0', fontWeight: 'normal', whiteSpace: '',
    width: Math.max(L.w * z + ed.fs * z * 1.5, 60) + 'px', height: L.h * z + 4 + 'px',
  });
}
te.addEventListener('input', positionTextEditor);
// 다른 곳을 누르면 확정. 단, 그사이 다른 편집(표의 다음 칸 등)이 시작됐으면 그것은 건드리지 않는다
te.addEventListener('blur', () => {
  const ed = state.editing;
  setTimeout(() => { if (ed && state.editing === ed && document.activeElement !== te) commitTextEdit(); }, 0);
});
// 표: Tab / Shift+Tab 으로 다음·이전 칸
te.addEventListener('keydown', (e) => {
  const ed = state.editing;
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
  te.hidden = true;
  te.style.padding = '0';
  te.style.whiteSpace = '';
  te.style.fontWeight = 'normal';
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
  const fmt = { smoothing: (v) => v, holdMs: (v) => `${v}ms`, holdTolerance: (v) => `${v}px`, palmSize: (v) => `${v}px`, penGuardMs: (v) => `${v}ms` };
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
});
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
    for (const [id, im] of Object.entries(data.images || {})) {
      const blob = await (await fetch(im.data)).blob();
      await store.putBlob({ id, docId: d.id, data: blob, w: im.w, h: im.h });
    }
    // 백업의 레이어 목록도 복원 (없으면 지금 레이어 유지)
    if (Array.isArray(data.layers) && data.layers.length) { d.meta.layers = data.layers; d.meta.activeLayer = null; initLayers(d); applyLayers(); }
    d.begin();
    let n = 0, bad = 0;
    for (let p = 0; p < viewer.pages.length; p++) {
      const raw = data.pages[p];
      const items = Array.isArray(raw) ? raw.map(sanitizeItem).filter((x) => x || (bad++, false)) : [];
      n += items.length;
      if (items.length || d.items(p).length) d.setItems(p, items);
    }
    d.commit();
    toast(`필기 ${n}개를 복원했습니다` + (bad ? ` (손상된 ${bad}개 제외)` : ''));
  } catch (err) { toast('백업을 읽을 수 없습니다: ' + err.message, { error: true }); }
});

settings.on('change', ({ path }) => {
  if (path === 'theme' || path === '*') applyTheme();
  if (path === 'debug' || path === '*') { dbg.enable(settings.get('debug')); $('#btnDebug').hidden = !settings.get('debug'); }
  if (path === 'tool' || path === '*') renderToolbar();
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
window.__flexnote = { viewer, tools, input, settings, state, store };
