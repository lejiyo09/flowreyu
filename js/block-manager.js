// 무한 캔버스·무한 스크롤 문서의 블록 단위 저장
//
// 편집할 때는 객체 배열 하나(page 0)로 다루고, 저장할 때만 배열을 CHUNK 개씩 잘라 블록 레코드로 쓴다.
// 객체는 불변이라 블록마다 "지난번 저장한 객체들과 같은 참조인지"만 비교하면 바뀐 블록을 알 수 있다.
// → 필기를 추가하면(가장 흔한 편집) 마지막 블록 하나만 다시 쓴다.
// 블록 레코드는 기존 pages 스토어에 page = -(블록 번호 + 1) 로 저장한다 (PDF 노트의 페이지 번호와 겹치지 않음).
export const CHUNK = 256;

export const blockKey = (k) => -(k + 1);
export const isBlockKey = (page) => page < 0;
export const blockIndex = (page) => -page - 1;

function chunks(items) {
  const out = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}
const same = (a, b) => a && b && a.length === b.length && a.every((x, i) => x === b[i]);

export class BlockManager {
  constructor() {
    this.saved = []; // 마지막으로 저장에 성공한 블록들 (객체 참조 배열)
  }

  /** 불러온 블록 레코드들 → 하나의 객체 배열 */
  load(records, clean) {
    const blocks = records.filter((r) => isBlockKey(r.page)).sort((a, b) => blockIndex(a.page) - blockIndex(b.page));
    const items = [];
    this.saved = [];
    for (const r of blocks) {
      const list = [];
      for (const raw of r.items) { const it = clean(raw); if (it) list.push(it); }
      items.push(...list);
    }
    this.saved = chunks(items); // 불러온 상태를 저장된 상태로 (다음 저장에서 쓸데없이 다시 쓰지 않도록)
    return items;
  }

  /** 저장할 변경: {put:[{page, items}], del:[page], next} — next 는 저장에 성공하면 commit(next) */
  diff(items) {
    const next = chunks(items);
    const put = [], del = [];
    next.forEach((c, k) => { if (!same(c, this.saved[k])) put.push({ page: blockKey(k), items: c }); });
    for (let k = next.length; k < this.saved.length; k++) del.push(blockKey(k));
    return { put, del, next };
  }

  commit(next) { this.saved = next; }
}
