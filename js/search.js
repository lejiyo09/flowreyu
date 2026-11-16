// 문서 안 글자 검색 (Ctrl+F)
//
// PDF 글자는 캔버스에 그림으로 그려지므로 브라우저 찾기로는 못 찾는다. pdf.js 의 글자 정보(getTextContent)로
// 페이지마다 글자 목록을 만들고, 직접 쓴 글(글상자·포스트잇·체크리스트·표)도 함께 찾는다.
// - 공백·대소문자는 무시하고 비교한다 (PDF 는 글자 사이에 공백을 넣거나 한 단어를 여러 조각으로 나누는 일이 많다)
// - 결과는 페이지 좌표(PDF 1배율) 사각형 → 화면 강조·이동에 그대로 쓴다
// - 글자 정보 없는 PDF(스캔본)는 PDF 글자를 찾을 수 없다 (손글씨·그림 속 글자도 대상 아님)

const norm = (s) => s.normalize('NFC').toLowerCase();
const isSpace = (ch) => /\s/.test(ch);

/** 검색어 → 비교용 글자 배열 (공백 제거) */
export function prepQuery(q) {
  return [...norm(q)].filter((ch) => !isSpace(ch)).join('');
}

let mctx = null;
/** 조각 안에서 앞 n 글자가 차지하는 폭의 비율 (글꼴로 실제 폭을 재고 조각 폭에 맞춤. 글자마다 폭이 달라 같은 비율로 자르면 어긋남) */
function prefixRatio(b, n) {
  if (n <= 0) return 0;
  if (n >= b.chars.length) return 1;
  if (!mctx) mctx = document.createElement('canvas').getContext('2d');
  mctx.font = `100px ${b.font}`;
  const full = mctx.measureText(b.chars.join('')).width;
  return full > 0 ? mctx.measureText(b.chars.slice(0, n).join('')).width / full : n / b.chars.length;
}

/**
 * pdf.js 글자 조각들 → 페이지 글자 색인 {text, at:[{item, ofs}], items:[{x,y,w,h,chars,font}]}
 * vt: 그 페이지 뷰포트 변환(scale 1). 조각 사각형은 페이지 좌표. styles: getTextContent 의 글꼴 정보
 */
export function buildPdfIndex(textItems, vt, styles = {}) {
  const T = (x, y) => [vt[0] * x + vt[2] * y + vt[4], vt[1] * x + vt[3] * y + vt[5]];
  let text = '';
  const at = [], items = [];
  for (const it of textItems) {
    if (typeof it.str !== 'string' || !it.str) continue;
    const [a, b, c, d, e, f] = it.transform;
    const fh = Math.hypot(c, d) || Math.hypot(a, b) || 10; // 글자 높이
    // 글자 기준선 왼쪽 → 화면 좌표, 오른쪽(폭만큼) → 화면 좌표로 사각형
    const ux = a / (Math.hypot(a, b) || 1), uy = b / (Math.hypot(a, b) || 1);
    const p0 = T(e, f), p1 = T(e + ux * it.width, f + uy * it.width), pt = T(e - uy * fh, f + ux * fh);
    const xs = [p0[0], p1[0], pt[0]], ys = [p0[1], p1[1], pt[1]];
    const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    const chars = [...it.str.normalize('NFC')]; // 폭 재기용 원래 글자 (소문자로 바꾸면 폭이 달라짐)
    const fam = styles[it.fontName]?.fontFamily || 'sans-serif';
    const k = items.length;
    const vertical = Math.abs(p1[1] - p0[1]) > Math.abs(p1[0] - p0[0]);
    const rev = vertical ? p1[1] < p0[1] : p1[0] < p0[0]; // 180°·270° 돌린 페이지: 글자가 화면에서 거꾸로 진행
    items.push({ ...box, chars, font: /^[\w\s-]+$/.test(fam) ? fam : 'sans-serif', vertical, rev });
    chars.forEach((ch, ofs) => {
      if (isSpace(ch)) return;
      for (const c of ch.toLowerCase()) { text += c; at.push({ item: k, ofs }); } // 비교용은 소문자 (글자 위치는 원래 글자 기준)
    });
  }
  return { text, at, items };
}

/** 색인에서 검색어 위치들 → [{rects:[{x,y,w,h}]}] (조각을 넘어가면 사각형 여러 개) */
export function findInIndex(idx, q) {
  const out = [];
  if (!q || !idx.text) return out;
  let from = 0;
  for (;;) {
    const i = idx.text.indexOf(q, from);
    if (i < 0) break;
    const parts = new Map(); // item → [첫 글자, 끝 글자]
    for (let k = i; k < i + q.length; k++) {
      const { item, ofs } = idx.at[k];
      const p = parts.get(item);
      if (p) p[1] = ofs; else parts.set(item, [ofs, ofs]);
    }
    const rects = [];
    for (const [item, [s, e]] of parts) {
      const b = idx.items[item];
      let r0 = prefixRatio(b, s), r1 = prefixRatio(b, e + 1);
      if (b.rev) [r0, r1] = [1 - r1, 1 - r0];
      if (b.vertical) rects.push({ x: b.x, y: b.y + b.h * r0, w: b.w, h: b.h * (r1 - r0) });
      else rects.push({ x: b.x + b.w * r0, y: b.y, w: b.w * (r1 - r0), h: b.h });
    }
    out.push({ rects });
    from = i + q.length;
  }
  return out;
}

/** 직접 쓴 글(글상자·포스트잇·체크리스트·표)에서 찾기 → [{rects:[객체 상자], id}] */
export function findInItems(items, q, bboxOf) {
  const out = [];
  if (!q) return out;
  for (const it of items) {
    let texts = [];
    if (it.t === 'tx' || it.t === 'nt') texts = [it.text || ''];
    else if (it.t === 'cl') texts = it.rows.map((r) => r.text);
    else if (it.t === 'tb') texts = it.cells.flat();
    else continue;
    const hay = prepQuery(texts.join('\n'));
    let from = 0, n = 0;
    while ((from = hay.indexOf(q, from)) >= 0) { n++; from += q.length; }
    const b = bboxOf(it);
    for (let k = 0; k < n; k++) out.push({ rects: [b], id: it.id });
  }
  return out;
}
