// 무한 스크롤 엔진: 폭이 고정된 긴 종이 한 장
//
// - 문서는 페이지 0 하나뿐이고, 높이는 아래쪽 내용에 맞춰 시트(인쇄 페이지) 단위로 자동으로 늘어난다
//   (마지막 내용 아래에 항상 빈 공간이 남도록).
// - 시트 경계(점선)는 화면 안내용이며 PDF 로 내보낼 때 이 경계로 잘라 여러 페이지를 만든다.
// - 배경(줄·모눈·점)은 시트마다 PDF 새 노트 속지(export.js drawTemplate)와 같은 위치에 그려 화면과 출력이 같다.
import { clamp } from './util.js';
import { bbox } from './ink.js';

const MARGIN = 16; // 화면 px (viewer 와 같은 값)
export const SHEET_SIZES = { A4: [595.28, 841.89], Letter: [612, 792] };

const bottoms = new WeakMap(); // items 배열 → 내용의 맨 아래 y
export function contentBottom(items) {
  let b = bottoms.get(items);
  if (b == null) {
    b = 0;
    for (const it of items) { const r = bbox(it); b = Math.max(b, r.y + r.h); }
    bottoms.set(items, b);
  }
  return b;
}

/** 시트 하나의 속지 선 (페이지 좌표, 시트 위쪽 기준) — export.js drawTemplate 과 같은 배치 */
export function sheetTemplate(template, W, H) {
  const lines = [], dots = [];
  if (template === 'lined') for (let y = 72; y < H - 40; y += 24) lines.push([36, y, W - 36, y]);
  else if (template === 'grid') {
    const s = 14.17;
    for (let x = 28; x < W - 20; x += s) lines.push([x, 28, x, H - 28]);
    for (let y = 28; y < H - 20; y += s) lines.push([28, H - y, W - 28, H - y]);
  } else if (template === 'dot') {
    const s = 14.17;
    for (let x = 28; x < W - 20; x += s) for (let y = 28; y < H - 20; y += s) dots.push([x, H - y]);
  }
  return { lines, dots };
}

export class ScrollEngine {
  constructor({ size = 'A4', bg = 'blank' } = {}) {
    this.kind = 'scroll';
    [this.W, this.sheetH] = SHEET_SIZES[size] || SHEET_SIZES.A4;
    this.bg = bg;
    this._tpl = null;
  }

  /** 내용에 맞춘 종이 높이: 마지막 내용 아래로 시트의 60% 이상 빈 공간, 시트 단위 */
  heightFor(items) {
    const need = contentBottom(items) + this.sheetH * 0.6;
    return Math.max(this.sheetH, Math.ceil(need / this.sheetH) * this.sheetH);
  }

  /** 문서가 바뀐 뒤: 높이가 달라지면 true */
  update(v) {
    const h = this.heightFor(v.doc.items(0));
    const p = v.pages[0];
    if (!p || Math.abs(p.h - h) < 0.5) return false;
    p.h = h;
    return true;
  }

  layout(v) {
    const p = v.pages[0];
    p.x = 0; p.y = 0; p.w = this.W;
    if (!p.h) p.h = this.heightFor(v.doc.items(0));
    const s = p.el.style;
    s.left = '0px'; s.top = '0px'; s.width = p.w + 'px'; s.height = p.h + 'px';
    v.contentW = p.w;
    v.contentH = p.h;
    v.fitZ = this.fitZ(v);
  }

  fitZ(v) { return (v.vw - MARGIN * 2) / this.W; }
  minZ(v) { return this.fitZ(v) * 0.3; }
  maxZ(v) { return Math.max(this.fitZ(v) * 10, 8); }

  clamp(v, c) {
    c.z = clamp(c.z, this.minZ(v), this.maxZ(v));
    const cw = v.contentW * c.z, ch = v.contentH * c.z;
    if (cw + MARGIN * 2 <= v.vw) c.tx = (v.vw - cw) / 2;
    else c.tx = clamp(c.tx, v.vw - cw - MARGIN, MARGIN);
    const top = MARGIN + v.insetTop, bottom = v.vh - ch - MARGIN;
    c.ty = clamp(c.ty, Math.min(bottom, top), top);
    return c;
  }

  /** 보던 위치: 화면 위쪽의 종이 높이 + 가로 위치 + 폭 맞춤 대비 배율 */
  anchor(v) {
    const w = v.toWorld(v.vw / 2, v.insetTop);
    return { kind: 'scroll', y: w.y, fx: w.x / this.W, zr: v.cam.z / this.fitZ(v) };
  }

  restore(v, view) {
    if (view?.kind === 'scroll' && Number.isFinite(view.y) && Number.isFinite(view.zr)) {
      const z = clamp(view.zr * this.fitZ(v), this.minZ(v), this.maxZ(v));
      v.setCamera(v.vw / 2 - view.fx * this.W * z, v.insetTop - view.y * z, z);
    } else {
      const z = this.fitZ(v);
      v.setCamera((v.vw - this.W * z) / 2, MARGIN + v.insetTop, z);
    }
  }

  fit(v, mode) {
    const a = this.anchor(v);
    if (mode === 'page') {
      const z = Math.min(this.fitZ(v), (v.vh - v.insetTop - MARGIN * 2) / this.sheetH);
      const i = this.currentSheet(v);
      v.setCamera((v.vw - this.W * z) / 2, MARGIN + v.insetTop - i * this.sheetH * z, z);
      return;
    }
    this.restore(v, { ...a, fx: 0.5, zr: 1 });
  }

  // ── 시트(인쇄 페이지) ──
  sheetCount(v) { return Math.max(1, Math.ceil(contentBottom(v.doc.items(0)) / this.sheetH)); }
  currentSheet(v) {
    const y = (v.vh / 2 - v.cam.ty) / v.cam.z;
    return clamp(Math.floor(y / this.sheetH), 0, Math.max(0, Math.round(v.pages[0].h / this.sheetH) - 1));
  }
  goToSheet(v, i) {
    v.setCamera(v.cam.tx, MARGIN + v.insetTop - Math.max(0, i) * this.sheetH * v.cam.z, v.cam.z);
  }

  /** 배경: 보이는 시트의 속지 + 시트 경계 점선. ctx 는 화면 픽셀 기준(변환 없음) */
  drawBackground(ctx, v) {
    const p = v.pages[0];
    const { tx, ty, z } = v.cam, d = v.dpr;
    ctx.save();
    ctx.setTransform(d * z, 0, 0, d * z, d * tx, d * ty);
    ctx.beginPath();
    ctx.rect(0, 0, p.w, p.h);
    ctx.clip();
    const top = Math.max(0, -ty / z), bot = Math.min(p.h, (v.vh - ty) / z);
    const i0 = Math.floor(top / this.sheetH), i1 = Math.floor(bot / this.sheetH);
    if (!this._tpl) this._tpl = sheetTemplate(this.bg, this.W, this.sheetH);
    const { lines, dots } = this._tpl;
    for (let i = i0; i <= i1; i++) {
      const oy = i * this.sheetH;
      if (lines.length) {
        ctx.strokeStyle = 'rgb(184,204,230)';
        ctx.lineWidth = this.bg === 'grid' ? 0.3 : 0.5;
        ctx.beginPath();
        for (const [x1, y1, x2, y2] of lines) { ctx.moveTo(x1, oy + y1); ctx.lineTo(x2, oy + y2); }
        ctx.stroke();
      }
      if (dots.length && z * 14.17 > 4) {
        ctx.fillStyle = 'rgb(153,168,191)';
        ctx.beginPath();
        for (const [x, y] of dots) { ctx.moveTo(x + 0.6, oy + y); ctx.arc(x, oy + y, 0.6, 0, Math.PI * 2); }
        ctx.fill();
      }
      if (i > 0) {
        // 인쇄 페이지 경계
        ctx.strokeStyle = 'rgba(90,110,140,0.45)';
        ctx.lineWidth = 1 / z;
        ctx.setLineDash([6 / z, 5 / z]);
        ctx.beginPath(); ctx.moveTo(0, oy); ctx.lineTo(p.w, oy); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    ctx.restore();
  }
}
