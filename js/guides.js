// 자 / 각도기 (화면 위에 떠 있는 도구)
//
// - 손가락 1개로 끌어 이동, 2개로 이동+회전 (15° 단위 근처에서 달라붙음, 각도 표시)
// - 자: 펜을 긴 모서리 근처에서 대고 그으면 모서리를 따라 직선
// - 각도기: 호 근처에서 시작하면 호를 따라, 밑변 근처에서 시작하면 밑변을 따라 그려지고
//           펜 위치의 각도(밑변 기준)를 실시간 표시
// - 눈금은 실제 페이지 단위(mm/cm, 1pt = 1/72 inch)라서 확대율이 바뀌면 같이 바뀐다
import { clamp, dist } from './util.js';

const SNAP_DIST = 26; // 화면 px: 이 안에서 펜을 대면 모서리/호에 붙는다
const MM = 72 / 25.4; // 1mm = 2.8346pt
const DEG = Math.PI / 180;

export class Guides {
  constructor(viewer, canvas) {
    this.viewer = viewer;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ruler = null; // {cx, cy, a, len, th}
    this.prot = null; // {cx, cy, a, r}
    this.grabs = new Map(); // pointerId -> {x, y}
    this.drag = null; // {target, base, pts}
    this.pen = null; // 각도 표시용 펜 위치 {x, y}
    this.showAngle = false;
    this._raf = 0;
    viewer.on('resize', () => this.resize());
    viewer.on('camera', () => this.request());
    this.resize();
  }

  get active() { return !!(this.ruler || this.prot); }

  resize() {
    const v = this.viewer, d = v.dpr;
    this.canvas.width = Math.round(v.vw * d);
    this.canvas.height = Math.round(v.vh * d);
    this.canvas.style.width = v.vw + 'px';
    this.canvas.style.height = v.vh + 'px';
    this.request();
  }

  toggleRuler() {
    const v = this.viewer;
    this.ruler = this.ruler ? null : { cx: v.vw / 2, cy: v.vh * 0.45, a: 0, len: Math.min(v.vw * 0.9, 900), th: 64 };
    this.request();
    return !!this.ruler;
  }

  toggleProtractor() {
    const v = this.viewer;
    const r = clamp(Math.min(v.vw, v.vh) * 0.28, 110, 220);
    this.prot = this.prot ? null : { cx: v.vw / 2, cy: v.vh * 0.62, a: 0, r };
    this.request();
    return !!this.prot;
  }

  hideAll() { this.ruler = null; this.prot = null; this.grabs.clear(); this.drag = null; this.request(); }

  // ───────── 좌표 ─────────

  /** 화면 점 → 도구 기준 좌표 (회전 해제) */
  local(g, x, y) {
    const c = Math.cos(-g.a), s = Math.sin(-g.a), dx = x - g.cx, dy = y - g.cy;
    return { x: dx * c - dy * s, y: dx * s + dy * c };
  }

  world(g, lx, ly) {
    const c = Math.cos(g.a), s = Math.sin(g.a);
    return { x: g.cx + lx * c - ly * s, y: g.cy + lx * s + ly * c };
  }

  hitRuler(x, y) {
    const g = this.ruler;
    if (!g) return false;
    const p = this.local(g, x, y);
    return Math.abs(p.x) <= g.len / 2 && Math.abs(p.y) <= g.th / 2;
  }

  hitProt(x, y) {
    const g = this.prot;
    if (!g) return false;
    const p = this.local(g, x, y);
    return (p.y <= 6 && Math.hypot(p.x, p.y) <= g.r) || (Math.abs(p.y) <= 14 && Math.abs(p.x) <= g.r);
  }

  // ───────── 손가락으로 옮기기 / 돌리기 ─────────

  /** 손가락이 도구 위에 닿으면 잡는다. 잡았으면 true (화면 이동 대신 도구 이동) */
  grab(id, x, y) {
    let target = this.drag?.target;
    if (!target) target = this.hitProt(x, y) ? 'prot' : this.hitRuler(x, y) ? 'ruler' : null;
    else if (!(target === 'prot' ? this.hitProt(x, y) : this.hitRuler(x, y))) target = null;
    if (!target) return false;
    this.grabs.set(id, { x, y });
    this.rebase(target);
    return true;
  }

  rebase(target) {
    const pts = [...this.grabs.entries()].slice(0, 2);
    if (!pts.length) { this.drag = null; this.showAngle = false; return; }
    const g = this[target];
    const base = { cx: g.cx, cy: g.cy, a: g.a };
    if (pts.length === 1) this.drag = { target, base, ids: [pts[0][0]], x: pts[0][1].x, y: pts[0][1].y };
    else {
      const [a, b] = [pts[0][1], pts[1][1]];
      this.drag = { target, base, ids: [pts[0][0], pts[1][0]], mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, ang: Math.atan2(b.y - a.y, b.x - a.x) };
    }
  }

  move(id, x, y) {
    if (!this.grabs.has(id) || !this.drag) return;
    this.grabs.set(id, { x, y });
    const d = this.drag, g = this[d.target];
    if (!g) return;
    if (d.ids.length === 1) {
      const p = this.grabs.get(d.ids[0]);
      g.cx = d.base.cx + p.x - d.x;
      g.cy = d.base.cy + p.y - d.y;
    } else {
      const a = this.grabs.get(d.ids[0]), b = this.grabs.get(d.ids[1]);
      if (!a || !b) return;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      let da = Math.atan2(b.y - a.y, b.x - a.x) - d.ang;
      // 중점 기준 회전 + 이동
      const ox = d.base.cx - d.mx, oy = d.base.cy - d.my;
      let ang = d.base.a + da;
      // 15° 배수 근처(±2°)에서는 달라붙기
      const snapped = Math.round(ang / (15 * DEG)) * 15 * DEG;
      if (Math.abs(ang - snapped) < 2 * DEG) { da += snapped - ang; ang = snapped; }
      const c2 = Math.cos(da), s2 = Math.sin(da);
      g.cx = mx + ox * c2 - oy * s2;
      g.cy = my + ox * s2 + oy * c2;
      g.a = ang;
      this.showAngle = true;
    }
    this.request();
  }

  release(id) {
    if (!this.grabs.delete(id)) return;
    if (this.drag) this.rebase(this.drag.target);
    if (!this.grabs.size) { this.showAngle = false; this.request(); }
  }

  isGrabbed(id) { return this.grabs.has(id); }

  // ───────── 펜 달라붙기 ─────────

  /** 펜이 닿은 위치가 자 모서리/각도기 호·밑변 근처면 투영 함수를 돌려준다 */
  snapperAt(x, y) {
    const r = this.ruler;
    if (r) {
      const p = this.local(r, x, y);
      if (Math.abs(p.x) <= r.len / 2 + SNAP_DIST) {
        for (const edge of [-r.th / 2, r.th / 2]) {
          if (Math.abs(p.y - edge) <= SNAP_DIST) {
            return { kind: 'ruler', project: (sx, sy) => { const q = this.local(r, sx, sy); return this.world(r, q.x, edge); } };
          }
        }
      }
    }
    const g = this.prot;
    if (g) {
      const p = this.local(g, x, y);
      const d = Math.hypot(p.x, p.y);
      if (Math.abs(d - g.r) <= SNAP_DIST && p.y <= SNAP_DIST) {
        return { kind: 'arc', project: (sx, sy) => {
          const q = this.local(g, sx, sy);
          let t = Math.atan2(q.y, q.x);
          if (t > 0) t = q.x >= 0 ? 0 : -Math.PI; // 위쪽 반원 안으로
          return this.world(g, Math.cos(t) * g.r, Math.sin(t) * g.r);
        } };
      }
      if (Math.abs(p.y) <= SNAP_DIST * 0.7 && Math.abs(p.x) <= g.r + SNAP_DIST) {
        return { kind: 'base', project: (sx, sy) => { const q = this.local(g, sx, sy); return this.world(g, q.x, 0); } };
      }
    }
    return null;
  }

  /** 각도 표시용 펜 위치 */
  penAt(x, y) {
    if (!this.prot) return;
    this.pen = { x, y };
    this.request();
  }

  penUp() { if (this.pen) { this.pen = null; this.request(); } }

  /** 각도기 기준 각도 (0~180°, 밑변 오른쪽 = 0°) */
  angleOf(x, y) {
    const p = this.local(this.prot, x, y);
    let deg = -Math.atan2(p.y, p.x) / DEG;
    if (deg < 0) deg += 360;
    return deg;
  }

  // ───────── 그리기 ─────────

  request() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); });
  }

  draw() {
    const ctx = this.ctx, d = this.viewer.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.active) return;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    const pxPerMm = MM * this.viewer.cam.z;
    if (this.ruler) this.drawRuler(ctx, this.ruler, pxPerMm);
    if (this.prot) this.drawProt(ctx, this.prot);
  }

  drawRuler(ctx, g, pxPerMm) {
    ctx.save();
    ctx.translate(g.cx, g.cy);
    ctx.rotate(g.a);
    const L = g.len, T = g.th;
    ctx.fillStyle = 'rgba(245, 248, 252, 0.82)';
    ctx.strokeStyle = 'rgba(40, 60, 90, 0.55)';
    ctx.lineWidth = 1;
    roundRect(ctx, -L / 2, -T / 2, L, T, 8);
    ctx.fill(); ctx.stroke();
    // 위쪽 모서리 눈금 (mm), 1cm 마다 숫자
    const showMm = pxPerMm >= 3;
    const step = showMm ? pxPerMm : pxPerMm * 10;
    const n = Math.floor(L / step);
    ctx.strokeStyle = 'rgba(30, 40, 60, 0.85)';
    ctx.fillStyle = 'rgba(30, 40, 60, 0.9)';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const x = -L / 2 + 8 + i * step;
      if (x > L / 2 - 6) break;
      const mm = showMm ? i : i * 10;
      const len = mm % 10 === 0 ? 14 : mm % 5 === 0 ? 9 : 5;
      ctx.moveTo(x, -T / 2); ctx.lineTo(x, -T / 2 + len);
      ctx.moveTo(x, T / 2); ctx.lineTo(x, T / 2 - len);
      if (mm % 10 === 0) ctx.fillText(String(mm / 10), x, -T / 2 + 16);
    }
    ctx.stroke();
    // 가운데 각도 표시
    let deg = Math.round(((-g.a / DEG) % 360 + 360) % 360);
    if (deg > 180) deg -= 360;
    ctx.font = `${this.showAngle && this.drag?.target === 'ruler' ? 'bold 15px' : '12px'} system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = this.showAngle && this.drag?.target === 'ruler' ? '#1e63d6' : 'rgba(30,40,60,0.7)';
    ctx.fillText(`${deg}°`, 0, T / 2 - 14);
    ctx.font = '9px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(30,40,60,0.55)';
    ctx.fillText('cm', L / 2 - 20, T / 2 - 14);
    ctx.restore();
  }

  drawProt(ctx, g) {
    ctx.save();
    ctx.translate(g.cx, g.cy);
    ctx.rotate(g.a);
    const R = g.r;
    ctx.beginPath();
    ctx.moveTo(-R, 0);
    ctx.arc(0, 0, R, Math.PI, 0);
    ctx.closePath();
    ctx.fillStyle = 'rgba(245, 248, 252, 0.8)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(40, 60, 90, 0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();
    // 눈금: 1°, 5°, 10° + 숫자
    ctx.strokeStyle = 'rgba(30, 40, 60, 0.85)';
    ctx.fillStyle = 'rgba(30, 40, 60, 0.9)';
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.beginPath();
    for (let deg = 0; deg <= 180; deg++) {
      const t = -deg * DEG, c = Math.cos(t), s = Math.sin(t);
      const len = deg % 10 === 0 ? 14 : deg % 5 === 0 ? 9 : 5;
      ctx.moveTo(c * R, s * R); ctx.lineTo(c * (R - len), s * (R - len));
      if (deg % 10 === 0 && R > 120) ctx.fillText(String(deg), c * (R - 24), s * (R - 24));
    }
    ctx.stroke();
    // 중심
    ctx.beginPath();
    ctx.moveTo(-8, 0); ctx.lineTo(8, 0); ctx.moveTo(0, -8); ctx.lineTo(0, 0);
    ctx.strokeStyle = '#e53935';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // 회전 각도
    if (this.showAngle && this.drag?.target === 'prot') {
      let deg = Math.round(((-g.a / DEG) % 360 + 360) % 360);
      if (deg > 180) deg -= 360;
      ctx.font = 'bold 14px system-ui, sans-serif';
      ctx.fillStyle = '#1e63d6';
      ctx.fillText(`${deg}°`, 0, -R * 0.45);
    }
    ctx.restore();
    // 펜 각도 표시: 중심에서 펜까지 선 + 값
    if (this.pen) {
      const p = this.pen;
      if (dist(p.x, p.y, g.cx, g.cy) <= R * 1.6) {
        const deg = this.angleOf(p.x, p.y);
        ctx.save();
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = 'rgba(229, 57, 53, 0.85)';
        ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(g.cx, g.cy); ctx.lineTo(p.x, p.y); ctx.stroke();
        ctx.setLineDash([]);
        const label = `${(deg > 180 ? 360 - deg : deg).toFixed(0)}°`;
        ctx.font = 'bold 15px system-ui, sans-serif';
        const w = ctx.measureText(label).width + 14;
        const lx = p.x + 18, ly = p.y - 30;
        ctx.fillStyle = 'rgba(229, 57, 53, 0.92)';
        roundRect(ctx, lx, ly, w, 24, 12);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, lx + w / 2, ly + 12);
        ctx.restore();
      }
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
