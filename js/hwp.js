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
  static async open(root, bytes, { onChange, onError, onShortcut, onState } = {}) {
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
      // 엔진의 글 입력 칸에도 Grammarly 등 확장이 붙지 않게 (캔버스 위 엉뚱한 자리에 밑줄이 뜸)
      for (const ta of root.querySelectorAll('textarea')) { ta.setAttribute('data-gramm', 'false'); ta.setAttribute('data-gramm_editor', 'false'); ta.setAttribute('data-enable-grammarly', 'false'); ta.spellcheck = false; }
      // 한글처럼 투명 표 선(테두리 없는 표)을 편집 화면에 점선으로 (인쇄·저장에는 나오지 않음)
      try { surface.setDisplayOptions({ paragraphMarks: false, formattingMarks: false, showTableGrid: true, showTransparentTableLines: true }); } catch { /* */ }
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
        onState?.(state); // 선택·커서 이동 포함 (도구 모음 표시)
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
  async _align(alignment) {
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
    let n = 0;
    for (const _ of H.documentTextMatches(index, query)) n++; // 생성기
    return n;
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
  async _insertTable(rows, cols, widthPt = 450, rowHeightPt = 18) {
    await this.settle();
    const st = this.state();
    const target = H.getSelectionFormatting(st).target;
    const av = H.getTableInsertAvailability(st, target);
    if (!av.allowed) return av.reason === 'UnsupportedTableInsertReference' ? '이 위치(표 안·글상자 등)에는 표를 넣을 수 없습니다. 본문 문단을 누르세요' : describe(av.reason);
    return this.run(H.INSERT_TABLE_COMMAND, { target, options: { rows, columns: cols, width: Math.max(cols, Math.round(widthPt * 100)), rowHeight: Math.round(rowHeightPt * 100), resources: av.resources } });
  }
  /** 표 행·열: action 'insert-row'|'delete-row'|'insert-column'|'delete-column' (지금 셀 기준, 넣기는 아래·오른쪽) */
  async _tableGrid(action) {
    await this.settle();
    const st = this.state();
    const src = this.surface.captureSourceTableGridSelection?.();
    if (src && src.state === st && src.current()) {
      const prevSel = st.selection;
      const index = (action.endsWith('row') ? src.row : src.column) + (action.startsWith('insert') ? 1 : 0);
      if (action === 'delete-row' && src.rows === 1) return '마지막 행은 지울 수 없습니다 (표를 지우려면 표 전체를 선택해 지우세요)';
      if (action === 'delete-column' && src.columns === 1) return '마지막 열은 지울 수 없습니다';
      const payload = Object.freeze({
        section: src.section, tableNode: src.tableNode, expectedRows: src.rows, expectedColumns: src.columns, action, index,
        ...(st.content?.format === 'hwp5' ? { layout: 'observed8' } : {}),
      });
      const r = await this.editor.dispatchCommand(H.EDIT_SOURCE_TABLE_GRID_COMMAND, payload).catch((e) => ({ error: e?.message }));
      if (r?.status === 'committed-with-snapshot') { try { src.recordHistory?.(r, payload); } catch { /* 실행 취소 기록 연결 실패는 편집 결과에 영향 없음 */ } }
      if (!/^committed/.test(r?.status || '')) return describe(r?.error || r?.status);
      await this.editor.refresh?.().catch(() => {}); // 표 구조가 바뀌면 엔진이 화면을 다시 확인해야 다음 표 편집을 받음
      await this.restoreCaret(prevSel); // 같은 칸에 커서를 다시 (이어서 행·열을 또 바꿀 수 있게)
      return null;
    }
    const gen = this.surface.captureGeneratedTableGridSelection?.();
    if (gen && gen.state === st && gen.current()) {
      const c = gen.createdCell, prevSel = st.selection;
      const index = (action.endsWith('row') ? c.row : c.column) + (action.startsWith('insert') ? 1 : 0);
      const why = await this.run(H.EDIT_CREATED_TABLE_GRID_COMMAND, { section: gen.section, identity: c.identity, action, index });
      if (!why) await this.restoreCaret(prevSel);
      return why;
    }
    return '표의 칸을 누르세요 (행·열을 바꾼 뒤에는 칸을 다시 눌러야 합니다)';
  }
  /** 표 바꾸기 직전의 화면 위치(마지막으로 누른 곳)를 다시 눌러 커서를 되돌림 */
  async restoreCaret(prevSel) {
    // 1) 엔진 선택 API 로 같은 칸·같은 자리 (토큰만 새 상태로)
    if (prevSel) {
      try {
        const st = this.state(), t = st.token || {};
        await this.editor.setSelection({ ...prevSel, editorId: t.editorId ?? st.editorId, documentId: t.documentId ?? st.documentId, generation: t.generation ?? st.generation, operationRevision: t.operationRevision ?? st.operationRevision, viewRevision: t.viewRevision ?? st.viewRevision });
        if (this.surface.captureSourceTableGridSelection?.() || this.surface.captureGeneratedTableGridSelection?.()) { this.focus(); return; }
      } catch { /* 2) 화면 누르기로 */ }
    }
    const p = this.lastPoint;
    if (!p) return;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const t = document.elementFromPoint(p.x, p.y);
    if (!t || !this.surface || !t.closest?.('.hwp-root') || t.classList.contains('hwp-ink')) return;
    const o = { bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, view: window };
    t.dispatchEvent(new PointerEvent('pointerdown', { ...o, buttons: 1 }));
    t.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
    t.dispatchEvent(new MouseEvent('click', { ...o, buttons: 0, detail: 1 }));
    this.focus();
  }
  /** 셀 합치기: 칸 여러 개를 블록으로 선택한 뒤 (F5 또는 끌기) */
  async _mergeCells() {
    const m = this.surface.captureSourceTableCellMerge?.();
    if (!m) return this.fileFormat === 'hwp5' ? 'HWP(.hwp) 표의 셀 합치기는 엔진이 아직 지원하지 않습니다 (.hwpx 에서는 됩니다)' : '합칠 칸을 두 개 이상 고르세요: 칸을 누른 뒤 "칸→"·"칸↓" (키보드: F5 두 번 → 방향키)';
    return this.run(H.MERGE_SOURCE_TABLE_CELLS_COMMAND, m.target);
  }
  /** 셀 나누기: 지금 칸을 rows×cols 로 */
  async _splitCell(rows, cols) {
    const sp = this.surface.captureSourceTableCellSplit?.();
    if (!sp) return '나눌 칸을 누르세요';
    return this.run(H.SPLIT_SOURCE_TABLE_CELLS_COMMAND, { target: sp.target, rows, columns: cols, mode: 'each', equalizeRows: true });
  }
  /** 칸 블록 시작(F5) */
  cellBlock(extend = false) { return this.surface.requestCellBlock?.(extend) || false; }
  /**
   * 칸 블록을 한 칸 넓히기 (키보드 없는 태블릿용): 한글처럼 F5 두 번(블록 넓히기 상태) 뒤 방향키.
   * dir: 'ArrowRight'|'ArrowDown'|'ArrowLeft'|'ArrowUp'. 블록이 생기면 true
   */
  async extendCellBlock(dir) {
    if (!this.surface.hasCellBlock?.() || !this._blockExtending) {
      if (!this.surface.requestCellBlock?.(false)) return false;
      this.surface.requestCellBlock?.(false);
      this._blockExtending = true;
    }
    const ta = [...this.surface && document.querySelectorAll('.hwp-root textarea')][0];
    const ev = { key: dir, code: dir, bubbles: true, cancelable: true, composed: true };
    (ta || document.activeElement).dispatchEvent(new KeyboardEvent('keydown', ev));
    (ta || document.activeElement).dispatchEvent(new KeyboardEvent('keyup', ev));
    await new Promise((r) => setTimeout(r, 120));
    return !!this.surface.hasCellBlock?.();
  }

  // ── 각주·미주 ──
  /** 커서 자리에 각주('foot')·미주('end'), 본문 글 body */
  async insertNote(kind, body) {
    if (this.fileFormat === 'hwp5') return 'HWP(.hwp) 문서의 각주·미주 넣기는 엔진이 아직 지원하지 않습니다 (.hwpx 문서에서는 됩니다)';
    return this.fresh(() => this._insertNote(kind, body));
  }
  async _insertNote(kind, body) {
    await this.settle();
    const st = this.state();
    const caret = this.surface.captureInlineObjectInsertCaret?.();
    if (!caret || caret.state !== st) return '주석을 넣을 자리에 커서를 놓으세요 (글자를 선택하지 말고)';
    let target;
    try { target = await this.editor.getInlineObjectInsertTarget(caret.selector, caret.unit, { affinity: caret.affinity ?? 'forward' }); }
    catch (e) { return describe(e?.message || e); }
    const c = this.state().content || {};
    const res = c.tableCreationResources || {}, pol = c.noteShapes || { sections: 1, notes: [] };
    const resources = { paragraph: res.paragraph?.[0], character: res.character?.[0], style: res.style?.[0] };
    if (!Object.values(resources).every((id) => Number.isInteger(id) && id >= 0)) return '이 문서에는 주석에 쓸 기본 서식이 없어 넣을 수 없습니다';
    const format = { number_type: 'DIGIT', user_char: '', prefix_char: '', suffix_char: ')', superscript: false };
    const initial_policies = [];
    for (let section = 0; section < pol.sections; section++) {
      if (!pol.notes.some((p) => p.section_ordinal === section && p.kind === kind)) initial_policies.push({ section, shape: {
        format, line_length: kind === 'foot' ? -1 : -4, line_type: 'SOLID', line_width: '0.12 mm', line_color: '#000000',
        between_notes: kind === 'foot' ? 283 : 0, below_line: 567, above_line: 850, start: 1,
        place: kind === 'foot' ? 'EACH_COLUMN' : 'END_OF_DOCUMENT', beneath_text: false } });
    }
    return this.insertWithCaret(kind === 'foot' ? H.INSERT_FOOTNOTE_COMMAND : H.INSERT_ENDNOTE_COMMAND,
      { target, selectionVersion: this.state().stateVersion, options: { body, format, resources, initial_policies } });
  }

  // ── 수식 ──
  /** 커서 자리에 수식. script 는 한글 수식 문법(예: {a} over {b}, sqrt {x}); LaTeX(\frac 등)도 기본 기호는 바꿔 줌 */
  async insertEquation(script) {
    return this.fresh(() => this._insertEquation2(script));
  }
  async _insertEquation2(script) {
    await this.settle();
    script = latexToHwpEq(String(script || '').trim());
    if (!script) return '수식을 입력하세요';
    const st = this.state();
    let target = st.selection;
    const av = H.getInlineObjectInsertAvailability?.(st, 'equation');
    if (!av?.enabled || st.content?.format === 'hwpx') { // HWPX·표 칸 등: 위치 조회로 (HWPX 는 소유 위치를 함께 보내야 받음)
      const caret = this.surface.captureInlineObjectInsertCaret?.();
      if (!caret || caret.state !== st) return '수식을 넣을 자리에 커서를 놓으세요 (글자를 선택하지 말고)';
      try { target = await this.editor.getInlineObjectInsertTarget(caret.selector, caret.unit, { affinity: caret.affinity ?? 'forward' }); }
      catch (e) { return describe(e?.message || e); }
      const av2 = H.getInlineObjectInsertAvailability?.(this.state(), 'equation', undefined, target);
      if (!av2?.enabled) return describe(av2?.reason || av?.reason || 'InlineObjectInsertionUnavailable');
    }
    // 크기(HWPUNIT, 1pt=100): 엔진이 글로 크기를 재지 않으므로 대략 — 분수·위아래 첨자가 있으면 높게
    const tall = /\bover\b|\batop\b|\bsum\b|\bint\b|\blim\b|\bmatrix\b|\bcases\b|\^|_/.test(script);
    const plain = script.replace(/\b(over|sqrt|times|left|right|alpha|beta|gamma|theta|pi|sum|int|lim|rm|it)\b|[{}\s]/g, '');
    const width = Math.max(1200, Math.round((plain.length + 1) * 550)), height = tall ? 3000 : 1600;
    return this.insertWithCaret(H.INSERT_EQUATION_COMMAND, { target, selectionVersion: this.state().stateVersion,
      options: { script, width, height, baseLine: tall ? 70 : 85, baseUnit: 1000, version: 'Equation Version 60', font: 'HYhwpEQ', ...(this.state().content?.format === 'hwp5' ? { colorRgb: 0, lineMode: false } : {}) } }); // 색·줄 모드는 HWP5 만
  }
  /** HWP5 문서의 기존 수식 목록 [{index, script?}] */
  equations() {
    try { return H.hwp5EquationScriptSources(this.state()).map((r, i) => ({ i, row: r })); } catch { return []; }
  }
  /** 기존 수식(HWP5) 고치기: row = equations()[k].row */
  async readEquation(row) {
    const sel = await this.editor.setSelection(H.createParagraphSelection(this.state(), { section: row.section, paragraph: row.paragraph, startUnit: row.unit, endUnit: row.unit + 1 }));
    const cap = await this.editor.getHwp5EquationScript({ section: row.section, equationNode: row.equationNode, layout: 'version-only' }, { token: sel.token });
    if (cap.state !== 'available') throw new Error(describe(cap.reason));
    return cap;
  }
  async editEquation(cap, script) {
    script = latexToHwpEq(String(script || '').trim());
    if (!script) return '수식을 입력하세요';
    return this.run(H.EDIT_HWP5_EQUATION_SCRIPT_COMMAND, { target: cap.target, script });
  }
  releaseEquation(cap) { if (cap) this.editor.releaseHwp5EquationScript(cap.target).catch(() => {}); }

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
    return this.insertWithCaret(H.INSERT_IMAGE_COMMAND, { target, selectionVersion: st.stateVersion, options: { imageBytes: bytes, width: w, height: h } });
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
  /**
   * 쪽 설정 바꾸기 (mm). scope 'section'|'document'.
   * 이번에 새로 넣은 표·그림이 있으면 엔진이 거절(PendingObjects) → 저장해 다시 연 뒤 적용 (실행 취소 기록은 비워짐)
   */
  async setPageSettings(read, v, scope = 'document', { confirmReload } = {}) {
    const u = (mm) => Math.round(mm * 7200 / 25.4);
    const values = { orientation: v.orientation, width: u(v.width), height: u(v.height), gutter_type: v.gutter_type, margin: Object.fromEntries(Object.entries(v.margin).map(([k, x]) => [k, u(x || 0)])) };
    const apply = async (target) => {
      try { return await this.editor.dispatchCommand(H.EDIT_PAGE_SETTINGS_COMMAND, { target, scope, values }); } catch (e) { return { error: e?.message || String(e) }; }
    };
    let r = await apply(read.target);
    if (/PendingObjects/.test(r?.error || '')) {
      if (confirmReload && !(await confirmReload())) return '취소했습니다';
      await this.reload();
      const again = await this.editor.getPageSettings();
      if (again.state !== 'available') return describe(again.reason);
      r = await apply(again.target);
      if (/^committed/.test(r?.status || '')) this.reloaded = true;
    }
    if (/^committed/.test(r?.status || '') || r?.status === 'known-no-op') return null;
    return describe(r?.error || r?.status);
  }
  /**
   * 인쇄용 쪽 그림. 이번에 새로 만든 표 등은 엔진이 바로 인쇄 그림으로 못 그리는 경우가 있어(PrintTablePaintIncomplete)
   * 그때는 지금 내용을 저장해 보이지 않는 두 번째 엔진에서 열어 그린다 (편집 중인 문서·실행 취소 기록은 그대로)
   */
  async printPages(scale = 2) {
    await this.settle();
    try { return await this.surface.capturePrintPages({ scale }); }
    catch (e) { if (!/Incomplete|Stale|Pending/i.test(e?.message || '')) throw e; }
    const { bytes } = await this.save();
    return screenPages(bytes, scale);
  }
  /** 지금 내용을 저장해 같은 편집기로 다시 열기 (엔진이 새 개체를 정리한 상태로). 본문 커서 자리는 유지 */
  async reload() {
    const sel = this.state().selection;
    const { bytes } = await this.save();
    await this.editor.load(bytes, { format: this.fileFormat, editable: true });
    if (sel && sel.owner === `section:${sel.section}:body`) {
      try { await this.editor.setSelection(H.createParagraphSelection(this.state(), { section: sel.section, paragraph: sel.paragraph, startUnit: sel.startUnit, endUnit: sel.startUnit })); this.focus(); } catch { /* 커서는 다시 눌러야 함 */ }
    }
  }

  // ── 클립보드 ──
  async copy(cut = false) {
    if (!this.surface.canTransferSelection?.(cut, navigator.clipboard)) return '복사할 글을 선택하세요';
    const ok = await this.surface.transferSelection({ cut, clipboard: navigator.clipboard }).catch(() => false);
    return ok ? null : (cut ? '잘라내지 못했습니다' : '복사하지 못했습니다');
  }

  /**
   * 입력 직후에는 엔진이 '그사이 바뀜·조합 중'으로 거절할 수 있음 → 위치를 새로 읽어 몇 번 다시 (사용자가 다시 누를 필요 없게)
   */
  async fresh(fn) {
    let why;
    for (let i = 0; i < 4; i++) {
      why = await fn();
      if (!why || !/Stale|Mismatch|CompositionBlocked|그사이 바뀌었/.test(why)) return why;
      await new Promise((r) => setTimeout(r, 200 + i * 150));
    }
    return why;
  }
  insertTable(...a) { return this.fresh(() => this._insertTable(...a)); }
  tableGrid(...a) { return this.fresh(() => this._tableGrid(...a)); }
  mergeCells(...a) { return this.fresh(() => this._mergeCells(...a)); }
  splitCell(...a) { return this.fresh(() => this._splitCell(...a)); }
  align(...a) { return this.fresh(() => this._align(...a)); }
  insertImageFresh(...a) { return this.fresh(() => this.insertImage(...a)); }

  /** 개체(수식·주석·그림·표)를 넣은 뒤 커서가 사라지면, 넣은 자리 바로 뒤에 커서를 다시 놓음 */
  async caretAfter(before) {
    if (!before || this.state().selection) return;
    for (const d of [8, 1, 0]) { // 한글 문서의 개체 자리 = 보통 8 글자 단위
      try {
        await this.editor.setSelection(H.createParagraphSelection(this.state(), { section: before.section, paragraph: before.paragraph, startUnit: before.startUnit + d, endUnit: before.startUnit + d }));
        if (this.state().selection) { this.focus(); return; }
      } catch { /* 다음 후보 */ }
    }
  }
  async insertWithCaret(cmd, payload) {
    const before = this.state().selection;
    const why = await this.run(cmd, payload);
    if (!why && before && before.owner === `section:${before.section}:body`) await this.caretAfter(before);
    return why;
  }

  async run(cmd, payload, tries = 0) {
    try {
      const r = await this.editor.dispatchCommand(cmd, payload);
      if (tries < 6 && /CompositionBlocked/.test(r?.error || '')) { await new Promise((ok) => setTimeout(ok, 150)); await this.settle(); return this.run(cmd, payload, tries + 1); } // 입력 처리 중·한글 조합 중 → 잠깐 뒤 다시
      if (/^committed/.test(r?.status || '') || r?.status === 'known-no-op') return null;
      return describe(r?.error || r?.reason || r?.status);
    } catch (e) {
      if (tries < 6 && /CompositionBlocked/.test(e?.message || '')) { await new Promise((ok) => setTimeout(ok, 150)); await this.settle(); return this.run(cmd, payload, tries + 1); }
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
  if (/Stale|Mismatch/i.test(r)) return `문서가 그사이 바뀌었습니다. 다시 눌러 주세요 (${r})`;
  if (/Unavailable|Unsupported/i.test(r)) return `엔진이 이 위치·문서에서는 아직 지원하지 않습니다 (${r})`;
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
      if (!target || !root.contains(target) || target.classList.contains('hwp-ink')) return; // 필기 모드: 탭은 아무것도 안 함
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
  root.addEventListener('pointerdown', (e) => { if (e.isTrusted && !e.target.classList?.contains('hwp-ink')) { session.lastPoint = { x: e.clientX, y: e.clientY }; session._blockExtending = false; } }, true);
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

/**
 * 인쇄 검사기가 거절한 문서용 대안: 보이지 않는 엔진 화면에 쪽을 하나씩 띄워 그려진 그림을 복사한다.
 * (편집용 점선·문단 부호는 끔. 화면과 같은 그림이므로 내용은 같고, 해상도는 scale 배)
 */
async function screenPages(bytes, scale = 2) {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:0;top:0;width:1000px;height:1300px;pointer-events:none;opacity:0;z-index:-1'; // 화면 밖이면 엔진이 그리지 않음 → 투명하게 뒤에
  document.body.appendChild(box);
  let s;
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try {
    s = await HwpSession.open(box, bytes);
    try { s.surface.setDisplayOptions({ paragraphMarks: false, formattingMarks: false, showTableGrid: false, showTransparentTableLines: false }); } catch { /* */ }
    await new Promise((r) => setTimeout(r, 400));
    const sc = [...box.querySelectorAll('div')].find((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY));
    const g0 = s.surface.getPageGeometry();
    if (!sc || !g0) throw new Error('쪽 그림을 만들 수 없습니다');
    const W = g0.paper.width, Hh = g0.paper.height;
    const n = s.surface.getPageStatus()?.total || 1;
    const gap = n > 1 ? Math.max(0, (sc.scrollHeight - 20 - n * Hh) / (n - 1)) : 20;
    const pages = [];
    for (let k = 0; k < n; k++) {
      sc.scrollTop = 20 + k * (Hh + gap) - 10;
      await frame(); await new Promise((r) => setTimeout(r, 150)); await frame();
      const cv = [...box.querySelectorAll('canvas')].find((c) => c.width > 100);
      const g = s.surface.getPageGeometry();
      const pr = cv.getBoundingClientRect(), r = sc.getBoundingClientRect();
      const px = cv.width / pr.width;
      const top = 20 + k * (Hh + gap) - sc.scrollTop; // 쪽 위 (스크롤 칸 기준 CSS px)
      const left = (g?.paperLeft ?? g0.paperLeft) - sc.scrollLeft;
      const out = document.createElement('canvas');
      out.width = Math.round(W * scale); out.height = Math.round(Hh * scale);
      const ctx = out.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(cv, (r.left - pr.left + left) * px, (r.top - pr.top + top) * px, W * px, Hh * px, 0, 0, out.width, out.height);
      const png = await new Promise((res) => out.toBlob(res, 'image/png'));
      pages.push({ ordinal: k, section: 0, widthCssPx: W, heightCssPx: Hh, pixelWidth: out.width, pixelHeight: out.height, png });
    }
    return { kind: 'screen-pages', pages };
  } finally {
    await s?.dispose();
    box.remove();
  }
}

/** LaTeX 기본 기호 → 한글 수식 문법 (이미 한글 문법이면 그대로) */
export function latexToHwpEq(t) {
  if (!/\\/.test(t)) return t;
  let s = t;
  for (let k = 0; k < 6; k++) s = s.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '{$1} over {$2}');
  s = s.replace(/\\sqrt\s*\[([^\]]*)\]\s*\{([^{}]*)\}/g, 'root {$1} of {$2}').replace(/\\sqrt\s*\{([^{}]*)\}/g, 'sqrt {$1}');
  const map = { cdot: 'cdot', times: 'times', div: 'div', pm: '+-', mp: '-+', le: '<=', leq: '<=', ge: '>=', geq: '>=', ne: '!=', neq: '!=', approx: 'approx', infty: 'inf',
    sum: 'sum', int: 'int', lim: 'lim', to: '->', rightarrow: '->', leftarrow: '<-', cdots: 'cdots', ldots: 'ldots', in: 'in', subset: 'subset', cup: 'cup', cap: 'cap',
    sin: 'sin', cos: 'cos', tan: 'tan', log: 'log', ln: 'ln', left: 'left', right: 'right', quad: '~', qquad: '~~' };
  s = s.replace(/\\([a-zA-Z]+)/g, (m, w) => (map[w] ?? (/^(alpha|beta|gamma|delta|epsilon|theta|lambda|mu|pi|sigma|phi|omega|Alpha|Beta|Gamma|Delta|Theta|Lambda|Pi|Sigma|Phi|Omega)$/.test(w) ? w : w)) + ' ');
  return s.replace(/\s+/g, ' ').trim();
}
