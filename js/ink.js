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
//  image  : {id, t:'im', x, y, w, h, blob}            (blob = IndexedDB blobs 스토어의 id, 이미지 자체는 따로 저장)
//  note   : {id, t:'nt', x, y, w, h, c(배경), fs, text, fold?} (포스트잇, fold=true 면 작은 아이콘으로 접힘)

//  check  : {id, t:'cl', x, y, w, fs, c, rows:[{text, done}]}          (체크리스트, 높이는 줄 수로 계산)
//  table  : {id, t:'tb', x, y, w, h, fs, cells:[[text]]}             (표, 행·열은 cells 크기, 첫 행은 머리글)

/** 지우개가 건드리지 않는 "개체" 종류 (설정의 "개체도 지우기"로 허용) */
export const OBJECT_TYPES = new Set(['tx', 'ln', 'im', 'nt', 'cl', 'tb']);
export const NOTE_COLORS = ['#fff59d', '#ffcc80', '#f8bbd0', '#b3e5fc', '#c5e1a5', '#e1bee7'];
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
  if (item.t === 'nt' && item.fold) return noteIconRect(item);
  if (item.t === 'cl') { const bh = objBarH(item); return { x: item.x, y: item.y - bh, w: item.w, h: checkHeight(item) + bh }; } // 위쪽 손잡이 띠 포함
  if (item.t === 'tb') { const bh = objBarH(item); return { x: item.x, y: item.y - bh, w: item.w, h: item.h + bh }; } // 위쪽 손잡이 띠 포함
  if (item.t === 'ln' || item.t === 'im' || item.t === 'nt') return { x: item.x, y: item.y, w: item.w, h: item.h };
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
/** opts.print: PDF 내보내기용 (화면 전용 손잡이는 그리지 않음) */
export function drawItem(ctx, item, opts) {
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
  } else if (item.t === 'im') {
    drawImage(ctx, item);
  } else if (item.t === 'nt') {
    drawNote(ctx, item);
  } else if (item.t === 'cl') {
    drawChecklist(ctx, item, opts);
  } else if (item.t === 'tb') {
    drawTable(ctx, item, opts);
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

// ── 그림 ──
// 이미지는 비동기로 읽어 오므로 캐시에 없으면 자리 표시를 그리고, 다 읽히면 onImageReady 로 다시 그리게 한다.
const imageCache = new Map(); // blobId -> ImageBitmap | 'loading' | 'error'
export const imageHooks = { load: null, ready: null }; // main.js 가 연결: load(blobId) → Promise<ImageBitmap>

export function getImage(id) {
  const hit = imageCache.get(id);
  if (hit && hit !== 'loading' && hit !== 'error') return hit;
  if (!hit && imageHooks.load) {
    imageCache.set(id, 'loading');
    imageHooks.load(id).then((bmp) => { imageCache.set(id, bmp || 'error'); imageHooks.ready?.(id); })
      .catch(() => { imageCache.set(id, 'error'); imageHooks.ready?.(id); });
  }
  return null;
}
export function putImage(id, bmp) { imageCache.set(id, bmp); }

function drawImage(ctx, item) {
  const bmp = getImage(item.blob);
  if (bmp) { ctx.drawImage(bmp, item.x, item.y, item.w, item.h); return; }
  const failed = imageCache.get(item.blob) === 'error';
  ctx.fillStyle = failed ? 'rgba(229,72,77,0.08)' : 'rgba(120,130,150,0.12)';
  ctx.fillRect(item.x, item.y, item.w, item.h);
  ctx.strokeStyle = 'rgba(120,130,150,0.6)';
  ctx.lineWidth = 0.8;
  ctx.strokeRect(item.x, item.y, item.w, item.h);
  ctx.fillStyle = 'rgba(90,100,120,0.8)';
  ctx.font = `${Math.max(6, Math.min(14, item.h / 6))}px ${TEXT_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(failed ? '그림을 불러올 수 없음' : '그림 불러오는 중…', item.x + item.w / 2, item.y + item.h / 2);
  ctx.textAlign = 'start';
}

// ── 포스트잇 ──
export const NOTE_PAD = 8;
const NOTE_ICON = 30; // 접힌 포스트잇 아이콘 크기 (페이지 단위)

/** 접힌 포스트잇 아이콘 영역 (원래 위치의 왼쪽 위) */
export function noteIconRect(n) {
  return { x: n.x, y: n.y, w: Math.min(NOTE_ICON, n.w), h: Math.min(NOTE_ICON, n.h) };
}

/** 포스트잇 윗부분(어두운 띠) 높이: 펜·손가락으로 잡고 끌어 옮기는 손잡이 */
export function noteHeadH(n) { return Math.min(18, n.h * 0.18); }

/** 띠 오른쪽 버튼 한 칸 크기 */
function noteBtnW(n) { return Math.max(noteHeadH(n), Math.min(22, n.w * 0.2)); }

/** 펼친 포스트잇의 삭제(×) 버튼 영역 (어두운 띠의 오른쪽 끝) */
export function noteDeleteButton(n) {
  const s = noteBtnW(n);
  return { x: n.x + n.w - s, y: n.y, w: s, h: noteHeadH(n) };
}

/** 펼친 포스트잇의 접기(–) 버튼 영역 (삭제 버튼 바로 왼쪽) */
export function noteFoldButton(n) {
  const s = noteBtnW(n);
  return { x: n.x + n.w - s * 2, y: n.y, w: s, h: noteHeadH(n) };
}

/** 끌어 옮기는 손잡이 영역: 펼친 상태는 어두운 띠(버튼 제외), 접힌 상태는 아이콘 전체 */
export function noteHandle(n) {
  if (n.fold) return noteIconRect(n);
  return { x: n.x, y: n.y, w: n.w - noteBtnW(n) * 2, h: noteHeadH(n) };
}

const inRect = (b, r) => b.x >= r.x - 0.5 && b.y >= r.y - 0.5 && b.x + b.w <= r.x + r.w + 0.5 && b.y + b.h <= r.y + r.h + 0.5;

/** 포스트잇 위에 쓴 것: 포스트잇보다 나중에(위에) 그려졌고 포스트잇 안에 완전히 들어가는 필기·도형·글상자 */
export function noteAttached(items, note) {
  const out = [];
  const i0 = items.indexOf(note);
  if (i0 < 0) return out;
  const rect = { x: note.x, y: note.y, w: note.w, h: note.t === 'cl' ? checkHeight(note) : note.h };
  for (let j = i0 + 1; j < items.length; j++) {
    const it = items[j];
    if ((it.t === 's' || it.t === 'sh' || it.t === 'tx') && inRect(bbox(it), rect)) out.push(it.id);
  }
  return out;
}

/** 접힌 포스트잇과 함께 숨길 객체 id (위에 쓴 필기) */
export function foldHidden(items) {
  let hidden = null;
  for (const it of items) {
    if (it.t !== 'nt' || !it.fold) continue;
    if (!hidden) hidden = new Set();
    for (const id of noteAttached(items, it)) hidden.add(id);
  }
  return hidden;
}

/** 포스트잇 안의 글 줄바꿈 (폭에 맞춰 자동 줄바꿈 + 직접 줄바꿈) */
export function noteLines(item) {
  const e = entry(item);
  if (e.lines) return e.lines;
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = `${item.fs}px ${TEXT_FONT}`;
  const maxW = Math.max(item.w - NOTE_PAD * 2, item.fs);
  const out = [];
  for (const para of String(item.text || '').split('\n')) {
    let line = '';
    for (const ch of [...para]) {
      if (line && measureCtx.measureText(line + ch).width > maxW) {
        // 공백에서 끊을 수 있으면 단어 단위로
        const sp = line.lastIndexOf(' ');
        if (sp > 0 && ch !== ' ') { out.push(line.slice(0, sp)); line = line.slice(sp + 1) + ch; }
        else { out.push(line); line = ch === ' ' ? '' : ch; }
      } else line += ch;
    }
    out.push(line);
  }
  e.lines = out;
  return out;
}

/** 포스트잇 글이 시작하는 높이 (띠 아래) */
export function noteTextTop(n) { return noteHeadH(n) + 4; }

function drawNote(ctx, item) {
  if (item.fold) {
    // 접힌 상태: 작은 포스트잇 아이콘 (모서리 접힘 + 줄)
    const r = noteIconRect(item), f = r.w * 0.3;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.25)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1.5;
    ctx.fillStyle = item.c;
    ctx.beginPath();
    ctx.moveTo(r.x, r.y); ctx.lineTo(r.x + r.w, r.y); ctx.lineTo(r.x + r.w, r.y + r.h - f); ctx.lineTo(r.x + r.w - f, r.y + r.h); ctx.lineTo(r.x, r.y + r.h); ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.beginPath(); ctx.moveTo(r.x + r.w, r.y + r.h - f); ctx.lineTo(r.x + r.w - f, r.y + r.h - f); ctx.lineTo(r.x + r.w - f, r.y + r.h); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = Math.max(0.8, r.w * 0.05);
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let k = 0; k < 3; k++) { const y = r.y + r.h * (0.3 + k * 0.18); ctx.moveTo(r.x + r.w * 0.2, y); ctx.lineTo(r.x + r.w * (k === 2 ? 0.5 : 0.75), y); }
    ctx.stroke();
    return;
  }
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.22)';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = item.c;
  ctx.fillRect(item.x, item.y, item.w, item.h);
  ctx.restore();
  // 어두운 띠(손잡이) + 가운데 잡는 표시 + 접기(–)·삭제(×) 버튼
  const hh = noteHeadH(item);
  ctx.fillStyle = 'rgba(0,0,0,0.10)';
  ctx.fillRect(item.x, item.y, item.w, hh);
  ctx.fillStyle = 'rgba(0,0,0,0.30)';
  const gx = item.x + (item.w - noteBtnW(item) * 2) / 2, gy = item.y + hh / 2, gr = Math.max(0.6, hh * 0.07);
  for (const dx of [-hh * 0.4, 0, hh * 0.4]) { ctx.beginPath(); ctx.arc(gx + dx, gy, gr, 0, Math.PI * 2); ctx.fill(); }
  const fb = noteFoldButton(item);
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = Math.max(0.8, fb.w * 0.09);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(fb.x + fb.w * 0.3, fb.y + fb.h * 0.5); ctx.lineTo(fb.x + fb.w * 0.7, fb.y + fb.h * 0.5);
  const db = noteDeleteButton(item), cx = db.x + db.w / 2, cy = db.y + db.h / 2, xs = Math.min(db.w, db.h) * 0.2;
  ctx.moveTo(cx - xs, cy - xs); ctx.lineTo(cx + xs, cy + xs); ctx.moveTo(cx + xs, cy - xs); ctx.lineTo(cx - xs, cy + xs);
  ctx.stroke();
  if (!item.text) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(item.x, item.y, item.w, item.h);
  ctx.clip();
  ctx.fillStyle = '#2b2b2b';
  ctx.font = `${item.fs}px ${TEXT_FONT}`;
  ctx.textBaseline = 'top';
  const lines = noteLines(item);
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], item.x + NOTE_PAD, item.y + noteTextTop(item) + i * item.fs * TEXT_LINE);
  ctx.restore();
}

// ── 체크리스트 ──
const CL_ROW = 1.7; // 줄 높이 = 글자 크기 × 1.7
const CL_PAD = 4;
export function checkRowH(it) { return it.fs * CL_ROW; }
export function checkHeight(it) { return Math.max(1, it.rows.length) * checkRowH(it) + CL_PAD * 2; }
/** i 번째 줄 체크 상자 영역 */
export function checkBox(it, i) {
  const rh = checkRowH(it), s = it.fs * 0.95;
  return { x: it.x + CL_PAD, y: it.y + CL_PAD + i * rh + (rh - s) / 2, w: s, h: s };
}
/** 줄 번호 (영역 밖이면 -1) */
export function checkRowAt(it, x, y) {
  if (x < it.x || x > it.x + it.w) return -1;
  const i = Math.floor((y - it.y - CL_PAD) / checkRowH(it));
  return i >= 0 && i < it.rows.length ? i : -1;
}

function drawChecklist(ctx, it, opts) {
  const rh = checkRowH(it);
  if (!opts?.print) drawObjBar(ctx, it);
  ctx.save();
  ctx.beginPath();
  ctx.rect(it.x, it.y, it.w, checkHeight(it));
  ctx.clip();
  ctx.font = `${it.fs}px ${TEXT_FONT}`;
  ctx.textBaseline = 'middle';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  it.rows.forEach((r, i) => {
    const b = checkBox(it, i);
    ctx.lineWidth = Math.max(0.8, it.fs * 0.08);
    ctx.strokeStyle = r.done ? '#2e9d4f' : 'rgba(40,40,40,0.75)';
    ctx.fillStyle = r.done ? '#2e9d4f' : 'rgba(255,255,255,0.9)';
    roundRectPath(ctx, b.x, b.y, b.w, b.h, b.w * 0.2);
    ctx.fill();
    ctx.stroke();
    if (r.done) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(1, it.fs * 0.12);
      ctx.beginPath();
      ctx.moveTo(b.x + b.w * 0.22, b.y + b.h * 0.52); ctx.lineTo(b.x + b.w * 0.42, b.y + b.h * 0.72); ctx.lineTo(b.x + b.w * 0.78, b.y + b.h * 0.3);
      ctx.stroke();
    }
    const tx = b.x + b.w + it.fs * 0.5, ty = it.y + CL_PAD + i * rh + rh / 2;
    ctx.fillStyle = r.done ? 'rgba(60,60,60,0.5)' : it.c;
    ctx.fillText(r.text, tx, ty);
    if (r.done && r.text) {
      const tw = ctx.measureText(r.text).width;
      ctx.strokeStyle = 'rgba(60,60,60,0.55)';
      ctx.lineWidth = Math.max(0.6, it.fs * 0.06);
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(tx + tw, ty); ctx.stroke();
    }
  });
  ctx.restore();
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ── 표 ──
// 표·체크리스트 위쪽 바깥에 붙은 어두운 손잡이 띠: 잡고 끌면 이동, 오른쪽 끝 × 를 탭하면 삭제 (포스트잇 띠와 같은 방식)
export function objBarH(it) { return Math.max(12, Math.min(22, it.fs * 1.6)); }
export function objBar(it) { const h = objBarH(it); return { x: it.x, y: it.y - h, w: it.w, h }; }
/** 삭제(×) 버튼: 띠 오른쪽 끝 정사각형 */
export function objDeleteButton(it) { const b = objBar(it), s = Math.min(b.h * 1.3, it.w * 0.3); return { x: b.x + b.w - s, y: b.y, w: s, h: b.h }; }
/** 끌어 옮기는 손잡이: 띠에서 삭제 버튼을 뺀 부분 */
export function objHandle(it) { const b = objBar(it); return { ...b, w: b.w - objDeleteButton(it).w }; }
export function tableSize(it) { return { rows: it.cells.length, cols: it.cells[0]?.length || 0 }; }
export function cellRect(it, r, c) {
  const { rows, cols } = tableSize(it);
  const cw = it.w / cols, ch = it.h / rows;
  return { x: it.x + c * cw, y: it.y + r * ch, w: cw, h: ch };
}
export function cellAt(it, x, y) {
  const { rows, cols } = tableSize(it);
  if (x < it.x || y < it.y || x > it.x + it.w || y > it.y + it.h) return null;
  return { r: Math.min(rows - 1, Math.floor((y - it.y) / (it.h / rows))), c: Math.min(cols - 1, Math.floor((x - it.x) / (it.w / cols))) };
}

function drawObjBar(ctx, it) {
  const b = objBar(it), del = objDeleteButton(it), r = Math.min(b.h * 0.35, 6);
  ctx.save();
  ctx.fillStyle = 'rgba(55,65,85,0.88)';
  ctx.beginPath();
  ctx.moveTo(b.x, b.y + b.h); ctx.lineTo(b.x, b.y + r); ctx.arcTo(b.x, b.y, b.x + r, b.y, r);
  ctx.lineTo(b.x + b.w - r, b.y); ctx.arcTo(b.x + b.w, b.y, b.x + b.w, b.y + r, r); ctx.lineTo(b.x + b.w, b.y + b.h);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = Math.max(0.8, b.h * 0.09);
  ctx.lineCap = 'round';
  // 잡는 곳 표시 (가운데 줄 3개)
  const gx = b.x + (b.w - del.w) / 2, gw = Math.min(b.h * 1.2, (b.w - del.w) * 0.4);
  ctx.beginPath();
  for (const k of [-1, 0, 1]) { const y = b.y + b.h / 2 + k * b.h * 0.2; ctx.moveTo(gx - gw / 2, y); ctx.lineTo(gx + gw / 2, y); }
  ctx.stroke();
  // 삭제 ×
  const cx = del.x + del.w / 2, cy = del.y + del.h / 2, s = b.h * 0.22;
  ctx.beginPath(); ctx.moveTo(cx - s, cy - s); ctx.lineTo(cx + s, cy + s); ctx.moveTo(cx + s, cy - s); ctx.lineTo(cx - s, cy + s); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = Math.max(0.5, b.h * 0.05);
  ctx.beginPath(); ctx.moveTo(del.x, b.y + b.h * 0.2); ctx.lineTo(del.x, b.y + b.h * 0.8); ctx.stroke();
  ctx.restore();
}

function drawTable(ctx, it, opts) {
  const { rows, cols } = tableSize(it);
  if (!opts?.print) drawObjBar(ctx, it);
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillRect(it.x, it.y, it.w, it.h);
  ctx.fillStyle = 'rgba(52,120,246,0.10)'; // 첫 행 = 머리글
  ctx.fillRect(it.x, it.y, it.w, it.h / rows);
  ctx.strokeStyle = 'rgba(40,50,70,0.7)';
  ctx.lineWidth = Math.max(0.6, it.fs * 0.06);
  ctx.beginPath();
  for (let r = 0; r <= rows; r++) { const y = it.y + (it.h * r) / rows; ctx.moveTo(it.x, y); ctx.lineTo(it.x + it.w, y); }
  for (let c = 0; c <= cols; c++) { const x = it.x + (it.w * c) / cols; ctx.moveTo(x, it.y); ctx.lineTo(x, it.y + it.h); }
  ctx.stroke();
  ctx.fillStyle = '#1c1f24';
  ctx.textBaseline = 'top';
  const pad = it.fs * 0.35;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const text = it.cells[r][c];
    if (!text) continue;
    const b = cellRect(it, r, c);
    ctx.save();
    ctx.beginPath(); ctx.rect(b.x, b.y, b.w, b.h); ctx.clip();
    ctx.font = `${r === 0 ? 'bold ' : ''}${it.fs}px ${TEXT_FONT}`;
    const lines = wrapText(ctx, text, b.w - pad * 2);
    lines.forEach((l, k) => ctx.fillText(l, b.x + pad, b.y + pad + k * it.fs * TEXT_LINE));
    ctx.restore();
  }
  ctx.restore();
}

/** 폭에 맞춰 줄바꿈 (한글은 글자 단위, 공백이 있으면 단어 단위) */
function wrapText(ctx, text, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const ch of [...para]) {
      if (line && ctx.measureText(line + ch).width > maxW) {
        const sp = line.lastIndexOf(' ');
        if (sp > 0 && ch !== ' ') { out.push(line.slice(0, sp)); line = line.slice(sp + 1) + ch; } else { out.push(line); line = ch === ' ' ? '' : ch; }
      } else line += ch;
    }
    out.push(line);
  }
  return out;
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
  if (OBJECT_TYPES.has(item.t)) return true;
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
  if (OBJECT_TYPES.has(item.t)) {
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
  if (item.t === 'ln' || item.t === 'im') return { ...item, x: X(item.x), y: Y(item.y), w: item.w * s, h: item.h * s };
  if (item.t === 'nt' || item.t === 'tb') return { ...item, x: X(item.x), y: Y(item.y), w: item.w * s, h: item.h * s, fs: item.fs * s };
  if (item.t === 'cl') return { ...item, x: X(item.x), y: Y(item.y), w: item.w * s, fs: item.fs * s };
  return item;
}

const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
const fin = (v) => typeof v === 'number' && Number.isFinite(v);

/** 녹음 시각 표시 {rec, t} 검증 (녹음 재생 시 필기 따라가기용) */
function cleanRt(rt) {
  return rt && typeof rt.rec === 'string' && fin(rt.t) ? { rt: { rec: rt.rec, t: rt.t } } : {};
}

/** 저장소에서 읽은 객체 검증. 잘못된 객체는 null */
export function sanitizeItem(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.t !== 'string') return null;
  const id = typeof raw.id === 'string' ? raw.id : uid('x');
  const c = typeof raw.c === 'string' && COLOR_RE.test(raw.c) ? raw.c : '#111111';
  if (raw.t === 's') {
    if (!Array.isArray(raw.pts) || raw.pts.length < 3 || raw.pts.length % 3 !== 0) return null;
    if (!raw.pts.every(fin)) return null;
    if (!fin(raw.w) || raw.w <= 0) return null;
    return { id, t: 's', tool: raw.tool === 'hl' ? 'hl' : 'pen', c, w: raw.w, pr: !!raw.pr, pts: raw.pts, ...cleanRt(raw.rt) };
  }
  if (raw.t === 'sh') {
    if (!['line', 'arrow', 'rect', 'ellipse'].includes(raw.kind)) return null;
    if (![raw.x1, raw.y1, raw.x2, raw.y2, raw.w].every(fin)) return null;
    return { id, t: 'sh', kind: raw.kind, c, w: raw.w, x1: raw.x1, y1: raw.y1, x2: raw.x2, y2: raw.y2, ...cleanRt(raw.rt) };
  }
  if (raw.t === 'tx') {
    if (![raw.x, raw.y, raw.fs].every(fin) || typeof raw.text !== 'string') return null;
    return { id, t: 'tx', x: raw.x, y: raw.y, c, fs: raw.fs, text: raw.text, ...cleanRt(raw.rt) };
  }
  if (raw.t === 'im') {
    if (![raw.x, raw.y, raw.w, raw.h].every(fin) || raw.w <= 0 || raw.h <= 0 || typeof raw.blob !== 'string') return null;
    return { id, t: 'im', x: raw.x, y: raw.y, w: raw.w, h: raw.h, blob: raw.blob };
  }
  if (raw.t === 'nt') {
    if (![raw.x, raw.y, raw.w, raw.h, raw.fs].every(fin) || raw.w <= 0 || raw.h <= 0) return null;
    return { id, t: 'nt', x: raw.x, y: raw.y, w: raw.w, h: raw.h, c, fs: raw.fs, text: typeof raw.text === 'string' ? raw.text : '', ...(raw.fold ? { fold: true } : {}) };
  }
  if (raw.t === 'cl') {
    if (![raw.x, raw.y, raw.w, raw.fs].every(fin) || raw.w <= 0 || !Array.isArray(raw.rows)) return null;
    const rows = raw.rows.filter((r) => r && typeof r.text === 'string').map((r) => ({ text: r.text, done: !!r.done }));
    if (!rows.length) return null;
    return { id, t: 'cl', x: raw.x, y: raw.y, w: raw.w, fs: raw.fs, c, rows };
  }
  if (raw.t === 'tb') {
    if (![raw.x, raw.y, raw.w, raw.h, raw.fs].every(fin) || raw.w <= 0 || raw.h <= 0 || !Array.isArray(raw.cells) || !raw.cells.length) return null;
    const cols = Array.isArray(raw.cells[0]) ? raw.cells[0].length : 0;
    if (!cols || !raw.cells.every((r) => Array.isArray(r) && r.length === cols)) return null;
    return { id, t: 'tb', x: raw.x, y: raw.y, w: raw.w, h: raw.h, fs: raw.fs, cells: raw.cells.map((r) => r.map((v) => (typeof v === 'string' ? v : ''))) };
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
