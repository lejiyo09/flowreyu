// 한글(HWP·HWPX) 문서 편집: @ohah/hwpjs (MIT, vendor/hwpjs) 엔진을 FlexNote 안에서 쓴다.
// 한글 파일을 다른 형식으로 바꾸지 않고 원래 형식(.hwp/.hwpx) 그대로 열고, 고치고, 저장한다.
// 엔진(약 9MB: 모듈 2MB + 워커 1.5MB + WASM 5.6MB)은 한글 파일을 처음 열 때만 읽는다.
const BASE = new URL('../vendor/hwpjs/', import.meta.url);
let H = null;
const ZOOMS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export async function loadEngine() {
  H ||= await import('../vendor/hwpjs/hwpjs.mjs');
  return H;
}

/** 파일 앞부분으로 형식 판별: HWP5 = OLE 복합 문서, HWPX = ZIP. 아니면 null */
export function sniffFormat(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return 'hwp5';
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'hwpx';
  return null;
}

/** 편집 중인 한글 문서 하나 (캔버스 화면 + 엔진) */
export class HwpSession {
  /**
   * root 안에 문서를 그리고 편집할 수 있게 연다.
   * onChange(): 내용이 바뀔 때 (실행 취소 포함)
   */
  static async open(root, bytes, { onChange, onError, onShortcut } = {}) {
    const E = await loadEngine();
    const editor = E.createEditor({
      runtimeFactory: E.createWorkerRuntimeFactory() /* 주소를 넘기면 엔진이 '사용자 지정'으로 보고 찾기·서식 읽기 등을 끔 → 모듈 옆 worker.js·hwpjs.wasm 기본값 */,
      onError: (ev) => onError?.(ev.error),
    });
    let surface = null;
    try {
      surface = E.createCanvasSurface({ root, editor });
      // bytes 가 'hwp5'|'hwpx' 문자열이면 빈 새 문서
      const format = typeof bytes === 'string' ? bytes : E.detectDocumentFormat(bytes);
      const st = typeof bytes === 'string' ? await editor.createDocument({ format, editable: true }) : await editor.load(bytes, { format, editable: true });
      const s = new HwpSession(editor, surface, format, st.operationRevision);
      s.detachTouch = touchNavigation(root, s);
      // 한글 프로그램과 같은 단축키 (Ctrl+B·I·U, Alt+Shift+B, Ctrl+Shift+L/C/R/M 정렬, Ctrl+F·H, Ctrl+S …) → 앱이 실행
      if (onShortcut && E.createKeyboardShortcuts) {
        const mac = /Mac|iPhone|iPad/.test(navigator.platform);
        s.shortcuts = E.createKeyboardShortcuts({
          root, config: E.DEFAULT_KEYMAP, fallback: E.DEFAULT_KEYMAP, platform: mac ? 'mac' : /Win/.test(navigator.platform) ? 'windows' : 'linux',
          shouldHandle: (e) => !e.isComposing && !e.target?.closest?.('dialog'),
          isAvailable: (cmd) => onShortcut(cmd, true),
          execute: (cmd) => onShortcut(cmd, false),
          nativePaste: () => surface.focusForPaste?.() || false,
          onError: (e) => console.warn('[hwp shortcut]', e),
        });
      }
      editor.registerStateListener((state) => {
        if (state.operationRevision !== s.rev) { s.rev = state.operationRevision; onChange?.(); }
      });
      return s;
    } catch (e) {
      try { await surface?.dispose(); } finally { await editor.dispose().catch(() => {}); }
      throw e;
    }
  }

  constructor(editor, surface, format, rev) {
    this.editor = editor;
    this.surface = surface;
    this.fileFormat = format; // 'hwp5' | 'hwpx'
    this.rev = rev;
    this.scale = 1;
  }

  /**
   * 지금 내용을 원래 형식의 파일로. 한글이 열 때 줄 배치를 다시 계산하므로
   * 옛 줄 배치 정보가 남아 있어도(allowStaleLayout) 저장한다 — 글·서식·표는 그대로.
   */
  async save({ flush = true } = {}) {
    // 조합 중인 한글 마지막 글자까지 (자동 저장은 입력 도중이라 끊지 않음 — 다음 자동 저장에 들어감)
    if (flush) await this.surface.flushComposition?.().catch(() => {});
    const r = await this.editor.save({ allowStaleLayout: true });
    return { bytes: r.bytes, format: r.format, staleLayout: !!r.layoutRequiresReflow };
  }

  /** 앞선 입력(조합 중인 한글 글자 포함)을 모두 반영 */
  async settle() {
    await this.surface.flushComposition?.().catch(() => {});
    await this.editor.update(() => {}).catch(() => {});
  }
  selection() { return this.surface.getSelection?.() || null; }
  state() { return this.editor.getEditorState(); }

  /** 지금 선택·커서의 서식 (도구 모음 표시용). size 는 pt, align 은 left/center/right/justify */
  formatting() {
    try {
      const f = H.getSelectionFormatting(this.state());
      const font = f.fontNames?.hangul?.kind === 'single' ? f.fontNames.hangul.name : f.fontNames?.latin?.kind === 'single' ? f.fontNames.latin.name : '';
      const range = !!f.target && f.target.startUnit !== f.target.endUnit;
      return {
        range, caret: !!f.target && !range,
        bold: f.bold === true, italic: f.italic === true, underline: f.underline === true, strike: f.strike === true,
        size: typeof f.size === 'number' ? f.size / 100 : null, color: typeof f.textColor === 'string' ? f.textColor : null,
        align: typeof f.align === 'string' ? f.align.toLowerCase() : null, font,
      };
    } catch { return {}; }
  }

  /**
   * 글자 서식. 글자를 선택했으면 그 글자에, 커서만 있으면 다음에 칠 글자에 (한글 프로그램과 같음).
   * kind: bold·italic·underline·strike(켜기/끄기), size(pt), color('#rrggbb'), font(글꼴 이름). 실패하면 이유 문자열
   */
  async setFormat(kind, value) {
    await this.settle();
    const state = this.state();
    let f;
    try { f = H.getSelectionFormatting(state); } catch { f = null; }
    const target = f?.target;
    if (!target) return '먼저 글자를 선택하거나 커서를 놓으세요';
    if (target.startUnit !== target.endUnit) { // 선택한 글자
      const C = H;
      if (kind === 'bold' || kind === 'italic') return this.run(C.SET_CHARACTER_PROPERTIES_COMMAND, { target, properties: { [kind]: value } });
      if (kind === 'size') return this.run(C.SET_CHARACTER_PROPERTIES_COMMAND, { target, properties: { size: Math.round(value * 100) } });
      if (kind === 'underline') return this.run(C.SET_CHARACTER_UNDERLINE_COMMAND, { target, kind: value ? 'bottom' : 'none' });
      if (kind === 'strike') return this.run(C.SET_CHARACTER_STRIKE_COMMAND, { target, enabled: value });
      if (kind === 'color') return this.run(C.SET_CHARACTER_TEXT_COLOR_COMMAND, { target, color: value });
      if (kind === 'font') {
        for (const language of ['hangul', 'latin']) {
          const why = await this.run(C.SET_CHARACTER_FONT_NAME_COMMAND, { target: this.state().selection || target, language, name: value });
          if (why) return why;
        }
        return null;
      }
      return '지원하지 않는 서식';
    }
    // 커서만: 다음 입력 서식 (엔진 화면이 맡음)
    const cap = this.surface.captureCaretFormatting?.();
    if (!cap) return '이 위치에서는 다음 입력 서식을 정할 수 없습니다';
    const intent = kind === 'bold' || kind === 'italic' ? { kind: 'character-properties', properties: { [kind]: value } }
      : kind === 'size' ? { kind: 'character-properties', properties: { size: Math.round(value * 100) } }
      : kind === 'underline' ? { kind: 'underline', underlineKind: value ? 'bottom' : 'none' }
      : kind === 'strike' ? { kind: 'strike', enabled: value }
      : kind === 'color' ? { kind: 'text-color', color: value }
      : kind === 'font' ? { kind: 'font-names', names: Object.fromEntries(['hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user'].map((l) => [l, value])) }
      : null;
    if (!intent) return '지원하지 않는 서식';
    try { return cap.request(intent) ? null : '다음 입력 서식을 정하지 못했습니다'; } catch (e) { return describe(e?.message || e); }
  }

  /** 문단 정렬 left/center/right/justify (커서만 있어도 그 문단) */
  async align(alignment) {
    await this.settle();
    const target = this.state().selection || this.selection();
    if (!target) return '먼저 문단을 누르세요';
    return this.run(H.SET_PARAGRAPH_ALIGNMENT_COMMAND, { target, alignment: String(alignment).toUpperCase() });
  }

  // ── 찾기·바꾸기 (엔진의 문서 전체 글 색인) ──
  /** query 를 찾아 선택. dir 'forward'|'backward'. 결과 'selected'|'not-found' */
  async find(query, dir = 'forward') {
    if (!query) return 'not-found';
    await this.settle();
    await this.surface.prepareDocumentTextReadView?.(() => true).catch(() => {});
    for (let attempt = 0; attempt < 2; attempt++) {
      const st = this.state();
      const index = await this.editor.getDocumentTextSnapshot({ token: st.token });
      let anchor = this.lastFind && this.lastFind.query === query && this.lastFind.state === st ? this.lastFind.match : null;
      if (!anchor) { // 커서 위치부터
        const read = this.surface.captureDocumentTextCaret?.();
        if (read?.status === 'captured' && this.editor.getDocumentTextAnchor) {
          try {
            const a = await this.editor.getDocumentTextAnchor(index, read.capture.anchor);
            const b = await this.editor.getDocumentTextAnchor(index, read.capture.focus);
            const order = a.ordinal - b.ordinal || a.startUnit - b.startUnit;
            const from = dir === 'forward' ? (order > 0 ? a : b) : order < 0 ? a : b;
            anchor = { ref: from.ref, startUnit: from.startUnit, endUnit: from.endUnit };
          } catch { /* 처음부터 */ }
        }
      }
      const match = H.findDocumentTextMatch(index, query, { direction: dir, wrap: true, ...(anchor ? { anchor: { ref: anchor.ref, startUnit: anchor.startUnit, endUnit: anchor.endUnit } } : {}) });
      if (!match) return 'not-found';
      const obs = await this.editor.getDocumentTextSelection(index, match);
      const receipt = await this.surface.selectDocumentText(obs, () => true, match);
      if (!receipt) return 'not-found';
      if (receipt.status === 'revealed') continue; // 화면을 옮겼으니 다시 관측
      await this.settle();
      this.lastFind = { query, match, state: this.state() };
      return 'selected';
    }
    return 'not-found';
  }
  /** 문서 전체에서 query 가 나오는 횟수 */
  async count(query) {
    if (!query) return 0;
    const index = await this.editor.getDocumentTextSnapshot({ token: this.state().token });
    if (H.documentTextMatches) return H.documentTextMatches(index, query).length;
    return 0;
  }
  /** 지금 선택이 query 와 같으면 replacement 로 바꿈 → 바꿨으면 true */
  async replaceSelection(query, replacement) {
    await this.settle();
    const st = this.state();
    if (!H.selectionMatchesText(st, query)) return false;
    const r = await this.editor.dispatchCommand(H.SPLICE_TEXT_COMMAND, { target: st.selection, text: replacement, selectionVersion: st.stateVersion });
    return /^committed/.test(r?.status || '');
  }
  /** 모두 바꾸기 → 'done' | 'none' | 이유 */
  async replaceAll(query, replacement) {
    await this.settle();
    const st = this.state();
    const r = await this.editor.dispatchCommand(H.REPLACE_ALL_COMMAND, { schemaVersion: 1, query, replacement, layoutToken: st.token, stateVersion: st.stateVersion });
    if (r?.status === 'known-no-op') return 'none';
    if (/^committed/.test(r?.status || '')) return 'done';
    return describe(r?.error || r?.status);
  }

  // ── 표 ──
  /** 커서 자리에 rows×cols 표 (너비 pt). 실패하면 이유 */
  async insertTable(rows, cols, widthPt = 450, rowHeightPt = 18) {
    await this.settle();
    const st = this.state();
    const target = H.getSelectionFormatting(st).target;
    const av = H.getTableInsertAvailability(st, target);
    if (!av.allowed) return av.reason === 'UnsupportedTableInsertReference' ? '이 위치(표 안·글상자 등)에는 표를 넣을 수 없습니다. 본문 문단을 누르세요' : describe(av.reason);
    return this.run(H.INSERT_TABLE_COMMAND, { target, options: { rows, columns: cols, width: Math.max(cols, Math.round(widthPt * 100)), rowHeight: Math.round(rowHeightPt * 100), resources: av.resources } });
  }
  /** 표 행·열: action 'insert-row'|'delete-row'|'insert-column'|'delete-column' (지금 셀 기준, 넣기는 아래·오른쪽) */
  async tableGrid(action) {
    await this.settle();
    const st = this.state();
    const src = this.surface.captureSourceTableGridSelection?.();
    if (src && src.state === st && src.current()) {
      const index = (action.endsWith('row') ? src.row : src.column) + (action.startsWith('insert') ? 1 : 0);
      if (action === 'delete-row' && src.rows === 1) return '마지막 행은 지울 수 없습니다 (표를 지우려면 표 전체를 선택해 지우세요)';
      if (action === 'delete-column' && src.columns === 1) return '마지막 열은 지울 수 없습니다';
      const r = await this.editor.dispatchCommand(H.EDIT_SOURCE_TABLE_GRID_COMMAND, {
        section: src.section, tableNode: src.tableNode, expectedRows: src.rows, expectedColumns: src.columns, action, index,
        ...(st.content?.format === 'hwp5' ? { layout: 'observed8' } : {}),
      }).catch((e) => ({ error: e?.message }));
      if (r?.status === 'committed-with-snapshot') src.recordHistory?.(r, null);
      return /^committed/.test(r?.status || '') ? null : describe(r?.error || r?.status);
    }
    const gen = this.surface.captureGeneratedTableGridSelection?.();
    if (gen && gen.state === st && gen.current()) {
      const c = gen.createdCell;
      const index = (action.endsWith('row') ? c.row : c.column) + (action.startsWith('insert') ? 1 : 0);
      return this.run(H.EDIT_CREATED_TABLE_GRID_COMMAND, { section: gen.section, identity: c.identity, action, index });
    }
    return '먼저 표의 칸을 누르세요';
  }
  /** 셀 합치기: 칸 여러 개를 블록으로 선택한 뒤 (F5 또는 끌기) */
  async mergeCells() {
    const m = this.surface.captureSourceTableCellMerge?.();
    if (!m) return '합칠 칸을 두 개 이상 선택하세요 (칸 안에서 F5 뒤 방향키, 또는 끌어서)';
    return this.run(H.MERGE_SOURCE_TABLE_CELLS_COMMAND, m.target);
  }
  /** 셀 나누기: 지금 칸을 rows×cols 로 */
  async splitCell(rows, cols) {
    const sp = this.surface.captureSourceTableCellSplit?.();
    if (!sp) return '나눌 칸을 누르세요';
    return this.run(H.SPLIT_SOURCE_TABLE_CELLS_COMMAND, { target: sp.target, rows, columns: cols, mode: 'each', equalizeRows: true });
  }
  /** 칸 블록 시작(F5) */
  cellBlock(extend = false) { return this.surface.requestCellBlock?.(extend) || false; }

  // ── 그림 ──
  /** 커서 자리에 그림 (PNG/JPEG 바이트, 픽셀 크기). 너무 크면 150mm 안으로 */
  async insertImage(bytes, pxW, pxH) {
    await this.settle();
    const st = this.state();
    const caret = this.surface.captureInlineObjectInsertCaret?.();
    if (!caret || caret.state !== st) return '그림을 넣을 자리에 커서를 놓으세요';
    // HWPUNIT: 1인치 = 7200, 96px = 1인치 → 1px = 75
    let w = pxW * 75, h = pxH * 75;
    const cap = 150 / 25.4 * 7200, k = Math.min(1, cap / w, cap / h);
    w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));
    let target;
    if (st.content?.format === 'hwpx') {
      try { target = await this.editor.getInlineObjectInsertTarget(caret.selector, caret.unit, { affinity: caret.affinity ?? 'forward' }); }
      catch (e) { return describe(e?.message || e); }
    } else {
      target = st.selection;
      if (!target || target.owner !== `section:${target.section}:body`) return '그림은 본문 문단에만 넣을 수 있습니다 (표 안·글상자 제외)';
    }
    return this.run(H.INSERT_IMAGE_COMMAND, { target, selectionVersion: st.stateVersion, options: { imageBytes: bytes, width: w, height: h } });
  }

  // ── 쪽 설정 ──
  /** 지금 구역의 용지·여백 (mm) */
  async pageSettings() {
    const read = await this.editor.getPageSettings();
    if (read.state !== 'available') return { error: describe(read.reason) };
    const cur = read.sections.find((x) => x.section === (read.currentSection ?? 0)) || read.sections[0];
    const s = cur?.source;
    if (!s) return { error: describe(cur?.reason || 'Unavailable') };
    const mm = (v) => (v == null ? null : Math.round(v * 25.4 / 7200 * 10) / 10);
    return { read, values: { orientation: s.orientation, gutter_type: s.gutter_type || 'left_only', width: mm(s.width), height: mm(s.height), margin: Object.fromEntries(Object.entries(s.margin || {}).map(([k, v]) => [k, mm(v)])) }, sections: read.sections.length };
  }
  /** 쪽 설정 바꾸기 (mm). scope 'section'|'document' */
  async setPageSettings(read, v, scope = 'document') {
    const u = (mm) => Math.round(mm * 7200 / 25.4);
    const values = { orientation: v.orientation, width: u(v.width), height: u(v.height), gutter_type: v.gutter_type, margin: Object.fromEntries(Object.entries(v.margin).map(([k, x]) => [k, u(x || 0)])) };
    return this.run(H.EDIT_PAGE_SETTINGS_COMMAND, { target: read.target, scope, values });
  }

  // ── 클립보드 ──
  async copy(cut = false) {
    if (!this.surface.canTransferSelection?.(cut, navigator.clipboard)) return '복사할 글을 선택하세요';
    const ok = await this.surface.transferSelection({ cut, clipboard: navigator.clipboard }).catch(() => false);
    return ok ? null : (cut ? '잘라내지 못했습니다' : '복사하지 못했습니다');
  }

  async run(cmd, payload) {
    try {
      const r = await this.editor.dispatchCommand(cmd, payload);
      if (/^committed/.test(r?.status || '') || r?.status === 'known-no-op') return null;
      return describe(r?.error || r?.reason || r?.status);
    } catch (e) {
      return describe(e?.message || e);
    }
  }

  canUndo() { return this.surface.canRequestHistory('undo'); }
  canRedo() { return this.surface.canRequestHistory('redo'); }
  undo() { return this.surface.requestHistory('undo'); }
  redo() { return this.surface.requestHistory('redo'); }
  focus() { this.surface.focus(); }

  /** 배율: 엔진이 받는 단계(25%~400%) 중 가장 가까운 값으로 */
  setScale(z) {
    const near = ZOOMS.reduce((a, b) => (Math.abs(Math.log(b / z)) < Math.abs(Math.log(a / z)) ? b : a));
    if (near !== this.scale && this.surface.setScale(near)) this.scale = near;
    return this.scale;
  }
  /** 한 단계 확대(+1)·축소(-1) */
  zoomStep(dir) {
    const i = ZOOMS.indexOf(this.scale);
    const next = ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, (i < 0 ? ZOOMS.indexOf(1) : i) + dir))];
    return this.setScale(next);
  }

  async dispose() {
    this.detachTouch?.();
    try { this.shortcuts?.dispose(); } catch { /* */ }
    try { await this.surface.dispose(); } catch { /* */ }
    try { await this.editor.dispose(); } catch { /* */ }
  }
}

/** 엔진의 거절 이유를 사람 말로 */
function describe(reason) {
  const r = String(reason || '').replace(/^(Error|RuntimeAdmissionRejected):\s*/, '');
  if (/ReadOnly/i.test(r)) return '읽기 전용 문서입니다';
  if (/Unavailable|Unsupported/i.test(r)) return '이 위치에서는 아직 이 서식을 바꿀 수 없습니다';
  return r ? `적용하지 못했습니다 (${r})` : '적용하지 못했습니다';
}

/**
 * 손가락 조작: 엔진 캔버스는 touch-action:none 이라 그대로면 손가락으로 넘길 수 없다.
 * 한 손가락 끌기 = 문서 스크롤, 짧은 탭 = 그 자리 클릭(커서), 두 손가락 = 확대·축소. 펜·마우스는 엔진이 그대로 받음.
 */
function touchNavigation(root, session) {
  const pts = new Map(); // pointerId → {x, y}
  let start = null, moved = false, pinch = null, raf = 0, nextScale = 0;
  const scroller = () => {
    for (const el of root.querySelectorAll('div')) {
      const o = getComputedStyle(el).overflowY;
      if ((o === 'auto' || o === 'scroll') && el.scrollHeight > el.clientHeight) return el;
    }
    return root.querySelector('div div') || root;
  };
  const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };
  const own = (e) => { e.stopPropagation(); if (e.cancelable) e.preventDefault(); };
  const down = (e) => {
    if (e.pointerType !== 'touch') return;
    own(e);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { root.setPointerCapture(e.pointerId); } catch { /* */ }
    if (pts.size === 1) {
      const sc = scroller();
      start = { x: e.clientX, y: e.clientY, sl: sc.scrollLeft, st: sc.scrollTop, sc, t: performance.now() };
      moved = false;
    } else if (pts.size === 2) { pinch = { d: dist(), z: session.scale }; moved = true; }
  };
  const move = (e) => {
    if (e.pointerType !== 'touch' || !pts.has(e.pointerId)) return;
    own(e);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size >= 2) {
      nextScale = pinch.z * dist() / pinch.d;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; session.setScale(nextScale); session.onScale?.(session.scale); });
      return;
    }
    if (!start) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (!moved && Math.hypot(dx, dy) < 8) return;
    moved = true;
    start.sc.scrollLeft = start.sl - dx;
    start.sc.scrollTop = start.st - dy;
  };
  const up = (e) => {
    if (e.pointerType !== 'touch' || !pts.has(e.pointerId)) return;
    own(e);
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size) return;
    const tap = start && !moved && e.type === 'pointerup' && performance.now() - start.t < 600;
    start = null;
    if (tap) { // 탭: 같은 자리에 마우스 클릭을 보내 엔진이 커서를 놓게
      const target = document.elementFromPoint(e.clientX, e.clientY);
      if (!target || !root.contains(target)) return;
      const o = { bubbles: true, cancelable: true, composed: true, clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, view: window };
      target.dispatchEvent(new PointerEvent('pointerdown', { ...o, buttons: 1 }));
      target.dispatchEvent(new MouseEvent('mousedown', { ...o, buttons: 1 }));
      target.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
      target.dispatchEvent(new MouseEvent('mouseup', { ...o, buttons: 0 }));
      target.dispatchEvent(new MouseEvent('click', { ...o, buttons: 0, detail: 1 }));
      session.focus();
    }
  };
  // 마우스·펜으로 눌러도 엔진의 글 입력 칸에 초점이 가지 않아 키보드 입력이 사라짐 → 누른 뒤 초점 주기
  const focusAfter = (e) => {
    if (e.pointerType === 'touch') return;
    setTimeout(() => { const a = document.activeElement; if (!(a?.tagName === 'TEXTAREA' && root.contains(a))) session.focus(); }, 0);
  };
  root.addEventListener('pointerup', focusAfter);
  const opt = { capture: true, passive: false };
  root.addEventListener('pointerdown', down, opt);
  root.addEventListener('pointermove', move, opt);
  root.addEventListener('pointerup', up, opt);
  root.addEventListener('pointercancel', up, opt);
  return () => {
    root.removeEventListener('pointerup', focusAfter);
    root.removeEventListener('pointerdown', down, opt);
    root.removeEventListener('pointermove', move, opt);
    root.removeEventListener('pointerup', up, opt);
    root.removeEventListener('pointercancel', up, opt);
    cancelAnimationFrame(raf);
  };
}
