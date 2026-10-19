// 열려 있는 문서의 필기 상태, Undo/Redo, 자동 저장
//
// Undo/Redo는 "페이지 배열 스냅샷" 방식이다. 객체는 불변(immutable)으로 다루기 때문에
// 스냅샷은 참조 배열의 얕은 복사일 뿐이라 메모리 부담이 작다.
// Undo/Redo 역시 일반 편집과 똑같이 페이지를 dirty로 표시하므로 저장 상태와 항상 일치한다.
import { Emitter, debounce } from './util.js';
import { sanitizeItem } from './ink.js';
import * as store from './store.js';

const HISTORY_LIMIT = 300;
const SAVE_DELAY = 500;

export class NoteDocument extends Emitter {
  constructor(meta) {
    super();
    this.meta = meta; // docs 레코드
    this.id = meta.id;
    this.pages = new Map(); // page -> items[]
    this.rev = new Map(); // page -> 변경 횟수
    this.dirty = new Set();
    this.undoStack = [];
    this.redoStack = [];
    this.tx = null; // 진행 중인 묶음 편집 {pages: Map(page -> before)}
    this.saveState = 'saved'; // saved | pending | saving | error
    this.saveError = null;
    this.saving = null;
    this.retryMs = 0;
    this.closed = false;
    this._saveSoon = debounce(() => this.save(), SAVE_DELAY);
  }

  /** 저장소에서 필기 로드 (손상된 객체는 건너뛰고 개수를 보고) */
  async load() {
    const recs = await store.loadPages(this.id);
    let skipped = 0;
    for (const r of recs) {
      if (!Number.isInteger(r.page) || !Array.isArray(r.items)) { skipped++; continue; }
      const items = [];
      for (const raw of r.items) {
        const it = sanitizeItem(raw);
        if (it) items.push(it); else skipped++;
      }
      this.pages.set(r.page, items);
      this.rev.set(r.page, r.rev || 0);
    }
    return { skipped };
  }

  items(page) { return this.pages.get(page) || EMPTY; }

  /** 묶음 편집 시작: 여러 번 바꿔도 Undo 한 번으로 되돌아간다 */
  begin() { if (!this.tx) this.tx = { pages: new Map() }; }

  _touch(page) {
    if (this.tx && !this.tx.pages.has(page)) this.tx.pages.set(page, this.items(page));
  }

  /** 페이지 객체 배열 교체 (불변 갱신) */
  setItems(page, items, { record = true, appended = null } = {}) {
    const auto = record && !this.tx;
    if (auto) this.begin();
    if (record) this._touch(page);
    this.pages.set(page, items);
    this._markDirty(page);
    if (auto) this.commit();
    this.emit('change', { page, appended });
  }

  /** 맨 위에 객체 추가. appended 로 알려 화면은 새 객체만 덧그리면 된다 */
  add(page, item) { this.setItems(page, [...this.items(page), item], { appended: item }); }

  commit() {
    const tx = this.tx;
    this.tx = null;
    if (!tx || tx.pages.size === 0) return false;
    const entry = [];
    for (const [page, before] of tx.pages) {
      const after = this.items(page);
      if (before !== after) entry.push({ page, before, after });
    }
    if (!entry.length) return false;
    this.undoStack.push(entry);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
    this.emit('history');
    return true;
  }

  /** 묶음 편집 취소: 시작 전 상태로 복원 */
  rollback() {
    const tx = this.tx;
    this.tx = null;
    if (!tx) return;
    for (const [page, before] of tx.pages) {
      this.pages.set(page, before);
      this._markDirty(page);
      this.emit('change', { page });
    }
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  undo() {
    if (this.tx) this.commit();
    const entry = this.undoStack.pop();
    if (!entry) return null;
    for (const e of entry) { this.pages.set(e.page, e.before); this._markDirty(e.page); this.emit('change', { page: e.page }); }
    this.redoStack.push(entry);
    this.emit('history');
    return entry[0].page;
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    for (const e of entry) { this.pages.set(e.page, e.after); this._markDirty(e.page); this.emit('change', { page: e.page }); }
    this.undoStack.push(entry);
    this.emit('history');
    return entry[0].page;
  }

  _markDirty(page) {
    this.rev.set(page, (this.rev.get(page) || 0) + 1);
    this.dirty.add(page);
    this._setState('pending');
    this._saveSoon();
  }

  _setState(s, err = null) {
    if (this.saveState === s && !err) return;
    this.saveState = s;
    this.saveError = err;
    this.emit('save', { state: s, error: err });
  }

  /** dirty 페이지 저장. 저장 도중 새 변경이 생기면 끝난 뒤 다시 저장한다. */
  async save() {
    if (this.closed && !this.dirty.size) return true;
    while (this.saving) await this.saving.catch(() => {});
    if (!this.dirty.size) { if (this.saveState !== 'error') this._setState('saved'); return this.saveState !== 'error'; }
    const pages = [...this.dirty];
    const snapshot = pages.map((p) => ({ page: p, items: this.items(p), rev: this.rev.get(p) || 0 }));
    this.dirty.clear();
    this._setState('saving');
    this.saving = store.savePages(this.id, snapshot);
    try {
      await this.saving;
      this.retryMs = 0;
      if (this.dirty.size) { this._saveSoon(); this._setState('pending'); }
      else this._setState('saved');
      return true;
    } catch (err) {
      // 실패한 페이지를 다시 dirty로 돌려 놓고 재시도
      for (const p of pages) this.dirty.add(p);
      this._setState('error', err);
      console.error('[save] 실패', err);
      this.retryMs = Math.min((this.retryMs || 1000) * 2, 30000);
      if (!this.closed) setTimeout(() => { if (this.saveState === 'error') this.save(); }, this.retryMs);
      return false;
    } finally {
      this.saving = null;
    }
  }

  /** 즉시 저장 (페이지 이탈, 백그라운드 전환 시) */
  flush() {
    this._saveSoon.cancel();
    return this.save();
  }

  async close() {
    if (this.tx) this.commit();
    await this.flush();
    this.closed = true;
  }

  /**
   * 페이지 번호 재배치 (페이지 추가/삭제 후). map(oldIndex) → newIndex, 삭제된 페이지는 -1.
   * Undo 기록의 페이지 번호도 함께 옮겨서 이전 편집을 계속 되돌릴 수 있게 한다.
   */
  remapPages(map) {
    if (this.tx) this.commit();
    const remap = (m) => {
      const out = new Map();
      for (const [k, v] of m) { const n = map(k); if (n >= 0) out.set(n, v); }
      return out;
    };
    this.pages = remap(this.pages);
    // 사용자 링크의 대상 페이지 번호도 옮긴다 (삭제된 페이지를 가리키면 대상 없음)
    for (const [pg, items] of this.pages) {
      if (!items.some((it) => it.t === 'ln' && Number.isInteger(it.to?.page))) continue;
      this.pages.set(pg, items.map((it) => {
        if (it.t !== 'ln' || !Number.isInteger(it.to?.page)) return it;
        const n = map(it.to.page);
        return { ...it, to: n >= 0 ? { page: n } : {} };
      }));
    }
    this.rev = remap(this.rev);
    this.dirty = new Set([...this.dirty].map(map).filter((n) => n >= 0));
    const fix = (stack) => stack
      .map((entry) => entry.map((e) => ({ ...e, page: map(e.page) })).filter((e) => e.page >= 0))
      .filter((entry) => entry.length);
    this.undoStack = fix(this.undoStack);
    this.redoStack = fix(this.redoStack);
    this.emit('history');
  }

  /** 저장용 전체 레코드 */
  allRecords() {
    return [...this.pages].map(([page, items]) => ({ page, items, rev: this.rev.get(page) || 0 }));
  }

  /** 구조 변경 저장이 끝난 뒤: 모든 변경이 저장된 상태 */
  markAllSaved() {
    this._saveSoon.cancel();
    this.dirty.clear();
    this._setState('saved');
  }

  totalItems() {
    let n = 0;
    for (const it of this.pages.values()) n += it.length;
    return n;
  }
}

const EMPTY = Object.freeze([]);
