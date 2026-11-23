// 타이핑형 노트: 키보드로 쓰는 쪽(페이지) 문서 편집기 (한글·Word 처럼)
//
// 구조
//  - 편집기(Tiptap/ProseMirror, vendor/tiptap)는 뷰어 월드(#world) 안의 종이 위에 놓인다.
//    → 확대·이동(카메라), 페이지 배치, 필기 도구(펜·형광펜·지우개·올가미·레이어·실행 취소)를 PDF 노트와 그대로 함께 쓴다.
//      필기는 페이지 좌표로 저장되어 글이 다시 흘러도 그 페이지 그 자리에 남는다(필기 위치 고정).
//  - 쪽 나눔: 블록(문단·제목·목록·그림)과 표의 행마다 위치를 재서, 쪽 경계에 걸치면 그 앞에 빈 칸(위젯)을 넣어 다음 쪽으로 민다.
//    표는 행 단위로 다음 쪽에 이어지고, 쪽 나누기(Ctrl+Enter)는 다음 블록을 새 쪽에서 시작한다.
//    한 문단이 한 쪽보다 길면 그 문단은 나누지 않는다(알려진 한계).
//  - 단위: 월드 1 = 1pt (PDF 노트와 같음). 글자 크기 "12px" 로 저장된 값은 12pt 와 같다.
import {
  Editor, Extension, Node, StarterKit, TextStyleKit, TextAlign, TableKit, Image, Highlight, Subscript, Superscript, Mathematics,
  Plugin, PluginKey, Decoration, DecorationSet,
} from '../vendor/tiptap/tiptap.mjs';
import { clamp } from './util.js';
import { pageGeom, GAP } from './typing-page.js';
export { PAPER, MARGINS, FONTS, DEFAULT_PAGE, pageGeom } from './typing-page.js';

const SCREEN_MARGIN = 16; // 화면 가장자리 여백 (px)
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ───────────────────────────── 뷰어 엔진 (쪽 배치·카메라) ─────────────────────────────

export class TypingEngine {
  constructor(page) {
    this.kind = 'typing';
    this.count = 1;
    this.setPage(page);
    this.host = document.createElement('div');
    this.host.className = 'typing-host';
  }

  setPage(page) {
    this.g = pageGeom(page);
    this.W = this.g.W;
  }

  update() { return false; }

  layout(v) {
    const g = this.g;
    // 쪽 요소를 개수에 맞춤 (편집기 아래에 깔림)
    while (v.pages.length < this.count) {
      const el = document.createElement('div');
      el.className = 'page typing-page';
      v.pages.push({ index: v.pages.length, w: 0, h: 0, x: 0, y: 0, el, base: null, baseScale: 0, detail: null, detailKey: '', vt: null, sized: true, proxy: null });
    }
    while (v.pages.length > this.count) v.pages.pop().el.remove();
    const total = v.pages.length;
    v.pages.forEach((p, k) => {
      p.index = k; p.x = 0; p.y = k * g.stride; p.w = g.W; p.h = g.H;
      p.el.dataset.page = k;
      p.el.className = 'page typing-page';
      if (p.el.parentNode !== v.world) v.world.insertBefore(p.el, this.host.parentNode === v.world ? this.host : null);
      Object.assign(p.el.style, { left: '0px', top: p.y + 'px', width: g.W + 'px', height: g.H + 'px' });
      p.el.innerHTML = this.decor(k, total);
    });
    if (this.host.parentNode !== v.world) v.world.appendChild(this.host);
    Object.assign(this.host.style, { left: g.ml + 'px', top: g.mt + 'px', width: g.contentW + 'px', '--page-h': g.contentH + 'px' });
    v.contentW = g.W;
    v.contentH = total * g.stride - GAP;
    v.fitZ = this.fitZ(v);
  }

  /** 머리글·바닥글·쪽 번호 ({n} = 쪽, {total} = 전체 쪽) */
  decor(k, total) {
    const { page: p, ml, mr, mt, mb } = this.g;
    const sub = (s) => esc(s).replace(/\{n\}/g, k + 1).replace(/\{total\}/g, total);
    let html = '';
    if (p.header) html += `<div class="pg-hf pg-head" style="left:${ml}px;right:${mr}px;top:${mt * 0.4}px">${sub(p.header)}</div>`;
    const num = p.pageNum && p.pageNum !== 'none' ? `- ${k + 1} -` : '';
    const foot = [p.footer ? sub(p.footer) : '', num].filter(Boolean).join('　');
    if (foot) html += `<div class="pg-hf pg-foot" style="left:${ml}px;right:${mr}px;bottom:${mb * 0.4}px;text-align:${p.pageNum === 'right' ? 'right' : p.pageNum === 'left' ? 'left' : 'center'}">${foot}</div>`;
    return html;
  }

  setCount(v, n) {
    n = Math.max(1, n);
    if (n === this.count) return false;
    this.count = n;
    this.layout(v);
    v.clampCamera();
    v.applyCamera();
    v.emit('sized');
    return true;
  }

  fitZ(v) { return (v.vw - SCREEN_MARGIN * 2) / this.g.W; }
  minZ(v) { return Math.min(this.fitZ(v) * 0.25, ((v.vh - SCREEN_MARGIN * 2) / this.g.H) * 0.5); }
  maxZ(v) { return Math.max(this.fitZ(v) * 6, 6); }

  clamp(v, c) {
    c.z = clamp(c.z, this.minZ(v), this.maxZ(v));
    const cw = v.contentW * c.z, ch = v.contentH * c.z;
    if (cw + SCREEN_MARGIN * 2 <= v.vw) c.tx = (v.vw - cw) / 2;
    else c.tx = clamp(c.tx, v.vw - cw - SCREEN_MARGIN, SCREEN_MARGIN);
    const top = SCREEN_MARGIN + v.insetTop, bottom = v.vh - ch - SCREEN_MARGIN * 4;
    c.ty = clamp(c.ty, Math.min(bottom, top), top);
    return c;
  }

  anchor(v) {
    const w = v.toWorld(v.vw / 2, v.insetTop);
    return { kind: 'typing', y: w.y, fx: w.x / this.g.W, zr: v.cam.z / this.fitZ(v) };
  }

  restore(v, view) {
    const fz = Math.min(this.fitZ(v), 1.6); // 넓은 화면에서도 너무 크지 않게
    if (view?.kind === 'typing' && Number.isFinite(view.y) && Number.isFinite(view.zr)) {
      const z = clamp(view.zr * this.fitZ(v), this.minZ(v), this.maxZ(v));
      v.setCamera(v.vw / 2 - view.fx * this.g.W * z, v.insetTop - view.y * z, z);
    } else v.setCamera((v.vw - this.g.W * fz) / 2, SCREEN_MARGIN + v.insetTop, fz);
  }

  fit(v, mode) {
    const a = this.anchor(v);
    if (mode === 'page') {
      const z = Math.min(this.fitZ(v), (v.vh - v.insetTop - SCREEN_MARGIN * 2) / this.g.H);
      const i = clamp(Math.floor(a.y / this.g.stride + 0.5), 0, this.count - 1);
      v.setCamera((v.vw - this.g.W * z) / 2, SCREEN_MARGIN + v.insetTop - i * this.g.stride * z, z);
      return;
    }
    this.restore(v, { ...a, fx: 0.5, zr: 1 });
  }

  drawBackground() {}

  dispose() { this.host.remove(); }
}

// ───────────────────────────── 편집기 확장 ─────────────────────────────

/** 쪽 나누기 (Ctrl+Enter): 다음 블록을 새 쪽에서 시작 */
const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,
  selectable: true,
  parseHTML() { return [{ tag: 'div[data-page-break]' }, { tag: 'hr[data-page-break]' }]; },
  renderHTML() { return ['div', { 'data-page-break': '', class: 'pg-break', contenteditable: 'false' }]; },
  addCommands() {
    return {
      // 표 칸 안에서는 쪽을 나눌 수 없음 (본문에서만)
      setPageBreak: () => ({ editor, chain }) => !editor.isActive('table') && chain().insertContent([{ type: 'pageBreak' }, { type: 'paragraph' }]).run(),
    };
  },
  addKeyboardShortcuts() { return { 'Mod-Enter': () => this.editor.commands.setPageBreak() }; },
});

/** 문단 서식: 들여쓰기·내어쓰기·문단 뒤 간격·줄 간격 (문단·제목에 붙는 속성) */
const ParagraphFormat = Extension.create({
  name: 'paragraphFormat',
  addGlobalAttributes() {
    const num = (v) => (v == null || v === '' ? null : Number(v));
    return [{
      types: ['paragraph', 'heading'],
      attributes: {
        indent: { default: 0, parseHTML: (el) => num(el.dataset.indent) || 0, renderHTML: (a) => (a.indent ? { 'data-indent': a.indent, style: `margin-left:${a.indent}px` } : {}) },
        hanging: { default: 0, parseHTML: (el) => num(el.dataset.hanging) || 0, renderHTML: (a) => (a.hanging ? { 'data-hanging': a.hanging, style: `padding-left:${a.hanging}px;text-indent:-${a.hanging}px` } : {}) },
        spaceAfter: { default: null, parseHTML: (el) => num(el.dataset.spaceAfter), renderHTML: (a) => (a.spaceAfter != null ? { 'data-space-after': a.spaceAfter, style: `margin-bottom:${a.spaceAfter}px` } : {}) },
        lineHeight: { default: null, parseHTML: (el) => num(el.dataset.lineHeight), renderHTML: (a) => (a.lineHeight ? { 'data-line-height': a.lineHeight, style: `line-height:${a.lineHeight}` } : {}) },
      },
    }];
  },
  addCommands() {
    const setAll = (attrs) => ({ commands }) => { commands.updateAttributes('paragraph', attrs); commands.updateAttributes('heading', attrs); return true; };
    const step = (dir) => ({ editor, commands }) => {
      if (editor.isActive('listItem')) return dir > 0 ? commands.sinkListItem('listItem') : commands.liftListItem('listItem');
      const cur = editor.getAttributes(editor.isActive('heading') ? 'heading' : 'paragraph').indent || 0;
      return setAll({ indent: Math.max(0, cur + dir * 20) })({ commands });
    };
    return {
      setParagraphFormat: (attrs) => setAll(attrs),
      indentMore: () => step(1),
      indentLess: () => step(-1),
    };
  },
  addKeyboardShortcuts() {
    return {
      Tab: () => (this.editor.isActive('table') ? false : this.editor.commands.indentMore()),
      'Shift-Tab': () => (this.editor.isActive('table') ? false : this.editor.commands.indentLess()),
    };
  },
});

// ───────────────────────────── 쪽 나눔 ─────────────────────────────

const pgKey = new PluginKey('pagination');

function gapWidget(h, cols) {
  return () => {
    const el = document.createElement(cols ? 'tr' : 'div');
    el.className = 'pg-gap';
    el.contentEditable = 'false';
    // 칸 수는 표와 똑같이 (더 크게 잡으면 고정 배치 표가 그만큼 열을 나눠 칸이 좁아짐)
    if (cols) { const td = document.createElement('td'); td.colSpan = cols; td.style.height = h + 'px'; el.appendChild(td); }
    else el.style.height = h + 'px';
    return el;
  };
}

function buildGaps(doc, gaps) {
  return DecorationSet.create(doc, gaps.map((g) => Decoration.widget(g.pos, gapWidget(g.h, g.row), { side: -1, ignoreSelection: true, key: `g${g.pos}:${g.h}:${g.row || 'b'}` })));
}

/**
 * 블록·표 행 위치를 재서 쪽 경계에 걸치는 것 앞에 빈 칸을 넣는다.
 * 재는 값은 지금 들어 있는 빈 칸 높이를 빼고 계산하므로 몇 번 반복해도 같은 결과로 수렴한다.
 */
function paginationPlugin(geom, onPages) {
  return new Plugin({
    key: pgKey,
    state: {
      init: () => ({ gaps: [], set: DecorationSet.empty }),
      apply(tr, old) {
        const gaps = tr.getMeta(pgKey);
        if (gaps) return { gaps, set: buildGaps(tr.doc, gaps) };
        if (!tr.docChanged) return old;
        return { gaps: old.gaps.map((g) => ({ ...g, pos: tr.mapping.map(g.pos, -1) })), set: old.set.map(tr.mapping, tr.doc) };
      },
    },
    props: { decorations: (state) => pgKey.getState(state).set },
    view(view) {
      let raf = 0;
      const run = () => { raf = 0; measure(view, geom(), onPages); };
      const schedule = () => { if (!raf) raf = requestAnimationFrame(run); };
      schedule();
      // 그림을 다 읽으면 높이가 바뀜
      const onLoad = (e) => { if (e.target.tagName === 'IMG') schedule(); };
      view.dom.addEventListener('load', onLoad, true);
      return { update: schedule, destroy() { cancelAnimationFrame(raf); view.dom.removeEventListener('load', onLoad, true); } };
    },
  });
}

export function measure(view, g, onPages) {
  const root = view.dom;
  if (!root.isConnected || !root.offsetHeight) return;
  const r0 = root.getBoundingClientRect();
  const scale = r0.height / root.offsetHeight || 1;
  const rel = (el) => { const r = el.getBoundingClientRect(); return { t: (r.top - r0.top) / scale, h: r.height / scale }; };
  const gapEls = [...root.querySelectorAll('.pg-gap')].map((el) => rel(el));
  const items = [];
  view.state.doc.forEach((node, offset) => {
    const dom = view.nodeDOM(offset);
    if (!(dom instanceof HTMLElement)) return;
    if (node.type.name === 'table') {
      let cols = 0;
      node.firstChild?.forEach((cell) => { cols += cell.attrs.colspan || 1; });
      node.forEach((row, rOff) => { const pos = offset + 1 + rOff; const el = view.nodeDOM(pos); if (el instanceof HTMLElement) items.push({ pos, el, row: Math.max(1, cols) }); });
    } else items.push({ pos: offset, el: dom, brk: node.type.name === 'pageBreak' });
  });
  const { stride, contentH } = g;
  let shift = 0, bottom = 0, forceNext = false;
  const want = [];
  for (const it of items) {
    const { t, h } = rel(it.el);
    const above = gapEls.reduce((n, gp) => n + (gp.t < t - 0.5 ? gp.h : 0), 0);
    let top = t - above + shift;
    const k = Math.floor((top + 0.01) / stride), start = k * stride, end = start + contentH, next = start + stride;
    let push = 0;
    if (forceNext) { if (top > start + 0.5) push = next - top; forceNext = false; }
    else if (top >= end - 0.5) push = next - top; // 쪽 아래 여백에서 시작
    else if (top + h > end + 0.5 && h <= contentH && top > start + 0.5) push = next - top; // 쪽 경계에 걸침
    if (it.brk) forceNext = true;
    if (push > 0.5) { push = Math.round(push * 100) / 100; want.push({ pos: it.pos, h: push, row: it.row || 0 }); shift += push; top += push; }
    bottom = Math.max(bottom, top + h);
  }
  const cur = pgKey.getState(view.state).gaps;
  const same = cur.length === want.length && cur.every((c, i) => c.pos === want[i].pos && c.row === want[i].row && Math.abs(c.h - want[i].h) < 0.6);
  if (!same) view.dispatch(view.state.tr.setMeta(pgKey, want).setMeta('addToHistory', false));
  onPages?.(Math.max(1, Math.floor(Math.max(0, bottom - 0.5) / stride) + 1));
}

// ───────────────────────────── 편집기 만들기 ─────────────────────────────

let katexCss = false;
function loadKatexCss() {
  if (katexCss) return;
  katexCss = true;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = new URL('../vendor/katex/katex.min.css', import.meta.url).href;
  document.head.appendChild(l);
}

/**
 * @param host  TypingEngine.host
 * @param o {content, page, onPages(n), onUpdate(), onSelection(), onMathEdit(node,pos,kind)}
 */
export function createEditor(host, o) {
  loadKatexCss();
  let g = pageGeom(o.page);
  const editor = new Editor({
    element: host,
    content: o.content || '<p></p>',
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true, defaultProtocol: 'https' } }), // 끝에 늘 빈 문단 (표·그림 뒤에도 이어 쓰기)
      TextStyleKit,
      TextAlign.configure({ types: ['heading', 'paragraph'], alignments: ['left', 'center', 'right', 'justify'] }),
      Highlight.configure({ multicolor: true }),
      Subscript, Superscript,
      TableKit.configure({ table: { resizable: true, cellMinWidth: 24 } }),
      Image.configure({ allowBase64: true, resize: { enabled: true, alwaysPreserveAspectRatio: true, minWidth: 24, minHeight: 24 } }),
      Mathematics.configure({
        katexOptions: { throwOnError: false },
        inlineOptions: { onClick: (node, pos) => o.onMathEdit?.(node, pos, 'inline') },
        blockOptions: { onClick: (node, pos) => o.onMathEdit?.(node, pos, 'block') },
      }),
      PageBreak, ParagraphFormat,
      Extension.create({ name: 'pagination', addProseMirrorPlugins: () => [paginationPlugin(() => g, (n) => o.onPages?.(n))] }),
    ],
    editorProps: { attributes: { class: 'typing-doc', spellcheck: 'false' } },
    // 글이 바뀌거나 커서가 움직였을 때만 (쪽 나눔 빈 칸만 바뀐 경우는 화면을 커서로 끌고 가지 않도록 구분)
    onUpdate: () => { o.onUpdate?.(); o.onSelection?.(true); },
    onSelectionUpdate: () => o.onSelection?.(true),
    onTransaction: ({ transaction }) => { if (!transaction.docChanged && !transaction.selectionSet) o.onSelection?.(false); },
  });
  applyPageStyle(host, g);
  return {
    editor,
    setPage(page) { g = pageGeom(page); applyPageStyle(host, g); measure(editor.view, g, o.onPages); },
    remeasure() { measure(editor.view, g, o.onPages); },
    destroy() { editor.destroy(); },
  };
}

function applyPageStyle(host, g) {
  host.style.fontFamily = g.page.font;
  host.style.fontSize = g.page.fontSize + 'px';
  host.style.setProperty('--page-h', g.contentH + 'px');
}

/** 그림 파일 → data URL (긴 변 1600px 이하로 줄임: 문서 저장이 무거워지지 않게) */
export async function imageToDataUrl(file, max = 1600) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return { src: c.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.9), w: c.width, h: c.height };
}
