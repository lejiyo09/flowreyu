// DOCX(Word) 열기·저장 어댑터: Office Open XML ↔ 타이핑형 노트 문서(ProseMirror JSON)
//
// 열기: zip 을 풀어 document.xml · styles.xml · numbering.xml · 관계(rels) · 머리글/바닥글 · 그림을 읽고
//       문단·글자 서식, 표(병합·배경·테두리·너비), 그림, 탭 채움선, 목록, 쪽 설정, 쪽 번호, 수식(OMML→LaTeX 기본)을 옮긴다.
//       옮기지 못하거나 근사로만 옮긴 요소는 warnings 에 모아 사용자에게 알린다 (조용히 버리지 않음).
// 저장: 문서 JSON 에서 새 DOCX 를 만든다 (원본 XML 을 그대로 두는 방식이 아니므로, 열 때 경고한 요소는 저장되지 않음).
//       수정하지 않았다면 호출하는 쪽(main.js)이 보관해 둔 원본 파일을 그대로 내려준다.
//
// 단위: twip(1/20pt), half-point(글자 크기), EMU(1/12700pt) → 편집기 단위(1 = 1pt).
import { unzipSync, zipSync, strFromU8, strToU8 } from '../vendor/fflate/fflate.mjs';
import { PAPER, DEFAULT_PAGE } from './typing-page.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const TW = 20; // twip → pt
const EMU = 12700;
const MM = 72 / 25.4;

// ───────────────────────────── XML 도우미 ─────────────────────────────

const kids = (el, ns, name) => (el ? [...el.children].filter((c) => c.namespaceURI === ns && (!name || c.localName === name)) : []);
const kid = (el, ns, name) => kids(el, ns, name)[0] || null;
const attr = (el, name, ns = W) => (el ? el.getAttributeNS(ns, name) ?? el.getAttribute('w:' + name) : null);
const val = (el) => attr(el, 'val');
const num = (v) => (v == null || v === '' ? null : Number(v));
/** <w:b/> · <w:b w:val="true|1|on"/> → true, w:val="false|0|off" → false, 없으면 null */
const onoff = (el) => (el ? !['false', '0', 'off', 'none'].includes(String(val(el) ?? 'true')) : null);
function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('XML 을 읽을 수 없습니다');
  return doc;
}

const HIGHLIGHT = { yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000', darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000', darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000', white: '#ffffff' };
const KO_FALLBACK = 'Malgun Gothic, 맑은 고딕, Apple SD Gothic Neo, sans-serif';
const cssFont = (name) => (name ? `"${name.replace(/"/g, '')}", ${KO_FALLBACK}` : null);
const fontName = (css) => (css ? css.split(',')[0].replace(/["']/g, '').trim() : null);
const hex = (c) => (c && /^[0-9a-f]{6}$/i.test(c) ? '#' + c.toLowerCase() : null);

// ───────────────────────────── 열기 ─────────────────────────────

/**
 * @param bytes ArrayBuffer|Uint8Array .docx
 * @returns {{content, page, warnings: string[], approx: string[]}}
 */
export function importDocx(bytes) {
  let files;
  try { files = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); } catch { throw new Error('DOCX(zip) 파일이 아니거나 손상되었습니다'); }
  const text = (p) => (files[p] ? strFromU8(files[p]) : null);
  if (!files['word/document.xml']) throw new Error('Word 문서 본문(word/document.xml)이 없습니다');
  const warn = new Map(), approx = new Map();
  const note = (map, k) => map.set(k, (map.get(k) || 0) + 1);
  const W_ = (k) => note(warn, k), APX = (k) => note(approx, k);

  const rels = readRels(text('word/_rels/document.xml.rels'));
  const styles = readStyles(text('word/styles.xml'));
  const numbering = readNumbering(text('word/numbering.xml'));
  const doc = parseXml(text('word/document.xml'));
  const body = kid(doc.documentElement, W, 'body');

  // 기본 글꼴·크기·줄 간격
  const defR = styles.defaults.r, defP = styles.defaults.p;
  const baseSize = defR.size || 10;
  const page = { ...DEFAULT_PAGE, margin: { ...DEFAULT_PAGE.margin }, font: cssFont(defR.font) || DEFAULT_PAGE.font, fontSize: baseSize, lineHeight: defP.lineHeight && typeof defP.lineHeight === 'number' ? defP.lineHeight : 1.2 };

  // 쪽 설정: 마지막 구역(sectPr). 구역이 여러 개면 첫 설정만 쓰고 알림
  const sects = [...doc.getElementsByTagNameNS(W, 'sectPr')];
  if (sects.length > 1) W_('구역마다 다른 쪽 설정 (마지막 구역 설정으로 통일)');
  const sect = kid(body, W, 'sectPr') || sects[sects.length - 1];
  if (sect) {
    const sz = kid(sect, W, 'pgSz'), mar = kid(sect, W, 'pgMar');
    if (sz) {
      const wmm = (num(attr(sz, 'w')) / 1440) * 25.4, hmm = (num(attr(sz, 'h')) / 1440) * 25.4;
      const land = attr(sz, 'orient') === 'landscape' || wmm > hmm;
      const [a, b] = land ? [hmm, wmm] : [wmm, hmm];
      const named = Object.entries(PAPER).find(([, [pw, ph]]) => Math.abs(pw - a) < 1.5 && Math.abs(ph - b) < 1.5);
      page.size = named ? named[0] : 'custom';
      if (!named) { page.width = +a.toFixed(1); page.height = +b.toFixed(1); }
      page.orient = land ? 'landscape' : 'portrait';
    }
    if (mar) {
      const mm = (k, d) => { const v = num(attr(mar, k)); return v == null ? d : +((v / 1440) * 25.4).toFixed(1); };
      page.margin = { t: mm('top', 20), b: mm('bottom', 15), l: mm('left', 30), r: mm('right', 30) };
    }
    if (kid(sect, W, 'cols') && num(attr(kid(sect, W, 'cols'), 'num')) > 1) W_('다단 (한 단으로 표시)');
    // 머리글·바닥글 (기본 것). 쪽 번호 필드는 {n}/{total}
    for (const [tag, key] of [['headerReference', 'header'], ['footerReference', 'footer']]) {
      const ref = kids(sect, W, tag).find((r) => (attr(r, 'type') || 'default') === 'default') || kids(sect, W, tag)[0];
      const target = ref && rels[ref.getAttributeNS(R, 'id')]?.target;
      const xml = target && text('word/' + target.replace(/^\/?word\//, ''));
      if (!xml) continue;
      const hf = readHeaderFooter(xml);
      if (key === 'footer' && /^\{n\}$/.test(hf.text.trim())) { page.pageNum = hf.align || 'center'; page.footer = ''; }
      else if (key === 'footer') { page.footer = hf.text; page.pageNum = 'none'; }
      else page.header = hf.text.replace(/\{n\}/, '{n}');
      if (hf.complex) W_(key === 'header' ? '머리글의 표·그림 (글자만 유지)' : '바닥글의 표·그림 (글자만 유지)');
    }
    if (!kids(sect, W, 'footerReference').length) page.pageNum = 'none';
    if (kids(sect, W, 'headerReference').some((r) => attr(r, 'type') === 'first') || kids(sect, W, 'footerReference').some((r) => attr(r, 'type') === 'first')) APX('첫 쪽만 다른 머리글·바닥글 (모든 쪽에 같은 것)');
  }

  const footnotes = readNotes(text('word/footnotes.xml'), 'footnote');
  const endnotes = readNotes(text('word/endnotes.xml'), 'endnote');
  const usedNotes = [];
  const media = (rid) => {
    const t = rels[rid]?.target;
    if (!t) return null;
    const path = t.startsWith('/') ? t.slice(1) : 'word/' + t;
    const bin = files[path];
    if (!bin) return null;
    const ext = path.split('.').pop().toLowerCase();
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', webp: 'image/webp' }[ext];
    if (!mime) { W_(`지원하지 않는 그림 형식(.${ext})`); return null; }
    let s = '';
    for (let i = 0; i < bin.length; i += 0x8000) s += String.fromCharCode.apply(null, bin.subarray(i, i + 0x8000));
    return `data:${mime};base64,${btoa(s)}`;
  };

  /** 문단 서식 (스타일 → 직접 서식 순서로 덮어씀) */
  function paraProps(pPr) {
    const st = styles.resolve(val(kid(pPr, W, 'pStyle')) || styles.defaultPara);
    const p = { ...defP, ...st.p, ...readPPr(pPr) };
    return { p, r: { ...defR, ...st.r }, styleName: st.name, outline: p.outline ?? st.outline };
  }

  /** 글자 묶음(run) → 텍스트 노드들 */
  function runNodes(r, baseR, out, ctx) {
    const rPr = kid(r, W, 'rPr');
    const rs = styles.resolve(val(kid(rPr, W, 'rStyle')), 'character');
    const f = { ...baseR, ...rs.r, ...readRPr(rPr) };
    const marks = runMarks(f, ctx);
    for (const c of r.children) {
      const n = c.localName;
      if (c.namespaceURI === W) {
        if (n === 't' || n === 'delText') {
          // 글 안의 탭 문자도 Word 에서는 탭 (목차 등): 탭 노드로 나눔
          c.textContent.split('\t').forEach((part, k) => {
            if (k) out.push({ type: 'tab' });
            if (part) out.push({ type: 'text', text: part, ...(marks.length ? { marks } : {}) });
          });
        }
        else if (n === 'tab' || n === 'ptab') out.push({ type: 'tab' });
        else if (n === 'br') { if (attr(c, 'type') === 'page') out.push({ type: '__pagebreak' }); else if (attr(c, 'type') !== 'column') out.push({ type: 'hardBreak' }); }
        else if (n === 'cr') out.push({ type: 'hardBreak' });
        else if (n === 'noBreakHyphen') out.push({ type: 'text', text: '‑', ...(marks.length ? { marks } : {}) });
        else if (n === 'sym') { const ch = attr(c, 'char'); if (ch) out.push({ type: 'text', text: String.fromCharCode(parseInt(ch, 16) & 0xffff), ...(marks.length ? { marks } : {}) }); }
        else if (n === 'drawing') drawing(c, out);
        else if (n === 'pict' || n === 'object') W_('예전 형식 그림·개체(VML/OLE)');
        else if (n === 'footnoteReference' || n === 'endnoteReference') {
          const id = attr(c, 'id'), src = n === 'footnoteReference' ? footnotes : endnotes;
          if (src[id] != null) { usedNotes.push({ kind: n === 'footnoteReference' ? '각주' : '미주', text: src[id] }); out.push({ type: 'text', text: `[${usedNotes.length}]`, marks: [...marks.filter((m) => m.type !== 'superscript'), { type: 'superscript' }] }); }
        } else if (n === 'fldChar' || n === 'instrText') ctx.field(c);
        else if (n === 'lastRenderedPageBreak' || n === 'rPr' || n === 'softHyphen') { /* 화면 배치 정보 */ }
        else if (n === 'commentReference') W_('메모(댓글)');
        else APX(`알 수 없는 글자 요소(${n})`);
      } else if (c.namespaceURI === 'http://schemas.openxmlformats.org/markup-compatibility/2006' && n === 'AlternateContent') {
        const fb = kid(c, 'http://schemas.openxmlformats.org/markup-compatibility/2006', 'Fallback');
        const choice = kid(c, 'http://schemas.openxmlformats.org/markup-compatibility/2006', 'Choice');
        const d = (choice || fb) && [...(choice || fb).getElementsByTagNameNS(W, 'drawing')][0];
        if (d) drawing(d, out); else W_('도형·글상자');
      }
    }
  }

  function runMarks(f, ctx) {
    const m = [];
    if (f.b) m.push({ type: 'bold' });
    if (f.i) m.push({ type: 'italic' });
    if (f.u) m.push({ type: 'underline' });
    if (f.strike) m.push({ type: 'strike' });
    if (f.vert === 'superscript') m.push({ type: 'superscript' });
    if (f.vert === 'subscript') m.push({ type: 'subscript' });
    if (f.highlight) m.push({ type: 'highlight', attrs: { color: f.highlight } });
    const ts = {};
    if (f.size && Math.abs(f.size - baseSize) > 0.01) ts.fontSize = `${f.size}px`;
    if (f.font && f.font !== defR.font) ts.fontFamily = cssFont(f.font);
    if (f.color) ts.color = f.color;
    if (Object.keys(ts).length) m.push({ type: 'textStyle', attrs: ts });
    if (ctx.link) m.push({ type: 'link', attrs: { href: ctx.link } });
    if (f.caps || f.smallCaps) APX('대문자·작은 대문자 효과');
    return m;
  }

  function drawing(d, out) {
    const holder = kid(d, WP, 'inline') || kid(d, WP, 'anchor');
    if (!holder) return;
    if (holder.localName === 'anchor') APX('떠 있는 그림 (글 안 그림으로 배치)');
    const ext = kid(holder, WP, 'extent');
    const blip = holder.getElementsByTagNameNS(A, 'blip')[0];
    const pic = holder.getElementsByTagNameNS(PIC, 'pic')[0];
    if (!blip || !pic) { W_(holder.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/chart', 'chart').length ? '차트' : '도형·글상자·SmartArt'); return; }
    const src = media(blip.getAttributeNS(R, 'embed'));
    if (!src) return;
    const w = ext ? Math.round(num(attr(ext, 'cx', null) ?? ext.getAttribute('cx')) / EMU) : null;
    const h = ext ? Math.round(num(ext.getAttribute('cy')) / EMU) : null;
    const alt = kid(holder, WP, 'docPr')?.getAttribute('descr') || kid(holder, WP, 'docPr')?.getAttribute('name') || '';
    out.push({ type: 'image', attrs: { src, alt, ...(w ? { width: w } : {}), ...(h ? { height: h } : {}) } });
  }

  /** 문단 → 블록들 (쪽 나눔 문자가 있으면 문단을 나눔) */
  function paragraph(p) {
    const pPr = kid(p, W, 'pPr');
    const { p: pp, r: baseR, styleName, outline } = paraProps(pPr);
    const inline = [];
    const ctx = { link: null, fieldDepth: 0, fieldCode: '', inField: false, field: (c) => {
      if (c.localName === 'instrText') { ctx.fieldCode += c.textContent; return; }
      const t = attr(c, 'fldCharType');
      if (t === 'begin') { ctx.fieldCode = ''; ctx.inField = true; }
      else if (t === 'separate') { ctx.inField = false; const code = ctx.fieldCode.trim().split(/\s+/)[0]?.toUpperCase(); if (code === 'TOC') APX('목차 필드 (지금 글자로 유지, 자동 갱신 안 됨)'); else if (code && !['PAGE', 'NUMPAGES', 'HYPERLINK', 'REF', 'PAGEREF'].includes(code)) APX(`필드 ${code} (결과 글자로 유지)`); }
      else if (t === 'end') ctx.inField = false;
    } };
    const walk = (el) => {
      for (const c of el.children) {
        if (c.namespaceURI === M && (c.localName === 'oMath' || c.localName === 'oMathPara')) {
          const latex = ommlToLatex(c.localName === 'oMathPara' ? kid(c, M, 'oMath') || c : c, APX);
          inline.push({ type: 'inlineMath', attrs: { latex } });
          continue;
        }
        if (c.namespaceURI !== W) {
          if (c.localName === 'AlternateContent') runNodes({ children: [c] }, baseR, inline, ctx);
          continue;
        }
        const n = c.localName;
        if (n === 'r') { if (!ctx.inField) runNodes(c, baseR, inline, ctx); else if ([...c.children].some((x) => x.localName === 'fldChar' || x.localName === 'instrText')) runNodes(c, baseR, inline, ctx); }
        else if (n === 'hyperlink') {
          const rid = c.getAttributeNS(R, 'id');
          const href = rid && rels[rid]?.external ? rels[rid].target : null;
          if (!href && attr(c, 'anchor')) APX('문서 안 책갈피 링크 (글자만 유지)');
          const prev = ctx.link; ctx.link = href; walk(c); ctx.link = prev;
        } else if (n === 'ins') { W_('변경 내용 추적 (삽입은 반영)'); walk(c); }
        else if (n === 'del') W_('변경 내용 추적 (삭제된 글 제외)');
        else if (n === 'smartTag' || n === 'customXml' || n === 'fldSimple' || n === 'dir' || n === 'bdo') walk(c);
        else if (n === 'sdt') walk(kid(c, W, 'sdtContent') || c);
        else if (n === 'bookmarkStart' || n === 'bookmarkEnd' || n === 'proofErr' || n === 'pPr' || n === 'permStart' || n === 'permEnd') { /* 무시해도 되는 표시 */ }
        else if (n === 'commentRangeStart' || n === 'commentRangeEnd') W_('메모(댓글)');
        else APX(`알 수 없는 문단 요소(${n})`);
      }
    };
    walk(p);
    // 문단 속성 → 노드 속성
    const attrs = {};
    if (pp.align) attrs.textAlign = pp.align;
    if (pp.indent) attrs.indent = pp.indent;
    if (pp.hanging) attrs.hanging = pp.hanging;
    if (pp.firstLine) attrs.firstLine = pp.firstLine;
    if (pp.after != null) attrs.spaceAfter = pp.after;
    if (pp.before) attrs.spaceBefore = pp.before;
    if (pp.lineHeight != null && pp.lineHeight !== page.lineHeight) attrs.lineHeight = pp.lineHeight;
    if (pp.leader && inline.some((x) => x.type === 'tab')) attrs.tabLeader = pp.leader;
    else if (pp.tabsUsed && inline.some((x) => x.type === 'tab')) APX('탭 위치 (기본 간격으로 표시)');
    if (pp.keepNext || pp.keepLines) { /* 쪽 나눔이 문단·행 단위라 대부분 그대로 지켜짐 */ }
    const level = outline != null && outline < 6 ? outline + 1 : /^heading\s*([1-6])$|^제목\s*([1-6])$/i.exec(styleName || '')?.slice(1).find(Boolean);
    const type = level ? 'heading' : 'paragraph';
    if (level) { attrs.level = +level; if (!baseR.b) attrs.plain = true; } // 스타일이 굵지 않은 제목
    // 제목 스타일의 글자 모양은 글자에 직접 (편집기 기본 제목 크기와 달라도 원본대로)
    if (level) for (const t of inline) if (t.type === 'text' && !t.marks?.some((m) => m.type === 'textStyle' && m.attrs.fontSize)) {
      const sz = baseR.size;
      if (sz && Math.abs(sz - baseSize) > 0.01) t.marks = [...(t.marks || []).filter((m) => m.type !== 'textStyle'), { type: 'textStyle', attrs: { ...(t.marks?.find((m) => m.type === 'textStyle')?.attrs || {}), fontSize: `${sz}px` } }];
    }
    // 쪽 나눔 문자 기준으로 나눔
    const blocks = [];
    let cur = [];
    const flush = () => { blocks.push({ type, attrs: { ...attrs }, ...(cur.length ? { content: mergeText(cur) } : {}) }); cur = []; };
    for (const x of inline) { if (x.type === '__pagebreak') { flush(); blocks.push({ type: 'pageBreak' }); } else cur.push(x); }
    flush();
    if (blocks.length > 1 && !blocks[blocks.length - 1].content && blocks[blocks.length - 2].type === 'pageBreak') blocks.pop(); // 끝의 빈 문단
    if (pp.pageBreakBefore) blocks.unshift({ type: 'pageBreak' });
    return { blocks, numPr: pp.numPr };
  }

  function table(tbl) {
    const tblPr = kid(tbl, W, 'tblPr');
    const grid = kids(kid(tbl, W, 'tblGrid'), W, 'gridCol').map((g) => num(attr(g, 'w')) / TW);
    const tb = readBorders(kid(tblPr, W, 'tblBorders'));
    const st = styles.resolve(val(kid(tblPr, W, 'tblStyle')), 'table');
    const tblBorders = { ...st.borders, ...tb };
    const jc = val(kid(tblPr, W, 'jc'));
    const rowsEl = kids(tbl, W, 'tr');
    const nR = rowsEl.length;
    // 칸 → 격자 위치 (세로 병합 계산)
    const cells = []; // [{r, c, span, el, merge}]
    rowsEl.forEach((tr, r) => {
      let col = num(attr(kid(kid(tr, W, 'trPr'), W, 'gridBefore'), 'val')) || 0;
      if (col) APX('행 앞 빈 칸(gridBefore)');
      for (const tc of kids(tr, W, 'tc').concat(kids(tr, W, 'sdt').flatMap((s) => kids(kid(s, W, 'sdtContent'), W, 'tc')))) {
        const tcPr = kid(tc, W, 'tcPr');
        const span = num(val(kid(tcPr, W, 'gridSpan'))) || 1;
        const vm = kid(tcPr, W, 'vMerge');
        cells.push({ r, c: col, span, el: tc, merge: vm ? (val(vm) === 'restart' ? 'restart' : 'continue') : null });
        col += span;
      }
    });
    const nC = Math.max(grid.length, ...cells.map((x) => x.c + x.span));
    const colW = Array.from({ length: nC }, (_, i) => grid[i] || null);
    // 세로 병합: continue 칸은 위의 시작 칸 rowspan 을 늘리고 없앰
    const byPos = new Map(cells.map((x) => [x.r + ':' + x.c, x]));
    for (const x of cells) {
      if (x.merge !== 'continue') continue;
      let up = null;
      for (let r = x.r - 1; r >= 0; r--) { const u = byPos.get(r + ':' + x.c); if (u && u.merge !== 'continue') { up = u; break; } if (!u) break; }
      if (up) { up.rowspan = (up.rowspan || 1) + 1; x.skip = true; } else x.merge = null;
    }
    const rows = rowsEl.map((tr, r) => {
      const content = cells.filter((x) => x.r === r && !x.skip).map((x) => {
        const tcPr = kid(x.el, W, 'tcPr');
        const shd = kid(tcPr, W, 'shd');
        const fill = shd && attr(shd, 'fill');
        const va = val(kid(tcPr, W, 'vAlign'));
        const own = readBorders(kid(tcPr, W, 'tcBorders'));
        const edge = (side, inside) => own[side] ?? (inside ? tblBorders[inside] : tblBorders[side]);
        const bt = edge('top', x.r > 0 ? 'insideH' : null), bb = edge('bottom', x.r + (x.rowspan || 1) < nR ? 'insideH' : null);
        const bl = edge('left', x.c > 0 ? 'insideV' : null), br = edge('right', x.c + x.span < nC ? 'insideV' : null);
        const mar = kid(tcPr, W, 'tcMar') || kid(tblPr, W, 'tblCellMar');
        const pad = mar ? ['top', 'right', 'bottom', 'left'].map((s) => `${((num(attr(kid(mar, W, s) || kid(mar, W, s === 'left' ? 'start' : s === 'right' ? 'end' : s), 'w')) || 0) / TW).toFixed(1)}px`).join(' ') : null;
        const css = [['top', bt], ['right', br], ['bottom', bb], ['left', bl]].map(([s, b]) => `border-${s}:${b ? `${b.w}px solid ${b.color}` : 'none'}`).join(';') + (pad ? `;padding:${pad}` : '');
        const blocks = cellBlocks(x.el);
        return {
          type: 'tableCell',
          attrs: {
            colspan: x.span, rowspan: x.rowspan || 1,
            colwidth: colW.slice(x.c, x.c + x.span).every(Boolean) ? colW.slice(x.c, x.c + x.span).map((v) => Math.round(v)) : null,
            ...(hex(fill) && fill.toLowerCase() !== 'auto' ? { background: hex(fill) } : {}),
            ...(va === 'center' ? { valign: 'middle' } : va === 'bottom' ? { valign: 'bottom' } : {}),
            cstyle: css,
          },
          content: blocks.length ? blocks : [{ type: 'paragraph' }],
        };
      });
      return { type: 'tableRow', content };
    }).filter((r) => r.content.length);
    if (rowsEl.some((tr) => onoff(kid(kid(tr, W, 'trPr'), W, 'tblHeader')))) APX('쪽마다 반복되는 표 제목 행 (첫 쪽에만)');
    if (rowsEl.some((tr) => kid(kid(tr, W, 'trPr'), W, 'trHeight'))) APX('표 행 높이 고정 (내용에 맞춤)');
    const style = jc === 'center' ? 'margin-left:auto;margin-right:auto' : jc === 'right' || jc === 'end' ? 'margin-left:auto' : null;
    return { type: 'table', attrs: style ? { style } : {}, content: rows };
  }

  function cellBlocks(tc) { return blocksOf(tc); }

  /** 본문·표 칸의 자식 → 블록 (목록 문단은 모아서 목록으로) */
  function blocksOf(parent) {
    const out = [];
    let list = null; // {numId, items:[{lvl, blocks}]}
    const endList = () => { if (list) { out.push(...buildLists(list, numbering)); list = null; } };
    for (const c of parent.children) {
      if (c.namespaceURI !== W) continue;
      const n = c.localName;
      if (n === 'p') {
        const { blocks, numPr } = paragraph(c);
        if (numPr && numbering.isList(numPr.numId)) {
          if (!list || list.numId !== numPr.numId) { endList(); list = { numId: numPr.numId, items: [] }; }
          list.items.push({ lvl: numPr.ilvl || 0, blocks: blocks.filter((b) => b.type !== 'pageBreak').map((b) => (b.type === 'heading' ? { ...b, type: 'paragraph', attrs: { ...b.attrs, level: undefined } } : b)) });
          continue;
        }
        endList();
        out.push(...blocks);
      } else if (n === 'tbl') { endList(); out.push(table(c)); }
      else if (n === 'sdt') { endList(); out.push(...blocksOf(kid(c, W, 'sdtContent') || c)); }
      else if (n === 'customXml') { endList(); out.push(...blocksOf(c)); }
      else if (n === 'sectPr' || n === 'tcPr' || n === 'bookmarkStart' || n === 'bookmarkEnd') { /* */ }
      else if (n === 'altChunk') W_('다른 형식으로 끼워 넣은 내용(altChunk)');
      else APX(`알 수 없는 블록 요소(${n})`);
    }
    endList();
    return out;
  }

  const content = blocksOf(body);
  if (usedNotes.length) {
    W_('각주·미주 (문서 끝 "주석"으로 옮김)');
    content.push({ type: 'paragraph', attrs: { spaceBefore: 12 }, content: [{ type: 'text', text: '주석', marks: [{ type: 'bold' }] }] });
    usedNotes.forEach((nt, i) => content.push({ type: 'paragraph', content: [{ type: 'text', text: `[${i + 1}] ${nt.text}` }] }));
  }
  if (!content.length) content.push({ type: 'paragraph' });
  // 맨 끝은 문단 (표·그림 뒤에도 이어 쓸 수 있게)
  if (content[content.length - 1].type !== 'paragraph') content.push({ type: 'paragraph' });
  for (const k of ['customXml/', 'word/comments.xml', 'word/people.xml']) if (Object.keys(files).some((f) => f.startsWith(k))) { if (k.includes('comments')) W_('메모(댓글)'); }
  if (files['word/vbaProject.bin']) W_('매크로(VBA)');
  const list = (m) => [...m].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k));
  return { content: { type: 'doc', content }, page, warnings: list(warn), approx: list(approx) };
}

/** 이어진 같은 모양 텍스트 합치기 */
function mergeText(nodes) {
  const out = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (n.type === 'text' && last?.type === 'text' && JSON.stringify(last.marks || []) === JSON.stringify(n.marks || [])) last.text += n.text;
    else out.push({ ...n });
  }
  return out.filter((n) => n.type !== 'text' || n.text);
}

function readRels(xml) {
  const out = {};
  if (!xml) return out;
  for (const r of parseXml(xml).getElementsByTagName('Relationship')) out[r.getAttribute('Id')] = { target: r.getAttribute('Target'), type: r.getAttribute('Type'), external: r.getAttribute('TargetMode') === 'External' };
  return out;
}

function readRPr(rPr) {
  const f = {};
  if (!rPr) return f;
  const b = onoff(kid(rPr, W, 'b')); if (b != null) f.b = b;
  const i = onoff(kid(rPr, W, 'i')); if (i != null) f.i = i;
  const u = kid(rPr, W, 'u'); if (u) f.u = val(u) !== 'none';
  const s = onoff(kid(rPr, W, 'strike')) || onoff(kid(rPr, W, 'dstrike')); if (s != null) f.strike = s;
  const va = val(kid(rPr, W, 'vertAlign')); if (va) f.vert = va;
  const sz = num(val(kid(rPr, W, 'sz'))); if (sz) f.size = sz / 2;
  const fonts = kid(rPr, W, 'rFonts');
  if (fonts) { const name = attr(fonts, 'eastAsia') || attr(fonts, 'ascii') || attr(fonts, 'hAnsi'); if (name) f.font = name; }
  const col = val(kid(rPr, W, 'color')); if (col && col !== 'auto') f.color = hex(col);
  const hl = val(kid(rPr, W, 'highlight')); if (hl && hl !== 'none') f.highlight = HIGHLIGHT[hl] || null;
  const shd = kid(rPr, W, 'shd'); if (shd && !f.highlight) { const fill = attr(shd, 'fill'); if (hex(fill) && fill.toLowerCase() !== 'ffffff') f.highlight = hex(fill); }
  if (onoff(kid(rPr, W, 'caps'))) f.caps = true;
  if (onoff(kid(rPr, W, 'smallCaps'))) f.smallCaps = true;
  return f;
}

function readPPr(pPr) {
  const p = {};
  if (!pPr) return p;
  const jc = val(kid(pPr, W, 'jc'));
  if (jc) p.align = { center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify', left: 'left', start: 'left' }[jc] || null;
  const sp = kid(pPr, W, 'spacing');
  if (sp) {
    const after = num(attr(sp, 'after')), before = num(attr(sp, 'before')), line = num(attr(sp, 'line'));
    if (after != null) p.after = +(after / TW).toFixed(1);
    if (before != null) p.before = +(before / TW).toFixed(1);
    if (line != null) {
      const rule = attr(sp, 'lineRule') || 'auto';
      p.lineHeight = rule === 'auto' ? +((line / 240) * 1.2).toFixed(2) : `${+(line / TW).toFixed(1)}px`; // 한 줄(240) ≈ 글자 크기의 1.2배
    }
  }
  const ind = kid(pPr, W, 'ind');
  if (ind) {
    const left = num(attr(ind, 'left') ?? attr(ind, 'start')), hanging = num(attr(ind, 'hanging')), first = num(attr(ind, 'firstLine'));
    if (left != null) p.indent = +(left / TW).toFixed(1);
    if (hanging) { p.hanging = +(hanging / TW).toFixed(1); p.indent = Math.max(0, (p.indent || 0) - p.hanging); } // 우리 내어쓰기는 패딩 안쪽에서 첫 줄을 당김
    if (first) p.firstLine = +(first / TW).toFixed(1);
  }
  const tabs = kids(kid(pPr, W, 'tabs'), W, 'tab');
  if (tabs.length) {
    p.tabsUsed = true;
    const lead = tabs.map((t) => attr(t, 'leader')).find((l) => l && l !== 'none');
    if (lead) p.leader = { dot: 'dot', middleDot: 'dot', hyphen: 'hyphen', underscore: 'underscore', heavy: 'underscore' }[lead] || 'dot';
  }
  const numPr = kid(pPr, W, 'numPr');
  if (numPr) { const id = val(kid(numPr, W, 'numId')); if (id && id !== '0') p.numPr = { numId: id, ilvl: num(val(kid(numPr, W, 'ilvl'))) || 0 }; }
  if (onoff(kid(pPr, W, 'pageBreakBefore'))) p.pageBreakBefore = true;
  if (onoff(kid(pPr, W, 'keepNext'))) p.keepNext = true;
  if (onoff(kid(pPr, W, 'keepLines'))) p.keepLines = true;
  const ol = num(val(kid(pPr, W, 'outlineLvl'))); if (ol != null && ol < 9) p.outline = ol;
  return p;
}

function readBorders(el) {
  const out = {};
  if (!el) return out;
  for (const side of ['top', 'left', 'bottom', 'right', 'insideH', 'insideV', 'start', 'end']) {
    const b = kid(el, W, side);
    if (!b) continue;
    const key = side === 'start' ? 'left' : side === 'end' ? 'right' : side;
    const v = val(b);
    out[key] = !v || v === 'none' || v === 'nil' ? null : { w: Math.max(0.5, (num(attr(b, 'sz')) || 4) / 8).toFixed(2) * 1, color: hex(attr(b, 'color')) || '#000000' };
  }
  return out;
}

function readStyles(xml) {
  const map = new Map();
  const res = { defaults: { p: {}, r: {} }, defaultPara: null, resolve: (id, type = 'paragraph') => {
    const seen = new Set();
    const chain = [];
    let s = id ? map.get(id) : null;
    if (!s && type === 'paragraph' && res.defaultPara) s = map.get(res.defaultPara);
    while (s && !seen.has(s.id)) { seen.add(s.id); chain.unshift(s); s = s.basedOn ? map.get(s.basedOn) : null; }
    const out = { p: {}, r: {}, borders: {}, name: chain.length ? chain[chain.length - 1].name : null, outline: null };
    for (const c of chain) { Object.assign(out.p, c.p); Object.assign(out.r, c.r); Object.assign(out.borders, c.borders); if (c.p.outline != null) out.outline = c.p.outline; }
    return out;
  } };
  if (!xml) return res;
  const doc = parseXml(xml).documentElement;
  const dd = kid(doc, W, 'docDefaults');
  res.defaults.r = readRPr(kid(kid(dd, W, 'rPrDefault'), W, 'rPr'));
  res.defaults.p = readPPr(kid(kid(dd, W, 'pPrDefault'), W, 'pPr'));
  for (const s of kids(doc, W, 'style')) {
    const id = attr(s, 'styleId');
    const st = { id, type: attr(s, 'type'), name: val(kid(s, W, 'name')) || id, basedOn: val(kid(s, W, 'basedOn')), p: readPPr(kid(s, W, 'pPr')), r: readRPr(kid(s, W, 'rPr')), borders: readBorders(kid(kid(s, W, 'tblPr'), W, 'tblBorders')) };
    map.set(id, st);
    if (st.type === 'paragraph' && (attr(s, 'default') === '1' || attr(s, 'default') === 'true')) res.defaultPara = id;
  }
  return res;
}

function readNumbering(xml) {
  const abs = new Map(), nums = new Map();
  if (xml) {
    const doc = parseXml(xml).documentElement;
    for (const a of kids(doc, W, 'abstractNum')) {
      const lv = new Map();
      for (const l of kids(a, W, 'lvl')) lv.set(num(attr(l, 'ilvl')) || 0, { fmt: val(kid(l, W, 'numFmt')) || 'decimal', text: val(kid(l, W, 'lvlText')) || '' });
      abs.set(attr(a, 'abstractNumId'), lv);
    }
    for (const n of kids(doc, W, 'num')) nums.set(attr(n, 'numId'), val(kid(n, W, 'abstractNumId')));
  }
  return {
    isList: (id) => nums.has(id),
    fmt: (id, lvl) => abs.get(nums.get(id))?.get(lvl)?.fmt || 'bullet',
  };
}

/** 목록 문단들 → 들여쓰기 수준대로 중첩된 bulletList / orderedList */
function buildLists(list, numbering) {
  const mk = (lvl) => ({ type: numbering.fmt(list.numId, lvl) === 'bullet' ? 'bulletList' : 'orderedList', content: [] });
  const root = mk(list.items[0].lvl);
  const stack = [{ lvl: list.items[0].lvl, node: root }];
  for (const it of list.items) {
    while (stack.length > 1 && it.lvl < stack[stack.length - 1].lvl) stack.pop();
    let top = stack[stack.length - 1];
    if (it.lvl > top.lvl) {
      const parentItem = top.node.content[top.node.content.length - 1];
      const sub = mk(it.lvl);
      if (parentItem) { parentItem.content.push(sub); stack.push({ lvl: it.lvl, node: sub }); top = stack[stack.length - 1]; }
    }
    top.node.content.push({ type: 'listItem', content: it.blocks.length ? it.blocks.map((b) => ({ type: 'paragraph', attrs: { textAlign: b.attrs?.textAlign }, content: b.content })) : [{ type: 'paragraph' }] });
  }
  return [root];
}

function readNotes(xml, tag) {
  const out = {};
  if (!xml) return out;
  for (const n of parseXml(xml).getElementsByTagNameNS(W, tag)) {
    const t = attr(n, 'type');
    if (t && t !== 'normal') continue;
    out[attr(n, 'id')] = [...n.getElementsByTagNameNS(W, 'p')].map((p) => [...p.getElementsByTagNameNS(W, 't')].map((x) => x.textContent).join('')).join(' ').trim();
  }
  return out;
}

/** 머리글·바닥글 → 글(쪽 번호 필드는 {n}), 정렬, 표·그림 여부 */
function readHeaderFooter(xml) {
  const doc = parseXml(xml).documentElement;
  let text = '', align = null, inCode = false, inResult = false, code = '';
  for (const p of doc.getElementsByTagNameNS(W, 'p')) {
    const jc = val(kid(kid(p, W, 'pPr'), W, 'jc'));
    if (!align && jc) align = { center: 'center', right: 'right', end: 'right' }[jc] || 'left';
    for (const el of p.getElementsByTagNameNS(W, '*')) {
      if (el.localName === 'fldChar') {
        const t = attr(el, 'fldCharType');
        if (t === 'begin') { inCode = true; code = ''; }
        else if (t === 'separate' || (t === 'end' && inCode)) {
          const c = code.trim().split(/\s+/)[0]?.toUpperCase();
          const known = c === 'PAGE' || c === 'NUMPAGES' || c === 'SECTIONPAGES';
          if (c === 'PAGE') text += '{n}'; else if (known) text += '{total}';
          inCode = false;
          inResult = t === 'separate' && known; // 쪽 번호 필드의 '지금 결과'(예: 1)는 버림
        } else if (t === 'end') inResult = false;
      } else if (el.localName === 'instrText') code += el.textContent;
      else if (el.localName === 'fldSimple') { const c = (attr(el, 'instr') || '').trim().split(/\s+/)[0]?.toUpperCase(); if (c === 'PAGE') text += '{n}'; else if (c === 'NUMPAGES') text += '{total}'; }
      else if (el.localName === 't' && !inCode && !inResult && el.parentNode?.parentNode?.localName !== 'fldSimple') text += el.textContent;
      else if (el.localName === 'tab') text += ' ';
    }
    text += ' ';
  }
  return { text: text.replace(/\s+/g, ' ').trim(), align, complex: doc.getElementsByTagNameNS(W, 'tbl').length > 0 || doc.getElementsByTagNameNS(W, 'drawing').length > 0 };
}

// ── 수식: OMML → LaTeX (자주 쓰는 구조만. 나머지는 글자로) ──
const NARY = { '∑': '\\sum', '∏': '\\prod', '∫': '\\int', '∬': '\\iint', '∭': '\\iiint', '∮': '\\oint', '⋃': '\\bigcup', '⋂': '\\bigcap' };
const GREEK = { α: '\\alpha', β: '\\beta', γ: '\\gamma', δ: '\\delta', ε: '\\epsilon', θ: '\\theta', λ: '\\lambda', μ: '\\mu', π: '\\pi', σ: '\\sigma', φ: '\\phi', ω: '\\omega', Δ: '\\Delta', Σ: '\\Sigma', Ω: '\\Omega', '×': '\\times', '÷': '\\div', '±': '\\pm', '≤': '\\le', '≥': '\\ge', '≠': '\\ne', '∞': '\\infty', '·': '\\cdot', '→': '\\to' };
export function ommlToLatex(el, onApprox = () => {}) {
  const g = (e) => (e ? [...e.children].map(node).join('') : '');
  const arg = (e, name) => g(kid(e, M, name));
  const br = (s) => `{${s}}`;
  function node(e) {
    if (e.namespaceURI !== M) return e.localName === 'r' ? [...e.getElementsByTagNameNS(W, 't')].map((t) => t.textContent).join('') : '';
    switch (e.localName) {
      case 'r': return [...e.children].filter((c) => c.localName === 't').map((t) => [...t.textContent].map((ch) => GREEK[ch] ? GREEK[ch] + ' ' : ch).join('')).join('');
      case 'f': return `\\frac${br(arg(e, 'num'))}${br(arg(e, 'den'))}`;
      case 'sSup': return `${br(arg(e, 'e'))}^${br(arg(e, 'sup'))}`;
      case 'sSub': return `${br(arg(e, 'e'))}_${br(arg(e, 'sub'))}`;
      case 'sSubSup': return `${br(arg(e, 'e'))}_${br(arg(e, 'sub'))}^${br(arg(e, 'sup'))}`;
      case 'rad': { const deg = arg(e, 'deg'); return `\\sqrt${deg ? `[${deg}]` : ''}${br(arg(e, 'e'))}`; }
      case 'd': {
        const pr = kid(e, M, 'dPr');
        const beg = kid(pr, M, 'begChr')?.getAttributeNS(M, 'val') ?? '(', end = kid(pr, M, 'endChr')?.getAttributeNS(M, 'val') ?? ')';
        const esc = (c) => ({ '{': '\\{', '}': '\\}', '': '.' }[c] ?? c);
        return `\\left${esc(beg)}${kids(e, M, 'e').map(g).join(',')}\\right${esc(end)}`;
      }
      case 'nary': {
        const ch = kid(kid(e, M, 'naryPr'), M, 'chr')?.getAttributeNS(M, 'val') || '∫';
        const sub = arg(e, 'sub'), sup = arg(e, 'sup');
        return `${NARY[ch] || ch}${sub ? `_${br(sub)}` : ''}${sup ? `^${br(sup)}` : ''}${br(arg(e, 'e'))}`;
      }
      case 'func': return `\\operatorname${br(arg(e, 'fName'))}${br(arg(e, 'e'))}`;
      case 'acc': return `\\hat${br(arg(e, 'e'))}`;
      case 'bar': return `\\overline${br(arg(e, 'e'))}`;
      case 'limLow': return `${br(arg(e, 'e'))}_${br(arg(e, 'lim'))}`;
      case 'limUpp': return `${br(arg(e, 'e'))}^${br(arg(e, 'lim'))}`;
      case 'm': return `\\begin{matrix}${kids(e, M, 'mr').map((r) => kids(r, M, 'e').map(g).join('&')).join('\\\\')}\\end{matrix}`;
      case 'e': case 'oMath': case 'num': case 'den': case 'sub': case 'sup': case 'deg': case 'lim': case 'fName': case 'box': case 'borderBox': return g(e);
      case 'ctrlPr': case 'rPr': case 'fPr': case 'sSupPr': case 'sSubPr': case 'radPr': case 'naryPr': case 'dPr': case 'funcPr': case 'accPr': case 'barPr': case 'mPr': case 'oMathParaPr': case 'sSubSupPr': return '';
      default: onApprox('수식의 일부 구조 (글자로 근사)'); return g(e);
    }
  }
  return node(el).trim();
}

// ───────────────────────────── 저장 ─────────────────────────────

const xe = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const tw = (pt) => Math.round(pt * TW);
const LATEX_SYM = Object.fromEntries(Object.entries(GREEK).map(([k, v]) => [v.slice(1), k]));

/**
 * 문서 JSON → .docx (Uint8Array)
 * @param doc ProseMirror JSON
 * @param page 쪽 설정 (typing-page.js 형식)
 * @returns {{bytes: Uint8Array, lost: string[]}}  lost: 저장하면서 근사하거나 빠진 것
 */
export function exportDocx(doc, page, { title = '' } = {}) {
  const lost = new Map();
  const LOST = (k) => lost.set(k, (lost.get(k) || 0) + 1);
  const p0 = { ...DEFAULT_PAGE, ...page, margin: { ...DEFAULT_PAGE.margin, ...(page?.margin || {}) } };
  let [wmm, hmm] = p0.size === 'custom' && p0.width ? [p0.width, p0.height] : PAPER[p0.size] || PAPER.A4;
  if (p0.orient === 'landscape') [wmm, hmm] = [hmm, wmm];
  const contentW = (wmm - p0.margin.l - p0.margin.r) * MM;
  const baseSize = p0.fontSize || 10;
  const rels = []; // {id, type, target, external}
  const media = []; // {path, bytes}
  let relN = 10, imgN = 0, drawN = 0;
  const rel = (type, target, external) => { const id = 'rId' + relN++; rels.push({ id, type, target, external }); return id; };

  function runProps(marks = [], plain = false) {
    const has = (t) => marks.find((m) => m.type === t);
    let s = '';
    if (plain && !has('bold')) s += '<w:b w:val="0"/><w:bCs w:val="0"/>'; // 굵지 않은 제목 (제목 스타일은 굵게)
    const ts = has('textStyle')?.attrs || {};
    if (ts.fontFamily) { const f = xe(fontName(ts.fontFamily)); s += `<w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:eastAsia="${f}" w:cs="${f}"/>`; }
    if (has('bold')) s += '<w:b/><w:bCs/>';
    if (has('italic')) s += '<w:i/><w:iCs/>';
    if (has('strike')) s += '<w:strike/>';
    if (ts.color && /^#[0-9a-f]{6}$/i.test(ts.color)) s += `<w:color w:val="${ts.color.slice(1).toUpperCase()}"/>`;
    const size = parseFloat(ts.fontSize);
    if (size) s += `<w:sz w:val="${Math.round(size * 2)}"/><w:szCs w:val="${Math.round(size * 2)}"/>`;
    const hl = has('highlight')?.attrs?.color;
    if (hl) s += `<w:shd w:val="clear" w:color="auto" w:fill="${(/^#[0-9a-f]{6}$/i.test(hl) ? hl : '#ffff00').slice(1).toUpperCase()}"/>`;
    if (has('underline') || has('link')) s += '<w:u w:val="single"/>';
    if (has('link') && !ts.color) s += '<w:color w:val="1A5FD0"/>';
    if (has('superscript')) s += '<w:vertAlign w:val="superscript"/>';
    else if (has('subscript')) s += '<w:vertAlign w:val="subscript"/>';
    return s ? `<w:rPr>${s}</w:rPr>` : '';
  }

  function inlineXml(nodes = [], plain = false) {
    let out = '', link = null, linkBuf = '';
    const flushLink = () => { if (link) { out += `<w:hyperlink r:id="${rel('http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink', link, true)}">${linkBuf}</w:hyperlink>`; link = null; linkBuf = ''; } };
    for (const n of nodes) {
      const href = n.marks?.find((m) => m.type === 'link')?.attrs?.href || null;
      if (href !== link) { flushLink(); link = href; }
      let x = '';
      if (n.type === 'text') x = n.text.split('\n').map((t, i) => (i ? '<w:br/>' : '') + `<w:t xml:space="preserve">${xe(t)}</w:t>`).join('');
      else if (n.type === 'hardBreak') x = '<w:br/>';
      else if (n.type === 'tab') x = '<w:tab/>';
      else if (n.type === 'image') { out += flushAnd(() => imageXml(n)); continue; }
      else if (n.type === 'inlineMath') { const m = latexToOmml(n.attrs?.latex || '', LOST); if (link) linkBuf += m; else out += m; continue; }
      else { LOST(`알 수 없는 글 요소(${n.type})`); continue; }
      const r = `<w:r>${runProps(n.marks, plain)}${x}</w:r>`;
      if (link) linkBuf += r; else out += r;
    }
    flushLink();
    return out;
    function flushAnd(f) { flushLink(); return f(); }
  }

  function imageXml(n) {
    const src = n.attrs?.src || '';
    const m = /^data:(image\/(png|jpe?g|gif|bmp));base64,(.*)$/.exec(src);
    if (!m) { LOST('외부 주소 그림 (저장되지 않음)'); return ''; }
    const ext = m[2] === 'jpeg' || m[2] === 'jpg' ? 'jpeg' : m[2];
    const bin = Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0));
    const name = `media/image${++imgN}.${ext}`;
    media.push({ path: 'word/' + name, bytes: bin });
    const id = rel('http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', name);
    let w = Number(n.attrs.width) || 0, h = Number(n.attrs.height) || 0;
    if (!w || !h) { const d = imageSize(bin); if (d) { const k = Math.min(1, contentW / d.w); w = w || d.w * k; h = h || (d.h * (w / d.w)); } else { w = w || 200; h = h || 150; } }
    if (w > contentW) { h *= contentW / w; w = contentW; }
    const cx = Math.round(w * EMU), cy = Math.round(h * EMU), dn = ++drawN, alt = xe(n.attrs.alt || '');
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${dn}" name="그림 ${dn}" descr="${alt}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${dn}" name="image${dn}.${ext}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  }

  function pPrXml(n, extra = '') {
    const a = n.attrs || {};
    let s = '';
    if (n.type === 'heading') s += `<w:pStyle w:val="Heading${Math.min(6, a.level || 1)}"/>`;
    s += extra;
    if (a.tabLeader) s += `<w:tabs><w:tab w:val="right" w:leader="${a.tabLeader === 'hyphen' ? 'hyphen' : a.tabLeader === 'underscore' ? 'underscore' : 'dot'}" w:pos="${tw(contentW)}"/></w:tabs>`;
    const sp = [];
    if (a.spaceBefore) sp.push(`w:before="${tw(a.spaceBefore)}"`);
    if (a.spaceAfter != null) sp.push(`w:after="${tw(a.spaceAfter)}"`);
    if (a.lineHeight) sp.push(typeof a.lineHeight === 'string' && a.lineHeight.endsWith('px') ? `w:line="${tw(parseFloat(a.lineHeight))}" w:lineRule="exact"` : `w:line="${Math.round((Number(a.lineHeight) / 1.2) * 240)}" w:lineRule="auto"`);
    if (sp.length) s += `<w:spacing ${sp.join(' ')}/>`;
    const ind = [];
    const left = (a.indent || 0) + (a.hanging || 0);
    if (left) ind.push(`w:left="${tw(left)}"`);
    if (a.hanging) ind.push(`w:hanging="${tw(a.hanging)}"`);
    else if (a.firstLine) ind.push(`w:firstLine="${tw(a.firstLine)}"`);
    if (ind.length) s += `<w:ind ${ind.join(' ')}/>`;
    const jc = { center: 'center', right: 'right', justify: 'both' }[a.textAlign];
    if (jc) s += `<w:jc w:val="${jc}"/>`;
    return s ? `<w:pPr>${s}</w:pPr>` : '';
  }

  const listNum = { bulletList: 1, orderedList: 2 };
  function blockXml(n, ctx = {}) {
    switch (n.type) {
      case 'paragraph': case 'heading': {
        const extra = ctx.list ? `<w:numPr><w:ilvl w:val="${ctx.list.lvl}"/><w:numId w:val="${ctx.list.numId}"/></w:numPr>` : '';
        const pb = ctx.breakBefore ? '<w:pageBreakBefore/>' : '';
        return `<w:p>${pPrXml(n, pb + extra)}${inlineXml(n.content, n.type === 'heading' && n.attrs?.plain)}</w:p>`;
      }
      case 'pageBreak': return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
      case 'bulletList': case 'orderedList': {
        const lvl = ctx.list ? ctx.list.lvl + 1 : 0;
        return (n.content || []).map((li) => (li.content || []).map((b, i) => (b.type === 'bulletList' || b.type === 'orderedList') ? blockXml(b, { list: { lvl: lvl, numId: listNum[n.type] } }) : blockXml(b, i === 0 ? { list: { lvl: Math.min(8, lvl), numId: listNum[n.type] } } : { indentLvl: lvl })).join('')).join('');
      }
      case 'table': return tableXml(n);
      case 'blockMath': return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr>${latexToOmml(n.attrs?.latex || '', LOST, true)}</w:p>`;
      case 'blockquote': LOST('인용 블록 (일반 문단으로)'); return (n.content || []).map((b) => blockXml(b)).join('');
      case 'codeBlock': return (n.content?.[0]?.text || '').split('\n').map((t) => `<w:p><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr><w:t xml:space="preserve">${xe(t)}</w:t></w:r></w:p>`).join('');
      case 'horizontalRule': return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>';
      default: LOST(`알 수 없는 블록(${n.type})`); return '';
    }
  }

  function cssBorder(css, side) {
    const m = new RegExp(`border-${side}:([^;]+)`).exec(css || '');
    if (!m) return null;
    if (/none/.test(m[1])) return 'none';
    const w = parseFloat(m[1]) || 0.5, c = (/#([0-9a-f]{6})/i.exec(m[1]) || [, '000000'])[1];
    return `<w:${side} w:val="single" w:sz="${Math.max(2, Math.round(w * 8))}" w:space="0" w:color="${c.toUpperCase()}"/>`;
  }

  function tableXml(t) {
    const rows = t.content || [];
    // 격자: 행마다 rowspan 으로 덮인 칸을 계산해 vMerge continue 칸을 끼워 넣는다
    const nCols = Math.max(1, ...rows.map((r) => (r.content || []).reduce((s, c) => s + (c.attrs?.colspan || 1), 0)));
    const first = rows[0]?.content || [];
    const widths = [];
    for (const c of first) { const cw = c.attrs?.colwidth; for (let j = 0; j < (c.attrs?.colspan || 1); j++) widths.push(cw?.[j] || null); }
    while (widths.length < nCols) widths.push(null);
    const known = widths.filter(Boolean).reduce((a, b) => a + b, 0), unknown = widths.filter((w) => !w).length;
    const rest = unknown ? Math.max(30, (contentW - known) / unknown) : 0;
    const colW = widths.map((w) => w || rest);
    const total = colW.reduce((a, b) => a + b, 0);
    const style = t.attrs?.style || '';
    const jc = /margin-left:\s*auto/.test(style) && /margin-right:\s*auto/.test(style) ? 'center' : /margin-left:\s*auto/.test(style) ? 'right' : null;
    let x = `<w:tbl><w:tblPr><w:tblW w:w="${tw(total)}" w:type="dxa"/>${jc ? `<w:jc w:val="${jc}"/>` : ''}<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`).join('')}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr>`;
    x += `<w:tblGrid>${colW.map((w) => `<w:gridCol w:w="${tw(w)}"/>`).join('')}</w:tblGrid>`;
    const covered = new Map(); // "r:c" → {span, cell}
    rows.forEach((row, r) => {
      x += '<w:tr><w:trPr><w:cantSplit/></w:trPr>';
      let c = 0;
      const cells = [...(row.content || [])];
      const emitContinue = (cv) => { x += `<w:tc><w:tcPr><w:tcW w:w="${tw(colW.slice(c, c + cv.span).reduce((a, b) => a + b, 0))}" w:type="dxa"/>${cv.span > 1 ? `<w:gridSpan w:val="${cv.span}"/>` : ''}<w:vMerge/>${cellPr(cv.cell, true)}</w:tcPr><w:p/></w:tc>`; c += cv.span; };
      while (c < nCols) {
        const cv = covered.get(r + ':' + c);
        if (cv) { emitContinue(cv); continue; }
        const cell = cells.shift();
        if (!cell) { x += `<w:tc><w:tcPr><w:tcW w:w="${tw(colW[c])}" w:type="dxa"/></w:tcPr><w:p/></w:tc>`; c++; continue; }
        const span = cell.attrs?.colspan || 1, rs = cell.attrs?.rowspan || 1;
        for (let k = 1; k < rs; k++) covered.set((r + k) + ':' + c, { span, cell });
        const blocks = (cell.content || []).map((b) => blockXml(b)).join('') || '<w:p/>';
        const endsP = /<\/w:p>$|<w:p\/>$/.test(blocks);
        x += `<w:tc><w:tcPr><w:tcW w:w="${tw(colW.slice(c, c + span).reduce((a, b) => a + b, 0))}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}${rs > 1 ? '<w:vMerge w:val="restart"/>' : ''}${cellPr(cell)}</w:tcPr>${blocks}${endsP ? '' : '<w:p/>'}</w:tc>`;
        c += span;
      }
      x += '</w:tr>';
    });
    return x + '</w:tbl>';
  }
  function cellPr(cell) {
    const a = cell.attrs || {};
    let s = '';
    const sides = ['top', 'left', 'bottom', 'right'].map((sd) => cssBorder(a.cstyle, sd));
    if (sides.some(Boolean)) s += `<w:tcBorders>${sides.map((b, i) => (b === 'none' ? `<w:${['top', 'left', 'bottom', 'right'][i]} w:val="nil"/>` : b || '')).join('')}</w:tcBorders>`;
    if (a.background && /^#[0-9a-f]{6}$/i.test(a.background)) s += `<w:shd w:val="clear" w:color="auto" w:fill="${a.background.slice(1).toUpperCase()}"/>`;
    const pad = /padding:\s*([\d.]+)px\s+([\d.]+)px\s+([\d.]+)px\s+([\d.]+)px/.exec(a.cstyle || ''); // 칸 안쪽 여백 (위 오른쪽 아래 왼쪽)
    if (pad) s += `<w:tcMar>${['top', 'right', 'bottom', 'left'].map((sd, i) => `<w:${sd} w:w="${tw(+pad[i + 1])}" w:type="dxa"/>`).join('')}</w:tcMar>`;
    if (a.valign === 'middle') s += '<w:vAlign w:val="center"/>';
    else if (a.valign === 'bottom') s += '<w:vAlign w:val="bottom"/>';
    return s;
  }

  const bodyXml = (doc.content || []).map((n) => blockXml(n)).join('');
  // 바닥글·머리글
  const hfXml = (tag, text, align) => {
    const parts = String(text).split(/(\{n\}|\{total\})/).filter(Boolean).map((s) => (s === '{n}' ? fld('PAGE') : s === '{total}' ? fld('NUMPAGES') : `<w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${xe(s)}</w:t></w:r>`)).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${tag} ${NS}><w:p><w:pPr><w:jc w:val="${align || 'center'}"/></w:pPr>${parts}</w:p></w:${tag}>`;
  };
  const fld = (code) => `<w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:instrText xml:space="preserve"> ${code} </w:instrText></w:r><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t>1</w:t></w:r><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:fldChar w:fldCharType="end"/></w:r>`;
  const parts = {};
  let refs = '';
  const footText = [p0.footer || '', p0.pageNum && p0.pageNum !== 'none' ? '{n}' : ''].filter(Boolean).join('  ');
  if (footText) { const id = rel('http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer', 'footer1.xml'); parts['word/footer1.xml'] = hfXml('ftr', footText, p0.pageNum === 'right' ? 'right' : p0.pageNum === 'left' ? 'left' : 'center'); refs += `<w:footerReference w:type="default" r:id="${id}"/>`; }
  if (p0.header) { const id = rel('http://schemas.openxmlformats.org/officeDocument/2006/relationships/header', 'header1.xml'); parts['word/header1.xml'] = hfXml('hdr', p0.header, 'center'); refs = `<w:headerReference w:type="default" r:id="${id}"/>` + refs; }
  const mt = (v) => Math.round((v / 25.4) * 1440);
  const sect = `<w:sectPr>${refs}<w:pgSz w:w="${mt(wmm)}" w:h="${mt(hmm)}"${p0.orient === 'landscape' ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="${mt(p0.margin.t)}" w:right="${mt(p0.margin.r)}" w:bottom="${mt(p0.margin.b)}" w:left="${mt(p0.margin.l)}" w:header="${mt(Math.max(5, p0.margin.t * 0.4))}" w:footer="${mt(Math.max(5, p0.margin.b * 0.4))}" w:gutter="0"/></w:sectPr>`;
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${bodyXml}${sect}</w:body></w:document>`;
  const font = xe(fontName(p0.font) || '맑은 고딕');
  const lineAuto = Math.round(((p0.lineHeight || 1.2) / 1.2) * 240);
  const headSizes = [20, 16, 13, 12, 11, 10.5];
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:cs="${font}"/><w:sz w:val="${Math.round(baseSize * 2)}"/><w:szCs w:val="${Math.round(baseSize * 2)}"/><w:lang w:val="ko-KR" w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="${lineAuto}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${headSizes.map((sz, i) => `<w:style w:type="paragraph" w:styleId="Heading${i + 1}"><w:name w:val="heading ${i + 1}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="${i}"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="${Math.round((baseSize / 10) * sz * 2)}"/></w:rPr></w:style>`).join('')}<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`;
  const lvl = (i, fmt, text, ind) => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${ind}" w:hanging="360"/></w:pPr></w:lvl>`;
  const bullets = ['•', '◦', '▪'];
  const numFmts = ['decimal', 'lowerLetter', 'lowerRoman'];
  const numberingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${NS}><w:abstractNum w:abstractNumId="1">${Array.from({ length: 9 }, (_, i) => lvl(i, 'bullet', bullets[i % 3], 720 + i * 360)).join('')}</w:abstractNum><w:abstractNum w:abstractNumId="2">${Array.from({ length: 9 }, (_, i) => lvl(i, numFmts[i % 3], `%${i + 1}.`, 720 + i * 360)).join('')}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num></w:numbering>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>${rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${xe(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`;
  const exts = [...new Set(media.map((m) => m.path.split('.').pop()))];
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${exts.map((e) => `<Default Extension="${e}" ContentType="image/${e}"/>`).join('')}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>${parts['word/footer1.xml'] ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : ''}${parts['word/header1.xml'] ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : ''}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const files = {
    '[Content_Types].xml': types,
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>',
    'docProps/core.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xe(title)}</dc:title><dc:creator>FlexNote</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`,
    'docProps/app.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>FlexNote</Application></Properties>',
    'word/document.xml': document,
    'word/styles.xml': stylesXml,
    'word/numbering.xml': numberingXml,
    'word/settings.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings ${NS}><w:defaultTabStop w:val="720"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`,
    'word/_rels/document.xml.rels': docRels,
    ...parts,
  };
  const zipIn = {};
  for (const [k, v] of Object.entries(files)) zipIn[k] = strToU8(v);
  for (const m of media) zipIn[m.path] = [m.bytes, { level: 0 }];
  return { bytes: zipSync(zipIn, { level: 6 }), lost: [...lost].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)) };
}

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';

/** PNG·JPEG·GIF 크기 (px → pt 1:1 로 씀) */
function imageSize(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return { w: (b[16] << 24 | b[17] << 16 | b[18] << 8 | b[19]) * 0.75, h: (b[20] << 24 | b[21] << 16 | b[22] << 8 | b[23]) * 0.75 };
  if (b[0] === 0x47 && b[1] === 0x49) return { w: (b[6] | b[7] << 8) * 0.75, h: (b[8] | b[9] << 8) * 0.75 };
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i < b.length - 9;) {
      if (b[i] !== 0xff) { i++; continue; }
      const mk = b[i + 1], len = b[i + 2] << 8 | b[i + 3];
      if (mk >= 0xc0 && mk <= 0xc3) return { h: (b[i + 5] << 8 | b[i + 6]) * 0.75, w: (b[i + 7] << 8 | b[i + 8]) * 0.75 };
      i += 2 + len;
    }
  }
  return null;
}

/** LaTeX(자주 쓰는 것) → OMML. 모르는 명령은 글자로 두고 알림 */
export function latexToOmml(src, onLost = () => {}, block = false) {
  let i = 0;
  const s = src;
  const r = (t) => (t ? `<m:r><m:t xml:space="preserve">${xe(t)}</m:t></m:r>` : '');
  function group() {
    skip();
    if (s[i] === '{') { i++; const out = seq('}'); i++; return out; }
    return atom();
  }
  function skip() { while (s[i] === ' ') i++; }
  function seq(end) {
    let out = '';
    while (i < s.length && s[i] !== end) {
      if (end === '}' && s[i] === '}') break;
      let a = atom();
      // 위·아래 첨자
      for (;;) {
        skip();
        if (s[i] === '^' || s[i] === '_') {
          const k1 = s[i]; i++; const g1 = group();
          skip();
          if ((s[i] === '^' || s[i] === '_') && s[i] !== k1) { i++; const g2 = group(); const [sub, sup] = k1 === '_' ? [g1, g2] : [g2, g1]; a = `<m:sSubSup><m:e>${a}</m:e><m:sub>${sub}</m:sub><m:sup>${sup}</m:sup></m:sSubSup>`; }
          else a = k1 === '^' ? `<m:sSup><m:e>${a}</m:e><m:sup>${g1}</m:sup></m:sSup>` : `<m:sSub><m:e>${a}</m:e><m:sub>${g1}</m:sub></m:sSub>`;
        } else break;
      }
      out += a;
    }
    return out;
  }
  function atom() {
    skip();
    const c = s[i];
    if (c == null) return '';
    if (c === '{') return group();
    if (c === '\\') {
      i++;
      let name = '';
      while (i < s.length && /[a-zA-Z]/.test(s[i])) name += s[i++];
      if (!name) { const ch = s[i++]; return r(ch === '\\' ? '' : ch); }
      if (name === 'frac' || name === 'dfrac' || name === 'tfrac') return `<m:f><m:num>${group()}</m:num><m:den>${group()}</m:den></m:f>`;
      if (name === 'sqrt') { skip(); let deg = ''; if (s[i] === '[') { i++; deg = seq(']'); i++; } return `<m:rad><m:radPr><m:degHide m:val="${deg ? 0 : 1}"/></m:radPr><m:deg>${deg}</m:deg><m:e>${group()}</m:e></m:rad>`; }
      if (name === 'left' || name === 'right') { skip(); const ch = s[i] === '\\' ? s.substr(i, 2) : s[i]; i += ch.length; return r(ch === '.' ? '' : ch.replace('\\', '')); }
      if (name === 'text' || name === 'mathrm' || name === 'operatorname') { skip(); i++; let t = ''; while (i < s.length && s[i] !== '}') t += s[i++]; i++; return r(t); }
      const big = { sum: '∑', prod: '∏', int: '∫', iint: '∬', oint: '∮' }[name];
      if (big) return `<m:nary><m:naryPr><m:chr m:val="${big}"/></m:naryPr><m:sub></m:sub><m:sup></m:sup><m:e></m:e></m:nary>`;
      if (LATEX_SYM[name]) return r(LATEX_SYM[name]);
      const fn = ['sin', 'cos', 'tan', 'log', 'ln', 'exp', 'lim', 'max', 'min'];
      if (fn.includes(name)) return r(name);
      onLost(`수식 명령 \\${name} (글자로)`);
      return r('\\' + name);
    }
    i++;
    return r(c);
  }
  const inner = seq(null);
  return block ? `<m:oMathPara><m:oMath>${inner}</m:oMath></m:oMathPara>` : `<m:oMath>${inner}</m:oMath>`;
}
