// 앱 진입점: 라이브러리 ↔ 편집기, 도구 UI, 설정, 자동 저장 상태 표시를 연결한다.
import { settings, PEN_COLORS, HL_COLORS } from './settings.js';
import * as store from './store.js';
import { NoteDocument } from './document.js';
import { Viewer, pdfjsLib } from './viewer.js';
import { InputRouter } from './input.js';
import { ToolController } from './tools.js';
import { ThumbPanel } from './thumbs.js';
import { Guides } from './guides.js';
import { InputDebugger } from './debug.js';
import { uid, debounce, formatBytes, formatDate, escapeHtml, clamp } from './util.js';
import { sanitizeItem, TEXT_FONT, textLayout } from './ink.js';

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
  openMenu: (sx, sy, source) => openQuickMenu(sx, sy, source),
  undo: () => doUndo(),
  redo: () => doRedo(),
  showZoom: () => showZoomBadge(),
  onSelection: (sel, dragging, m) => renderSelection(sel, dragging, m),
  editText: (page, item, x, y) => startTextEdit(page, item, x, y),
  editLink: (page, item, rect) => editLink(page, item, rect),
  onEraserUsed: () => {
    if (!settings.get('eraser').autoReturn || settings.get('tool') !== 'eraser') return;
    selectTool(toolBeforeEraser || 'pen');
  },
  tap: (sx, sy) => followLinkAt(sx, sy),
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
  commitTextEdit();
  tools.cancel();
  tools.clearSelection();
  input.resetAll('close');
  closeQuickMenu(); closeToolPopup();
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
      (i, n) => busy(`PDF 만드는 중… ${i}/${n}`));
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

// ───────────────────────────── 링크 ─────────────────────────────

let backAnchor = null;
async function followLinkAt(sx, sy) {
  if (!state.doc) return;
  const hit = viewer.pageAtScreen(sx, sy, true);
  if (!hit) return;
  const inside = (r) => hit.x >= r.x && hit.x <= r.x + r.w && hit.y >= r.y && hit.y <= r.y + r.h;
  const items = state.doc.items(hit.page);
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].t === 'ln' && inside(items[i])) { followTarget(items[i].to); return; }
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

function selectTool(tool) {
  const prev = settings.get('tool');
  if (prev !== tool) {
    if (tool === 'eraser') toolBeforeEraser = prev;
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
        if (!colors.childElementCount) for (const c of PEN_COLORS.slice(0, 5)) colors.appendChild(swatch(c, false, () => tools.recolorSelection(c)));
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
});

// ───────────────────────────── 텍스트 편집 ─────────────────────────────

const te = $('#textEditor');
function startTextEdit(page, item, x, y) {
  commitTextEdit();
  const cfg = settings.get('text');
  state.editing = item
    ? { page, item, x: item.x, y: item.y, fs: item.fs, c: item.c }
    : { page, item: null, x, y: y - cfg.size * 0.65, fs: cfg.size, c: cfg.color };
  if (item) { viewer.hidden = new Set([item.id]); viewer.requestInk(); }
  te.value = item ? item.text : '';
  te.hidden = false;
  positionTextEditor();
  // 화면 키보드가 뜨도록 포커스 (펜 탭 직후)
  setTimeout(() => { te.focus({ preventScroll: true }); te.setSelectionRange(te.value.length, te.value.length); }, 0);
}
function positionTextEditor() {
  const ed = state.editing;
  if (!ed) return;
  const z = viewer.cam.z;
  const a = viewer.pageToScreen(ed.page, ed.x, ed.y);
  const L = textLayout({ text: te.value || ' ', fs: ed.fs });
  Object.assign(te.style, {
    left: a.x - 2 + 'px', top: a.y - 2 + 'px',
    fontSize: ed.fs * z + 'px', color: ed.c, fontFamily: TEXT_FONT,
    width: Math.max(L.w * z + ed.fs * z * 1.5, 60) + 'px', height: L.h * z + 4 + 'px',
  });
}
te.addEventListener('input', positionTextEditor);
te.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== te) commitTextEdit(); }, 0));
function commitTextEdit() {
  const ed = state.editing;
  if (!ed) return;
  state.editing = null;
  te.hidden = true;
  viewer.hidden = null;
  const doc = state.doc;
  const text = te.value.replace(/\s+$/, '');
  te.value = '';
  te.blur();
  if (!doc) return;
  const items = doc.items(ed.page);
  if (ed.item) {
    if (!text) doc.setItems(ed.page, items.filter((i) => i.id !== ed.item.id));
    else if (text !== ed.item.text) doc.setItems(ed.page, items.map((i) => (i.id === ed.item.id ? { ...i, text } : i)));
  } else if (text) {
    doc.add(ed.page, { id: uid('tx'), t: 'tx', x: ed.x, y: ed.y, c: ed.c, fs: ed.fs, text });
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
$('#setEraserReturn').addEventListener('change', (e) => settings.set('eraser', { ...settings.get('eraser'), autoReturn: e.target.checked }));

function syncSettingsForm() {
  $('#setEraserReturn').checked = !!settings.get('eraser').autoReturn;
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
  const data = { format: 'flexnote-ink', version: 1, name: d.meta.name, pageCount: viewer.pages.length, exported: new Date().toISOString(), pages };
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
