// 필기를 포함한 PDF 내보내기, 빈 노트 생성 (pdf-lib)
import {
  PDFDocument, rgb, pushGraphicsState, popGraphicsState, concatTransformationMatrix,
  moveTo, lineTo, stroke, setLineWidth, setLineCap, setLineJoin, LineCapStyle, LineJoinStyle,
  setStrokingRgbColor, setGraphicsState, drawObject,
} from '../vendor/pdf-lib/pdf-lib.esm.min.js';
import { strokeRuns, shapePolylines, textLayout, drawItem } from './ink.js';

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
 */
export async function exportAnnotatedPdf(pdfBytes, pageTransforms, getItems, onProgress) {
  const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });
  const pages = pdf.getPages();
  const gs = (page, key, dict) => {
    const name = page.node.newExtGState('GS', pdf.context.obj(dict));
    return name;
  };
  for (let i = 0; i < pages.length; i++) {
    const items = getItems(i);
    if (!items.length) continue;
    const vt = pageTransforms[i];
    if (!vt) continue;
    const page = pages[i];
    const inv = invert(vt); // 페이지(뷰포트) 좌표 → PDF 사용자 좌표
    const ops = [pushGraphicsState(), concatTransformationMatrix(...inv)];
    const gsNormal = gs(page, 'n', { Type: 'ExtGState', ca: 1, CA: 1, BM: 'Normal' });
    const gsMul = gs(page, 'm', { Type: 'ExtGState', ca: 1, CA: 1, BM: 'Multiply' });
    // 형광펜을 먼저 (화면과 같은 순서: 형광펜 레이어가 아래)
    const ordered = [...items.filter((it) => it.t === 's' && it.tool === 'hl'), ...items.filter((it) => !(it.t === 's' && it.tool === 'hl'))];
    for (const it of ordered) {
      if (it.t === 'tx') {
        const img = await textImage(pdf, it);
        if (!img) continue;
        const L = textLayout(it);
        const xo = page.node.newXObject('Tx', img.ref);
        // 이미지 단위 정사각형 → 뷰포트 좌표 (x, y + h)에서 위로 뒤집기
        ops.push(pushGraphicsState(), setGraphicsState(gsNormal), concatTransformationMatrix(L.w, 0, 0, -L.h, it.x, it.y + L.h), drawObject(xo), popGraphicsState());
        continue;
      }
      const [r, g, b] = hexToRgb(it.c);
      ops.push(setGraphicsState(it.tool === 'hl' ? gsMul : gsNormal), setStrokingRgbColor(r, g, b),
        setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round));
      if (it.t === 's') for (const run of strokeRuns(it)) ops.push(...polylineOps(run.pts, run.w));
      else if (it.t === 'sh') for (const pl of shapePolylines(it)) ops.push(...polylineOps(pl, it.w));
    }
    ops.push(popGraphicsState());
    page.pushOperators(...ops);
    onProgress?.(i + 1, pages.length);
    if (i % 5 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  return pdf.save({ useObjectStreams: true });
}

async function textImage(pdf, it) {
  const L = textLayout(it);
  const scale = 4;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(L.w * scale));
  c.height = Math.max(1, Math.ceil(L.h * scale));
  const ctx = c.getContext('2d');
  ctx.scale(scale, scale);
  ctx.translate(-it.x, -it.y);
  drawItem(ctx, it);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  if (!blob) return null;
  const img = await pdf.embedPng(await blob.arrayBuffer());
  return img;
}

/** 빈 노트 PDF 만들기. template: blank | lined | grid | dot */
export async function createBlankPdf(pageCount, template, size = 'A4') {
  const pdf = await PDFDocument.create();
  const [W, H] = size === 'Letter' ? [612, 792] : [595.28, 841.89];
  const line = rgb(0.72, 0.8, 0.9);
  for (let i = 0; i < pageCount; i++) {
    const page = pdf.addPage([W, H]);
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
  pdf.setTitle('새 노트');
  pdf.setProducer('FlexNote');
  return pdf.save();
}
