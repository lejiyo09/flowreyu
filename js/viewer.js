// PDF 뷰어: 카메라(확대/이동), 페이지 배치, PDF 렌더링, 필기 레이어 그리기
//
// 좌표계
//  - 월드 좌표: 페이지를 세로로 이어 붙인 공간. 단위 = PDF 포인트(1배율)
//  - 화면 좌표: 뷰포트 엘리먼트 기준 CSS px.  screen = world * z + (tx, ty)
//  - 페이지 좌표: 각 페이지 좌상단 기준 월드 좌표. 필기는 이 좌표로 저장된다.
//
// 렌더링 구조
//  - #world (CSS transform) 안의 페이지마다: base 캔버스(페이지 전체, 해상도 상한) + detail 캔버스(보이는 영역만 고해상도)
//    → 이동/확대 중에는 GPU 변환만 일어나므로 끊김이 적고, 멈추면 선명하게 다시 그린다.
//  - 필기는 화면 크기의 캔버스(형광펜 레이어 / 펜 레이어)에 벡터로 매 프레임 다시 그린다 → 어떤 배율에서도 선명.
import { Emitter, clamp, rectsIntersect } from './util.js';
import { drawItem, isHighlighter, bbox } from './ink.js';
import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
export { pdfjsLib };

const PAGE_GAP = 14; // 월드 단위
const MARGIN = 16; // 화면 px
const MAX_BASE_PIXELS = 4.5e6; // base 캔버스 최대 픽셀 수 (메모리 보호)
const KEEP_RANGE = 3; // 보이는 페이지 ± n 장의 base 렌더 유지

export class Viewer extends Emitter {
  constructor(viewportEl, worldEl, canvases) {
    super();
    this.el = viewportEl;
    this.world = worldEl;
    this.hlCanvas = canvases.hl;
    this.inkCanvas = canvases.ink;
    this.liveCanvas = canvases.live;
    this.hlCtx = this.hlCanvas.getContext('2d');
    this.inkCtx = this.inkCanvas.getContext('2d');
    // desynchronized: 지원 기기(안드로이드/크롬OS)에서 펜 지연 감소
    this.liveCtx = this.liveCanvas.getContext('2d', { desynchronized: true }) || this.liveCanvas.getContext('2d');
    this.pdf = null;
    this.doc = null;
    this.pages = []; // {index, w, h, x, y, el, base, baseScale, detail, detailKey, vt}
    this.contentW = 0;
    this.contentH = 0;
    this.cam = { tx: 0, ty: 0, z: 1 };
    this.vw = 1; this.vh = 1; this.dpr = 1;
    this.rect = { left: 0, top: 0 };
    this.fitZ = 1;
    this.renderBusy = false;
    this.renderPaused = false;
    this._resumeWaiters = [];
    this._inkFrame = 0;
    this.inkCost = 0; this.drawnCam = null; this.inkOffset = false; this._lastFullInk = 0;
    this._settleTimer = 0;
    this._renderGen = 0;
    this.selection = null; // {page, ids:Set, m:{s,ox,oy,dx,dy}} 이동 중 미리보기
    this.hidden = null; // 편집 중 숨길 객체 id (텍스트 편집)
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(this.el);
    this.resize(true);
  }

  // ───────────────────────── 문서 로드 / 배치 ─────────────────────────

  async open(pdf, doc, view) {
    this.close();
    this.pdf = pdf;
    this.doc = doc;
    const n = pdf.numPages;
    const first = await pdf.getPage(1);
    const vp1 = first.getViewport({ scale: 1 });
    this.pages = [];
    for (let i = 0; i < n; i++) {
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.page = i;
      this.world.appendChild(el);
      this.pages.push({ index: i, w: vp1.width, h: vp1.height, x: 0, y: 0, el, base: null, baseScale: 0, detail: null, detailKey: '', vt: null, sized: false, proxy: null });
    }
    this.pages[0].vt = vp1.transform; this.pages[0].proxy = first; this.pages[0].sized = true;
    this.layout();
    this.resize(true);
    this.restoreView(view);
    this.requestInk();
    this.scheduleRender(0);
    // 나머지 페이지 크기를 백그라운드로 읽어 배치 갱신 (대용량 PDF에서 UI가 멈추지 않도록 나눠서)
    this._sizeAll(pdf).catch((e) => console.warn('page size scan', e));
  }

  async _sizeAll(pdf) {
    let changed = false;
    for (let i = 1; i < this.pages.length; i++) {
      if (this.pdf !== pdf) return;
      const p = this.pages[i];
      const page = await pdf.getPage(i + 1);
      const vp = page.getViewport({ scale: 1 });
      p.vt = vp.transform;
      p.sized = true;
      if (Math.abs(vp.width - p.w) > 0.5 || Math.abs(vp.height - p.h) > 0.5) { p.w = vp.width; p.h = vp.height; changed = true; }
      if (changed && (i % 40 === 0 || i === this.pages.length - 1)) {
        const anchor = this.anchor();
        this.layout();
        this.restoreAnchor(anchor);
        changed = false;
      }
      if (i % 20 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    this.emit('sized');
  }

  close() {
    this._renderGen++;
    for (const p of this.pages) { this._freeBase(p); this._freeDetail(p); p.el.remove(); p.proxy?.cleanup?.(); }
    this.pages = [];
    this.pdf = null;
    this.doc = null;
    this.selection = null;
    this.clearLive();
    this.requestInk();
  }

  layout() {
    let maxW = 0;
    for (const p of this.pages) maxW = Math.max(maxW, p.w);
    let y = 0;
    for (const p of this.pages) {
      p.x = (maxW - p.w) / 2;
      p.y = y;
      y += p.h + PAGE_GAP;
      const s = p.el.style;
      s.left = p.x + 'px'; s.top = p.y + 'px'; s.width = p.w + 'px'; s.height = p.h + 'px';
    }
    this.contentW = maxW;
    this.contentH = Math.max(0, y - PAGE_GAP);
    this.fitZ = this.pages.length ? (this.vw - MARGIN * 2) / maxW : 1;
  }

  resize(force) {
    const r = this.el.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.max(1, r.width), h = Math.max(1, r.height);
    this.rect = { left: r.left, top: r.top };
    if (!force && w === this.vw && h === this.vh && dpr === this.dpr) return;
    const anchor = this.pages.length ? this.anchor() : null;
    this.vw = w; this.vh = h; this.dpr = dpr;
    for (const c of [this.hlCanvas, this.inkCanvas, this.liveCanvas]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = w + 'px';
      c.style.height = h + 'px';
    }
    if (this.pages.length) {
      this.fitZ = (this.vw - MARGIN * 2) / this.contentW;
      if (anchor && !force) {
        this.cam.z = clamp(anchor.zr * this.pageFitZ(anchor.page), this.minZ(), this.maxZ());
        this.restoreAnchor(anchor);
      }
    }
    this.applyCamera();
    this.emit('resize');
  }

  updateRect() {
    const r = this.el.getBoundingClientRect();
    this.rect = { left: r.left, top: r.top };
  }

  // ───────────────────────── 카메라 ─────────────────────────

  minZ() { return Math.min(this.fitZ * 0.25, (this.vh - MARGIN * 2) / (this.pages[0]?.h || 800) * 0.5); }
  maxZ() { return Math.max(this.fitZ * 10, 8); }

  clampCamera(c = this.cam) {
    c.z = clamp(c.z, this.minZ(), this.maxZ());
    const cw = this.contentW * c.z, ch = this.contentH * c.z;
    if (cw + MARGIN * 2 <= this.vw) c.tx = (this.vw - cw) / 2;
    else c.tx = clamp(c.tx, this.vw - cw - MARGIN, MARGIN);
    const top = MARGIN, bottom = this.vh - ch - MARGIN * 6; // 마지막 페이지 아래 여유
    if (ch + MARGIN * 2 <= this.vh) c.ty = clamp(c.ty, Math.min(top, bottom), Math.max(top, (this.vh - ch) / 2));
    else c.ty = clamp(c.ty, Math.min(bottom, top), top);
    return c;
  }

  setCamera(tx, ty, z, { clampIt = true } = {}) {
    this.cam.tx = tx; this.cam.ty = ty; this.cam.z = z;
    if (clampIt) this.clampCamera();
    this.applyCamera();
  }

  applyCamera() {
    const { tx, ty, z } = this.cam;
    this.world.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${z})`;
    this._inkFollowCamera();
    this.emit('camera');
    this.scheduleRender();
  }

  /** 화면 점(sx,sy)을 고정한 채 확대 */
  zoomAt(sx, sy, z) {
    z = clamp(z, this.minZ(), this.maxZ());
    const wx = (sx - this.cam.tx) / this.cam.z, wy = (sy - this.cam.ty) / this.cam.z;
    this.setCamera(sx - wx * z, sy - wy * z, z);
  }

  zoomBy(f) { this.zoomAt(this.vw / 2, this.vh / 2, this.cam.z * f); }

  /** 페이지 폭에 맞추는 배율 (페이지마다 폭이 다를 수 있음) */
  pageFitZ(i = this.currentPage()) {
    const p = this.pages[i];
    return p ? (this.vw - MARGIN * 2) / p.w : this.fitZ;
  }

  /** 현재 페이지 폭 맞춤 기준 배율 (100% = 폭 맞춤) */
  relZoom() { return this.cam.z / this.pageFitZ(); }

  fitWidth() {
    const a = this.anchor();
    this.cam.z = clamp(this.pageFitZ(a?.page), this.minZ(), this.maxZ());
    if (a) a.fx = 0.5; // 폭 맞춤은 페이지를 가로 중앙에
    this.restoreAnchor(a);
  }

  fitPage() {
    const p = this.pages[this.currentPage()];
    if (!p) return;
    const z = Math.min((this.vw - MARGIN * 2) / p.w, (this.vh - MARGIN * 2) / p.h);
    this.setCamera(this.vw / 2 - (p.x + p.w / 2) * z, this.vh / 2 - (p.y + p.h / 2) * z, z);
  }

  toWorld(sx, sy) { return { x: (sx - this.cam.tx) / this.cam.z, y: (sy - this.cam.ty) / this.cam.z }; }
  toScreen(wx, wy) { return { x: wx * this.cam.z + this.cam.tx, y: wy * this.cam.z + this.cam.ty }; }

  /** clientX/Y → 뷰포트 화면 좌표 */
  clientToScreen(cx, cy) { return { x: cx - this.rect.left, y: cy - this.rect.top }; }

  /** 화면 좌표의 페이지와 페이지 좌표. 페이지 사이 여백이면 가장 가까운 페이지 */
  pageAtScreen(sx, sy, strict = false) {
    const w = this.toWorld(sx, sy);
    let best = null, bestD = Infinity;
    for (const p of this.visiblePages(0.2)) {
      const inside = w.x >= p.x && w.x <= p.x + p.w && w.y >= p.y && w.y <= p.y + p.h;
      if (inside) return { page: p.index, x: w.x - p.x, y: w.y - p.y, inside: true };
      if (strict) continue;
      const dx = Math.max(p.x - w.x, 0, w.x - (p.x + p.w)), dy = Math.max(p.y - w.y, 0, w.y - (p.y + p.h));
      const d = Math.hypot(dx, dy);
      if (d < bestD) { bestD = d; best = { page: p.index, x: w.x - p.x, y: w.y - p.y, inside: false }; }
    }
    return best;
  }

  pageToScreen(page, x, y) {
    const p = this.pages[page];
    return this.toScreen(p.x + x, p.y + y);
  }

  visiblePages(extra = 0) {
    if (!this.pages.length) return [];
    const top = (-this.cam.ty - this.vh * extra) / this.cam.z;
    const bottom = (this.vh * (1 + extra) - this.cam.ty) / this.cam.z;
    // 이진 탐색으로 첫 페이지 찾기
    let lo = 0, hi = this.pages.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const p = this.pages[mid];
      if (p.y + p.h < top) lo = mid + 1; else hi = mid;
    }
    const out = [];
    for (let i = lo; i < this.pages.length; i++) {
      const p = this.pages[i];
      if (p.y > bottom) break;
      if (p.y + p.h >= top) out.push(p);
    }
    return out;
  }

  /** 화면 중앙에 가장 많이 걸친 페이지 */
  currentPage() {
    const vis = this.visiblePages();
    if (!vis.length) return 0;
    const cy = (this.vh / 2 - this.cam.ty) / this.cam.z;
    let best = vis[0], bestD = Infinity;
    for (const p of vis) {
      const d = cy < p.y ? p.y - cy : cy > p.y + p.h ? cy - (p.y + p.h) : 0;
      if (d < bestD) { bestD = d; best = p; }
    }
    return best.index;
  }

  goToPage(i) {
    i = clamp(i, 0, this.pages.length - 1);
    const p = this.pages[i];
    if (!p) return;
    this.setCamera(this.cam.tx, MARGIN - p.y * this.cam.z, this.cam.z);
  }

  /** 현재 보기 위치를 페이지 기준 상대 값으로 (리사이즈·복원용) */
  anchor() {
    const p = this.pages[this.currentPage()] || this.pages[0];
    if (!p) return null;
    const w = this.toWorld(this.vw / 2, 0);
    return { page: p.index, fx: (w.x - p.x) / p.w, fy: ((-this.cam.ty) / this.cam.z - p.y) / p.h, zr: this.cam.z / this.pageFitZ(p.index) };
  }

  restoreAnchor(a) {
    if (!a || !this.pages[a.page]) return;
    const p = this.pages[a.page];
    const z = this.cam.z;
    const wx = p.x + a.fx * p.w;
    const wy = p.y + a.fy * p.h;
    this.setCamera(this.vw / 2 - wx * z, -wy * z, z);
  }

  restoreView(view) {
    if (view && Number.isFinite(view.zr) && this.pages[view.page]) {
      this.cam.z = clamp(view.zr * this.pageFitZ(view.page), this.minZ(), this.maxZ());
      this.restoreAnchor(view);
    } else {
      this.cam.z = this.pageFitZ(0);
      this.setCamera((this.vw - this.contentW * this.cam.z) / 2, MARGIN, this.cam.z);
    }
  }

  // ───────────────────────── PDF 렌더링 ─────────────────────────

  /** 펜 입력 중에는 PDF 렌더링을 잠시 멈춰 필기 지연을 줄인다 */
  pauseRender(p) {
    this.renderPaused = p;
    if (!p) {
      const w = this._resumeWaiters; this._resumeWaiters = []; w.forEach((f) => f());
      // 이어서 진행만 한다. scheduleRender 를 부르면 진행 중인 고해상도 렌더가 취소되어
      // 획을 계속 쓰는 동안 페이지가 영영 선명해지지 않는다.
      if (!this.renderBusy) { clearTimeout(this._settleTimer); this._settleTimer = setTimeout(() => this._renderLoop(), 60); }
    }
  }

  scheduleRender(delay = 140) {
    clearTimeout(this._settleTimer);
    this._renderGen++;
    // 카메라가 바뀌면 진행 중인 고해상도 렌더는 쓸모가 없어지므로 취소
    if (this._detailTask) { try { this._detailTask.cancel(); } catch { /* */ } }
    this._settleTimer = setTimeout(() => this._renderLoop(), delay);
  }

  async _getProxy(p) {
    if (!p.proxy) p.proxy = await this.pdf.getPage(p.index + 1);
    return p.proxy;
  }

  async _renderLoop() {
    if (!this.pdf) return;
    if (this.renderBusy) { this._again = true; return; }
    this.renderBusy = true;
    try {
      do {
        this._again = false;
        const gen = this._renderGen;
        const jobs = this._planJobs();
        for (const job of jobs) {
          if (gen !== this._renderGen && job.kind === 'detail') break;
          if (!this.pdf) return;
          try { await job.run(); }
          catch (e) { if (e?.name !== 'RenderingCancelledException') console.warn('render', e); }
        }
        this._releaseFar();
      } while (this._again);
    } finally {
      this.renderBusy = false;
    }
  }

  _planJobs() {
    const jobs = [];
    const vis = this.visiblePages();
    const cur = this.currentPage();
    vis.sort((a, b) => Math.abs(a.index - cur) - Math.abs(b.index - cur));
    const target = this.cam.z * this.dpr;
    // 1) 보이는 페이지 base
    for (const p of vis) {
      const cap = Math.sqrt(MAX_BASE_PIXELS / (p.w * p.h));
      const want = Math.min(target, cap);
      if (!p.base || p.baseScale < want * 0.6 || p.baseScale > want * 2.2) jobs.push({ kind: 'base', run: () => this._renderBase(p, want) });
    }
    // 2) 보이는 영역 고해상도 (base가 충분히 선명하지 않을 때만)
    for (const p of vis) {
      const cap = Math.sqrt(MAX_BASE_PIXELS / (p.w * p.h));
      if (Math.min(target, cap) < target * 0.95) jobs.push({ kind: 'detail', run: () => this._renderDetail(p) });
      else this._freeDetail(p);
    }
    // 3) 앞뒤 페이지 미리 렌더
    const near = this.visiblePages(1.0).filter((p) => !vis.includes(p));
    for (const p of near) {
      const cap = Math.sqrt(MAX_BASE_PIXELS / (p.w * p.h));
      const want = Math.min(target, cap) * 0.6;
      if (!p.base) jobs.push({ kind: 'base', run: () => this._renderBase(p, want) });
    }
    return jobs;
  }

  _waitResume() {
    return new Promise((r) => (this.renderPaused ? this._resumeWaiters.push(r) : r()));
  }

  async _renderTo(canvas, p, scale, offX, offY) {
    const page = await this._getProxy(p);
    await this._waitResume();
    const viewport = page.getViewport({ scale });
    const ctx = canvas.getContext('2d', { alpha: false });
    const task = page.render({
      canvasContext: ctx,
      viewport,
      transform: offX || offY ? [1, 0, 0, 1, -offX, -offY] : undefined,
      background: '#ffffff',
    });
    // 펜 입력 중이면 렌더 조각 실행을 미뤄서 필기 이벤트가 먼저 처리되게 한다
    task.onContinue = (cont) => { if (this.renderPaused) this._resumeWaiters.push(cont); else cont(); };
    return task;
  }

  async _renderBase(p, scale) {
    const c = document.createElement('canvas');
    c.className = 'pdf-base';
    c.width = Math.max(1, Math.floor(p.w * scale));
    c.height = Math.max(1, Math.floor(p.h * scale));
    const task = await this._renderTo(c, p, scale, 0, 0);
    await task.promise;
    if (!this.pages.includes(p)) return;
    this._freeBase(p);
    p.base = c;
    p.baseScale = scale;
    p.el.prepend(c);
    p.el.classList.add('rendered');
  }

  async _renderDetail(p) {
    const z = this.cam.z, dpr = this.dpr;
    // 페이지 중 화면에 보이는 영역 (월드 좌표, 약간 여유)
    const w0 = this.toWorld(0, 0), w1 = this.toWorld(this.vw, this.vh);
    const padX = (w1.x - w0.x) * 0.1, padY = (w1.y - w0.y) * 0.1;
    const rx0 = Math.max(p.x, w0.x - padX), ry0 = Math.max(p.y, w0.y - padY);
    const rx1 = Math.min(p.x + p.w, w1.x + padX), ry1 = Math.min(p.y + p.h, w1.y + padY);
    if (rx1 <= rx0 || ry1 <= ry0) { this._freeDetail(p); return; }
    const scale = z * dpr;
    const key = [rx0, ry0, rx1, ry1, scale].map((v) => v.toFixed(1)).join(',');
    if (p.detailKey === key && p.detail) return;
    const lx = (rx0 - p.x) * scale, ly = (ry0 - p.y) * scale;
    const c = document.createElement('canvas');
    c.className = 'pdf-detail';
    c.width = Math.ceil((rx1 - rx0) * scale);
    c.height = Math.ceil((ry1 - ry0) * scale);
    const task = await this._renderTo(c, p, scale, Math.floor(lx), Math.floor(ly));
    this._detailTask = task;
    await task.promise;
    this._detailTask = null;
    if (!this.pages.includes(p)) return;
    this._freeDetail(p);
    const ox = Math.floor(lx) / scale, oy = Math.floor(ly) / scale;
    c.style.left = ox + 'px';
    c.style.top = oy + 'px';
    c.style.width = c.width / scale + 'px';
    c.style.height = c.height / scale + 'px';
    p.detail = c;
    p.detailKey = key;
    p.el.appendChild(c);
  }

  _freeBase(p) {
    if (p.base) { p.base.width = p.base.height = 0; p.base.remove(); p.base = null; p.baseScale = 0; }
  }
  _freeDetail(p) {
    if (p.detail) { p.detail.width = p.detail.height = 0; p.detail.remove(); p.detail = null; p.detailKey = ''; }
  }

  _releaseFar() {
    const vis = this.visiblePages();
    if (!vis.length) return;
    const a = vis[0].index - KEEP_RANGE, b = vis[vis.length - 1].index + KEEP_RANGE;
    for (const p of this.pages) {
      if (p.index < a || p.index > b) {
        if (p.base) { this._freeBase(p); p.el.classList.remove('rendered'); }
        this._freeDetail(p);
        if (p.proxy && p.index !== 0) { p.proxy.cleanup(); p.proxy = null; }
      } else if (!vis.includes(p)) this._freeDetail(p);
    }
  }

  // ───────────────────────── 필기 레이어 ─────────────────────────

  requestInk() {
    if (this._inkFrame) return;
    this._inkFrame = requestAnimationFrame(() => { this._inkFrame = 0; this.drawInk(); });
  }

  /**
   * 카메라가 움직일 때 필기 레이어 처리.
   * 가벼운 페이지는 매 프레임 벡터로 다시 그리고, 무거운 페이지(다시 그리기 > 10ms)는
   * 마지막으로 그린 비트맵을 CSS 변환으로 따라가게 한 뒤 움직임이 멈추면(또는 300ms마다) 선명하게 다시 그린다.
   */
  _inkFollowCamera() {
    if (!this.inkCost || this.inkCost < 10 || !this.drawnCam) { this.requestInk(); return; }
    const d = this.drawnCam, c = this.cam, k = c.z / d.z;
    const t = `translate(${c.tx - d.tx * k}px, ${c.ty - d.ty * k}px) scale(${k})`;
    this.hlCanvas.style.transform = t;
    this.inkCanvas.style.transform = t;
    this.inkOffset = true;
    clearTimeout(this._inkSettle);
    this._inkSettle = setTimeout(() => this.requestInk(), 90);
    if (performance.now() - this._lastFullInk > 300) this.requestInk();
  }

  /** 페이지 좌표계로 ctx 변환 (dpr 포함) */
  pageTransform(ctx, p) {
    const { tx, ty, z } = this.cam, d = this.dpr;
    ctx.setTransform(d * z, 0, 0, d * z, d * (p.x * z + tx), d * (p.y * z + ty));
  }

  drawInk() {
    const t0 = performance.now();
    this._drawInk();
    const dt = performance.now() - t0;
    this.inkCost = this.inkCost ? this.inkCost * 0.7 + dt * 0.3 : dt;
    this._lastFullInk = performance.now();
    this.drawnCam = { ...this.cam };
    if (this.inkOffset) { this.hlCanvas.style.transform = ''; this.inkCanvas.style.transform = ''; this.inkOffset = false; }
  }

  _drawInk() {
    const hl = this.hlCtx, ink = this.inkCtx;
    hl.setTransform(1, 0, 0, 1, 0, 0);
    ink.setTransform(1, 0, 0, 1, 0, 0);
    hl.clearRect(0, 0, this.hlCanvas.width, this.hlCanvas.height);
    ink.clearRect(0, 0, this.inkCanvas.width, this.inkCanvas.height);
    if (!this.doc) return;
    const sel = this.selection;
    for (const p of this.visiblePages(0.05)) {
      const items = this.doc.items(p.index);
      if (!items.length) continue;
      // 화면에 보이는 페이지 영역 (페이지 좌표)
      const w0 = this.toWorld(0, 0), w1 = this.toWorld(this.vw, this.vh);
      const view = { x: w0.x - p.x, y: w0.y - p.y, w: w1.x - w0.x, h: w1.y - w0.y };
      for (const ctx of [hl, ink]) {
        ctx.save();
        this.pageTransform(ctx, p);
        ctx.beginPath();
        ctx.rect(0, 0, p.w, p.h);
        ctx.clip();
      }
      for (const it of items) {
        if (this.hidden && this.hidden.has(it.id)) continue;
        const ctx = isHighlighter(it) ? hl : ink;
        const moving = sel && sel.page === p.index && sel.ids.has(it.id) && sel.m;
        if (moving) {
          const { s, ox, oy, dx, dy } = sel.m;
          ctx.save();
          ctx.translate(ox + dx, oy + dy);
          ctx.scale(s, s);
          ctx.translate(-ox, -oy);
          drawItem(ctx, it);
          ctx.restore();
          continue;
        }
        if (!rectsIntersect(bbox(it), view)) continue;
        drawItem(ctx, it);
      }
      hl.restore();
      ink.restore();
    }
    this.emit('inkdrawn');
  }

  /** 새 객체 하나만 현재 화면에 덧그린다. 전체 다시 그리기가 필요한 상태면 false */
  appendItem(page, item) {
    if (this._inkFrame || this.selection?.m || this.hidden || this.inkOffset) return false;
    const p = this.pages[page];
    if (!p) return false;
    const ctx = isHighlighter(item) ? this.hlCtx : this.inkCtx;
    ctx.save();
    this.pageTransform(ctx, p);
    ctx.beginPath();
    ctx.rect(0, 0, p.w, p.h);
    ctx.clip();
    drawItem(ctx, item);
    ctx.restore();
    return true;
  }

  clearLive() {
    const c = this.liveCtx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.liveCanvas.width, this.liveCanvas.height);
  }
}
