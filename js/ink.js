// 필기 객체 모델, 렌더링, 히트 테스트, 변형
//
// 모든 좌표는 "페이지 좌표"(PDF 1배율 viewport 단위, 좌상단 원점, y 아래 방향)로 저장한다.
// 확대율·스크롤과 무관하므로 저장된 필기는 어떤 배율에서도 같은 위치에 그려진다.
//
// 객체 종류
//  stroke : {id, t:'s', tool:'pen'|'hl', c, w, pr:bool(필압 사용), pts:[x,y,p, x,y,p, ...]}
//  shape  : {id, t:'sh', kind:'line'|'arrow'|'rect'|'ellipse', c, w, x1,y1,x2,y2}
//  text   : {id, t:'tx', x, y, c, fs, text}
//  link   : {id, t:'ln', x, y, w, h, to:{page}|{url}}  (손가락 탭으로 이동하는 사용자 링크 영역)
import { distToSegment, pointInPolygon, uid } from './util.js';

const cache = new WeakMap(); // item -> {bbox, path, polys}

export const TEXT_FONT = '"Pretendard", "Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", system-ui, sans-serif';
export const TEXT_LINE = 1.3;

/** 필압 → 반지름 배율 */
export function pressureFactor(p) {
  const q = p > 0 ? Math.min(p, 1) : 0.5;
  return 0.3 + 1.15 * q; // p=0.6 ≒ 1.0
}

export function strokeRadii(item) {
  const n = item.pts.length / 3;
  const r = new Float32Array(n);
  const base = item.w / 2;
  if (item.pr) {
    // 필압 튐 방지용 가벼운 평활화
    let prev = item.pts[2];
    for (let i = 0; i < n; i++) {
      const p = item.pts[i * 3 + 2];
      prev = prev + (p - prev) * 0.5;
      r[i] = base * pressureFactor(prev);
    }
  } else r.fill(base);
  return r;
}

// ── 가변 두께 획 그리기 ──
// 점마다 두께가 다른 획을 "두께가 거의 같은 구간(run)"으로 나눠 각 구간을 하나의 폴리라인으로 그린다.
// 캔버스/PDF 의 둥근 이음(round join)·둥근 끝(round cap)을 쓰므로 두꺼운 획도 외곽이 매끈하고,
// 획 하나당 그리기 호출이 몇 번뿐이라 빠르다. 구간 경계는 같은 점을 공유해 이음매가 없다.
const WIDTH_STEP = Math.log(1.05); // 두께 5% 단위로 구간을 나눈다

export function widthBucket(w) { return Math.round(Math.log(Math.max(w, 0.01)) / WIDTH_STEP); }

/** 획 → [{w, pts:[x,y,...]}] (두께별 구간) */
export function strokeRuns(item) {
  const radii = strokeRadii(item);
  const p = item.pts, n = p.length / 3;
  if (!item.pr) {
    const pts = [];
    for (let i = 0; i < n; i++) pts.push(p[i * 3], p[i * 3 + 1]);
    return [{ w: item.w, pts }];
  }
  const runs = [];
  let cur = null, curB = 0;
  for (let i = 0; i < n; i++) {
    const w = radii[i] * 2, b = widthBucket(w);
    if (!cur || b !== curB) {
      cur = { w: Math.exp(b * WIDTH_STEP), pts: [] };
      if (i > 0) cur.pts.push(p[(i - 1) * 3], p[(i - 1) * 3 + 1]); // 이전 점에서 시작 → 끊김 없음
      runs.push(cur);
      curB = b;
    }
    cur.pts.push(p[i * 3], p[i * 3 + 1]);
  }
  return runs;
}

/** 도형 → 폴리라인 목록 (페이지 좌표) */
export function shapePolylines(s) {
  const { x1, y1, x2, y2 } = s;
  switch (s.kind) {
    case 'line': return [[x1, y1, x2, y2]];
    case 'arrow': {
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const L = Math.hypot(x2 - x1, y2 - y1);
      const h = Math.min(Math.max(s.w * 4, 8), L * 0.45);
      const a1 = ang + Math.PI * 0.82, a2 = ang - Math.PI * 0.82;
      return [[x1, y1, x2, y2], [x2 + Math.cos(a1) * h, y2 + Math.sin(a1) * h, x2, y2, x2 + Math.cos(a2) * h, y2 + Math.sin(a2) * h]];
    }
    case 'rect': return [[x1, y1, x2, y1, x2, y2, x1, y2, x1, y1]];
    case 'ellipse': {
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
      const seg = Math.max(24, Math.min(96, Math.round((rx + ry) / 3)));
      const out = [];
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        out.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
      }
      return [out];
    }
  }
  return [];
}

/** 텍스트 줄 분할과 크기 측정 (오프스크린 캔버스) */
let measureCtx = null;
export function textLayout(item) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = `${item.fs}px ${TEXT_FONT}`;
  const lines = String(item.text).split('\n');
  let w = 0;
  for (const l of lines) w = Math.max(w, measureCtx.measureText(l).width);
  return { lines, w: Math.max(w, item.fs * 0.5), h: lines.length * item.fs * TEXT_LINE };
}

function computeBBox(item) {
  if (item.t === 's') {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const p = item.pts;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i] < minX) minX = p[i]; if (p[i] > maxX) maxX = p[i];
      if (p[i + 1] < minY) minY = p[i + 1]; if (p[i + 1] > maxY) maxY = p[i + 1];
    }
    const pad = (item.w / 2) * (item.pr ? 1.45 : 1) + 0.5;
    return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
  }
  if (item.t === 'sh') {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pl of shapePolylines(item)) for (let i = 0; i < pl.length; i += 2) {
      minX = Math.min(minX, pl[i]); maxX = Math.max(maxX, pl[i]);
      minY = Math.min(minY, pl[i + 1]); maxY = Math.max(maxY, pl[i + 1]);
    }
    const pad = item.w / 2 + 0.5;
    return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
  }
  if (item.t === 'tx') {
    const L = textLayout(item);
    return { x: item.x, y: item.y, w: L.w, h: L.h };
  }
  if (item.t === 'ln') return { x: item.x, y: item.y, w: item.w, h: item.h };
  return { x: 0, y: 0, w: 0, h: 0 };
}

function entry(item) {
  let e = cache.get(item);
  if (!e) { e = {}; cache.set(item, e); }
  return e;
}

export function bbox(item) {
  const e = entry(item);
  return e.bbox || (e.bbox = computeBBox(item));
}

/** 그리기용 경로 캐시: 획은 [{w, path, dot}] 구간 목록, 도형은 Path2D 하나 */
export function itemPath(item) {
  const e = entry(item);
  if (e.path) return e.path;
  if (item.t === 's') {
    e.path = strokeRuns(item).map((r) => {
      const path = new Path2D();
      path.moveTo(r.pts[0], r.pts[1]);
      for (let i = 2; i < r.pts.length; i += 2) path.lineTo(r.pts[i], r.pts[i + 1]);
      return { w: r.w, path, dot: r.pts.length === 2 ? [r.pts[0], r.pts[1]] : null };
    });
  } else if (item.t === 'sh') {
    const path = new Path2D();
    for (const pl of shapePolylines(item)) {
      path.moveTo(pl[0], pl[1]);
      for (let i = 2; i < pl.length; i += 2) path.lineTo(pl[i], pl[i + 1]);
    }
    e.path = path;
  }
  return e.path;
}

/** 구간 목록 그리기 (ctx 는 페이지 좌표계) */
export function strokeRunPaths(ctx, runs, color) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const r of runs) {
    if (r.dot) { ctx.beginPath(); ctx.arc(r.dot[0], r.dot[1], r.w / 2, 0, Math.PI * 2); ctx.fill(); continue; }
    ctx.lineWidth = r.w;
    ctx.stroke(r.path);
  }
}

/** ctx는 이미 페이지 좌표계로 변환되어 있어야 한다 */
export function drawItem(ctx, item) {
  if (item.t === 's') {
    strokeRunPaths(ctx, itemPath(item), item.c);
  } else if (item.t === 'sh') {
    ctx.strokeStyle = item.c;
    ctx.lineWidth = item.w;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(itemPath(item));
  } else if (item.t === 'ln') {
    drawLink(ctx, item);
  } else if (item.t === 'tx') {
    const L = textLayout(item);
    ctx.fillStyle = item.c;
    ctx.font = `${item.fs}px ${TEXT_FONT}`;
    ctx.textBaseline = 'top';
    for (let i = 0; i < L.lines.length; i++) {
      ctx.fillText(L.lines[i], item.x, item.y + i * item.fs * TEXT_LINE + item.fs * (TEXT_LINE - 1) / 2);
    }
  }
}

export function linkLabel(item) {
  if (item.to?.url) { try { return '🔗 ' + new URL(item.to.url).hostname; } catch { return '🔗 ' + item.to.url; } }
  if (Number.isInteger(item.to?.page)) return `→ ${item.to.page + 1}쪽`;
  return '⚠ 대상 없음';
}

function drawLink(ctx, item) {
  ctx.fillStyle = 'rgba(52,120,246,0.10)';
  ctx.fillRect(item.x, item.y, item.w, item.h);
  ctx.setLineDash([3, 2]);
  ctx.lineWidth = 0.8;
  ctx.strokeStyle = 'rgba(52,120,246,0.85)';
  ctx.strokeRect(item.x, item.y, item.w, item.h);
  ctx.setLineDash([]);
  const fs = Math.max(5, Math.min(9, item.h * 0.6));
  ctx.font = `${fs}px ${TEXT_FONT}`;
  ctx.textBaseline = 'top';
  const label = linkLabel(item);
  const tw = ctx.measureText(label).width + 4;
  ctx.fillStyle = 'rgba(52,120,246,0.9)';
  ctx.fillRect(item.x, item.y - fs - 3, Math.min(tw, Math.max(item.w, tw)), fs + 3);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, item.x + 2, item.y - fs - 1.5);
}

export const isHighlighter = (item) => item.t === 's' && item.tool === 'hl';

/** 객체 위의 대표 점들 (올가미 판정용) */
export function samplePoints(item) {
  if (item.t === 's') return item.pts.filter((_, i) => i % 3 !== 2);
  if (item.t === 'sh') return shapePolylines(item).flat();
  const b = bbox(item);
  return [b.x, b.y, b.x + b.w, b.y, b.x, b.y + b.h, b.x + b.w, b.y + b.h, b.x + b.w / 2, b.y + b.h / 2];
}

/** (x,y)에서 반경 r 안에 객체가 닿는지 */
export function hitTest(item, x, y, r) {
  const b = bbox(item);
  if (x < b.x - r || x > b.x + b.w + r || y < b.y - r || y > b.y + b.h + r) return false;
  if (item.t === 'tx' || item.t === 'ln') return true;
  if (item.t === 's') {
    const p = item.pts, half = (item.w / 2) * (item.pr ? 1.2 : 1);
    if (p.length === 3) return Math.hypot(p[0] - x, p[1] - y) <= r + half;
    for (let i = 3; i < p.length; i += 3) {
      if (distToSegment(x, y, p[i - 3], p[i - 2], p[i], p[i + 1]) <= r + half) return true;
    }
    return false;
  }
  if (item.t === 'sh') {
    for (const pl of shapePolylines(item)) for (let i = 2; i < pl.length; i += 2) {
      if (distToSegment(x, y, pl[i - 2], pl[i - 1], pl[i], pl[i + 1]) <= r + item.w / 2) return true;
    }
  }
  return false;
}

/** 선분 (ax,ay)-(bx,by) 이동 경로 전체에 대해 히트 테스트 (빠른 지우개 이동에도 누락 없이) */
export function hitTestSweep(item, ax, ay, bx, by, r) {
  const L = Math.hypot(bx - ax, by - ay);
  const steps = Math.max(1, Math.ceil(L / Math.max(r * 0.5, 0.5)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (hitTest(item, ax + (bx - ax) * t, ay + (by - ay) * t, r)) return true;
  }
  return false;
}

/** 올가미 다각형 안에 포함되는지 (대표 점 60% 이상) */
export function insideLasso(item, poly) {
  const s = samplePoints(item);
  if (item.t === 'tx' || item.t === 'ln') {
    const b = bbox(item);
    return pointInPolygon(b.x + b.w / 2, b.y + b.h / 2, poly);
  }
  let inside = 0, total = 0;
  const step = Math.max(1, Math.floor(s.length / 2 / 60)); // 최대 60점 정도 검사
  for (let i = 0; i < s.length; i += 2 * step) {
    total++;
    if (pointInPolygon(s[i], s[i + 1], poly)) inside++;
  }
  return total > 0 && inside / total >= 0.6;
}

/** 부분 지우개: 원 (x,y,r)에 닿는 부분을 잘라 낸 새 획 목록을 돌려준다. 변화 없으면 null */
export function eraseStrokePart(item, x, y, r) {
  if (item.t !== 's') return hitTest(item, x, y, r) ? [] : null;
  if (!hitTest(item, x, y, r)) return null;
  const p = item.pts;
  // 긴 선분을 잘게 쪼개서 원이 선분 사이를 지나쳐도 정확히 자르도록 한다
  const maxSeg = Math.max(r * 0.4, 0.4);
  const dense = [p[0], p[1], p[2]];
  for (let i = 3; i < p.length; i += 3) {
    const ax = p[i - 3], ay = p[i - 2], ap = p[i - 1], bx = p[i], by = p[i + 1], bp = p[i + 2];
    const L = Math.hypot(bx - ax, by - ay);
    const k = Math.ceil(L / maxSeg);
    for (let j = 1; j <= k; j++) {
      const t = j / k;
      dense.push(ax + (bx - ax) * t, ay + (by - ay) * t, ap + (bp - ap) * t);
    }
  }
  const half = item.w / 2;
  const runs = [];
  let cur = [];
  for (let i = 0; i < dense.length; i += 3) {
    const inside = Math.hypot(dense[i] - x, dense[i + 1] - y) <= r + half * 0.6;
    if (inside) { if (cur.length) runs.push(cur); cur = []; }
    else cur.push(dense[i], dense[i + 1], dense[i + 2]);
  }
  if (cur.length) runs.push(cur);
  const out = [];
  for (const run of runs) {
    if (run.length < 6) continue; // 점 하나만 남은 조각은 버린다
    out.push({ ...item, id: uid('s'), pts: simplifyPts(run, 0.15) });
  }
  return out;
}

/** 거의 일직선인 중간 점 제거 (Ramer–Douglas–Peucker, 필압 포함 3원소 배열) */
export function simplifyPts(pts, eps) {
  const n = pts.length / 3;
  if (n <= 2) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(pts[i * 3], pts[i * 3 + 1], pts[a * 3], pts[a * 3 + 1], pts[b * 3], pts[b * 3 + 1]);
      const dp = Math.abs(pts[i * 3 + 2] - (pts[a * 3 + 2] + pts[b * 3 + 2]) / 2);
      const score = d + dp * 2;
      if (score > maxD) { maxD = score; idx = i; }
    }
    if (maxD > eps && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
  return out;
}

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

export function roundPts(pts) {
  const out = new Array(pts.length);
  for (let i = 0; i < pts.length; i += 3) { out[i] = r2(pts[i]); out[i + 1] = r2(pts[i + 1]); out[i + 2] = r3(pts[i + 2]); }
  return out;
}

/** 평행이동 + 균등 확대 (원점 ox,oy 기준 s배 후 dx,dy 이동) */
export function transformItem(item, m) {
  const { s, ox, oy, dx, dy } = m;
  const X = (x) => ox + (x - ox) * s + dx;
  const Y = (y) => oy + (y - oy) * s + dy;
  if (item.t === 's') {
    const pts = new Array(item.pts.length);
    for (let i = 0; i < pts.length; i += 3) { pts[i] = r2(X(item.pts[i])); pts[i + 1] = r2(Y(item.pts[i + 1])); pts[i + 2] = item.pts[i + 2]; }
    return { ...item, pts, w: item.w * s };
  }
  if (item.t === 'sh') return { ...item, x1: X(item.x1), y1: Y(item.y1), x2: X(item.x2), y2: Y(item.y2), w: item.w * s };
  if (item.t === 'tx') return { ...item, x: X(item.x), y: Y(item.y), fs: item.fs * s };
  if (item.t === 'ln') return { ...item, x: X(item.x), y: Y(item.y), w: item.w * s, h: item.h * s };
  return item;
}

const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
const fin = (v) => typeof v === 'number' && Number.isFinite(v);

/** 저장소에서 읽은 객체 검증. 잘못된 객체는 null */
export function sanitizeItem(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.t !== 'string') return null;
  const id = typeof raw.id === 'string' ? raw.id : uid('x');
  const c = typeof raw.c === 'string' && COLOR_RE.test(raw.c) ? raw.c : '#111111';
  if (raw.t === 's') {
    if (!Array.isArray(raw.pts) || raw.pts.length < 3 || raw.pts.length % 3 !== 0) return null;
    if (!raw.pts.every(fin)) return null;
    if (!fin(raw.w) || raw.w <= 0) return null;
    return { id, t: 's', tool: raw.tool === 'hl' ? 'hl' : 'pen', c, w: raw.w, pr: !!raw.pr, pts: raw.pts };
  }
  if (raw.t === 'sh') {
    if (!['line', 'arrow', 'rect', 'ellipse'].includes(raw.kind)) return null;
    if (![raw.x1, raw.y1, raw.x2, raw.y2, raw.w].every(fin)) return null;
    return { id, t: 'sh', kind: raw.kind, c, w: raw.w, x1: raw.x1, y1: raw.y1, x2: raw.x2, y2: raw.y2 };
  }
  if (raw.t === 'tx') {
    if (![raw.x, raw.y, raw.fs].every(fin) || typeof raw.text !== 'string') return null;
    return { id, t: 'tx', x: raw.x, y: raw.y, c, fs: raw.fs, text: raw.text };
  }
  if (raw.t === 'ln') {
    if (![raw.x, raw.y, raw.w, raw.h].every(fin) || raw.w <= 0 || raw.h <= 0) return null;
    const to = raw.to && typeof raw.to === 'object' ? raw.to : {};
    const clean = typeof to.url === 'string' && /^(https?:|mailto:|tel:)/i.test(to.url) ? { url: to.url }
      : Number.isInteger(to.page) && to.page >= 0 ? { page: to.page } : {};
    return { id, t: 'ln', x: raw.x, y: raw.y, w: raw.w, h: raw.h, to: clean };
  }
  return null;
}
