// 크롬북 갤러리(ChromeOS 미디어 앱) 필기와 서로 편집하기
//
// 갤러리는 필기를 PDF 주석이 아니라 페이지 내용에 직접 그려 넣는다. 다만 그 부분을
//   /GOOG:INKIsInker BMC  …  EMC
// 표시(marked content)로 감싸 두고, 획 하나를 "획 테두리를 따라 그린 채운 다각형" 하나로 저장한다
//   q r g b rg … /FXE2 gs  x y m  x y l … h f Q      (형광펜은 ExtGState /ca 0.4)
//
// 가져오기: 그 표시 안의 다각형을 읽어 'fp'(채운 도형 필기) 객체로 바꾸고, 앱에 저장하는 PDF 사본에서는 그 부분을 지운다.
// 내보내기: 우리 필기를 같은 모양(같은 표시 + 테두리 다각형)으로 써 넣어 갤러리가 자기 필기처럼 다룰 수 있게 한다.
import {
  PDFDocument, PDFName, PDFArray, decodePDFRawStream,
} from '../vendor/pdf-lib/pdf-lib.esm.min.js';
import { uid } from './util.js';
import { strokeRadii, shapePolylines } from './ink.js';

export const GALLERY_MARK = 'GOOG:INKIsInker';

// ───────────── 내용 스트림 읽기 ─────────────

const WS = /[\0\t\n\f\r ]/;
const DELIM = /[()<>[\]{}/%]/;

/** 내용 스트림 토큰화 (문자열·16진·배열·사전·인라인 그림을 건너뛸 수 있을 만큼만) */
function* tokens(s) {
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (WS.test(ch)) { i++; continue; }
    if (ch === '%') { while (i < n && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
    const start = i;
    if (ch === '(') { // 괄호 문자열 (중첩·이스케이프)
      let depth = 0;
      for (; i < n; i++) {
        if (s[i] === '\\') { i++; continue; }
        if (s[i] === '(') depth++;
        else if (s[i] === ')' && --depth === 0) { i++; break; }
      }
      yield { t: 'str', start, end: i };
      continue;
    }
    if (ch === '<' && s[i + 1] === '<') { i += 2; yield { t: '<<', start, end: i }; continue; }
    if (ch === '>' && s[i + 1] === '>') { i += 2; yield { t: '>>', start, end: i }; continue; }
    if (ch === '<') { const e = s.indexOf('>', i); i = e < 0 ? n : e + 1; yield { t: 'str', start, end: i }; continue; }
    if (ch === '[' || ch === ']' || ch === '{' || ch === '}') { i++; yield { t: ch, start, end: i }; continue; }
    if (ch === '/') {
      i++;
      while (i < n && !WS.test(s[i]) && !DELIM.test(s[i])) i++;
      yield { t: 'name', v: s.slice(start + 1, i), start, end: i };
      continue;
    }
    while (i < n && !WS.test(s[i]) && !DELIM.test(s[i])) i++;
    if (i === start) { i++; continue; } // 짝 없는 ) > 등
    const w = s.slice(start, i);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) { yield { t: 'num', v: +w, start, end: i }; continue; }
    if (w === 'BI') { // 인라인 그림: ID 다음 바이너리를 EI 까지 건너뜀
      const id = s.indexOf('ID', i);
      let e = id < 0 ? n : id + 3;
      while (e < n) { const k = s.indexOf('EI', e); if (k < 0) { e = n; break; } if ((k + 2 >= n || WS.test(s[k + 2])) && WS.test(s[k - 1])) { e = k + 2; break; } e = k + 2; }
      i = e;
      yield { t: 'op', v: 'BI', start, end: i };
      continue;
    }
    yield { t: 'op', v: w, start, end: i };
  }
}

const mul = (a, b) => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const hex2 = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
const r2 = (v) => Math.round(v * 100) / 100;

/**
 * 한 페이지의 내용 스트림들을 차례로 해석해서 갤러리 표시 안의 채운 도형을 모은다.
 * @returns {{polys: {pts:number[], c:string, op:number}[], cuts: Map<number, [number, number][]>}} cuts: 스트림 번호 → 지울 구간
 */
function scanPage(texts, alphaOf) {
  const polys = [];
  const cuts = new Map();
  let st = { ctm: [1, 0, 0, 1, 0, 0], fill: [0, 0, 0], alpha: 1 };
  const stack = [];
  texts.forEach((s, si) => {
    if (!s.includes(GALLERY_MARK)) {
      // 표시가 없는 스트림은 그래픽 상태(q/Q/cm)만 따라간다 (표시 앞의 좌표계 변환 반영)
      for (const tk of tokensFast(s)) {
        if (tk === 'q') stack.push(st);
        else if (tk === 'Q') st = stack.pop() || st;
        else if (Array.isArray(tk)) st = { ...st, ctm: mul(tk, st.ctm) };
      }
      return;
    }
    const nums = [];
    let lastName = null, depth = 0, markStart = -1, inMark = false;
    let path = [], cur = null, curP = [0, 0];
    const flush = (fill) => {
      if (cur && cur.length >= 6) path.push(cur);
      cur = null;
      if (fill && inMark) for (const p of path) if (p.length >= 6) polys.push({ pts: p, c: '#' + st.fill.map(hex2).join(''), op: st.alpha });
      path = [];
    };
    for (const tk of tokens(s)) {
      if (tk.t === 'num') { nums.push(tk.v); continue; }
      if (tk.t === 'name') { lastName = tk.v; continue; }
      if (tk.t !== 'op') continue;
      const a = nums.splice(0);
      switch (tk.v) {
        case 'q': stack.push(st); break;
        case 'Q': st = stack.pop() || st; break;
        case 'cm': if (a.length === 6) st = { ...st, ctm: mul(a, st.ctm) }; break;
        case 'rg': if (a.length === 3) st = { ...st, fill: a }; break;
        case 'g': if (a.length === 1) st = { ...st, fill: [a[0], a[0], a[0]] }; break;
        case 'k': if (a.length === 4) st = { ...st, fill: [0, 1, 2].map((j) => (1 - a[j]) * (1 - a[3])) }; break;
        case 'sc': case 'scn': if (a.length === 3) st = { ...st, fill: a }; else if (a.length === 1) st = { ...st, fill: [a[0], a[0], a[0]] }; break;
        case 'gs': { const ca = alphaOf(lastName); if (ca != null) st = { ...st, alpha: ca }; break; }
        case 'BMC': case 'BDC':
          if (inMark) depth++;
          else if (lastName === GALLERY_MARK) { inMark = true; depth = 0; markStart = s.lastIndexOf('/' + GALLERY_MARK, tk.start); }
          break;
        case 'EMC':
          if (inMark) {
            if (depth > 0) depth--;
            else { inMark = false; if (!cuts.has(si)) cuts.set(si, []); cuts.get(si).push([markStart, tk.end]); }
          }
          break;
        case 'm': if (a.length === 2) { if (cur && cur.length >= 6) path.push(cur); curP = [a[0], a[1]]; cur = [...apply(st.ctm, a[0], a[1])]; } break;
        case 'l': if (a.length === 2 && cur) { curP = [a[0], a[1]]; cur.push(...apply(st.ctm, a[0], a[1])); } break;
        case 'c': case 'v': case 'y': if (cur) {
          // 베지어 곡선은 6개 선분으로 근사
          const p0 = curP;
          const [p1, p2, p3] = tk.v === 'c' ? [[a[0], a[1]], [a[2], a[3]], [a[4], a[5]]]
            : tk.v === 'v' ? [p0, [a[0], a[1]], [a[2], a[3]]] : [[a[0], a[1]], [a[2], a[3]], [a[2], a[3]]];
          for (let k = 1; k <= 6; k++) {
            const t = k / 6, u = 1 - t;
            const x = u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0];
            const y = u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1];
            cur.push(...apply(st.ctm, x, y));
          }
          curP = p3;
        } break;
        case 're': if (a.length === 4) {
          if (cur && cur.length >= 6) path.push(cur);
          const [x, y, w, h] = a;
          cur = [...apply(st.ctm, x, y), ...apply(st.ctm, x + w, y), ...apply(st.ctm, x + w, y + h), ...apply(st.ctm, x, y + h)];
        } break;
        case 'h': break;
        case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'b': case 'b*': flush(true); break;
        case 'S': case 's': case 'n': flush(false); break;
        default: break;
      }
    }
  });
  return { polys, cuts };
}

/** 표시 없는 스트림용 빠른 q/Q/cm 추적 (문자열 안의 글자에 속지 않도록 tokens 사용) */
function* tokensFast(s) {
  const nums = [];
  for (const tk of tokens(s)) {
    if (tk.t === 'num') { nums.push(tk.v); continue; }
    if (tk.t !== 'op') { nums.length = 0; continue; }
    if (tk.v === 'q' || tk.v === 'Q') yield tk.v;
    else if (tk.v === 'cm' && nums.length >= 6) yield nums.slice(-6);
    nums.length = 0;
  }
}

const latin1 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return s; };
const fromLatin1 = (s) => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; };

/**
 * 갤러리 필기가 있을 수도 있는지 빠르게 확인 (문서마다 처음 열 때 한 번).
 * PDFium(갤러리)이 만드는 ExtGState 이름 /FXE… 이나 압축 안 된 표시가 보이면 후보.
 * 객체를 압축 묶음(/ObjStm)에 넣은 PDF 는 이름이 안 보이므로 30MB 이하면 직접 확인한다.
 */
export function mightHaveGalleryInk(bytes) {
  const s = latin1(new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 64 * 1024 * 1024)));
  return s.includes('/FXE') || s.includes(GALLERY_MARK) || (bytes.byteLength < 30 * 1024 * 1024 && s.includes('/ObjStm'));
}

/**
 * PDF 에서 갤러리 필기를 찾아 우리 필기 객체로 바꾼다.
 * @param bytes ArrayBuffer (건드리지 않음)
 * @param pageTransforms (pageIndex) => Promise<number[]>  pdf.js viewport(scale 1).transform (PDF → 페이지 좌표)
 * @returns null 이면 없음. {count, pages: Map(page → items[]), cleaned: Uint8Array(필기를 지운 PDF)}
 */
export async function extractGalleryInk(bytes, pageTransforms) {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const out = new Map();
  let count = 0;
  const pages = pdf.getPages();
  for (let pi = 0; pi < pages.length; pi++) {
    const node = pages[pi].node;
    const c = node.get(PDFName.of('Contents'));
    if (!c) continue;
    const resolved = pdf.context.lookup(c);
    const refs = resolved instanceof PDFArray ? resolved.asArray() : [c];
    const streams = refs.map((r) => pdf.context.lookup(r));
    const texts = streams.map((s) => { try { return latin1(decodePDFRawStream(s).decode()); } catch { return ''; } });
    if (!texts.some((t) => t.includes(GALLERY_MARK))) continue;
    const gsDict = node.Resources()?.lookup(PDFName.of('ExtGState'));
    const alphaOf = (name) => {
      if (!name || !gsDict) return null;
      const g = gsDict.lookup?.(PDFName.of(name));
      const ca = g?.get?.(PDFName.of('ca'));
      return ca ? Number(ca.asNumber ? ca.asNumber() : ca.toString()) : null;
    };
    const { polys, cuts } = scanPage(texts, alphaOf);
    if (!polys.length) continue;
    const vt = await pageTransforms(pi);
    const items = polys.map((p) => {
      const pts = [];
      for (let i = 0; i < p.pts.length; i += 2) { const [x, y] = apply(vt, p.pts[i], p.pts[i + 1]); pts.push(r2(x), r2(y)); }
      return { id: uid('fp'), t: 'fp', c: p.c, ...(p.op < 0.999 ? { op: Math.round(p.op * 1000) / 1000 } : {}), pts };
    });
    out.set(pi, items);
    count += items.length;
    // 앱이 보관할 PDF 에서는 그 부분을 지워 같은 필기가 두 번 보이지 않게 한다
    for (const [si, ranges] of cuts) {
      let t = texts[si];
      for (const [a, b] of [...ranges].sort((x, y) => y[0] - x[0])) t = t.slice(0, a) + t.slice(b);
      pdf.context.assign(refs[si], pdf.context.flateStream(fromLatin1(t)));
    }
  }
  if (!count) return null;
  const cleaned = await pdf.save({ useObjectStreams: false });
  return { count, pages: out, cleaned };
}

// ───────────── 내보내기: 갤러리 모양으로 쓰기 ─────────────

/** 굵기가 점마다 다른 폴리라인 → 테두리 다각형 (둥근 끝). pts: [x,y,…], r: 점마다 반지름 */
export function outlinePolygon(pts, r) {
  // 거의 같은 자리의 점은 합친다 (방향 계산이 흔들리지 않도록)
  const P = [], R = [];
  for (let i = 0; i < pts.length; i += 2) {
    const k = P.length;
    if (k && Math.hypot(pts[i] - P[k - 1][0], pts[i + 1] - P[k - 1][1]) < 0.05) { R[k - 1] = Math.max(R[k - 1], r[i / 2]); continue; }
    P.push([pts[i], pts[i + 1]]); R.push(r[i / 2]);
  }
  const n = P.length;
  const out = [];
  const arc = (cx, cy, rad, a0, a1, steps) => { for (let k = 0; k <= steps; k++) { const a = a0 + (a1 - a0) * (k / steps); out.push(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad); } };
  if (n === 1) { arc(P[0][0], P[0][1], R[0], 0, Math.PI * 2, 16); return out; }
  const nor = P.map((_, i) => {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
    return [-dy / L, dx / L];
  });
  for (let i = 0; i < n; i++) out.push(P[i][0] + nor[i][0] * R[i], P[i][1] + nor[i][1] * R[i]);
  const ae = Math.atan2(nor[n - 1][1], nor[n - 1][0]);
  arc(P[n - 1][0], P[n - 1][1], R[n - 1], ae, ae - Math.PI, 8); // 끝 둥글게 (진행 방향 쪽으로 돈다)
  for (let i = n - 1; i >= 0; i--) out.push(P[i][0] - nor[i][0] * R[i], P[i][1] - nor[i][1] * R[i]);
  const as = Math.atan2(-nor[0][1], -nor[0][0]);
  arc(P[0][0], P[0][1], R[0], as, as - Math.PI, 8); // 시작 둥글게
  return out;
}

/** 우리 필기 객체 → 다각형 목록 [{pts, c, op}] (페이지 좌표). 필기가 아닌 객체는 [] */
export function itemPolygons(it) {
  if (it.t === 'fp') return [{ pts: it.pts, c: it.c, op: it.op ?? 1 }];
  if (it.t === 's') {
    const xy = [];
    for (let i = 0; i < it.pts.length; i += 3) xy.push(it.pts[i], it.pts[i + 1]);
    return [{ pts: outlinePolygon(xy, strokeRadii(it)), c: it.c, op: it.tool === 'hl' ? 0.4 : 1 }];
  }
  if (it.t === 'sh') return shapePolylines(it).map((pl) => ({ pts: outlinePolygon(pl, new Array(pl.length / 2).fill(it.w / 2)), c: it.c, op: 1 }));
  return [];
}

const f5 = (v) => (Math.round(v * 1e5) / 1e5).toString();

/**
 * 갤러리 모양의 내용 스트림 글 만들기.
 * @param polys [{pts, c, op}] 페이지 좌표
 * @param inv 페이지 좌표 → PDF 사용자 좌표 행렬
 * @param gsName (alpha) => ExtGState 이름 (alpha 1 이면 기본)
 */
export function galleryContent(polys, inv, gsName) {
  const hexRgb = (h) => { const n = parseInt(h.slice(1, 7), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => f5(v / 255)).join(' '); };
  let s = `q\n0 0 0 RG 0 0 0 rg 1 w 0 J 0 j\n/${gsName(1)} gs /${GALLERY_MARK} BMC\n`;
  for (const p of polys) {
    const col = hexRgb(p.c);
    s += `q ${col} rg 0 0 0 RG ${p.op < 0.999 ? `/${gsName(p.op)} gs ` : ''}`;
    for (let i = 0; i < p.pts.length; i += 2) {
      const [x, y] = apply(inv, p.pts[i], p.pts[i + 1]);
      s += `${f5(x)} ${f5(y)} ${i ? 'l' : 'm'} `;
    }
    s += 'h f Q\n';
  }
  return s + 'EMC\nQ\n';
}
