// 객체 공간 검색 (격자 버킷)
//
// 무한 캔버스·긴 스크롤 문서에서 화면에 보이는 객체만 골라 그리기 위해 쓴다.
// 객체 배열은 불변이므로 배열 하나당 인덱스를 한 번 만들어 WeakMap 에 캐시한다 (배열이 바뀌면 새로 만듦).
// 결과는 배열 안의 위치(인덱스)를 오름차순으로 돌려주므로 그리기 순서(레이어·쌓인 순서)가 그대로 유지된다.
// 객체 수가 매우 많아지면 R-Tree 로 바꿀 수 있도록 build/query 두 함수만 노출한다.
import { bbox } from './ink.js';

const CELL = 512; // 격자 한 칸 (페이지 단위)
const cache = new WeakMap();

/** items 배열의 격자 인덱스 */
export function buildIndex(items) {
  let idx = cache.get(items);
  if (idx) return idx;
  const cells = new Map();
  const big = []; // 칸을 너무 많이 덮는 큰 객체는 따로 (항상 후보)
  for (let i = 0; i < items.length; i++) {
    const b = bbox(items[i]);
    const x0 = Math.floor(b.x / CELL), x1 = Math.floor((b.x + b.w) / CELL);
    const y0 = Math.floor(b.y / CELL), y1 = Math.floor((b.y + b.h) / CELL);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 64) { big.push(i); continue; }
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const k = cx + ',' + cy;
      const list = cells.get(k);
      if (list) list.push(i); else cells.set(k, [i]);
    }
  }
  idx = { cells, big, n: items.length };
  cache.set(items, idx);
  return idx;
}

/** rect(페이지 좌표)와 겹칠 수 있는 객체의 위치 목록 (오름차순, 중복 없음) */
export function queryIndex(items, rect) {
  const idx = buildIndex(items);
  const x0 = Math.floor(rect.x / CELL), x1 = Math.floor((rect.x + rect.w) / CELL);
  const y0 = Math.floor(rect.y / CELL), y1 = Math.floor((rect.y + rect.h) / CELL);
  // 아주 넓은 영역(많이 축소)이면 전부 훑는 편이 빠르다
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > idx.cells.size) return null;
  const seen = new Set(idx.big);
  for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
    const list = idx.cells.get(cx + ',' + cy);
    if (list) for (const i of list) seen.add(i);
  }
  return [...seen].sort((a, b) => a - b);
}
