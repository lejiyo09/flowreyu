// 필기 도구: 펜, 형광펜, 지우개, 올가미, 텍스트, 도형
// 입력 엔진(input.js)은 화면 좌표만 넘기고, 도구가 페이지 좌표로 변환해 문서를 수정한다.
import { settings } from './settings.js';
import {
  widthBucket, pressureFactor, roundPts, simplifyPts, hitTestSweep, eraseStrokePart,
  insideLasso, bbox, transformItem, shapePolylines, hitTest,
} from './ink.js';
import { uid, dist, now } from './util.js';

export class ToolController {
  constructor(viewer, app) {
    this.viewer = viewer;
    this.app = app; // { doc(), onSelection(sel), editText(page, item, x, y), toast }
    this.cur = null; // 현재 동작 중인 도구 세션
    this.selection = null; // {page, ids:Set}
    this._liveRaf = 0;
    this.tools = {
      pen: new PenTool(this, 'pen'),
      hl: new PenTool(this, 'hl'),
      eraser: new EraserTool(this),
      lasso: new LassoTool(this),
      text: new TextTool(this),
      shape: new ShapeTool(this),
    };
  }

  get doc() { return this.app.doc(); }
  toolName(override) { return override || settings.get('tool'); }

  /** 화면 좌표 → 지정 페이지의 페이지 좌표 */
  toPage(page, sx, sy) {
    const p = this.viewer.pages[page];
    const w = this.viewer.toWorld(sx, sy);
    return { x: w.x - p.x, y: w.y - p.y };
  }

  begin(ev) {
    if (!this.doc) return;
    if (this.cur) this.cancel();
    const name = this.toolName(ev.toolOverride);
    const tool = this.tools[name];
    if (!tool) return;
    // 올가미가 아닌 도구를 쓰면 선택 해제
    if (name !== 'lasso' && this.selection) this.clearSelection();
    const hit = this.viewer.pageAtScreen(ev.sx, ev.sy);
    if (!hit) return;
    this.cur = { tool, page: hit.page, t0: now(), sx0: ev.sx, sy0: ev.sy, path: 0, lastSx: ev.sx, lastSy: ev.sy };
    tool.begin(this.cur, ev);
  }

  move(pts, pred, isFinal) {
    const c = this.cur;
    if (!c) return;
    for (const p of pts) { c.path += dist(c.lastSx, c.lastSy, p.sx, p.sy); c.lastSx = p.sx; c.lastSy = p.sy; }
    c.tool.move(c, pts, pred, isFinal);
  }

  end() {
    const c = this.cur;
    this.cur = null;
    if (c) c.tool.end(c);
  }

  cancel() {
    const c = this.cur;
    this.cur = null;
    if (c) c.tool.cancel(c);
    this.viewer.clearLive();
  }

  /** 짧은 점/탭 수준의 입력인지 (메뉴를 열 때 버릴지 판단) */
  isTrivial() {
    const c = this.cur;
    return !c || c.path < Math.max(settings.get('holdTolerance') * 1.5, 8);
  }

  requestLive(draw) {
    this._liveDraw = draw;
    if (this._liveRaf) return;
    this._liveRaf = requestAnimationFrame(() => {
      this._liveRaf = 0;
      const d = this._liveDraw;
      this._liveDraw = null;
      if (d) d();
    });
  }

  flushLive() {
    if (this._liveRaf) { cancelAnimationFrame(this._liveRaf); this._liveRaf = 0; }
    this._liveDraw = null;
  }

  // ── 선택(올가미) ──
  setSelection(sel) {
    this.selection = sel && sel.ids.size ? sel : null;
    this.viewer.selection = this.selection ? { page: this.selection.page, ids: this.selection.ids, m: null } : null;
    this.app.onSelection(this.selection);
    this.viewer.requestInk();
  }
  clearSelection() { this.setSelection(null); }

  selectionBBox() {
    const sel = this.selection;
    if (!sel) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of this.doc.items(sel.page)) {
      if (!sel.ids.has(it.id)) continue;
      const b = bbox(it);
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
    }
    if (!Number.isFinite(x0)) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  deleteSelection() {
    const sel = this.selection;
    if (!sel) return;
    this.doc.setItems(sel.page, this.doc.items(sel.page).filter((it) => !sel.ids.has(it.id)));
    this.clearSelection();
  }

  duplicateSelection() {
    const sel = this.selection;
    if (!sel) return;
    const copies = [];
    for (const it of this.doc.items(sel.page)) {
      if (sel.ids.has(it.id)) copies.push({ ...transformItem(it, { s: 1, ox: 0, oy: 0, dx: 16, dy: 16 }), id: uid(it.t) });
    }
    this.doc.setItems(sel.page, [...this.doc.items(sel.page), ...copies]);
    this.setSelection({ page: sel.page, ids: new Set(copies.map((c) => c.id)) });
  }

  recolorSelection(color) {
    const sel = this.selection;
    if (!sel) return;
    this.doc.setItems(sel.page, this.doc.items(sel.page).map((it) => (sel.ids.has(it.id) && !(it.t === 's' && it.tool === 'hl') ? { ...it, c: color } : it)));
    this.app.onSelection(this.selection);
  }

  /** 문서가 바뀌었을 때(Undo 등) 사라진 객체를 선택에서 제외 */
  validateSelection() {
    const sel = this.selection;
    if (!sel) return;
    const alive = new Set(this.doc.items(sel.page).map((i) => i.id));
    for (const id of [...sel.ids]) if (!alive.has(id)) sel.ids.delete(id);
    if (!sel.ids.size) this.clearSelection();
    else this.app.onSelection(sel);
  }
}

// ───────────────────────────── 펜 / 형광펜 ─────────────────────────────

class PenTool {
  constructor(ctl, kind) { this.ctl = ctl; this.kind = kind; }

  cfg() { return settings.get(this.kind === 'hl' ? 'hl' : 'pen'); }

  begin(c, ev) {
    const cfg = this.cfg();
    const v = this.ctl.viewer;
    c.color = cfg.color;
    c.width = cfg.width;
    c.pr = this.kind === 'pen' && settings.get('pressure') && ev.kind === 'pen';
    c.pts = [];
    c.prevP = ev.p;
    c.runs = []; // 그리는 중인 두께별 구간 (ink.strokeRuns 와 같은 규칙)
    c.smooth = Math.min(settings.get('smoothing'), 10) * 0.065; // 0 ~ 0.65
    c.minStep = 0.35 / v.cam.z; // 화면 0.35px 미만 이동은 무시
    v.liveCanvas.style.mixBlendMode = this.kind === 'hl' ? 'multiply' : 'normal';
    this.addPoint(c, ev.sx, ev.sy, ev.p, true);
    this.draw(c, null);
  }

  addPoint(c, sx, sy, p, force) {
    let { x, y } = this.ctl.toPage(c.page, sx, sy);
    const n = c.pts.length;
    if (n && !force) {
      const lx = c.pts[n - 3], ly = c.pts[n - 2];
      if (c.smooth > 0) { x = lx + (x - lx) * (1 - c.smooth); y = ly + (y - ly) * (1 - c.smooth); }
      if (Math.hypot(x - lx, y - ly) < c.minStep) return false;
    }
    this.pushPoint(c, x, y, p);
    return true;
  }

  /** 점 추가 + 구간 갱신. 두께 계산은 ink.strokeRadii 와 같은 필압 평활화 → 그리는 중과 저장 후 모양이 같다 */
  pushPoint(c, x, y, p) {
    const n = c.pts.length;
    const px = n ? c.pts[n - 3] : x, py = n ? c.pts[n - 2] : y;
    c.pts.push(x, y, p);
    c.prevP = c.prevP + (p - c.prevP) * 0.5;
    const w = c.pr ? c.width * pressureFactor(c.prevP) : c.width;
    const b = c.pr ? widthBucket(w) : 0;
    let run = c.runs[c.runs.length - 1];
    if (!run || run.b !== b) {
      run = { b, w: c.pr ? Math.exp(b * Math.log(1.05)) : c.width, path: new Path2D(), count: 0, x, y };
      if (n) { run.path.moveTo(px, py); run.count = 1; } else run.path.moveTo(x, y);
      c.runs.push(run);
    }
    if (run.count > 0) run.path.lineTo(x, y);
    run.count++;
    run.x = x; run.y = y;
  }

  move(c, pts, pred, isFinal) {
    for (const p of pts) this.addPoint(c, p.sx, p.sy, p.p, false);
    if (isFinal && pts.length && c.smooth > 0) {
      // 평활화로 생긴 지연을 없애기 위해 실제 마지막 위치를 추가
      const last = pts[pts.length - 1];
      const { x, y } = this.ctl.toPage(c.page, last.sx, last.sy);
      const n = c.pts.length;
      if (Math.hypot(x - c.pts[n - 3], y - c.pts[n - 2]) > c.minStep) this.pushPoint(c, x, y, c.pts[n - 1]);
    }
    this.ctl.requestLive(() => this.draw(c, pred));
  }

  draw(c, pred) {
    const v = this.ctl.viewer;
    const ctx = v.liveCtx;
    v.clearLive();
    const p = v.pages[c.page];
    v.pageTransform(ctx, p);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, p.w, p.h); ctx.clip();
    ctx.strokeStyle = ctx.fillStyle = c.color;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const r of c.runs) {
      if (r.count === 1) { ctx.beginPath(); ctx.arc(r.x, r.y, r.w / 2, 0, Math.PI * 2); ctx.fill(); continue; }
      ctx.lineWidth = r.w;
      ctx.stroke(r.path);
    }
    const last = c.runs[c.runs.length - 1];
    if (pred && last) {
      // 예측 점: 화면에만 잠깐 보여 주고 저장하지 않음 → 체감 지연 감소
      const { x, y } = this.ctl.toPage(c.page, pred.sx, pred.sy);
      ctx.lineWidth = last.w;
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(x, y); ctx.stroke();
    }
    ctx.restore();
  }

  end(c) {
    this.ctl.flushLive();
    const v = this.ctl.viewer;
    if (c.pts.length) {
      const pts = roundPts(c.pts.length > 9 ? simplifyPts(c.pts, 0.04) : c.pts);
      const item = { id: uid('s'), t: 's', tool: this.kind, c: c.color, w: c.width, pr: c.pr, pts };
      // 문서 변경 이벤트에서 새 획만 덧그린다 (전체 다시 그리기 없음) → 그 뒤 라이브 레이어 지움
      this.ctl.doc.add(c.page, item);
    }
    v.clearLive();
  }

  cancel() { this.ctl.flushLive(); this.ctl.viewer.clearLive(); }
}

// ───────────────────────────── 지우개 ─────────────────────────────

class EraserTool {
  constructor(ctl) { this.ctl = ctl; }

  begin(c, ev) {
    c.mode = settings.get('eraser').mode;
    c.r = settings.get('eraser').size / 2; // 화면 px
    c.lx = ev.sx; c.ly = ev.sy;
    c.changed = false;
    this.ctl.doc.begin();
    this.ctl.viewer.liveCanvas.style.mixBlendMode = 'normal';
    this.eraseSeg(c, ev.sx, ev.sy, ev.sx, ev.sy);
    this.drawCursor(c, ev.sx, ev.sy);
  }

  move(c, pts) {
    for (const p of pts) { this.eraseSeg(c, c.lx, c.ly, p.sx, p.sy); c.lx = p.sx; c.ly = p.sy; }
    const last = pts[pts.length - 1];
    if (last) this.ctl.requestLive(() => this.drawCursor(c, last.sx, last.sy));
  }

  eraseSeg(c, ax, ay, bx, by) {
    const v = this.ctl.viewer, doc = this.ctl.doc;
    const hitA = v.pageAtScreen(ax, ay, true), hitB = v.pageAtScreen(bx, by, true);
    const pages = new Set([hitA?.page, hitB?.page].filter((p) => p != null));
    const r = c.r / v.cam.z;
    for (const page of pages) {
      const A = this.ctl.toPage(page, ax, ay), B = this.ctl.toPage(page, bx, by);
      const items = doc.items(page);
      let out = null;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (c.mode === 'area' && it.t === 's') {
          // 이동 구간을 잘게 나눠 부분 지우기
          let parts = [it];
          const L = Math.hypot(B.x - A.x, B.y - A.y);
          const steps = Math.max(1, Math.ceil(L / Math.max(r * 0.5, 0.5)));
          let touched = false;
          for (let k = 0; k <= steps; k++) {
            const t = k / steps, x = A.x + (B.x - A.x) * t, y = A.y + (B.y - A.y) * t;
            const next = [];
            for (const part of parts) {
              const res = eraseStrokePart(part, x, y, r);
              if (res === null) next.push(part); else { touched = true; next.push(...res); }
            }
            parts = next;
          }
          if (touched) { if (!out) out = items.slice(0, i); out.push(...parts); }
          else if (out) out.push(it);
        } else if (hitTestSweep(it, A.x, A.y, B.x, B.y, r)) {
          if (!out) out = items.slice(0, i);
        } else if (out) out.push(it);
      }
      if (out) { doc.setItems(page, out); c.changed = true; }
    }
    if (c.changed) v.requestInk();
  }

  drawCursor(c, sx, sy) {
    const v = this.ctl.viewer, ctx = v.liveCtx, d = v.dpr;
    v.clearLive();
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.beginPath();
    ctx.arc(sx, sy, c.r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(120,120,120,0.15)';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(80,80,80,0.8)';
    ctx.stroke();
  }

  end(c) {
    this.ctl.flushLive();
    this.ctl.doc.commit();
    this.ctl.viewer.clearLive();
    if (c.changed) this.ctl.validateSelection();
  }

  cancel() { this.ctl.flushLive(); this.ctl.doc.commit(); this.ctl.viewer.clearLive(); }
}

// ───────────────────────────── 올가미 ─────────────────────────────

const HANDLE = 22; // 화면 px, 크기 조절 손잡이 판정 범위

class LassoTool {
  constructor(ctl) { this.ctl = ctl; }

  /** 화면 좌표 기준 선택 상자 */
  screenBox() {
    const b = this.ctl.selectionBBox();
    if (!b) return null;
    const sel = this.ctl.selection;
    const v = this.ctl.viewer;
    const a = v.pageToScreen(sel.page, b.x, b.y), z = v.cam.z;
    return { x: a.x, y: a.y, w: b.w * z, h: b.h * z, pb: b };
  }

  begin(c, ev) {
    const v = this.ctl.viewer;
    v.liveCanvas.style.mixBlendMode = 'normal';
    const box = this.screenBox();
    if (box) {
      const pad = 8;
      const nearHandle = dist(ev.sx, ev.sy, box.x + box.w, box.y + box.h) <= HANDLE;
      const inside = ev.sx >= box.x - pad && ev.sx <= box.x + box.w + pad && ev.sy >= box.y - pad && ev.sy <= box.y + box.h + pad;
      if (nearHandle || inside) {
        c.mode = nearHandle ? 'resize' : 'move';
        c.box = box;
        c.page = this.ctl.selection.page;
        c.m = { s: 1, ox: box.pb.x, oy: box.pb.y, dx: 0, dy: 0 };
        this.ctl.app.onSelection(this.ctl.selection, true);
        return;
      }
      this.ctl.clearSelection();
    }
    c.mode = 'lasso';
    c.poly = [];
    const p = this.ctl.toPage(c.page, ev.sx, ev.sy);
    c.poly.push(p.x, p.y);
    c.spoly = [ev.sx, ev.sy];
  }

  move(c, pts) {
    const v = this.ctl.viewer;
    const last = pts[pts.length - 1];
    if (!last) return;
    if (c.mode === 'lasso') {
      for (const p of pts) {
        const q = this.ctl.toPage(c.page, p.sx, p.sy);
        c.poly.push(q.x, q.y);
        c.spoly.push(p.sx, p.sy);
      }
      this.ctl.requestLive(() => this.drawLasso(c));
      return;
    }
    const z = v.cam.z;
    if (c.mode === 'move') {
      c.m.dx = (last.sx - c.sx0) / z;
      c.m.dy = (last.sy - c.sy0) / z;
    } else {
      const w0 = c.box.w, h0 = c.box.h;
      const nw = Math.max(last.sx - c.box.x, 8), nh = Math.max(last.sy - c.box.y, 8);
      c.m.s = Math.max(0.05, Math.min(20, Math.max(nw / Math.max(w0, 1), nh / Math.max(h0, 1))));
    }
    v.selection = { page: c.page, ids: this.ctl.selection.ids, m: { ...c.m } };
    v.requestInk();
    this.ctl.app.onSelection(this.ctl.selection, true, c.m);
  }

  drawLasso(c) {
    const v = this.ctl.viewer, ctx = v.liveCtx, d = v.dpr;
    v.clearLive();
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.beginPath();
    const s = c.spoly;
    ctx.moveTo(s[0], s[1]);
    for (let i = 2; i < s.length; i += 2) ctx.lineTo(s[i], s[i + 1]);
    ctx.closePath();
    ctx.fillStyle = 'rgba(30,99,214,0.06)';
    ctx.fill();
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#1e63d6';
    ctx.stroke();
    ctx.setLineDash([]);
  }

  end(c) {
    this.ctl.flushLive();
    const v = this.ctl.viewer;
    v.clearLive();
    if (c.mode === 'lasso') {
      if (c.poly.length < 6) {
        // 탭: 그 위치의 객체 하나 선택
        const p = { x: c.poly[0], y: c.poly[1] };
        const items = this.ctl.doc.items(c.page);
        for (let i = items.length - 1; i >= 0; i--) {
          if (hitTest(items[i], p.x, p.y, 6 / v.cam.z)) { this.ctl.setSelection({ page: c.page, ids: new Set([items[i].id]) }); return; }
        }
        return;
      }
      const ids = new Set();
      for (const it of this.ctl.doc.items(c.page)) if (insideLasso(it, c.poly)) ids.add(it.id);
      this.ctl.setSelection({ page: c.page, ids });
      if (!ids.size) this.ctl.app.toast?.('선택된 필기가 없습니다');
      return;
    }
    // 이동/크기 변경 확정
    const m = c.m;
    v.selection = { page: c.page, ids: this.ctl.selection.ids, m: null };
    if (m.dx || m.dy || m.s !== 1) {
      const ids = this.ctl.selection.ids;
      this.ctl.doc.setItems(c.page, this.ctl.doc.items(c.page).map((it) => (ids.has(it.id) ? transformItem(it, m) : it)));
    }
    v.requestInk();
    this.ctl.app.onSelection(this.ctl.selection);
  }

  cancel(c) {
    this.ctl.flushLive();
    if (c.mode !== 'lasso' && this.ctl.selection) {
      this.ctl.viewer.selection = { page: c.page, ids: this.ctl.selection.ids, m: null };
      this.ctl.viewer.requestInk();
      this.ctl.app.onSelection(this.ctl.selection);
    }
  }
}

// ───────────────────────────── 텍스트 ─────────────────────────────

class TextTool {
  constructor(ctl) { this.ctl = ctl; }
  begin(c) { this.ctl.viewer.liveCanvas.style.mixBlendMode = 'normal'; }
  move() {}
  end(c) {
    if (c.path > 12) return; // 드래그는 무시, 탭만 텍스트 상자 생성
    const p = this.ctl.toPage(c.page, c.sx0, c.sy0);
    const items = this.ctl.doc.items(c.page);
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.t === 'tx' && hitTest(it, p.x, p.y, 4)) { this.ctl.app.editText(c.page, it); return; }
    }
    this.ctl.app.editText(c.page, null, p.x, p.y);
  }
  cancel() {}
}

// ───────────────────────────── 도형 ─────────────────────────────

class ShapeTool {
  constructor(ctl) { this.ctl = ctl; }

  begin(c, ev) {
    const cfg = settings.get('shape');
    c.kind = cfg.kind; c.color = cfg.color; c.width = cfg.width;
    const p = this.ctl.toPage(c.page, ev.sx, ev.sy);
    c.x1 = p.x; c.y1 = p.y; c.x2 = p.x; c.y2 = p.y;
    this.ctl.viewer.liveCanvas.style.mixBlendMode = 'normal';
  }

  move(c, pts) {
    const last = pts[pts.length - 1];
    if (!last) return;
    const p = this.ctl.toPage(c.page, last.sx, last.sy);
    c.x2 = p.x; c.y2 = p.y;
    this.ctl.requestLive(() => this.draw(c));
  }

  shape(c) {
    return { id: uid('sh'), t: 'sh', kind: c.kind, c: c.color, w: c.width, x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2 };
  }

  draw(c) {
    const v = this.ctl.viewer, ctx = v.liveCtx;
    v.clearLive();
    const p = v.pages[c.page];
    v.pageTransform(ctx, p);
    ctx.strokeStyle = c.color;
    ctx.lineWidth = c.width;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    for (const pl of shapePolylines(this.shape(c))) {
      ctx.moveTo(pl[0], pl[1]);
      for (let i = 2; i < pl.length; i += 2) ctx.lineTo(pl[i], pl[i + 1]);
    }
    ctx.stroke();
  }

  end(c) {
    this.ctl.flushLive();
    const v = this.ctl.viewer;
    if (Math.hypot(c.x2 - c.x1, c.y2 - c.y1) * v.cam.z > 6) {
      this.ctl.doc.add(c.page, this.shape(c));
    }
    v.clearLive();
  }

  cancel() { this.ctl.flushLive(); this.ctl.viewer.clearLive(); }
}
