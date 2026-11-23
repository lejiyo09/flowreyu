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
  static async open(root, bytes, { onChange, onError } = {}) {
    const E = await loadEngine();
    const editor = E.createEditor({
      runtimeFactory: E.createWorkerRuntimeFactory({ workerURL: new URL('worker.js', BASE), wasmURL: new URL('hwpjs.wasm', BASE) }),
      onError: (ev) => onError?.(ev.error),
    });
    let surface = null;
    try {
      surface = E.createCanvasSurface({ root, editor });
      const format = E.detectDocumentFormat(bytes);
      const st = await editor.load(bytes, { format, editable: true });
      const s = new HwpSession(editor, surface, format, st.operationRevision);
      s.detachTouch = touchNavigation(root, s);
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

  selection() { return this.surface.getSelection?.() || null; }

  /** 선택한 글자에 서식. 선택이 없거나 엔진이 지원하지 않으면 이유 문자열 */
  async setFormat(kind, value) {
    const target = this.selection();
    if (!target || target.startUnit === target.endUnit) return '먼저 글자를 선택하세요';
    const C = H;
    let cmd, payload;
    if (kind === 'bold' || kind === 'italic') { cmd = C.SET_CHARACTER_PROPERTIES_COMMAND; payload = { target, properties: { [kind]: value } }; }
    else if (kind === 'size') { cmd = C.SET_CHARACTER_PROPERTIES_COMMAND; payload = { target, properties: { size: value } }; }
    else if (kind === 'underline') { cmd = C.SET_CHARACTER_UNDERLINE_COMMAND; payload = { target, kind: value ? 'bottom' : 'none' }; }
    else if (kind === 'strike') { cmd = C.SET_CHARACTER_STRIKE_COMMAND; payload = { target, enabled: value }; }
    else if (kind === 'color') { cmd = C.SET_CHARACTER_TEXT_COLOR_COMMAND; payload = { target, color: value }; }
    else return '지원하지 않는 서식';
    return this.run(cmd, payload);
  }

  /** 문단 정렬 (커서만 있어도 됨) */
  async align(alignment) {
    const target = this.selection();
    if (!target) return '먼저 문단을 누르세요';
    return this.run(H.SET_PARAGRAPH_ALIGNMENT_COMMAND, { target, alignment });
  }

  async run(cmd, payload) {
    try {
      const r = await this.editor.dispatchCommand(cmd, payload);
      if (/^committed/.test(r?.status || '')) return null;
      return describe(r?.reason || r?.status);
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
    try { await this.surface.dispose(); } catch { /* */ }
    try { await this.editor.dispose(); } catch { /* */ }
  }
}

/** 엔진의 거절 이유를 사람 말로 */
function describe(reason) {
  const r = String(reason || '');
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
