// 객체 편집: 묶기(그룹), 앞뒤 순서, 정렬·간격 맞추기, 복사할 객체 꾸리기
//
// 모두 "객체 배열 → 새 객체 배열"인 순수 함수다 (객체는 불변, 호출하는 쪽이 doc.setItems 로 한 번에 반영 → 실행 취소 한 번).
// 묶음 단위(unit): 정렬·간격 맞추기에서 함께 움직이는 덩어리.
//   - 같은 그룹(gp)의 객체들
//   - 포스트잇과 그 위에 넣은 것 (noteAttached)
//   - 그 밖의 객체는 하나씩
import { bbox, transformItem, noteAttached } from './ink.js';
import { uid } from './util.js';

/** 선택에 같은 그룹의 나머지도 넣는다 (한 개만 골라도 그룹 전체) */
export function expandGroups(items, ids) {
  const gps = new Set();
  for (const it of items) if (ids.has(it.id) && it.gp) gps.add(it.gp);
  if (!gps.size) return ids;
  const out = new Set(ids);
  for (const it of items) if (it.gp && gps.has(it.gp)) out.add(it.id);
  return out;
}

/** 선택한 객체들을 한 그룹으로 (이미 다른 그룹이었으면 새 그룹으로 합침) */
export function groupItems(items, ids) {
  const gp = uid('g');
  return items.map((it) => (ids.has(it.id) ? { ...it, gp } : it));
}

/** 선택한 객체의 그룹 풀기 */
export function ungroupItems(items, ids) {
  return items.map((it) => {
    if (!ids.has(it.id) || !it.gp) return it;
    const { gp: _g, ...rest } = it;
    return rest;
  });
}

/** 선택 안의 그룹 수와 묶을 수 있는지 */
export function groupInfo(items, ids) {
  const sel = items.filter((it) => ids.has(it.id));
  const gps = new Set(sel.map((it) => it.gp).filter(Boolean));
  const allOneGroup = gps.size === 1 && sel.every((it) => it.gp);
  return { grouped: gps.size > 0, canGroup: sel.length > 1 && !allOneGroup };
}

/**
 * 앞뒤 순서: front(맨 앞) / back(맨 뒤) / forward(한 칸 앞) / backward(한 칸 뒤).
 * 선택한 객체끼리의 순서는 그대로. 한 칸 이동은 선택하지 않은 바로 앞(뒤) 객체 하나를 건너뛴다.
 */
export function reorder(items, ids, how) {
  const sel = items.filter((it) => ids.has(it.id));
  const rest = items.filter((it) => !ids.has(it.id));
  if (!sel.length || !rest.length) return items;
  if (how === 'front') return [...rest, ...sel];
  if (how === 'back') return [...sel, ...rest];
  // 한 칸: 선택 덩어리의 맨 앞(뒤) 위치를 기준으로 선택하지 않은 객체 하나만큼 옮긴다
  const idx = items.map((it, i) => (ids.has(it.id) ? i : -1)).filter((i) => i >= 0);
  if (how === 'forward') {
    const last = idx[idx.length - 1];
    const next = items.findIndex((it, i) => i > last && !ids.has(it.id));
    if (next < 0) return items;
    const pos = rest.indexOf(items[next]) + 1; // 그 객체 바로 뒤(=위)에
    return [...rest.slice(0, pos), ...sel, ...rest.slice(pos)];
  }
  if (how === 'backward') {
    const first = idx[0];
    let prev = -1;
    for (let i = first - 1; i >= 0; i--) if (!ids.has(items[i].id)) { prev = i; break; }
    if (prev < 0) return items;
    const pos = rest.indexOf(items[prev]); // 그 객체 바로 앞(=아래)에
    return [...rest.slice(0, pos), ...sel, ...rest.slice(pos)];
  }
  return items;
}

const unionBox = (bs) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of bs) { x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

/** 선택을 함께 움직이는 덩어리로 나눈다 → [{ids:Set, box}] (배열 순서대로) */
export function selectionUnits(items, ids) {
  const owner = new Map(); // id → 덩어리 키
  for (const it of items) {
    if (!ids.has(it.id)) continue;
    if (it.t === 'nt') for (const a of noteAttached(items, it)) if (ids.has(a)) owner.set(a, 'n:' + it.id);
  }
  const units = new Map();
  for (const it of items) {
    if (!ids.has(it.id)) continue;
    const key = it.gp ? 'g:' + it.gp : owner.get(it.id) || (it.t === 'nt' ? 'n:' + it.id : 'i:' + it.id);
    let u = units.get(key);
    if (!u) units.set(key, (u = { ids: new Set(), boxes: [] }));
    u.ids.add(it.id);
    u.boxes.push(bbox(it));
  }
  return [...units.values()].map((u) => ({ ids: u.ids, box: unionBox(u.boxes) }));
}

/** 덩어리마다 (dx, dy) 만큼 옮긴 배열 */
function moveUnits(items, moves) {
  const d = new Map();
  for (const { ids, dx, dy } of moves) if (dx || dy) for (const id of ids) d.set(id, { dx, dy });
  if (!d.size) return items;
  return items.map((it) => { const m = d.get(it.id); return m ? transformItem(it, { s: 1, ox: 0, oy: 0, dx: m.dx, dy: m.dy }) : it; });
}

/**
 * 정렬: left/hcenter/right/top/vcenter/bottom — 선택 전체 상자의 그 변(가운데)에 덩어리마다 맞춤.
 * 간격: hdist/vdist — 양 끝 덩어리는 두고 사이 간격을 같게 (덩어리 3개 이상)
 */
export function alignItems(items, ids, how) {
  const units = selectionUnits(items, ids);
  if (units.length < 2) return items;
  const all = unionBox(units.map((u) => u.box));
  if (how === 'hdist' || how === 'vdist') {
    if (units.length < 3) return items;
    const h = how === 'hdist';
    const sorted = [...units].sort((a, b) => (h ? a.box.x - b.box.x : a.box.y - b.box.y));
    const total = sorted.reduce((n, u) => n + (h ? u.box.w : u.box.h), 0);
    const gap = ((h ? all.w : all.h) - total) / (sorted.length - 1);
    let at = h ? all.x : all.y;
    const moves = sorted.map((u) => {
      const dv = at - (h ? u.box.x : u.box.y);
      at += (h ? u.box.w : u.box.h) + gap;
      return { ids: u.ids, dx: h ? dv : 0, dy: h ? 0 : dv };
    });
    return moveUnits(items, moves);
  }
  const moves = units.map(({ ids: uids, box: b }) => {
    let dx = 0, dy = 0;
    if (how === 'left') dx = all.x - b.x;
    else if (how === 'right') dx = all.x + all.w - (b.x + b.w);
    else if (how === 'hcenter') dx = all.x + all.w / 2 - (b.x + b.w / 2);
    else if (how === 'top') dy = all.y - b.y;
    else if (how === 'bottom') dy = all.y + all.h - (b.y + b.h);
    else if (how === 'vcenter') dy = all.y + all.h / 2 - (b.y + b.h / 2);
    return { ids: uids, dx, dy };
  });
  return moveUnits(items, moves);
}

/** 선택한 객체를 (dx, dy) 만큼 (화살표 키) */
export function nudgeItems(items, ids, dx, dy) {
  return items.map((it) => (ids.has(it.id) ? transformItem(it, { s: 1, ox: 0, oy: 0, dx, dy }) : it));
}

/**
 * 붙여 넣을 복사본: 새 id, 그룹은 복사본끼리 새 그룹, (dx, dy) 만큼 옮김.
 * 녹음 연결(rt)은 원래 필기만의 것이므로 뺀다.
 */
export function cloneItems(list, dx = 0, dy = 0) {
  const gmap = new Map();
  return list.map((it) => {
    const { rt: _rt, ...rest } = it;
    let out = dx || dy ? transformItem(rest, { s: 1, ox: 0, oy: 0, dx, dy }) : rest;
    out = { ...out, id: uid(it.t) };
    if (it.gp) { if (!gmap.has(it.gp)) gmap.set(it.gp, uid('g')); out.gp = gmap.get(it.gp); }
    return out;
  });
}
