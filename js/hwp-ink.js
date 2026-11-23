// 한글 문서 위 펜 필기: 엔진 화면(캔버스) 위에 투명한 필기 층을 겹친다.
// 필기는 문서 좌표(엔진의 '무대' 기준, 배율 1의 CSS px)로 노트의 0쪽에 저장 → 확대·스크롤해도 같은 자리.
// 한글 파일 자체는 바꾸지 않음 (주석은 FlexNote 노트에 보관, PDF 내보내기에 함께 나옴).
// 입력: 펜·마우스 = 쓰기/지우기, 손가락 = 문서 넘기기(엔진 스크롤로 전달), 두 손가락 = 확대(세션 배율).
import { drawItem, roundPts, simplifyPts, hitTestSweep } from './ink.js';
import { uid } from './util.js';

export const INK_PAGE = 0;

export class HwpInk {
  /**
   * host: .hwp-root (엔진이 그리는 곳), session: HwpSession, doc: NoteDocument
   * getPen(): {color, width} — 지금 펜 설정
   */
  constructor(host, session, doc, { getPen }) {
    this.host = host; this.session = session; this.doc = doc; this.getPen = getPen;
    this.mode = null; // null(편집) | 'pen' | 'hl' | 'eraser'
    const cv = this.canvas = document.createElement('canvas');
    cv.className = 'hwp-ink';
    host.appendChild(cv);
    this.ctx = cv.getContext('2d');
    this.live = null;
    this.raf = 0;
    this.offDoc = doc.on?.('change', () => this.redraw());
    this.onScroll = () => this.redraw();
    this.ro = new ResizeObserver(() => this.redraw());
    this.ro.observe(host);
    this.bindInput();
    this.redraw();
  }

  /** 엔진의 스크롤 칸과 무대(문서 전체 크기 요소) */
  scroller() {
    if (this._sc?.isConnected) return this._sc;
    for (const el of this.host.querySelectorAll('div')) {
      const o = getComputedStyle(el).overflowY;
      if (o === 'auto' || o === 'scroll') { this._sc = el; el.addEventListener('scroll', this.onScroll, { passive: true }); return el; }
    }
    return null;
  }
  /**
   * 문서 좌표계: y = 스크롤 내용 맨 위부터(배율 1), x = 용지 왼쪽 끝부터(배율 1).
   * 화면이 넓으면 엔진이 용지를 가운데 두므로 x 기준은 엔진이 알려 주는 용지 왼쪽(paperLeft).
   * origin(): 문서 (0,0) 이 놓인 화면(client) 위치
   */
  origin() {
    const sc = this.scroller();
    if (!sc) return null;
    const g = this.session.surface.getPageGeometry?.();
    if (g && Number.isFinite(g.paperLeft)) this.paperLeft = g.paperLeft / (g.scale || this.session.scale); // 배율 1 기준으로 보관
    const r = sc.getBoundingClientRect(), z = this.session.scale;
    return { x: r.left - sc.scrollLeft + (this.paperLeft ?? 20) * z, y: r.top - sc.scrollTop, z };
  }
  toDoc(cx, cy) {
    const o = this.origin();
    return { x: (cx - o.x) / o.z, y: (cy - o.y) / o.z };
  }
  /** 쪽 상자들 (문서 좌표): 첫 쪽 위 20, 쪽 사이 간격은 전체 높이로 계산 */
  pageBoxes(n, paperW, paperH) {
    const sc = this.scroller(), z = this.session.scale;
    const total = sc ? sc.scrollHeight / z : 20 + n * (paperH + 20);
    const gap = n > 1 ? Math.max(0, (total - 20 - n * paperH) / (n - 1)) : 20;
    return Array.from({ length: n }, (_, k) => ({ x: 0, y: 20 + k * (paperH + gap), w: paperW, h: paperH }));
  }

  setMode(mode) {
    this.mode = mode;
    this.canvas.classList.toggle('active', !!mode);
    this.canvas.style.cursor = mode === 'eraser' ? 'cell' : mode ? 'crosshair' : '';
  }

  redraw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.paint(); });
  }

  paint() {
    const cv = this.canvas, host = this.host;
    const dpr = window.devicePixelRatio || 1, w = host.clientWidth, h = host.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      cv.style.width = w + 'px'; cv.style.height = h + 'px';
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    const o = this.origin();
    if (!o) return;
    const hr = host.getBoundingClientRect();
    ctx.setTransform(dpr * o.z, 0, 0, dpr * o.z, dpr * (o.x - hr.left), dpr * (o.y - hr.top));
    for (const it of this.erasing ? this.doc.items(INK_PAGE).filter((x) => !this.erasing.removed.has(x.id)) : this.doc.items(INK_PAGE)) drawItem(ctx, it, {});
    if (this.live) drawItem(ctx, this.live, {});
  }

  bindInput() {
    const cv = this.canvas;
    let pan = null; const touches = new Map(); let pinch = null;
    const down = (e) => {
      if (!this.mode) return;
      e.preventDefault(); e.stopPropagation();
      try { cv.setPointerCapture(e.pointerId); } catch { /* */ }
      if (e.pointerType === 'touch') { // 손가락: 넘기기 / 두 손가락 확대
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const sc = this.scroller();
        if (touches.size === 1 && sc) pan = { x: e.clientX, y: e.clientY, sl: sc.scrollLeft, st: sc.scrollTop, sc };
        if (touches.size === 2) { const [a, b] = [...touches.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: this.session.scale }; pan = null; }
        return;
      }
      const p = this.toDoc(e.clientX, e.clientY);
      if (this.mode === 'eraser') { this.erasing = { x: p.x, y: p.y, removed: new Set() }; this.eraseAt(p.x, p.y, p.x, p.y); return; }
      const pen = this.getPen(this.mode);
      this.live = { id: uid('s'), t: 's', tool: this.mode === 'hl' ? 'hl' : 'pen', c: pen.color, w: pen.width, pr: e.pointerType === 'pen', pts: [p.x, p.y, e.pressure || 0.5] };
      this.redraw();
    };
    const move = (e) => {
      if (!this.mode) return;
      if (e.pointerType === 'touch') {
        if (!touches.has(e.pointerId)) return;
        e.preventDefault();
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinch && touches.size >= 2) { const [a, b] = [...touches.values()]; this.session.setScale(pinch.z * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d); this.session.onScale?.(); this.redraw(); return; }
        if (pan) { pan.sc.scrollLeft = pan.sl - (e.clientX - pan.x); pan.sc.scrollTop = pan.st - (e.clientY - pan.y); }
        return;
      }
      const evs = e.getCoalescedEvents?.() || [e];
      if (this.erasing) { for (const ev of evs) { const p = this.toDoc(ev.clientX, ev.clientY); this.eraseAt(this.erasing.x, this.erasing.y, p.x, p.y); this.erasing.x = p.x; this.erasing.y = p.y; } return; }
      if (!this.live) return;
      for (const ev of evs) { const p = this.toDoc(ev.clientX, ev.clientY); this.live.pts.push(p.x, p.y, ev.pressure || 0.5); }
      this.redraw();
    };
    const up = (e) => {
      if (e.pointerType === 'touch') { touches.delete(e.pointerId); if (touches.size < 2) pinch = null; if (!touches.size) pan = null; return; }
      if (this.erasing) {
        const gone = this.erasing.removed; this.erasing = null;
        if (gone.size) this.doc.setItems(INK_PAGE, this.doc.items(INK_PAGE).filter((it) => !gone.has(it.id)));
        this.redraw();
        return;
      }
      const it = this.live; this.live = null;
      if (it && e.type === 'pointerup') {
        const pts = roundPts(it.pts.length > 9 ? simplifyPts(it.pts, 0.04) : it.pts);
        this.doc.add(INK_PAGE, { ...it, pts });
      }
      this.redraw();
    };
    cv.addEventListener('pointerdown', down);
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', (e) => { const sc = this.scroller(); if (this.mode && sc) { sc.scrollTop += e.deltaY; sc.scrollLeft += e.deltaX; e.preventDefault(); } }, { passive: false });
  }

  /** 지우개: 지나간 선분에 닿은 획을 (손을 뗄 때 한 번에) 지움 — 지우는 동안은 흐리게 */
  eraseAt(ax, ay, bx, by) {
    const r = 8 / this.session.scale;
    for (const it of this.doc.items(INK_PAGE)) {
      if (this.erasing.removed.has(it.id)) continue;
      if (hitTestSweep(it, ax, ay, bx, by, r)) this.erasing.removed.add(it.id);
    }
    if (this.erasing.removed.size) this.redraw(); // 지울 획을 빼고 미리 보여 줌
  }

  /** PDF 내보내기용: 쪽 상자(문서 좌표)에 걸친 획 */
  itemsOnPage(box) {
    return this.doc.items(INK_PAGE).filter((it) => {
      const xs = it.pts.filter((_, i) => i % 3 === 0), ys = it.pts.filter((_, i) => i % 3 === 1);
      return Math.max(...xs) >= box.x && Math.min(...xs) <= box.x + box.w && Math.max(...ys) >= box.y && Math.min(...ys) <= box.y + box.h;
    });
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.offDoc?.();
    this.ro.disconnect();
    this._sc?.removeEventListener('scroll', this.onScroll);
    this.canvas.remove();
  }
}
