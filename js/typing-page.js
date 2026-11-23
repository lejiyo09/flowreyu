// 타이핑형 노트 쪽 설정 (용지·여백·글꼴). 편집기 묶음(vendor/tiptap)을 읽지 않고도 새 노트 창 등에서 쓰도록 따로 둔다
const MM = 72 / 25.4;
export const PAPER = { A4: [210, 297], A5: [148, 210], B5: [176, 250], Letter: [215.9, 279.4] };
export const MARGINS = { normal: { t: 20, b: 15, l: 30, r: 30 }, narrow: { t: 12.7, b: 12.7, l: 12.7, r: 12.7 }, wide: { t: 25.4, b: 25.4, l: 31.7, r: 31.7 } };
export const FONTS = [
  ['Malgun Gothic, 맑은 고딕, Apple SD Gothic Neo, sans-serif', '맑은 고딕'],
  ['NanumGothic, 나눔고딕, sans-serif', '나눔고딕'],
  ['Batang, 바탕, Nanum Myeongjo, serif', '바탕'],
  ['Dotum, 돋움, sans-serif', '돋움'],
  ['Gulim, 굴림, sans-serif', '굴림'],
  ['Arial, Helvetica, sans-serif', 'Arial'],
  ['Times New Roman, Times, serif', 'Times New Roman'],
  ['Consolas, Menlo, monospace', '고정폭'],
];
export const DEFAULT_PAGE = { size: 'A4', orient: 'portrait', margin: { ...MARGINS.normal }, header: '', footer: '', pageNum: 'center', font: FONTS[0][0], fontSize: 10.5, lineHeight: 1.6 };
export const GAP = 14; // 쪽 사이 (viewer 의 PAGE_GAP 과 같게)

/** 쪽 설정 → pt 크기·여백 */
export function pageGeom(page) {
  const p = { ...DEFAULT_PAGE, ...page, margin: { ...DEFAULT_PAGE.margin, ...(page?.margin || {}) } };
  // size 'custom': 가져온 문서의 용지 (width·height mm)
  let [w, h] = p.size === 'custom' && p.width > 20 && p.height > 20 ? [p.width, p.height] : PAPER[p.size] || PAPER.A4;
  if (p.size === 'custom' && w > h && p.orient !== 'landscape') [w, h] = [h, w];
  if (p.orient === 'landscape') [w, h] = [h, w];
  const m = p.margin;
  const W = w * MM, H = h * MM, mt = m.t * MM, mb = m.b * MM, ml = m.l * MM, mr = m.r * MM;
  return { W, H, mt, mb, ml, mr, contentW: W - ml - mr, contentH: H - mt - mb, stride: H + GAP, page: p };
}

