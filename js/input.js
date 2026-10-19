// 입력 엔진
//
// 입력을 세 갈래로 분리해서 서로 간섭하지 않게 한다.
//   PenInput     : S Pen(및 설정 시 마우스/손가락) → 필기 도구. 정지 감지 담당
//   TouchInput   : 손가락 → 한 손가락 이동, 두 손가락 확대/이동, 두·세 손가락 탭, 팜 리젝션
//   MouseInput   : 휠 스크롤/확대, 가운데 버튼 이동
// InputRouter 는 포인터를 분류해 위 컨트롤러로 보내고, 보조 버튼(우클릭) 판정과 상태 복구를 맡는다.
//
// S Pen 보조 버튼
//   안드로이드 크롬은 "버튼을 누른 채 화면에 닿기"를 우클릭으로 처리한다. 기기/버전에 따라
//   pen(buttons=2) · mouse(button=2) · contextmenu 중 어느 형태로든 올 수 있고, 같은 조작에서
//   펜 포인터가 중간에 마우스 포인터로 바뀌기도 한다. 그래서 pointerType 과 무관하게
//   "buttons 에 2 비트 / button=2 / contextmenu" 를 모두 보조 버튼 신호로 받는다.
//
// 상태 복구 (pointerup 이 오지 않아 펜이 '닿아 있는' 상태로 남으면 손가락이 전부 거부된다)
//   - window 단계에서도 pointerup/cancel 을 받아 정리
//   - 같은 펜이 호버(buttons=0)로 움직이면 이미 뗀 것으로 간주
//   - 펜 이벤트가 끊긴 채 손가락이 닿으면 펜 상태를 강제 종료
//   - touchend 에서 남은 손가락이 0개면 손가락 상태 초기화
import { settings } from './settings.js';
import { dist, now } from './util.js';

const BTN_SECONDARY = 2; // buttons 비트: 펜 보조(배럴) 버튼 = 마우스 오른쪽
const BTN_ERASER = 32; // buttons 비트: 펜 지우개 끝
const PEN_STALE_MS = 400; // 이 시간 동안 펜 이벤트가 없으면 펜 상태를 믿지 않는다
const MENU_DEDUPE_MS = 700;
const PEN_RECENT_MS = 500;

/** 설정 → 제스처 동작에서 이 제스처에 지정된 동작 */
const gestureAction = (key) => settings.get('gestures')[key] || 'none';
const FINGER_HOLD_MS = 600;

const isSecondary = (e) => (e.buttons & BTN_SECONDARY) !== 0 || e.button === 2;
const isEraserTip = (e) => (e.buttons & BTN_ERASER) !== 0 || e.button === 5;

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
    this.consumed = new Set(); // 보조 버튼으로 메뉴를 연 포인터: 뗄 때까지 무시
    this.lastPenEvent = -1e9; // 펜 이벤트(호버 포함) 마지막 시각
    this.lastPenUp = -1e9;
    this.penHovering = false;
    this.lastMenuAt = -1e9;
    this.enabled = true;
    this.onTrace = null; // 디버그 패널로 판정 이유를 보낸다

    const el = this.el;
    const opt = { passive: false };
    el.addEventListener('pointerdown', (e) => this.onDown(e), opt);
    el.addEventListener('pointermove', (e) => this.onMove(e), opt);
    el.addEventListener('pointerup', (e) => this.onUp(e), opt);
    el.addEventListener('pointercancel', (e) => this.onUp(e, true), opt);
    el.addEventListener('lostpointercapture', (e) => this.onLostCapture(e));
    el.addEventListener('pointerover', (e) => { if (e.pointerType === 'pen') { this.penHovering = true; this.lastPenEvent = now(); } });
    el.addEventListener('pointerleave', (e) => this.onLeave(e));
    el.addEventListener('contextmenu', (e) => this.onContextMenu(e), opt);
    el.addEventListener('auxclick', (e) => { if (e.button === 2) this.secondarySignal(e, 'auxclick'); });
    el.addEventListener('wheel', (e) => this.mouse.onWheel(e), opt);
    // 브라우저 기본 동작(스크롤, 당겨서 새로고침, 길게 눌러 선택) 차단 + 손가락 상태 재확인
    el.addEventListener('touchstart', (e) => { if (!this.app.isUiTarget(e.target)) e.preventDefault(); }, opt);
    el.addEventListener('touchmove', (e) => { if (!this.app.isUiTarget(e.target)) e.preventDefault(); }, opt);
    el.addEventListener('touchend', (e) => this.onTouchListEnd(e));
    el.addEventListener('touchcancel', (e) => this.onTouchListEnd(e));
    el.addEventListener('dragstart', (e) => e.preventDefault());
    el.addEventListener('selectstart', (e) => { if (!this.app.isUiTarget(e.target)) e.preventDefault(); });
    // 뷰포트 밖(도구 모음 위 등)에서 손을 떼도 상태가 남지 않도록
    window.addEventListener('pointerup', (e) => this.onGlobalEnd(e, false), true);
    window.addEventListener('pointercancel', (e) => this.onGlobalEnd(e, true), true);
    window.addEventListener('blur', () => this.resetAll('blur'));
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.resetAll('hidden'); });
  }

  trace(msg) { this.onTrace?.(msg); }

  screen(e) { return this.viewer.clientToScreen(e.clientX, e.clientY); }

  notePen(e) {
    if (e.pointerType === 'pen') this.lastPenEvent = now();
  }

  // ───────── 분류 ─────────

  onDown(e) {
    if (!this.enabled || this.app.isUiTarget(e.target)) return;
    this.viewer.updateRect();
    this.touch.stopInertia();
    this.notePen(e);
    if (e.pointerType === 'pen') this.penHovering = true;
    if (e.pointerType !== 'touch') e.preventDefault();
    this.consumed.delete(e.pointerId);

    // 1) 보조 버튼 (pen/mouse/touch 무엇으로 오든)
    if (isSecondary(e) && e.pointerType !== 'touch') {
      const act = gestureAction('penButton');
      if (e.pointerType === 'pen' && act === 'eraserHold') { this.pen.onDown(e, 'pen', 'eraser'); return; }
      if (e.pointerType === 'pen' && act === 'none') { this.pen.onDown(e, 'pen'); return; }
      this.consumePointer(e);
      this.secondarySignal(e, `pointerdown:${e.pointerType} button=${e.button} buttons=${e.buttons}`);
      return;
    }
    // 2) 펜 지우개 끝
    if (e.pointerType === 'pen') { this.pen.onDown(e, 'pen', isEraserTip(e) ? 'eraser' : undefined); return; }
    if (e.pointerType === 'touch') { this.touch.onDown(e); return; }
    this.mouse.onDown(e);
  }

  onMove(e) {
    this.notePen(e);
    if (e.pointerType === 'touch') this.touch.track(e);
    if (this.consumed.has(e.pointerId)) return;
    if (this.pen.owns(e.pointerId)) {
      // 펜이 호버(버튼 0, 압력 0)로 움직인다 = 이미 화면에서 떨어짐. pointerup 이 누락된 경우 복구
      if (e.pointerType === 'pen' && e.buttons === 0) { this.trace('pen hover while active → 획 종료(pointerup 누락 복구)'); this.pen.onUp(e); return; }
      // 필기 도중 보조 버튼을 누름 (buttons 에 2 비트가 새로 생김)
      if (isSecondary(e) && !this.pen.activeHadSecondary()) {
        const act = gestureAction('penButton');
        if (act === 'eraserHold' && e.pointerType === 'pen') { this.pen.switchToEraser(e); return; }
        if (act !== 'none' || e.pointerType !== 'pen') {
          this.consumePointer(e);
          this.secondarySignal(e, `pointermove:${e.pointerType} buttons=${e.buttons}`);
          return;
        }
      }
      this.pen.onMove(e);
      return;
    }
    if (e.pointerType === 'pen') {
      // 다른 펜 포인터가 움직이는데 기존 펜 상태가 오래됐다면 정리
      this.pen.healIfStale('other pen move');
      this.pen.onHover(e);
      return;
    }
    if (e.pointerType === 'touch') this.touch.onMove(e);
    else {
      // 마우스로 바뀐 펜(버튼 이동 중)이 들어오면 기존 펜 획은 끝난 것
      if (e.pointerType === 'mouse' && isSecondary(e)) this.pen.healIfStale('mouse move');
      this.mouse.onMove(e);
    }
  }

  onUp(e, cancelled = false) {
    this.notePen(e);
    this.consumed.delete(e.pointerId);
    if (this.pen.owns(e.pointerId)) {
      if (cancelled) this.pen.onCancel(e); else this.pen.onUp(e);
      if (e.pointerType === 'touch') this.touch.onUp(e, true); // 손가락 필기 모드
      return;
    }
    if (e.pointerType === 'pen') { this.lastPenUp = now(); this.pen.hoverButtons.delete(e.pointerId); return; }
    if (e.pointerType === 'touch') this.touch.onUp(e, cancelled);
    else this.mouse.onUp(e);
  }

  /** window 단계: 정상 처리가 끝난 뒤에도 같은 포인터가 남아 있으면 정리 */
  onGlobalEnd(e, cancelled) {
    // 이 이벤트 시점의 "그 획/그 손가락" 객체를 기억한다. 펜은 다음 획에도 같은 pointerId 를 쓰므로
    // id 로만 확인하면 바로 이어서 시작된 새 획을 잘못 끝내 버린다.
    const id = e.pointerId;
    const stroke = this.pen.owns(id) ? this.pen.active : null;
    const finger = this.touch.touches.get(id) || null;
    setTimeout(() => {
      if (stroke && this.pen.active === stroke) { this.trace(`window ${e.type} → 남은 펜 상태 정리`); cancelled ? this.pen.onCancel(e) : this.pen.onUp(e); }
      if (finger && this.touch.touches.get(id) === finger) { this.trace(`window ${e.type} → 남은 손가락 ${id} 정리`); this.touch.onUp(e, true); }
    }, 0);
  }

  onLostCapture(e) {
    // pointerup 없이 캡처를 잃은 경우(브라우저/OS가 가로챔)
    const stroke = this.pen.owns(e.pointerId) ? this.pen.active : null;
    if (!stroke) return;
    setTimeout(() => { if (this.pen.active === stroke) { this.trace('lostpointercapture → 펜 상태 정리'); this.pen.onUp(e); } }, 0);
  }

  onLeave(e) {
    if (e.pointerType !== 'pen') return;
    this.penHovering = false;
    this.lastPenEvent = now();
    if (this.pen.owns(e.pointerId) && e.buttons === 0) this.pen.onUp(e);
  }

  onTouchListEnd(e) {
    // TouchEvent 의 실제 손가락 수로 포인터 상태를 검증: 0개인데 남은 기록이 있으면 버린다
    if (e.touches.length === 0 && this.touch.touches.size) {
      setTimeout(() => {
        if (this.touch.touches.size) { this.trace(`touchend(남은 0개) → 손가락 기록 ${this.touch.touches.size}개 정리`); this.touch.clearStale(); }
      }, 0);
    }
  }

  // ───────── 보조 버튼 ─────────

  consumePointer(e) {
    this.consumed.add(e.pointerId);
    try { this.el.setPointerCapture(e.pointerId); } catch { /* */ }
  }

  /** contextmenu: 안드로이드 크롬에서 S Pen 버튼+터치는 우클릭(contextmenu)으로도 온다 */
  onContextMenu(e) {
    if (this.app.isUiTarget(e.target) && e.target.closest('input,textarea')) return;
    e.preventDefault();
    if (this.isFingerLongPress(e)) { this.trace('contextmenu: 손가락 길게 누르기로 판단 → 무시'); return; }
    this.secondarySignal(e, `contextmenu:${e.pointerType || '?'}`);
  }

  /** 손가락만 닿아 있고 펜 흔적이 없을 때만 손가락 길게 누르기로 본다 */
  isFingerLongPress(e) {
    if (settings.get('fingerDraw')) return false;
    if (e.pointerType === 'mouse' || e.pointerType === 'pen') return false;
    // 펜은 닿기 직전까지 호버 이벤트를 보내므로 펜에서 온 우클릭이면 펜 이벤트가 아주 최근에 있다
    const penRecent = this.pen.active?.kind === 'pen' || now() - this.lastPenEvent < PEN_RECENT_MS;
    if (penRecent) return false;
    return this.touch.touches.size > 0 || e.pointerType === 'touch';
  }

  /** 모든 보조 버튼 신호가 모이는 곳 */
  secondarySignal(e, source) {
    // 진짜 마우스 오른쪽 버튼은 항상 도구 메뉴, 펜 버튼은 설정된 동작
    const isMouse = e.pointerType === 'mouse' || source.startsWith('pointerdown:mouse');
    const act = isMouse ? 'menu' : gestureAction('penButton');
    if (act === 'none' || act === 'eraserHold') {
      this.trace(`보조 버튼(${source}) — 설정이 '${act}'라 동작 없음`);
      return;
    }
    // 진행 중이던 획은 정리 (버튼 누르기 전에 찍힌 점은 버림)
    if (this.pen.active) { const id = this.pen.active.id; this.pen.finishForMenu(); this.consumed.add(id); }
    // 펜이 손가락처럼 보고된 경우에도 화면이 움직이지 않도록
    this.touch.rejectAll('secondary');
    // pointerdown(버튼)으로 이미 연 뒤 따라오는 contextmenu/auxclick 만 중복으로 본다
    const followUp = source.startsWith('contextmenu') || source.startsWith('auxclick');
    if (followUp && now() - this.lastMenuAt < MENU_DEDUPE_MS) { this.trace(`보조 버튼(${source}) — 직전에 열림, 중복 무시`); return; }
    const s = this.screen(e);
    this.runGesture(act, s.x, s.y, `pen-button(${source})`);
  }

  openMenu(sx, sy, source) { this.runGesture('menu', sx, sy, source); }

  /** 제스처에 지정된 동작 실행 (도구 메뉴, 실행 취소, 도구 전환 …) */
  runGesture(action, sx, sy, source) {
    this.lastMenuAt = now();
    this.trace(`${source} → ${action}`);
    this.app.runAction(action, sx, sy, source);
  }

  /** 펜이 닿는 순간: 진행 중인 손가락 제스처를 멈춘다 (팜 리젝션) */
  penContact() { this.touch.onPenContact(); }

  resetAll(reason) {
    this.pen.forceEnd(reason);
    this.touch.reset();
    this.mouse.reset();
    this.consumed.clear();
  }

  isPenActive() { return this.pen.active != null; }

  /** 디버그 패널용 현재 상태 */
  stateText() {
    const a = this.pen.active;
    const pen = a ? `필기중(id ${a.id}, ${a.kind}, ${Math.round(now() - a.lastAt)}ms 전 이벤트)` : '없음';
    const t = [...this.touch.touches].map(([id, x]) => `${id}${x.rejected ? `✕${x.reason}` : '✓'}`).join(' ') || '없음';
    return `펜: ${pen} · 손가락: ${t} · 메뉴 대기 포인터: ${[...this.consumed].join(',') || '없음'}`;
  }
}

// ───────────────────────────── 펜 ─────────────────────────────

class PenInput {
  constructor(router, tools) {
    this.r = router;
    this.tools = tools;
    this.active = null; // {id, kind, t0, lastAt, sx0, sy0, ax, ay, moved, buttons, holdTimer}
    this.hoverButtons = new Map();
  }

  owns(id) { return this.active && this.active.id === id; }

  activeHadSecondary() { return this.active && (this.active.buttons & BTN_SECONDARY) !== 0; }

  /** 펜 이벤트가 끊긴 상태로 남아 있으면 종료 */
  healIfStale(why) {
    const a = this.active;
    if (a && a.kind !== 'touch' && now() - a.lastAt > PEN_STALE_MS) {
      this.r.trace(`펜 상태 ${Math.round(now() - a.lastAt)}ms 동안 이벤트 없음(${why}) → 강제 종료`);
      this.end(false, a.lastAt); // 뗀 시각 = 마지막 펜 이벤트 (지금으로 하면 펜 직후 터치 무시에 걸림)
    }
  }

  onDown(e, kind, toolOverride) {
    if (this.active && this.active.id !== e.pointerId) {
      this.healIfStale('new pointer');
      if (this.active) return; // 다른 포인터가 실제로 필기 중이면 무시 (동시에 두 획 불가)
    }
    if (this.active) this.end(false); // 같은 id 로 다시 down: 이전 up 이 누락된 것
    const s = this.r.screen(e);
    const viewer = this.r.viewer;
    const hit = viewer.pageAtScreen(s.x, s.y);
    if (!hit) return;
    if (kind === 'pen' || kind === 'mouse') this.r.penContact();
    try { this.r.el.setPointerCapture(e.pointerId); } catch { /* */ }
    this.active = {
      id: e.pointerId, kind, t0: now(), lastAt: now(), sx0: s.x, sy0: s.y, ax: s.x, ay: s.y,
      moved: false, buttons: e.buttons, holdTimer: 0, toolOverride,
      mark: this.r.app.historyMark?.(), // 두 번 탭이면 이 시점으로 되돌린다
    };
    viewer.pauseRender(true);
    this.tools.begin({ sx: s.x, sy: s.y, p: pressureOf(e, kind), kind, toolOverride, t: e.timeStamp });
    this.armHold();
  }

  switchToEraser(e) {
    this.end(false);
    this.onDown(e, 'pen', 'eraser');
  }

  onHover(e) {
    // 호버 중 보조 버튼 누름(buttons 0→2)을 메뉴 열기로 사용 (기기가 전달하는 경우에만)
    const prev = this.hoverButtons.get(e.pointerId) || 0;
    this.hoverButtons.set(e.pointerId, e.buttons);
    const act = gestureAction('penButton');
    if (!settings.get('penHoverButton') || act === 'none' || act === 'eraserHold') return;
    if (!(prev & BTN_SECONDARY) && (e.buttons & BTN_SECONDARY) && !(e.buttons & 1)) {
      this.r.consumePointer(e);
      this.r.secondarySignal(e, `hover:pen buttons=${e.buttons}`);
    }
  }

  onMove(e) {
    const a = this.active;
    a.lastAt = now();
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
    if (a && this.checkDoubleTap(a)) return;
    if (a && e.type === 'pointerup' && Number.isFinite(e.clientX)) {
      // pointerup 위치도 마지막 점으로 반영
      const s = this.r.screen(e);
      try { this.tools.move([{ sx: s.x, sy: s.y, p: pressureOf(e, a.kind, true), t: e.timeStamp }], null, true); }
      catch (err) { console.error(err); }
    }
    this.end(false);
  }

  onCancel() {
    // OS/브라우저가 취소한 입력(손바닥 판정 등): 획을 버린다
    this.end(true);
  }

  /**
   * 펜 두 번 탭 → 도구 메뉴. 첫 탭이 만든 점(또는 지운 것)은 되돌리고 두 번째 탭은 그리지 않는다.
   * 짧고(<250ms) 거의 움직이지 않은 접촉 두 번이 350ms 안에, 18px 안에서 (콜론 같은 점 찍기와 구분) 일어나야 한다.
   */
  checkDoubleTap(a) {
    const act = gestureAction('penDoubleTap');
    if (a.kind !== 'pen' || act === 'none') return false;
    const isTap = !a.moved && now() - a.t0 < 250;
    const prev = this.lastTap;
    this.lastTap = null;
    if (!isTap) return false;
    const tool = a.toolOverride || settings.get('tool');
    if (prev && now() - prev.t < 350 && dist(prev.x, prev.y, a.sx0, a.sy0) < 18 && tool !== 'text') {
      this.end(true);
      this.r.app.revertTo?.(prev.mark);
      this.r.consumed.add(a.id);
      this.r.runGesture(act, a.sx0, a.sy0, 'pen-double-tap');
      return true;
    }
    // 끝나는 시각 기준으로 다음 탭을 기다린다 (end 이후 기록)
    queueMicrotask(() => { this.lastTap = { t: now(), x: a.sx0, y: a.sy0, mark: a.mark }; });
    return false;
  }

  armHold() {
    const a = this.active;
    if (!a) return;
    this.clearHold();
    if (gestureAction('penHold') === 'none' || a.kind !== 'pen') return;
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
    this.r.consumed.add(id);
    this.r.runGesture(gestureAction('penHold'), x, y, 'pen-hold');
  }

  /** 메뉴를 열기 위해 현재 획을 정리: 의미 없는 짧은 획은 버리고, 긴 획은 보존 */
  finishForMenu() {
    if (!this.active) return;
    const keep = !this.tools.isTrivial() && now() - this.active.t0 > 400;
    this.end(!keep);
  }

  /** 획 종료. 어떤 예외가 나도 펜 상태는 반드시 해제한다 */
  end(cancel, upAt = now()) {
    const a = this.active;
    if (!a) return;
    this.clearHold();
    this.active = null;
    try { if (cancel) this.tools.cancel(); else this.tools.end(); }
    catch (err) { console.error('[pen end]', err); }
    finally {
      try { this.r.el.releasePointerCapture(a.id); } catch { /* */ }
      this.r.viewer.pauseRender(false);
      if (a.kind === 'pen') this.r.lastPenUp = upAt;
    }
  }

  forceEnd() { if (this.active) this.end(false); }
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
    for (const [id, t] of this.touches) if (!t.rejected && !t.guide && !t.noteDrag) out.push([id, t]);
    return out;
  }

  isPalm(e) {
    if (!settings.get('palmSizeEnabled')) return false;
    const size = Math.max(e.width || 0, e.height || 0);
    return size >= settings.get('palmSize');
  }

  onDown(e) {
    const r = this.r;
    if (e.isPrimary) { this.touches.clear(); this.gesture = null; this.base = null; } // 정리되지 않은 이전 터치 제거
    // 펜 상태가 남아 있지만 펜 이벤트가 끊겼다면 pointerup 누락 → 정리하고 손가락을 받는다
    r.pen.healIfStale('touch down');
    const s = r.screen(e);
    let reason = '';
    if (r.isPenActive() && r.pen.active.kind !== 'touch') reason = 'pen-active';
    else if (now() - r.lastPenUp < settings.get('penGuardMs')) reason = 'pen-guard';
    else if (settings.get('hoverGuard') && r.penHovering && now() - r.lastPenEvent < 1500) reason = 'pen-hover';
    else if (this.isPalm(e)) reason = 'palm-size';
    const t = { x: s.x, y: s.y, x0: s.x, y0: s.y, rejected: !!reason, reason };
    this.touches.set(e.pointerId, t);
    if (!this.gesture) this.gesture = { t0: now(), cam0: { ...r.viewer.cam }, maxCount: 0, moved: false, rejectedAny: false };
    if (t.rejected) { this.gesture.rejectedAny = true; r.trace(`손가락 ${e.pointerId} 거부: ${reason}`); return; }
    // 자/각도기 위에 닿은 손가락은 화면 대신 도구를 옮긴다
    if (r.app.guides?.grab(e.pointerId, s.x, s.y)) { t.guide = true; this.gesture.rejectedAny = true; this.rebase(); return; }
    // 포스트잇 어두운 띠(손잡이)를 손가락으로 잡으면 화면 대신 포스트잇을 옮긴다
    if (r.app.noteDragStart?.(s.x, s.y)) { t.noteDrag = true; this.gesture.rejectedAny = true; this.rebase(); return; }

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
    this.armFingerHold(e.pointerId, t);
  }

  /** 손가락 꾹 누르기: 한 손가락이 0.6초 동안 거의 움직이지 않으면 지정된 동작 */
  armFingerHold(id, t) {
    clearTimeout(this.holdTimer);
    this.holdTimer = 0;
    if (gestureAction('fingerHold') === 'none' || this.active().length !== 1) return;
    this.holdTimer = setTimeout(() => {
      this.holdTimer = 0;
      const cur = this.touches.get(id);
      if (!cur || cur !== t || cur.rejected || this.active().length !== 1 || dist(cur.x0, cur.y0, cur.x, cur.y) > 10) return;
      // 이 손가락은 이후 화면을 움직이지 않는다 (탭·관성도 없음)
      cur.rejected = true; cur.reason = 'finger-hold';
      if (this.gesture) this.gesture.rejectedAny = true;
      this.base = null;
      this.r.runGesture(gestureAction('fingerHold'), cur.x0, cur.y0, 'finger-hold');
    }, FINGER_HOLD_MS);
  }

  cancelFingerHold() { clearTimeout(this.holdTimer); this.holdTimer = 0; }

  /** 위치만 갱신 (손가락 필기 중에도 좌표를 최신으로 유지해 제스처 전환 시 튐 방지) */
  track(e) {
    const t = this.touches.get(e.pointerId);
    if (!t) return;
    const s = this.r.screen(e);
    t.x = s.x; t.y = s.y;
  }

  onMove(e) {
    const t = this.touches.get(e.pointerId);
    if (!t || t.rejected) return;
    if (t.guide) { this.r.app.guides?.move(e.pointerId, t.x, t.y); return; }
    if (t.noteDrag) { this.r.app.noteDragMove(t.x, t.y); return; }
    // 이동 중 접촉면이 커지면(손바닥이 눕는 경우) 그때라도 제외
    if (this.isPalm(e)) { t.rejected = true; t.reason = 'palm-size'; if (this.gesture) this.gesture.rejectedAny = true; this.rebase(); return; }
    if (this.gesture && dist(t.x0, t.y0, t.x, t.y) > 10) { this.gesture.moved = true; this.cancelFingerHold(); }
    if (!this.base) this.rebase();
    this.apply(e.timeStamp);
  }

  onUp(e, cancelled) {
    const t = this.touches.get(e.pointerId);
    if (this.fingerInk === e.pointerId) this.fingerInk = null;
    if (!t) return;
    this.touches.delete(e.pointerId);
    this.cancelFingerHold();
    if (t.guide) this.r.app.guides?.release(e.pointerId);
    if (t.noteDrag) {
      // 안 움직였으면 탭: 접힌 아이콘 펼치기 등
      const moved = this.r.app.noteDragEnd(!!cancelled);
      if (!moved && !cancelled) this.r.app.tap?.(t.x0, t.y0);
    }
    if (this.touches.size === 0) {
      const g = this.gesture;
      this.gesture = null;
      this.base = null;
      if (g && !cancelled && !g.moved && !g.rejectedAny && now() - g.t0 < 350) {
        const key = g.maxCount === 2 ? 'twoFingerTap' : g.maxCount === 3 ? 'threeFingerTap' : null;
        const act = key && gestureAction(key);
        if (act && act !== 'none') {
          this.r.viewer.setCamera(g.cam0.tx, g.cam0.ty, g.cam0.z); // 탭 중 미세하게 움직인 화면 원위치
          this.r.runGesture(act, t.x0, t.y0, key);
          return;
        }
        // 한 손가락 탭: 링크 따라가기 (펜 필기와 겹치지 않도록 링크는 손가락으로만 연다)
        if (g.maxCount === 1 && !t.rejected && now() - g.t0 < 300) { this.r.app.tap?.(t.x0, t.y0); return; }
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
      if (!a || !c || a.rejected || c.rejected) { this.rebase(); return; }
      const mx = (a.x + c.x) / 2, my = (a.y + c.y) / 2;
      const d = Math.max(dist(a.x, a.y, c.x, c.y), 1);
      let z = b.cam.z * (d / b.d);
      z = Math.min(Math.max(z, v.minZ()), v.maxZ());
      v.setCamera(mx - b.w.x * z, my - b.w.y * z, z);
      this.r.app.showZoom?.();
    } else this.rebase();
  }

  onPenContact() {
    this.stopInertia();
    if (!this.touches.size) return;
    const g = this.gesture;
    // 펜 직전에 닿은 한 손가락(대개 손바닥)으로 생긴 이동은 되돌린다
    if (g && settings.get('undoRestorePan') && g.maxCount <= 1 && now() - g.t0 < 700) {
      this.r.viewer.setCamera(g.cam0.tx, g.cam0.ty, g.cam0.z);
    }
    this.rejectAll('pen-contact');
  }

  rejectAll(reason) {
    this.cancelFingerHold();
    if (!this.touches.size) return;
    for (const t of this.touches.values()) if (t.noteDrag) { this.r.app.noteDragEnd(false); t.noteDrag = false; }
    for (const [id, t] of this.touches) if (t.guide) this.r.app.guides?.release(id);
    for (const t of this.touches.values()) if (!t.rejected) { t.rejected = true; t.reason = reason; }
    if (this.gesture) this.gesture.rejectedAny = true;
    this.base = null;
  }

  /** 실제로는 손가락이 하나도 없는데 기록만 남은 경우 */
  clearStale() { this.cancelFingerHold(); for (const id of this.touches.keys()) this.r.app.guides?.release(id); this.touches.clear(); this.base = null; this.gesture = null; this.fingerInk = null; }

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

  reset() { this.clearStale(); this.stopInertia(); }
}

// ───────────────────────────── 마우스 ─────────────────────────────

class MouseInput {
  constructor(router) {
    this.r = router;
    this.pan = null;
  }

  onDown(e) {
    const r = this.r;
    if (e.button === 0) {
      const s = r.screen(e);
      if (r.app.guides?.grab(e.pointerId, s.x, s.y)) { this.guide = e.pointerId; try { r.el.setPointerCapture(e.pointerId); } catch { /* */ } return; }
    }
    if (e.button === 0 && settings.get('mouseDraw')) { r.pen.onDown(e, 'mouse'); return; }
    if (e.button === 0 || e.button === 1) {
      const s = r.screen(e);
      this.pan = { id: e.pointerId, x: s.x, y: s.y, cam: { ...r.viewer.cam } };
      try { r.el.setPointerCapture(e.pointerId); } catch { /* */ }
    }
  }

  onMove(e) {
    if (this.guide === e.pointerId) { const s = this.r.screen(e); this.r.app.guides?.move(e.pointerId, s.x, s.y); return; }
    if (!this.pan || this.pan.id !== e.pointerId) return;
    const s = this.r.screen(e);
    const c = this.pan.cam;
    this.r.viewer.setCamera(c.tx + s.x - this.pan.x, c.ty + s.y - this.pan.y, c.z);
  }

  onUp(e) {
    if (this.guide === e.pointerId) { this.r.app.guides?.release(e.pointerId); this.guide = null; }
    if (this.pan && this.pan.id === e.pointerId) this.pan = null;
  }

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

  reset() { this.pan = null; if (this.guide != null) this.r.app.guides?.release(this.guide); this.guide = null; }
}
