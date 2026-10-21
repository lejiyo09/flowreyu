// 스톱워치 · 타이머
//
// 시작 시각(벽시계 Date.now)을 localStorage 에 저장하므로 패널을 닫거나 노트를 바꾸거나 새로고침해도 계속 간다.
// 화면 갱신은 main.js 가 맡고, 여기서는 시간 계산과 끝났을 때 'ring' 알림만 한다.
import { Emitter } from './util.js';

const KEY = 'flexnote.clock.v1';

export class Clock extends Emitter {
  constructor() {
    super();
    this.sw = { running: false, t0: 0, acc: 0, laps: [] }; // 스톱워치: acc = 멈출 때까지 쌓인 시간
    this.tm = { running: false, end: 0, left: 5 * 60000, total: 5 * 60000, done: false }; // 타이머
    this.timeout = 0;
    this.load();
  }

  load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (s?.sw) this.sw = { running: !!s.sw.running, t0: +s.sw.t0 || 0, acc: +s.sw.acc || 0, laps: Array.isArray(s.sw.laps) ? s.sw.laps.filter(Number.isFinite).slice(0, 99) : [] };
      if (s?.tm) this.tm = { running: !!s.tm.running, end: +s.tm.end || 0, left: Math.max(0, +s.tm.left || 0), total: Math.max(1000, +s.tm.total || 300000), done: !!s.tm.done };
    } catch { /* 저장소를 못 쓰면 메모리로만 */ }
  }
  save() {
    try { localStorage.setItem(KEY, JSON.stringify({ sw: this.sw, tm: this.tm })); } catch { /* */ }
    this.emit('change');
  }

  // ── 스톱워치 ──
  swElapsed() { return this.sw.acc + (this.sw.running ? Date.now() - this.sw.t0 : 0); }
  swToggle() {
    const now = Date.now();
    if (this.sw.running) { this.sw.acc += now - this.sw.t0; this.sw.running = false; }
    else { this.sw.t0 = now; this.sw.running = true; }
    this.save();
  }
  /** 랩: 지금까지의 누적 시간을 맨 앞에 기록 */
  swLap() {
    const t = this.swElapsed();
    if (!t) return;
    this.sw.laps.unshift(t);
    if (this.sw.laps.length > 99) this.sw.laps.length = 99;
    this.save();
  }
  swReset() { this.sw = { running: false, t0: 0, acc: 0, laps: [] }; this.save(); }

  // ── 타이머 ──
  tmLeft() { return this.tm.running ? Math.max(0, this.tm.end - Date.now()) : this.tm.left; }
  /** 시간 지정 (도는 중이면 새 시간으로 다시 시작) */
  tmSet(ms) {
    ms = Math.max(1000, Math.min(ms, 24 * 3600000));
    const wasRunning = this.tm.running;
    this.tm = { running: false, end: 0, left: ms, total: ms, done: false };
    if (wasRunning) this.tmToggle(); else this.save();
  }
  /** 남은 시간에 더하기 (도는 중이어도 가능) */
  tmAdd(ms) {
    if (this.tm.running) this.tm.end += ms;
    else this.tm.left = Math.max(0, this.tm.left) + ms;
    this.tm.total = Math.max(this.tm.total, this.tmLeft());
    this.tm.done = false;
    this.schedule();
    this.save();
  }
  tmToggle() {
    const now = Date.now();
    if (this.tm.running) { this.tm.left = Math.max(0, this.tm.end - now); this.tm.running = false; }
    else {
      if (this.tm.left <= 0) this.tm.left = this.tm.total; // 끝난 뒤 다시 시작하면 처음 시간으로
      this.tm.end = now + this.tm.left;
      this.tm.running = true;
      this.tm.done = false;
    }
    this.schedule();
    this.save();
  }
  tmReset() {
    this.tm = { ...this.tm, running: false, end: 0, left: this.tm.total, done: false };
    this.schedule();
    this.save();
  }

  /** 끝날 시각에 맞춰 확인 예약 (백그라운드 탭에서는 늦게 올 수 있어 화면 복귀 때도 check 호출) */
  schedule() {
    clearTimeout(this.timeout);
    if (this.tm.running) this.timeout = setTimeout(() => this.check(), Math.min(this.tm.end - Date.now() + 20, 2 ** 31 - 1));
  }
  /** 끝났으면 'ring' (late: 앱이 꺼져 있던 동안 끝난 경우) */
  check(late = false) {
    if (!this.tm.running) return;
    if (Date.now() < this.tm.end) { this.schedule(); return; }
    const over = Date.now() - this.tm.end;
    this.tm = { ...this.tm, running: false, left: 0, done: true };
    this.save();
    this.emit('ring', { late: late || over > 5000 });
  }
  /** 패널에서 끝남 표시를 지울 때 */
  ackDone() { if (this.tm.done) { this.tm.done = false; this.tm.left = this.tm.total; this.save(); } }
}

/** ms → "m:ss" 또는 "h:mm:ss" (cs: 1/100초까지) */
export function fmtClock(ms, cs = false) {
  ms = Math.max(0, ms);
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  const base = h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return cs ? `${base}.${String(Math.floor(ms / 10) % 100).padStart(2, '0')}` : base;
}

/** 알림음: 짧은 삐-삐-삐 3번 (Web Audio, 파일 없이) */
export function ringSound() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ac = new Ctx();
    const t0 = ac.currentTime + 0.05;
    for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) {
      const t = t0 + r * 1.0 + k * 0.18;
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine';
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
      o.connect(g).connect(ac.destination);
      o.start(t);
      o.stop(t + 0.15);
    }
    setTimeout(() => ac.close().catch(() => {}), 3500);
  } catch { /* 소리를 못 내도 화면 알림은 됨 */ }
}
