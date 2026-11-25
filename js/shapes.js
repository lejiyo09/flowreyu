// 펜의 직선·도형 모드 (플렉슬의 일직선·도형 자동 생성처럼)
// - 직선: 시작점과 끝점을 잇는 선. 수평·수직·45° 근처면 그 각도로 맞춤
// - 도형: 대충 그린 획을 분석해 원·타원·삼각형·사각형·다각형·꺾은선·화살표로 정돈. 알아보지 못하면 null (그린 그대로 둠)
// 좌표는 페이지 좌표. pts 는 [x, y, p, x, y, p, ...] (펜 획 형식)

const SNAP_DEG = 7; // 이 각도 안이면 수평·수직·45° 로

/** 각도 맞춤: (x1,y1)→(x2,y2) 를 0·45·90° 근처면 그 방향으로 (길이 유지) */
export function snapLine(x1, y1, x2, y2, deg = SNAP_DEG) {
  const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy);
  if (L < 1e-6) return { x2, y2 };
  const a = Math.atan2(dy, dx), step = Math.PI / 4;
  const near = Math.round(a / step) * step;
  if (Math.abs(a - near) <= (deg * Math.PI) / 180) return { x2: x1 + Math.cos(near) * L, y2: y1 + Math.sin(near) * L };
  return { x2, y2 };
}

const xy = (pts) => { const o = []; for (let i = 0; i < pts.length; i += 3) o.push([pts[i], pts[i + 1]]); return o; };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
/** Ramer–Douglas–Peucker: 꼭짓점만 남김 */
function rdp(P, eps) {
  if (P.length < 3) return P.slice();
  let k = -1, dmax = 0;
  for (let i = 1; i < P.length - 1; i++) { const d = segDist(P[i], P[0], P[P.length - 1]); if (d > dmax) { dmax = d; k = i; } }
  if (dmax <= eps) return [P[0], P[P.length - 1]];
  const a = rdp(P.slice(0, k + 1), eps), b = rdp(P.slice(k), eps);
  return a.slice(0, -1).concat(b);
}
const pathLen = (P) => { let s = 0; for (let i = 1; i < P.length; i++) s += dist(P[i - 1], P[i]); return s; };
/** 점들이 다각형(닫힌 꼭짓점 목록) 변에서 떨어진 평균 거리 */
function polyError(P, V) {
  let s = 0;
  for (const p of P) { let m = Infinity; for (let i = 0; i < V.length; i++) m = Math.min(m, segDist(p, V[i], V[(i + 1) % V.length])); s += m; }
  return s / P.length;
}
const angleAt = (a, b, c) => { // b 에서의 내각 (도)
  const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]];
  const d = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2) || 1);
  return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI;
};

/** 타원 맞춤 (주성분): 중심·반지름·기울기와 맞음 정도(err: 0 이 완벽) */
function fitEllipse(P) {
  const n = P.length;
  let cx = 0, cy = 0;
  for (const p of P) { cx += p[0]; cy += p[1]; }
  cx /= n; cy /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of P) { const dx = p[0] - cx, dy = p[1] - cy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  sxx /= n; syy /= n; sxy /= n;
  const tr = sxx + syy, det = sxx * syy - sxy * sxy, disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const a = Math.sqrt(2 * Math.max(l1, 1e-9)), b = Math.sqrt(2 * Math.max(l2, 1e-9)); // 고르게 퍼진 타원 위 점의 분산 = r²/2
  const c = Math.cos(ang), s = Math.sin(ang);
  const rel = P.map((p) => { const dx = p[0] - cx, dy = p[1] - cy; return [dx * c + dy * s, -dx * s + dy * c]; });
  let err = 0;
  for (const [u, v] of rel) err += Math.abs(Math.hypot(u / a, v / b) - 1);
  err /= n;
  return { cx, cy, a, b, ang, err };
}

/** 획 → 도형 판정. 반환: {kind, ...} 또는 null */
export function recognize(pts) {
  let P = xy(pts);
  if (P.length < 4) return null;
  // 손떨림 줄이기: 앞뒤 2점 이동 평균 (끝점은 그대로)
  if (P.length > 10) P = P.map((p, i) => { if (i < 2 || i > P.length - 3) return p; let x = 0, y = 0; for (let k = -2; k <= 2; k++) { x += P[i + k][0]; y += P[i + k][1]; } return [x / 5, y / 5]; });
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of P) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const diag = Math.hypot(maxX - minX, maxY - minY);
  if (diag < 8) return null;
  const L = pathLen(P), chord = dist(P[0], P[P.length - 1]);
  // ── 직선: 거의 곧은 열린 획 ──
  // 시작–끝을 잇는 선에서 가장 멀리 벗어난 거리가 작으면 직선 (획 길이는 손떨림에 늘어나므로 쓰지 않음)
  // (다듬기 전 원래 점으로 잼: 다듬으면 구불구불한 글씨도 펴져 보임)
  const raw0 = xy(pts);
  const maxOff = raw0.reduce((m, p) => Math.max(m, segDist(p, raw0[0], raw0[raw0.length - 1])), 0);
  if (chord > diag * 0.85 && maxOff < Math.max(chord * 0.07, 3)) {
    const e = snapLine(P[0][0], P[0][1], P[P.length - 1][0], P[P.length - 1][1]);
    return { kind: 'line', x1: P[0][0], y1: P[0][1], x2: e.x2, y2: e.y2 };
  }
  // 닫힘: 끝이 처음 근처로 돌아옴 (한 바퀴를 조금 넘겨 그린 경우: 뒤쪽 절반에서 시작점에 가장 가까운 곳까지만 씀)
  let closed = chord < diag * 0.22 && L > diag * 1.6;
  if (!closed && L > diag * 1.8) {
    let best = -1, bd = Infinity, acc = 0;
    for (let i = 1; i < P.length; i++) { acc += dist(P[i - 1], P[i]); if (acc > L * 0.5) { const d = dist(P[i], P[0]); if (d < bd) { bd = d; best = i; } } }
    if (best > 0 && bd < diag * 0.15) { P = P.slice(0, best + 1); closed = true; }
  }
  if (!closed) {
    // ── 화살표: 긴 몸통 + 끝에서 짧게 꺾인 머리 (한 획으로 그린 경우) ──
    const V = rdp(P, diag * 0.06);
    if (V.length >= 4) {
      const shaft = dist(V[0], V[1]);
      const rest = pathLen(V.slice(1));
      const nearTip = V.slice(2).every((p) => dist(p, V[1]) < shaft * 0.5);
      if (shaft > diag * 0.6 && rest < shaft * 1.2 && nearTip) {
        const e = snapLine(V[0][0], V[0][1], V[1][0], V[1][1]);
        return { kind: 'arrow', x1: V[0][0], y1: V[0][1], x2: e.x2, y2: e.y2 };
      }
    }
    // ── 꺾은선: 곧은 구간 2~3 개 (구간마다 곧고, 분명히 꺾여야 함 — 손글씨 곡선이 꺾은선이 되지 않게) ──
    if (V.length >= 3 && V.length <= 4) {
      const err = P.reduce((s, p) => { let m = Infinity; for (let i = 1; i < V.length; i++) m = Math.min(m, segDist(p, V[i - 1], V[i])); return s + m; }, 0) / P.length;
      const maxDev = P.reduce((m, p) => { let d = Infinity; for (let i = 1; i < V.length; i++) d = Math.min(d, segDist(p, V[i - 1], V[i])); return Math.max(m, d); }, 0);
      const sharp = V.slice(1, -1).every((v, i) => angleAt(V[i], v, V[i + 2]) < 150);
      if (err < diag * 0.016 && maxDev < diag * 0.06 && sharp) return { kind: 'polyline', points: V };
    }
    return null;
  }
  // ── 닫힌 도형 ──
  if (dist(P[0], P[P.length - 1]) > 1e-6) P = P.concat([P[0]]);
  const el = fitEllipse(P);
  // 꼭짓점: 시작점이 모서리가 아닐 수 있으므로 가장 먼 점에서 다시 시작해 RDP
  let far = 0, fd = -1;
  for (let i = 0; i < P.length; i++) { const d = Math.hypot(P[i][0] - el.cx, P[i][1] - el.cy); if (d > fd) { fd = d; far = i; } }
  const R = P.slice(far, -1).concat(P.slice(0, far + 1));
  let V = rdp(R, diag * 0.07);
  if (V.length > 2 && dist(V[0], V[V.length - 1]) < diag * 0.08) V = V.slice(0, -1);
  // 거의 일직선인 꼭짓점 합치기
  for (let changed = true; changed && V.length > 3;) {
    changed = false;
    for (let i = 0; i < V.length; i++) {
      if (angleAt(V[(i - 1 + V.length) % V.length], V[i], V[(i + 1) % V.length]) > 155) { V.splice(i, 1); changed = true; break; }
    }
  }
  const pErr = V.length >= 3 ? polyError(P, V) / diag : 1;
  const eErr = el.err;
  const polyOk = V.length >= 3 && V.length <= 6 && pErr < 0.03;
  // 변이 아주 곧으면 다각형(삼각형·사각형…), 아니면 타원이 맞을 때 원·타원 (원도 육각형쯤으로는 근사되므로 '곧음'으로 가름)
  // 삼각형·사각형은 다각형이 타원보다 확실히 잘 맞으면(오차 절반 이하), 오각형·육각형은 더 엄격히 (원·타원도 육각형쯤으로 근사되므로)
  const sharpPoly = polyOk && (V.length <= 4 ? pErr < 0.02 || pErr < eErr * 0.5 : pErr < 0.016 || pErr < eErr * 0.25);
  if (!sharpPoly && eErr < 0.12) {
    let { a, b, ang } = el;
    if (Math.min(a, b) / Math.max(a, b) > 0.85) { a = b = (a + b) / 2; ang = 0; } // 거의 원 → 원
    const deg = ((ang * 180) / Math.PI + 180) % 90;
    if (deg < 8 || deg > 82) { // 축에 맞춤 → 편집 가능한 원 개체
      const swap = Math.abs(Math.sin(ang)) > 0.7;
      const rx = swap ? b : a, ry = swap ? a : b;
      return { kind: 'ellipse', x1: el.cx - rx, y1: el.cy - ry, x2: el.cx + rx, y2: el.cy + ry };
    }
    return { kind: 'ellipse-rot', cx: el.cx, cy: el.cy, a, b, ang };
  }
  if (!polyOk) return null;
  if (V.length === 3) return { kind: 'triangle', points: V };
  if (V.length === 4) {
    const angs = V.map((v, i) => angleAt(V[(i + 3) % 4], v, V[(i + 1) % 4]));
    if (angs.every((x) => Math.abs(x - 90) < 18)) {
      // 직사각형: 변 방향 평균으로 기울기, 반듯하게
      // 네 변 방향의 평균 (90° 주기라 4배 각도로 원형 평균 → 0°/90° 경계에서 꼬이지 않음)
      let sx = 0, sy = 0;
      for (let i = 0; i < 4; i++) { const a = Math.atan2(V[(i + 1) % 4][1] - V[i][1], V[(i + 1) % 4][0] - V[i][0]); sx += Math.cos(4 * a); sy += Math.sin(4 * a); }
      const th = Math.atan2(sy, sx) / 4;
      if (Math.abs(th) < (8 * Math.PI) / 180) { // 축에 맞춤 → 편집 가능한 사각형 개체
        // 변 위치: 모서리(다듬기로 둥글어짐) 대신 변 위 점들의 위치로 — 각 변 근처 점들의 평균
        const xs = V.map((v) => v[0]).sort((p, q) => p - q), ys = V.map((v) => v[1]).sort((p, q) => p - q);
        let l = (xs[0] + xs[1]) / 2, r = (xs[2] + xs[3]) / 2, t = (ys[0] + ys[1]) / 2, b = (ys[2] + ys[3]) / 2;
        const band = Math.min(r - l, b - t) * 0.15, avg = (arr) => (arr.length ? arr.reduce((u, v) => u + v, 0) / arr.length : null);
        const raw = xy(pts);
        const L2 = avg(raw.filter((p) => Math.abs(p[0] - l) < band && p[1] > t + band && p[1] < b - band).map((p) => p[0]));
        const R2 = avg(raw.filter((p) => Math.abs(p[0] - r) < band && p[1] > t + band && p[1] < b - band).map((p) => p[0]));
        const T2 = avg(raw.filter((p) => Math.abs(p[1] - t) < band && p[0] > l + band && p[0] < r - band).map((p) => p[1]));
        const B2 = avg(raw.filter((p) => Math.abs(p[1] - b) < band && p[0] > l + band && p[0] < r - band).map((p) => p[1]));
        l = L2 ?? l; r = R2 ?? r; t = T2 ?? t; b = B2 ?? b;
        return { kind: 'rect', x1: l, y1: t, x2: r, y2: b };
      }
      const c = Math.cos(th), s = Math.sin(th);
      const cx = V.reduce((t, v) => t + v[0], 0) / 4, cy = V.reduce((t, v) => t + v[1], 0) / 4;
      const loc = V.map((v) => [(v[0] - cx) * c + (v[1] - cy) * s, -(v[0] - cx) * s + (v[1] - cy) * c]);
      const hw = loc.reduce((t, p) => t + Math.abs(p[0]), 0) / 4, hh = loc.reduce((t, p) => t + Math.abs(p[1]), 0) / 4;
      const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([u, v]) => [cx + u * c - v * s, cy + u * s + v * c]);
      return { kind: 'polygon', points: corners };
    }
    return { kind: 'polygon', points: V };
  }
  return { kind: 'polygon', points: V };
}

/** 판정 결과 → 페이지에 넣을 항목. base: {color, width, tool('pen'|'hl')} */
export function shapeToItem(r, base, uid) {
  const { color: c, width: w, tool } = base;
  // 펜의 반듯한 직선·화살표·사각형·원은 도형 개체 (올가미로 끝점·크기 편집). 형광펜은 겹쳐 칠하기 위해 획으로
  if (tool !== 'hl' && ['line', 'arrow', 'rect', 'ellipse'].includes(r.kind)) {
    return { id: uid('sh'), t: 'sh', kind: r.kind, c, w, x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 };
  }
  const pts = [];
  const add = (x, y) => pts.push(Math.round(x * 100) / 100, Math.round(y * 100) / 100, 0.5);
  if (r.kind === 'line' || r.kind === 'arrow') {
    add(r.x1, r.y1); add(r.x2, r.y2);
    if (r.kind === 'arrow') { // 형광펜 화살표: 머리를 이어 그림
      const ang = Math.atan2(r.y2 - r.y1, r.x2 - r.x1), h = Math.min(Math.max(w * 4, 8), Math.hypot(r.x2 - r.x1, r.y2 - r.y1) * 0.45);
      add(r.x2 + Math.cos(ang + Math.PI * 0.82) * h, r.y2 + Math.sin(ang + Math.PI * 0.82) * h);
      add(r.x2, r.y2);
      add(r.x2 + Math.cos(ang - Math.PI * 0.82) * h, r.y2 + Math.sin(ang - Math.PI * 0.82) * h);
    }
  } else if (r.kind === 'rect') {
    for (const [x, y] of [[r.x1, r.y1], [r.x2, r.y1], [r.x2, r.y2], [r.x1, r.y2], [r.x1, r.y1]]) add(x, y);
  } else if (r.kind === 'ellipse' || r.kind === 'ellipse-rot') {
    const cx = r.kind === 'ellipse' ? (r.x1 + r.x2) / 2 : r.cx, cy = r.kind === 'ellipse' ? (r.y1 + r.y2) / 2 : r.cy;
    const a = r.kind === 'ellipse' ? Math.abs(r.x2 - r.x1) / 2 : r.a, b = r.kind === 'ellipse' ? Math.abs(r.y2 - r.y1) / 2 : r.b;
    const ang = r.kind === 'ellipse' ? 0 : r.ang, c0 = Math.cos(ang), s0 = Math.sin(ang);
    const seg = Math.max(32, Math.min(120, Math.round((a + b) / 2)));
    for (let i = 0; i <= seg; i++) { const t = (i / seg) * Math.PI * 2, u = Math.cos(t) * a, v = Math.sin(t) * b; add(cx + u * c0 - v * s0, cy + u * s0 + v * c0); }
  } else if (r.kind === 'polyline') {
    for (const [x, y] of r.points) add(x, y);
  } else { // triangle / polygon: 닫음
    for (const [x, y] of r.points) add(x, y);
    add(r.points[0][0], r.points[0][1]);
  }
  return { id: uid('s'), t: 's', tool: tool === 'hl' ? 'hl' : 'pen', c, w, pr: false, pts };
}

export const SHAPE_NAMES = { line: '직선', arrow: '화살표', rect: '사각형', ellipse: '원', 'ellipse-rot': '타원', triangle: '삼각형', polygon: '다각형', polyline: '꺾은선' };
