// 무한 캔버스 엔진: 경계가 보이지 않는 넓은 평면
//
// - 문서는 페이지 0 하나이고 크기는 WORLD×WORLD (페이지 단위, 약 35m 사방). 새 캔버스는 가운데에서 시작한다.
//   좌표를 무한히 키우지 않는 이유: 캔버스 2D 는 내부적으로 32비트 실수를 쓰므로 좌표가 너무 크면
//   확대했을 때 선이 떨린다. 이 크기면 최대 확대(8배)에서도 오차가 0.3px 이하.
// - 화면 좌표 = 월드 좌표 × z + (tx, ty) — viewer 와 같은 카메라를 그대로 쓴다.
// - 배경(모눈·점·줄)은 무한히 반복되며, 축소해서 간격이 너무 촘촘해지면 5칸씩 묶어 그린다.
import { clamp } from './util.js';
import { bbox } from './ink.js';

export const WORLD = 100000;
const START = WORLD / 2;

export class CanvasEngine {
  constructor({ bg = 'grid' } = {}) {
    this.kind = 'canvas';
    this.bg = bg;
  }

  update() { return false; }

  layout(v) {
    const p = v.pages[0];
    p.x = 0; p.y = 0; p.w = WORLD; p.h = WORLD;
    p.el.style.display = 'none'; // 흰 바탕은 뷰포트가 칠한다 (거대한 요소를 만들지 않음)
    v.contentW = WORLD;
    v.contentH = WORLD;
    v.fitZ = 1;
  }

  fitZ() { return 1; } // 100% = 실제 크기
  minZ() { return 0.05; }
  maxZ() { return 8; }

  /** 화면 가운데가 평면 밖으로 나가지 않게 */
  clamp(v, c) {
    c.z = clamp(c.z, this.minZ(), this.maxZ());
    const cx = clamp((v.vw / 2 - c.tx) / c.z, 0, WORLD), cy = clamp((v.vh / 2 - c.ty) / c.z, 0, WORLD);
    c.tx = v.vw / 2 - cx * c.z;
    c.ty = v.vh / 2 - cy * c.z;
    return c;
  }

  anchor(v) {
    const w = v.toWorld(v.vw / 2, v.vh / 2);
    return { kind: 'canvas', cx: w.x, cy: w.y, z: v.cam.z };
  }

  restore(v, view) {
    const ok = view?.kind === 'canvas' && Number.isFinite(view.cx) && Number.isFinite(view.cy) && Number.isFinite(view.z);
    const z = ok ? view.z : 1, cx = ok ? view.cx : START, cy = ok ? view.cy : START;
    v.setCamera(v.vw / 2 - cx * z, v.vh / 2 - cy * z, z);
  }

  /** page: 내용 전체가 보이게, width: 실제 크기(100%) */
  fit(v, mode) {
    if (mode !== 'page') { const a = this.anchor(v); this.restore(v, { ...a, z: 1 }); return; }
    const items = v.doc.items(0);
    if (!items.length) { this.restore(v, null); return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of items) { const b = bbox(it); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
    const pad = 40;
    const z = clamp(Math.min((v.vw - pad * 2) / Math.max(1, x1 - x0), (v.vh - v.insetTop - pad * 2) / Math.max(1, y1 - y0)), this.minZ(), 2);
    this.restore(v, { kind: 'canvas', cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 - v.insetTop / 2 / z, z });
  }

  /** 배경 무늬. ctx 는 화면 픽셀 기준 */
  drawBackground(ctx, v) {
    if (this.bg === 'blank') return;
    const { tx, ty, z } = v.cam, d = v.dpr;
    let step = this.bg === 'lined' ? 24 : 14.17;
    const minPx = this.bg === 'dot' ? 14 : 7;
    while (step * z < minPx) step *= 5; // 축소하면 칸을 묶어 촘촘함 유지 (점은 그리는 양이 많아 더 넓게)
    const x0 = Math.floor(-tx / z / step) * step, x1 = (v.vw - tx) / z;
    const y0 = Math.floor(-ty / z / step) * step, y1 = (v.vh - ty) / z;
    ctx.save();
    ctx.setTransform(d, 0, 0, d, 0, 0); // 선 굵기를 화면 px 로 일정하게
    const X = (x) => Math.round(x * z + tx) + 0.5, Y = (y) => Math.round(y * z + ty) + 0.5;
    if (this.bg === 'dot') {
      ctx.fillStyle = 'rgb(153,168,191)';
      ctx.beginPath();
      for (let x = x0; x <= x1; x += step) for (let y = y0; y <= y1; y += step) { ctx.moveTo(X(x) + 1, Y(y)); ctx.arc(X(x), Y(y), 1, 0, Math.PI * 2); }
      ctx.fill();
    } else {
      ctx.strokeStyle = 'rgb(206,220,238)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (this.bg === 'grid') for (let x = x0; x <= x1; x += step) { ctx.moveTo(X(x), 0); ctx.lineTo(X(x), v.vh); }
      for (let y = y0; y <= y1; y += step) { ctx.moveTo(0, Y(y)); ctx.lineTo(v.vw, Y(y)); }
      ctx.stroke();
    }
    ctx.restore();
  }
}
