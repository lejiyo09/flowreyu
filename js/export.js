// 필기를 포함한 PDF 내보내기, 빈 노트 생성 (pdf-lib)
import {
  PDFDocument, PDFName, PDFString, rgb, pushGraphicsState, popGraphicsState, concatTransformationMatrix,
  moveTo, lineTo, stroke, setLineWidth, setLineCap, setLineJoin, LineCapStyle, LineJoinStyle,
  setStrokingRgbColor, setGraphicsState, drawObject, setFillingRgbColor, closePath, fill,
} from '../vendor/pdf-lib/pdf-lib.esm.min.js';
import { itemPolygons, galleryContent } from './gallery.js';
import { strokeRuns, shapePolylines, textLayout, drawItem, bbox, foldHidden, checkHeight, layerSorted } from './ink.js';

function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

function invert(m) {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** 폴리라인을 PDF 선 그리기 연산자로 (둥근 끝·이음: 화면과 같은 모양) */
function polylineOps(pts, width) {
  const ops = [setLineWidth(width), moveTo(pts[0], pts[1])];
  if (pts.length === 2) ops.push(lineTo(pts[0], pts[1])); // 점: 길이 0 선 + 둥근 끝 = 원
  for (let i = 2; i < pts.length; i += 2) ops.push(lineTo(pts[i], pts[i + 1]));
  ops.push(stroke());
  return ops;
}

/**
 * @param pdfBytes ArrayBuffer 원본 PDF
 * @param pageTransforms Array<number[]> 페이지별 pdf.js viewport(scale 1).transform
 * @param getItems (pageIndex) => items[]
 * @param opts.gallery true 면 필기(펜·형광펜·도형·채운 도형)를 크롬북 갤러리와 같은 모양으로 써서 갤러리에서도 지우고 고칠 수 있게 한다
 */
export async function exportAnnotatedPdf(pdfBytes, pageTransforms, getItems, onProgress, { getBlob, gallery = false } = {}) {
  const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });
  const pages = pdf.getPages();
  const gs = (page, key, dict) => {
    const name = page.node.newExtGState(key === 'g' ? 'FXE' : 'GS', pdf.context.obj(dict)); // 갤러리 모양은 이름도 갤러리(PDFium)처럼
    return name;
  };
  for (let i = 0; i < pages.length; i++) {
    const items = layerSorted(getItems(i)); // 레이어 순서대로 (숨긴 레이어는 아래 foldHidden 에서 빠짐)
    if (!items.length) continue;
    const vt = pageTransforms[i];
    if (!vt) continue;
    const page = pages[i];
    const inv = invert(vt); // 페이지(뷰포트) 좌표 → PDF 사용자 좌표
    const ops = [pushGraphicsState(), concatTransformationMatrix(...inv)];
    const gsNormal = gs(page, 'n', { Type: 'ExtGState', ca: 1, CA: 1, BM: 'Normal' });
    const gsMul = gs(page, 'm', { Type: 'ExtGState', ca: 1, CA: 1, BM: 'Multiply' });
    // 형광펜을 먼저 (화면과 같은 순서: 형광펜 레이어가 아래)
    const folded = foldHidden(items); // 접힌 포스트잇 위 필기는 화면처럼 숨김
    const shown = folded ? items.filter((it) => !folded.has(it.id)) : items;
    const ordered = [...shown.filter((it) => it.t === 's' && it.tool === 'hl'), ...shown.filter((it) => !(it.t === 's' && it.tool === 'hl'))];
    const galleryPolys = [];
    const alphaGs = new Map();
    for (const it of ordered) {
      if (gallery && (it.t === 's' || it.t === 'sh' || it.t === 'fp')) { galleryPolys.push(...itemPolygons(it)); continue; }
      if (it.t === 'fp') {
        // 채운 도형 필기 (갤러리에서 가져온 획)
        const op = it.op ?? 1;
        if (!alphaGs.has(op)) alphaGs.set(op, gs(page, 'a', { Type: 'ExtGState', ca: op, CA: op, BM: 'Normal' }));
        const [r, g, b] = hexToRgb(it.c);
        ops.push(pushGraphicsState(), setGraphicsState(alphaGs.get(op)), setFillingRgbColor(r, g, b), moveTo(it.pts[0], it.pts[1]));
        for (let k = 2; k < it.pts.length; k += 2) ops.push(lineTo(it.pts[k], it.pts[k + 1]));
        ops.push(closePath(), fill(), popGraphicsState());
        continue;
      }
      if (it.t === 'ln') { addLinkAnnot(pdf, pages, page, inv, it); continue; }
      if (it.t === 'tx' || it.t === 'nt' || it.t === 'im' || it.t === 'cl' || it.t === 'tb') {
        // 글상자·포스트잇은 그림으로 렌더링(한글 글꼴 문제 없음), 첨부 그림은 원본 그대로
        const placed = it.t === 'im' ? await embedAttachedImage(pdf, it, getBlob) : await renderItemImage(pdf, it);
        if (!placed) continue;
        const { img, box } = placed;
        const xo = page.node.newXObject('Im', img.ref);
        // 이미지 단위 정사각형 → 뷰포트 좌표 (x, y + h)에서 위로 뒤집기
        ops.push(pushGraphicsState(), setGraphicsState(gsNormal), concatTransformationMatrix(box.w, 0, 0, -box.h, box.x, box.y + box.h), drawObject(xo), popGraphicsState());
        continue;
      }
      const [r, g, b] = hexToRgb(it.c);
      ops.push(setGraphicsState(it.tool === 'hl' ? gsMul : gsNormal), setStrokingRgbColor(r, g, b),
        setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round));
      if (it.t === 's') for (const run of strokeRuns(it)) ops.push(...polylineOps(run.pts, run.w));
      else if (it.t === 'sh') for (const pl of shapePolylines(it)) ops.push(...polylineOps(pl, it.w));
    }
    ops.push(popGraphicsState());
    page.pushOperators(...ops); // (원본 내용은 pdf-lib 가 q/Q 로 감싸 둔다)
    if (galleryPolys.length) {
      // 갤러리 모양: /GOOG:INKIsInker 표시 안에 획마다 테두리 다각형 (좌표는 PDF 사용자 좌표로 직접)
      const names = new Map();
      const gsName = (a) => {
        if (!names.has(a)) names.set(a, gs(page, 'g', a >= 0.999 ? { BM: 'Normal', CA: 1, ca: 1 } : { ca: a }).toString().slice(1));
        return names.get(a);
      };
      const text = galleryContent(galleryPolys, inv, gsName);
      page.node.addContentStream(pdf.context.register(pdf.context.flateStream(text)));
    }
    onProgress?.(i + 1, pages.length);
    if (i % 5 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  // 갤러리 호환은 객체를 압축 묶음(object stream)에 넣지 않는다 (갤러리 저장본과 같은 구조, 다시 열 때 빠르게 알아봄)
  return pdf.save({ useObjectStreams: !gallery });
}

/** 사용자 링크 → PDF 링크 주석 (다른 PDF 뷰어에서도 눌러서 이동) */
function addLinkAnnot(pdf, pages, page, inv, it) {
  const pt = (x, y) => [inv[0] * x + inv[2] * y + inv[4], inv[1] * x + inv[3] * y + inv[5]];
  const cs = [pt(it.x, it.y), pt(it.x + it.w, it.y), pt(it.x, it.y + it.h), pt(it.x + it.w, it.y + it.h)];
  const xs = cs.map((c) => c[0]), ys = cs.map((c) => c[1]);
  const dict = { Type: 'Annot', Subtype: 'Link', Rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], Border: [0, 0, 0] };
  if (it.to?.url) dict.A = { Type: 'Action', S: 'URI', URI: PDFString.of(it.to.url) };
  else if (Number.isInteger(it.to?.page) && pages[it.to.page]) dict.Dest = [pages[it.to.page].ref, PDFName.of('Fit')];
  else return;
  page.node.addAnnot(pdf.context.register(pdf.context.obj(dict)));
}

/** 글상자/포스트잇을 고해상도 PNG 로 그려 넣는다 (포스트잇 그림자 여백 포함) */
async function renderItemImage(pdf, it) {
  const b = it.t === 'tx' ? (() => { const L = textLayout(it); return { x: it.x, y: it.y, w: L.w, h: L.h }; })() : it.t === 'tb' ? { x: it.x, y: it.y, w: it.w, h: it.h } : it.t === 'cl' ? { x: it.x, y: it.y, w: it.w, h: checkHeight(it) } : bbox(it); // 화면 전용 손잡이 띠 제외
  const m = it.t === 'nt' ? 8 : 0;
  const box = { x: b.x - m, y: b.y - m, w: b.w + m * 2, h: b.h + m * 2 };
  const scale = 4;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(box.w * scale));
  c.height = Math.max(1, Math.ceil(box.h * scale));
  const ctx = c.getContext('2d');
  ctx.scale(scale, scale);
  ctx.translate(-box.x, -box.y);
  drawItem(ctx, it, { print: true });
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  if (!blob) return null;
  return { img: await pdf.embedPng(await blob.arrayBuffer()), box };
}

/** 첨부 그림 원본(PNG/JPEG)을 그대로 넣는다 */
async function embedAttachedImage(pdf, it, getBlob) {
  const rec = getBlob ? await getBlob(it.blob).catch(() => null) : null;
  if (!rec) return null;
  const bytes = await rec.data.arrayBuffer();
  const img = rec.data.type === 'image/jpeg' ? await pdf.embedJpg(bytes) : await pdf.embedPng(bytes);
  return { img, box: { x: it.x, y: it.y, w: it.w, h: it.h } };
}

/** 속지 그리기 (pdf-lib 페이지에). template: blank | lined | grid | dot */
function drawTemplate(page, template) {
  const { width: W, height: H } = page.getSize();
  const line = rgb(0.72, 0.8, 0.9);
  if (template === 'lined') {
    for (let y = H - 72; y > 40; y -= 24) page.drawLine({ start: { x: 36, y }, end: { x: W - 36, y }, thickness: 0.5, color: line });
  } else if (template === 'grid') {
    const s = 14.17; // 5mm
    for (let x = 28; x < W - 20; x += s) page.drawLine({ start: { x, y: 28 }, end: { x, y: H - 28 }, thickness: 0.3, color: line });
    for (let y = 28; y < H - 20; y += s) page.drawLine({ start: { x: 28, y }, end: { x: W - 28, y }, thickness: 0.3, color: line });
  } else if (template === 'dot') {
    const s = 14.17;
    for (let x = 28; x < W - 20; x += s) for (let y = 28; y < H - 20; y += s) page.drawCircle({ x, y, size: 0.6, color: rgb(0.6, 0.66, 0.75) });
  }
}

export const PAGE_SIZES = { A4: [595.28, 841.89], Letter: [612, 792] };

/** 빈 노트 PDF 만들기 */
export async function createBlankPdf(pageCount, template, size = 'A4') {
  const pdf = await PDFDocument.create();
  const [W, H] = PAGE_SIZES[size] || PAGE_SIZES.A4;
  for (let i = 0; i < pageCount; i++) drawTemplate(pdf.addPage([W, H]), template);
  pdf.setTitle('새 노트');
  pdf.setProducer('FlexNote');
  return pdf.save();
}

/** index 위치에 빈 페이지 삽입 (width/height 는 화면에 보이는 크기, 회전 없는 새 페이지) */
export async function insertBlankPage(bytes, index, { template = 'blank', width = 595.28, height = 841.89 } = {}) {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const page = pdf.insertPage(Math.min(index, pdf.getPageCount()), [width, height]);
  drawTemplate(page, template);
  return pdf.save({ useObjectStreams: true });
}

/** index 페이지 삭제 */
export async function removePage(bytes, index) {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  if (pdf.getPageCount() <= 1) throw new Error('마지막 한 페이지는 삭제할 수 없습니다');
  pdf.removePage(index);
  return pdf.save({ useObjectStreams: true });
}
