// 입력 엔진
//
// 입력을 세 갈래로 분리해서 서로 간섭하지 않게 한다.
//   PenInput     : S Pen(및 설정 시 마우스/손가락) → 필기 도구. 보조 버튼, 정지 감지 담당
//   TouchInput   : 손가락 → 한 손가락 이동, 두 손가락 확대/이동, 두·세 손가락 탭, 팜 리젝션
//   MouseInput   : 휠 스크롤/확대, 가운데 버튼 이동, 오른쪽 버튼 메뉴
// InputRouter 는 포인터 이벤트를 받아 pointerType 에 따라 위 컨트롤러로 보내기만 한다.
import { settings } from './settings.js';
import { dist, now } from './util.js';

const BTN_BARREL = 2; // buttons 비트: 펜 보조(배럴) 버튼 = 마우스 오른쪽과 같은 비트
const BTN_ERASER = 32; // buttons 비트: 펜 지우개 끝

export class InputRouter {
  /**
   * @param viewer Viewer
   * @param tools  ToolController (begin/move/end/cancel/isTrivial)
   * @param app    { openMenu(sx, sy, source), undo(), redo(), isUiTarget(el) }
   */
  constructor(viewer, tools, app) {
    this.viewer = viewer;
    this.el = viewer.el;
    this.app = app;
    this.pen = new PenInput(this, tools);
    this.touch = new TouchInput(this);
    this.mouse = new MouseInput(this);
    this.lastPenEvent = -1e9; // 펜 이벤트(호버 포함) 마지막 시각
    this.lastPenUp = -1e9;
    this.penHovering = false;
    this.lastNonTouch = { type: '', t: -1e9 };
    this.lastMenuAt = -1e9;
    this.enabled = true;

    const el = this.el;
    const opt = { passive: false };
    el.addEventListener('pointerdown', (e) => this.onDown(e), opt);
    el.addEventListener('pointermove', (e) => this.onMove(e), opt);
    el.addEventListener('pointerup', (e) => this.onUp(e), opt);
    el.addEventListener('pointercancel', (e) => this.onCancel(e), opt);
    el.addEventListener('lostpointercapture', (e) => this.onLostCapture(e));
    el.addEventListener('pointerover', (e) => { if (e.pointerType === 'pen') { this.penHovering = true; this.lastPenEvent = now(); } });
    el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'pen') { this.penHovering = false; this.lastPenEvent = now(); } });
    el.addEventListener('contextmenu', (e) => this.onContextMenu(e), opt);
    el.addEventListener('auxclick', (e) => { if (e.button === 2) this.onSecondaryFallback(e, 'auxclick'); });
    el.addEventListener('wheel', (e) => this.mouse.onWheel(e), opt);
    // 브라우저 기본 동작(스크롤, 당겨서 새로고침, 길게 눌러 선택) 차단
    el.addEventListener('touchstart', (e) => { if (!this.app.isUiTarget(e.target)) e.preventDefault(); }, opt);
    el.addEventListener('touchmove', (e) => { if (!this.app.isUiTarget(e.target)) e.preventDefault(); }, opt);
    el.addEventListener('dragstart', (e) => e.preventDefault());
    el.addEventListener('selectstart', (e) => { if (!this.app.isUiTarget(e.target)) e.preventDefault(); });
    window.addEventListener('blur', () => this.resetAll('blur'));
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.resetAll('hidden'); });
  }

  screen(e) { return this.viewer.clientToScreen(e.clientX, e.clientY); }

  onDown(e) {
    if (!this.enabled || this.app.isUiTarget(e.target)) return;
    this.viewer.updateRect();
    this.touch.stopInertia();
    if (e.pointerType === 'pen') { this.lastPenEvent = now(); this.penHovering = true; this.lastNonTouch = { type: 'pen', t: now() }; }
    if (e.pointerType === 'mouse') this.lastNonTouch = { type: 'mouse', t: now() };
    if (e.pointerType !== 'touch') e.preventDefault();
    if (e.pointerType === 'pen') this.pen.onDown(e, 'pen');
    else if (e.pointerType === 'touch') this.touch.onDown(e);
    else this.mouse.onDown(e);
  }

  onMove(e) {
    if (e.pointerType === 'pen') { this.lastPenEvent = now(); this.lastNonTouch = { type: 'pen', t: now() }; }
    if (e.pointerType === 'touch') this.touch.track(e);
    if (this.pen.owns(e.pointerId)) { this.pen.onMove(e); return; }
    if (e.pointerType === 'pen') { this.pen.onHover(e); return; }
    if (e.pointerType === 'touch') this.touch.onMove(e);
    else this.mouse.onMove(e);
  }

  onUp(e) {
    if (e.pointerType === 'pen') { this.lastPenEvent = now(); }
    if (this.pen.owns(e.pointerId)) {
      this.pen.onUp(e);
      if (e.pointerType === 'touch') this.touch.onUp(e, true); // 손가락 필기 모드
      return;
    }
    if (e.pointerType === 'pen') { this.pen.releaseConsumed(e.pointerId); return; }
    if (e.pointerType === 'touch') this.touch.onUp(e);
    else this.mouse.onUp(e);
  }

  onCancel(e) {
    if (this.pen.owns(e.pointerId)) {
      this.pen.onCancel(e);
      if (e.pointerType === 'touch') this.touch.onUp(e, true);
      return;
    }
    this.pen.releaseConsumed(e.pointerId);
    if (e.pointerType === 'touch') this.touch.onUp(e, true);
    else this.mouse.onUp(e);
  }

  onLostCapture(e) {
    // pointerup 없이 캡처를 잃은 경우(브라우저/OS가 가로챔) 상태가 남지 않도록 정리
    if (this.pen.owns(e.pointerId)) setTimeout(() => { if (this.pen.owns(e.pointerId)) this.pen.onUp(e); }, 0);
  }

  /** contextmenu: S Pen 버튼 + 터치가 브라우저에서 우클릭으로 전달되는 경우 */
  onContextMenu(e) {
    if (this.app.isUiTarget(e.target) && e.target.closest('input,textarea')) return;
    e.preventDefault();
    this.onSecondaryFallback(e, 'contextmenu');
  }

  onSecondaryFallback(e, src) {
    // contextmenu 가 PointerEvent 이면 pointerType 이 있다(최신 크롬). 없으면 최근 비터치 입력으로 추정
    let type = e.pointerType;
    if (!type) type = now() - this.lastNonTouch.t < 1000 ? this.lastNonTouch.type : 'touch';
    if (type === 'touch' && !settings.get('fingerDraw')) return; // 손가락 길게 누르기는 무시
    if (type === 'pen' || type === 'touch') {
      if (settings.get('penButtonAction') === 'none' && type === 'pen') return;
      if (settings.get('penButtonAction') === 'eraser' && type === 'pen') return; // 지우개 모드에서는 버튼 비트로 처리
    }
    // 같은 조작으로 pointerdown(buttons=2)에서 이미 메뉴를 열었으면 중복 방지
    if (now() - this.lastMenuAt < 600) return;
    this.pen.abortForMenu();
    const s = this.screen(e);
    this.openMenu(s.x, s.y, `${src}:${type}`);
  }

  openMenu(sx, sy, source) {
    this.lastMenuAt = now();
    this.app.openMenu(sx, sy, source);
  }

  /** 펜이 닿는 순간: 진행 중인 손가락 제스처를 멈춘다 (팜 리젝션) */
  penContact() {
    this.touch.onPenContact();
  }

  resetAll(reason) {
    this.pen.forceEnd(reason);
    this.touch.reset();
    this.mouse.reset();
  }

  isPenActive() { return this.pen.active != null; }
}

// ───────────────────────────── 펜 ─────────────────────────────

class PenInput {
  constructor(router, tools) {
    this.r = router;
    this.tools = tools;
    this.active = null; // {id, kind, t0, sx0, sy0, ax, ay, moved, buttons, holdTimer}
    this.consumed = new Set(); // 메뉴를 연 포인터: 뗄 때까지 무시
    this.hoverButtons = new Map();
  }

  owns(id) { return this.active && this.active.id === id; }

  releaseConsumed(id) { this.consumed.delete(id); this.hoverButtons.delete(id); }

  onDown(e, kind, toolOverride) {
    if (this.active) {
      // 다른 펜/포인터가 이미 필기 중이면 무시 (동시에 두 획 불가)
      if (this.active.id !== e.pointerId) return;
    }
    if (kind === 'pen') {
      if ((e.buttons & BTN_ERASER) || e.button === 5) toolOverride = 'eraser';
      else if ((e.buttons & BTN_BARREL) || e.button === 2) {
        const act = settings.get('penButtonAction');
        if (act === 'menu') {
          this.consumed.add(e.pointerId);
          try { this.r.el.setPointerCapture(e.pointerId); } catch { /* */ }
          this.r.penContact();
          const s = this.r.screen(e);
          this.r.openMenu(s.x, s.y, `pointerdown:pen buttons=${e.buttons} button=${e.button}`);
          return;
        }
        if (act === 'eraser') toolOverride = 'eraser';
      }
    }
    if (this.consumed.has(e.pointerId)) return;
    const s = this.r.screen(e);
    const viewer = this.r.viewer;
    const hit = viewer.pageAtScreen(s.x, s.y);
    if (!hit) return;
    if (kind === 'pen' || kind === 'mouse') this.r.penContact();
    try { this.r.el.setPointerCapture(e.pointerId); } catch { /* */ }
    this.active = {
      id: e.pointerId, kind, t0: now(), sx0: s.x, sy0: s.y, ax: s.x, ay: s.y,
      moved: false, buttons: e.buttons, holdTimer: 0, toolOverride,
    };
    viewer.pauseRender(true);
    this.tools.begin({ sx: s.x, sy: s.y, p: pressureOf(e, kind), kind, toolOverride, t: e.timeStamp });
    this.armHold();
  }

  onHover(e) {
    // 호버 중 보조 버튼 누름(buttons 0→2)을 메뉴 열기로 사용 (기기가 전달하는 경우에만)
    const prev = this.hoverButtons.get(e.pointerId) || 0;
    this.hoverButtons.set(e.pointerId, e.buttons);
    if (this.consumed.has(e.pointerId)) {
      if (!(e.buttons & BTN_BARREL) && !(e.buttons & 1)) this.consumed.delete(e.pointerId);
      return;
    }
    if (!settings.get('penHoverButton') || settings.get('penButtonAction') !== 'menu') return;
    if (!(prev & BTN_BARREL) && (e.buttons & BTN_BARREL) && !(e.buttons & 1)) {
      const s = this.r.screen(e);
      this.consumed.add(e.pointerId);
      this.r.openMenu(s.x, s.y, `hover:pen buttons=${e.buttons}`);
    }
  }

  onMove(e) {
    const a = this.active;
    // 필기 도중 보조 버튼을 누른 경우 (buttons 에 2 비트가 새로 생김)
    if (a.kind === 'pen' && !(a.buttons & BTN_BARREL) && (e.buttons & BTN_BARREL)) {
      const act = settings.get('penButtonAction');
      if (act === 'menu') {
        this.finishForMenu();
        this.consumed.add(e.pointerId);
        const s = this.r.screen(e);
        this.r.openMenu(s.x, s.y, `pointermove:pen buttons=${e.buttons}`);
        return;
      }
      if (act === 'eraser' && a.toolOverride !== 'eraser') {
        this.end(false);
        this.onDown(e, 'pen', 'eraser');
        return;
      }
    }
    a.buttons = e.buttons;
    const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const evs = list.length ? list : [e];
    const pts = [];
    for (const ev of evs) {
      const s = this.r.screen(ev);
      pts.push({ sx: s.x, sy: s.y, p: pressureOf(ev, a.kind), t: ev.timeStamp });
    }
    let pred = null;
    if (settings.get('prediction') && typeof e.getPredictedEvents === 'function') {
      const pl = e.getPredictedEvents();
      if (pl.length) {
        const pe = pl[pl.length - 1];
        const s = this.r.screen(pe);
        pred = { sx: s.x, sy: s.y, p: pressureOf(pe, a.kind) };
      }
    }
    this.tools.move(pts, pred);
    // 정지 감지
    const last = pts[pts.length - 1];
    const tol = settings.get('holdTolerance');
    if (!a.moved && dist(a.sx0, a.sy0, last.sx, last.sy) > tol) a.moved = true;
    if (a.holdTimer && dist(a.ax, a.ay, last.sx, last.sy) > tol) {
      if (settings.get('holdCondition') === 'start') this.clearHold();
      else { a.ax = last.sx; a.ay = last.sy; this.armHold(); }
    }
  }

  onUp(e) {
    const a = this.active;
    if (a && e.type === 'pointerup' && e.clientX != null) {
      // pointerup 위치도 마지막 점으로 반영
      const s = this.r.screen(e);
      if (Number.isFinite(s.x)) this.tools.move([{ sx: s.x, sy: s.y, p: pressureOf(e, a.kind, true), t: e.timeStamp }], null, true);
    }
    this.end(false);
  }

  onCancel() {
    // OS/브라우저가 취소한 입력(손바닥 판정 등): 획을 버린다
    this.end(true);
  }

  armHold() {
    const a = this.active;
    if (!a) return;
    this.clearHold();
    if (!settings.get('holdEnabled') || a.kind !== 'pen') return;
    a.holdTimer = setTimeout(() => this.fireHold(), settings.get('holdMs'));
  }

  clearHold() {
    if (this.active?.holdTimer) { clearTimeout(this.active.holdTimer); this.active.holdTimer = 0; }
  }

  fireHold() {
    const a = this.active;
    if (!a) return;
    a.holdTimer = 0;
    if (settings.get('holdCondition') === 'start' && a.moved) return;
    const id = a.id, x = a.ax, y = a.ay;
    this.finishForMenu();
    this.consumed.add(id);
    this.r.openMenu(x, y, 'hold');
  }

  /** 메뉴를 열기 위해 현재 획을 정리: 의미 없는 짧은 획은 버리고, 긴 획은 보존 */
  finishForMenu() {
    if (!this.active) return;
    const keep = !this.tools.isTrivial() && now() - this.active.t0 > 400;
    this.end(!keep);
  }

  /** contextmenu 등 다른 경로로 메뉴가 열릴 때 */
  abortForMenu() {
    if (!this.active) return;
    const id = this.active.id;
    this.finishForMenu();
    this.consumed.add(id);
  }

  end(cancel) {
    const a = this.active;
    if (!a) return;
    this.clearHold();
    this.active = null;
    try { if (cancel) this.tools.cancel(); else this.tools.end(); }
    finally {
      try { this.r.el.releasePointerCapture(a.id); } catch { /* */ }
      this.r.viewer.pauseRender(false);
      if (a.kind === 'pen') this.r.lastPenUp = now();
    }
  }

  forceEnd() { if (this.active) this.end(false); this.consumed.clear(); }
}

function pressureOf(e, kind, isUp) {
  if (kind === 'pen') {
    const p = e.pressure;
    if (!(p > 0)) return isUp ? 0.2 : 0.5; // 일부 기기는 첫 이벤트에서 0을 보냄
    return p;
  }
  return 0.5;
}

// ───────────────────────────── 손가락 ─────────────────────────────

class TouchInput {
  constructor(router) {
    this.r = router;
    this.touches = new Map(); // id -> {x, y, x0, y0, rejected, reason}
    this.base = null;
    this.gesture = null; // {t0, cam0, maxCount, moved, rejectedAny}
    this.vel = [];
    this.inertiaRaf = 0;
    this.fingerInk = null; // 손가락 필기 모드에서 필기 중인 포인터 id
  }

  active() {
    const out = [];
    for (const [id, t] of this.touches) if (!t.rejected) out.push([id, t]);
    return out;
  }

  isPalm(e) {
    if (!settings.get('palmSizeEnabled')) return false;
    const size = Math.max(e.width || 0, e.height || 0);
    return size >= settings.get('palmSize');
  }

  onDown(e) {
    const r = this.r;
    if (e.isPrimary) { this.touches.clear(); this.gesture = null; } // 이전에 정리되지 않은 터치 제거
    const s = r.screen(e);
    let reason = '';
    if (r.isPenActive() && r.pen.active.kind !== 'touch') reason = 'pen-active';
    else if (now() - r.lastPenUp < settings.get('penGuardMs')) reason = 'pen-guard';
    else if (settings.get('hoverGuard') && r.penHovering && now() - r.lastPenEvent < 1500) reason = 'pen-hover';
    else if (this.isPalm(e)) reason = 'palm-size';
    const t = { x: s.x, y: s.y, x0: s.x, y0: s.y, rejected: !!reason, reason };
    this.touches.set(e.pointerId, t);
    if (!this.gesture) this.gesture = { t0: now(), cam0: { ...r.viewer.cam }, maxCount: 0, moved: false, rejectedAny: false };
    if (t.rejected) { this.gesture.rejectedAny = true; return; }

    // 손가락 필기 모드
    if (settings.get('fingerDraw')) {
      const act = this.active();
      if (act.length === 1 && !r.isPenActive()) {
        this.fingerInk = e.pointerId;
        r.pen.onDown(e, 'touch');
        this.gesture.maxCount = 1;
        return;
      }
      if (this.fingerInk != null && r.pen.owns(this.fingerInk)) {
        // 두 번째 손가락: 필기를 제스처로 전환
        r.pen.finishForMenu();
        this.fingerInk = null;
      }
    }
    this.gesture.maxCount = Math.max(this.gesture.maxCount, this.active().length);
    this.rebase();
  }

  /** 위치만 갱신 (손가락 필기 중에도 좌표를 최신으로 유지해 제스처 전환 시 튐 방지) */
  track(e) {
    const t = this.touches.get(e.pointerId);
    if (!t) return;
    const s = this.r.screen(e);
    t.x = s.x; t.y = s.y;
  }

  onMove(e) {
    const t = this.touches.get(e.pointerId);
    if (!t) return;
    if (t.rejected) return;
    // 이동 중 접촉면이 커지면(손바닥이 눕는 경우) 그때라도 제외
    if (this.isPalm(e)) { t.rejected = true; t.reason = 'palm-size'; this.gesture && (this.gesture.rejectedAny = true); this.rebase(); return; }
    if (this.gesture && dist(t.x0, t.y0, t.x, t.y) > 10) this.gesture.moved = true;
    this.apply(e.timeStamp);
  }

  onUp(e, cancelled) {
    const t = this.touches.get(e.pointerId);
    if (this.fingerInk === e.pointerId) this.fingerInk = null;
    if (!t) return;
    this.touches.delete(e.pointerId);
    if (this.touches.size === 0) {
      const g = this.gesture;
      this.gesture = null;
      this.base = null;
      if (g && !cancelled && !g.moved && !g.rejectedAny && now() - g.t0 < 350) {
        if (g.maxCount === 2 && settings.get('twoFingerUndo')) { this.r.viewer.setCamera(g.cam0.tx, g.cam0.ty, g.cam0.z); this.r.app.undo(); return; }
        if (g.maxCount === 3 && settings.get('threeFingerRedo')) { this.r.viewer.setCamera(g.cam0.tx, g.cam0.ty, g.cam0.z); this.r.app.redo(); return; }
      }
      if (g && !cancelled && g.maxCount === 1 && !t.rejected) this.startInertia();
      return;
    }
    this.rebase();
  }

  /** 현재 손가락들 기준으로 기준점을 다시 잡는다 → 손가락 수가 바뀌어도 화면이 튀지 않음 */
  rebase() {
    const act = this.active();
    const v = this.r.viewer;
    this.vel = [];
    if (!act.length) { this.base = null; return; }
    if (act.length === 1) {
      const [, t] = act[0];
      this.base = { n: 1, cam: { ...v.cam }, x: t.x, y: t.y };
    } else {
      const [, a] = act[0], [, b] = act[1];
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      this.base = { n: 2, cam: { ...v.cam }, d: Math.max(dist(a.x, a.y, b.x, b.y), 1), w: v.toWorld(mx, my), ids: [act[0][0], act[1][0]] };
    }
  }

  apply(ts) {
    const b = this.base;
    if (!b) return;
    const v = this.r.viewer;
    const act = this.active();
    if (b.n === 1 && act.length >= 1) {
      const [, t] = act[0];
      v.setCamera(b.cam.tx + (t.x - b.x), b.cam.ty + (t.y - b.y), b.cam.z);
      this.vel.push({ x: t.x, y: t.y, t: ts });
      if (this.vel.length > 8) this.vel.shift();
    } else if (b.n === 2 && act.length >= 2) {
      const a = this.touches.get(b.ids[0]), c = this.touches.get(b.ids[1]);
      if (!a || !c) { this.rebase(); return; }
      const mx = (a.x + c.x) / 2, my = (a.y + c.y) / 2;
      const d = Math.max(dist(a.x, a.y, c.x, c.y), 1);
      let z = b.cam.z * (d / b.d);
      z = Math.min(Math.max(z, v.minZ()), v.maxZ());
      v.setCamera(mx - b.w.x * z, my - b.w.y * z, z);
      this.r.app.showZoom?.();
    }
  }

  onPenContact() {
    this.stopInertia();
    if (!this.touches.size) return;
    const g = this.gesture;
    // 펜 직전에 닿은 한 손가락(대개 손바닥)으로 생긴 이동은 되돌린다
    if (g && settings.get('undoRestorePan') && g.maxCount <= 1 && now() - g.t0 < 700) {
      this.r.viewer.setCamera(g.cam0.tx, g.cam0.ty, g.cam0.z);
    }
    for (const t of this.touches.values()) { t.rejected = true; t.reason = 'pen-contact'; }
    if (g) g.rejectedAny = true;
    this.base = null;
  }

  startInertia() {
    if (!settings.get('inertia') || this.vel.length < 2) return;
    const a = this.vel[0], b = this.vel[this.vel.length - 1];
    const dt = b.t - a.t;
    if (dt <= 0 || dt > 150) return;
    let vx = (b.x - a.x) / dt, vy = (b.y - a.y) / dt; // px/ms
    if (Math.hypot(vx, vy) < 0.25) return;
    const v = this.r.viewer;
    let last = performance.now();
    const step = (t) => {
      const dtt = Math.min(t - last, 40);
      last = t;
      const before = { ...v.cam };
      v.setCamera(v.cam.tx + vx * dtt, v.cam.ty + vy * dtt, v.cam.z);
      const decay = Math.pow(0.995, dtt);
      vx *= decay; vy *= decay;
      const stuck = before.tx === v.cam.tx && before.ty === v.cam.ty;
      if (Math.hypot(vx, vy) > 0.02 && !stuck) this.inertiaRaf = requestAnimationFrame(step);
      else this.inertiaRaf = 0;
    };
    this.inertiaRaf = requestAnimationFrame(step);
  }

  stopInertia() { if (this.inertiaRaf) { cancelAnimationFrame(this.inertiaRaf); this.inertiaRaf = 0; } }

  reset() { this.touches.clear(); this.base = null; this.gesture = null; this.stopInertia(); this.fingerInk = null; }
}

// ───────────────────────────── 마우스 ─────────────────────────────

class MouseInput {
  constructor(router) {
    this.r = router;
    this.pan = null;
  }

  onDown(e) {
    const r = this.r;
    if (e.button === 2) {
      const s = r.screen(e);
      r.openMenu(s.x, s.y, `pointerdown:${e.pointerType} button=2`);
      return;
    }
    if (e.button === 0 && settings.get('mouseDraw')) { r.pen.onDown(e, 'mouse'); return; }
    if (e.button === 0 || e.button === 1) {
      const s = r.screen(e);
      this.pan = { id: e.pointerId, x: s.x, y: s.y, cam: { ...r.viewer.cam } };
      try { r.el.setPointerCapture(e.pointerId); } catch { /* */ }
    }
  }

  onMove(e) {
    if (!this.pan || this.pan.id !== e.pointerId) return;
    const s = this.r.screen(e);
    const c = this.pan.cam;
    this.r.viewer.setCamera(c.tx + s.x - this.pan.x, c.ty + s.y - this.pan.y, c.z);
  }

  onUp(e) { if (this.pan && this.pan.id === e.pointerId) this.pan = null; }

  onWheel(e) {
    if (this.r.app.isUiTarget(e.target)) return;
    e.preventDefault();
    const v = this.r.viewer;
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? v.vh : 1;
    if (e.ctrlKey || e.metaKey) {
      const s = this.r.screen(e);
      v.zoomAt(s.x, s.y, v.cam.z * Math.exp(-e.deltaY * k * 0.0025));
      this.r.app.showZoom?.();
    } else {
      const dx = e.shiftKey ? e.deltaY : e.deltaX, dy = e.shiftKey ? 0 : e.deltaY;
      v.setCamera(v.cam.tx - dx * k, v.cam.ty - dy * k, v.cam.z);
    }
  }

  reset() { this.pan = null; }
}
