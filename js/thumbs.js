// 페이지 썸네일 패널: 보이는 썸네일만 지연 렌더링, 필기도 함께 표시
import { drawItem, isHighlighter } from './ink.js';
import { debounce } from './util.js';

const THUMB_W = 130;

export class ThumbPanel {
  constructor(panel, list, viewer, onPick) {
    this.panel = panel;
    this.list = list;
    this.viewer = viewer;
    this.onPick = onPick;
    this.items = [];
    this.pdfCache = new Map(); // page -> canvas(PDF만)
    this.queue = new Set();
    this.busy = false;
    this.cur = -1;
    this.io = new IntersectionObserver((ents) => {
      for (const e of ents) {
        const i = +e.target.dataset.page;
        if (e.isIntersecting) { this.queue.add(i); } else this.queue.delete(i);
      }
      this.pump();
    }, { root: list, rootMargin: '300px 0px' });
    this.dirtyInk = new Set();
    this._inkSoon = debounce(() => { for (const p of this.dirtyInk) this.drawInk(p); this.dirtyInk.clear(); }, 400);
  }

  get open() { return !this.panel.hidden; }

  build() {
    this.io.disconnect();
    this.list.innerHTML = '';
    this.items = [];
    this.pdfCache.clear();
    this.queue.clear();
    const frag = document.createDocumentFragment();
    for (const p of this.viewer.pages) {
      const el = document.createElement('div');
      el.className = 'thumb';
      el.dataset.page = p.index;
      const box = document.createElement('div');
      box.className = 'tcv';
      box.style.height = Math.round(THUMB_W * p.h / p.w) + 'px';
      const label = document.createElement('span');
      label.textContent = p.index + 1;
      el.append(box, label);
      el.addEventListener('click', () => this.onPick(p.index));
      frag.appendChild(el);
      this.items.push({ el, box, canvas: null });
    }
    this.list.appendChild(frag);
    if (this.open) for (const it of this.items) this.io.observe(it.el);
  }

  show(v) {
    this.panel.hidden = !v;
    if (v) {
      for (const it of this.items) this.io.observe(it.el);
      this.setCurrent(this.viewer.currentPage(), true);
    } else this.io.disconnect();
  }

  /** 페이지 크기 정보가 나중에 갱신되면 높이 보정 */
  resizeBoxes() {
    for (const p of this.viewer.pages) {
      const it = this.items[p.index];
      if (it) it.box.style.height = Math.round(THUMB_W * p.h / p.w) + 'px';
    }
  }

  setCurrent(i, scroll) {
    if (i === this.cur && !scroll) return;
    this.items[this.cur]?.el.classList.remove('cur');
    this.cur = i;
    const it = this.items[i];
    if (!it) return;
    it.el.classList.add('cur');
    if (scroll && this.open) it.el.scrollIntoView({ block: 'center' });
  }

  async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.size && this.open) {
        if (this.viewer.renderPaused) { await new Promise((r) => setTimeout(r, 200)); continue; }
        const i = this.queue.values().next().value;
        this.queue.delete(i);
        if (this.pdfCache.has(i) || !this.viewer.pdf) continue;
        await this.renderPdf(i);
        this.drawInk(i);
      }
    } catch (e) { console.warn('thumb', e); }
    finally { this.busy = false; }
  }

  async renderPdf(i) {
    const p = this.viewer.pages[i];
    const page = await this.viewer.pdf.getPage(i + 1);
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const scale = (THUMB_W / p.w) * dpr;
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp, background: '#ffffff' }).promise;
    this.pdfCache.set(i, c);
  }

  markInk(page) {
    if (!this.open || !this.pdfCache.has(page)) return;
    this.dirtyInk.add(page);
    this._inkSoon();
  }

  drawInk(i) {
    const it = this.items[i], base = this.pdfCache.get(i);
    if (!it || !base) return;
    if (!it.canvas) { it.canvas = document.createElement('canvas'); it.box.appendChild(it.canvas); }
    const c = it.canvas;
    c.width = base.width; c.height = base.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(base, 0, 0);
    const items = this.viewer.doc?.items(i) || [];
    if (!items.length) return;
    const s = c.width / this.viewer.pages[i].w;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.globalCompositeOperation = 'multiply';
    for (const item of items) if (isHighlighter(item)) drawItem(ctx, item);
    ctx.globalCompositeOperation = 'source-over';
    for (const item of items) if (!isHighlighter(item)) drawItem(ctx, item);
  }

  clear() { this.io.disconnect(); this.list.innerHTML = ''; this.items = []; this.pdfCache.clear(); this.queue.clear(); this.cur = -1; }
}
