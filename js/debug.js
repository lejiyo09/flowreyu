// 입력 디버그 로그: S Pen 버튼 등 실제 기기가 브라우저에 무엇을 전달하는지 기록한다.
// 앱 동작과 독립적으로 window 캡처 단계에서 듣기만 하므로 입력 처리에 영향을 주지 않는다.
import { escapeHtml } from './util.js';

const TYPES = [
  'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerover', 'pointerout',
  'pointerenter', 'pointerleave', 'gotpointercapture', 'lostpointercapture',
  'mousedown', 'mouseup', 'auxclick', 'click', 'contextmenu',
  'touchstart', 'touchend', 'touchcancel',
  'keydown', // S Pen 에어 액션 등이 키 입력으로 오는지 확인용
];
const MAX = 400;

export class InputDebugger {
  constructor(panel) {
    this.panel = panel;
    this.list = panel.querySelector('.dbg-list');
    this.summary = panel.querySelector('.dbg-summary');
    this.stateEl = panel.querySelector('.dbg-state');
    this.getState = null; // () => 입력 엔진 상태 문자열
    this._stateTimer = 0;
    this.rows = [];
    this.on = false;
    this.hideMoves = true;
    this.t0 = performance.now();
    this.stats = {};
    this._h = (e) => this.record(e);
    this._pending = false;
    panel.querySelector('[data-dbg=moves]').addEventListener('change', (e) => { this.hideMoves = e.target.checked; this.render(); });
    panel.querySelector('[data-dbg=clear]').addEventListener('click', () => { this.rows = []; this.stats = {}; this.t0 = performance.now(); this.render(); });
    panel.querySelector('[data-dbg=copy]').addEventListener('click', () => this.copy());
    panel.querySelector('[data-dbg=save]').addEventListener('click', () => this.download());
    panel.querySelector('[data-dbg=close]').addEventListener('click', () => this.onClose?.());
  }

  enable(v) {
    if (v === this.on) return;
    this.on = v;
    this.panel.hidden = !v;
    for (const t of TYPES) {
      if (v) window.addEventListener(t, this._h, { capture: true, passive: true });
      else window.removeEventListener(t, this._h, { capture: true });
    }
    clearInterval(this._stateTimer);
    if (v) {
      this.render();
      this._stateTimer = setInterval(() => { if (this.getState) this.stateEl.textContent = this.getState(); }, 200);
    }
  }

  /** 입력 엔진의 판정 이유를 로그에 함께 남긴다 */
  note(msg) {
    if (!this.on) return;
    this.rows.push({ t: Math.round(performance.now() - this.t0), type: 'note', msg });
    if (!this._pending) { this._pending = true; requestAnimationFrame(() => { this._pending = false; this.render(); }); }
  }

  record(e) {
    if (this.panel.contains(e.target)) return;
    const r = {
      t: Math.round(e.timeStamp - this.t0),
      type: e.type,
      pt: e.pointerType ?? (e.type.startsWith('touch') ? '(touch)' : e.type.startsWith('mouse') || e.type === 'click' || e.type === 'auxclick' || e.type === 'contextmenu' ? '(mouse)' : ''),
      id: e.pointerId ?? '',
      button: e.button ?? '',
      buttons: e.buttons ?? '',
      pressure: e.pressure != null ? +e.pressure.toFixed(3) : '',
      tilt: e.tiltX != null ? `${e.tiltX},${e.tiltY}` : '',
      size: e.width != null ? `${Math.round(e.width)}x${Math.round(e.height)}` : '',
      primary: e.isPrimary ?? '',
      x: e.clientX != null ? Math.round(e.clientX) : (e.touches?.[0] ? Math.round(e.touches[0].clientX) : ''),
      y: e.clientY != null ? Math.round(e.clientY) : (e.touches?.[0] ? Math.round(e.touches[0].clientY) : ''),
      touches: e.touches ? e.touches.length : '',
      coalesced: typeof e.getCoalescedEvents === 'function' && e.type === 'pointermove' ? e.getCoalescedEvents().length : '',
    };
    if (e.type === 'keydown') r.pt = `key=${e.key} code=${e.code}`;
    this.rows.push(r);
    if (this.rows.length > MAX * 3) this.rows.splice(0, this.rows.length - MAX * 3);
    const key = `${r.type}|${r.pt}|b${r.button}|bs${r.buttons}`;
    this.stats[key] = (this.stats[key] || 0) + 1;
    if (!this._pending) { this._pending = true; requestAnimationFrame(() => { this._pending = false; this.render(); }); }
  }

  render() {
    if (!this.on) return;
    const rows = (this.hideMoves ? this.rows.filter((r) => r.type !== 'pointermove' || r.buttons > 1 || r.button > 0) : this.rows).slice(-MAX);
    const hi = (r) => (r.buttons & 2 || r.button === 2 || r.type === 'contextmenu' || r.type === 'auxclick' || r.buttons & 32 ? ' hl' : '');
    this.list.innerHTML = rows.slice().reverse().map((r) => r.type === 'note'
      ? `<tr class="note"><td>${r.t}</td><td colspan="9">▶ ${escapeHtml(r.msg)}</td></tr>`
      : `<tr class="${hi(r)}"><td>${r.t}</td><td>${r.type}</td><td>${escapeHtml(r.pt)}</td><td>${r.id}</td><td>${r.button}</td><td>${r.buttons}</td><td>${r.pressure}</td><td>${r.size}</td><td>${r.x},${r.y}</td><td>${r.tilt}</td></tr>`).join('');
    const keys = Object.keys(this.stats).filter((k) => /button[s]?[^|]*/.test(k)).sort();
    const interesting = keys.filter((k) => !k.includes('|b-1|bs0') && (k.includes('contextmenu') || k.includes('auxclick') || /bs([2-9]|[1-9]\d)/.test(k) || /\|b([1-9])/.test(k)));
    this.summary.innerHTML = interesting.length
      ? '보조 입력으로 보이는 이벤트: ' + interesting.map((k) => `<code>${escapeHtml(k)}</code>×${this.stats[k]}`).join(' ')
      : 'S Pen 버튼을 누른 채로 화면을 터치해 보세요. 버튼 관련 이벤트(buttons=2, button=2, contextmenu 등)가 잡히면 여기에 표시됩니다.';
  }

  text() {
    const env = `UA: ${navigator.userAgent}\nmaxTouchPoints: ${navigator.maxTouchPoints}\ndpr: ${devicePixelRatio}\n`;
    const head = 't(ms)\ttype\tpointerType\tid\tbutton\tbuttons\tpressure\tsize\tx,y\ttilt\tprimary\ttouches\tcoalesced';
    return env + head + '\n' + this.rows.map((r) => r.type === 'note' ? `${r.t}\t# ${r.msg}` : [r.t, r.type, r.pt, r.id, r.button, r.buttons, r.pressure, r.size, `${r.x},${r.y}`, r.tilt, r.primary, r.touches, r.coalesced].join('\t')).join('\n');
  }

  async copy() {
    try { await navigator.clipboard.writeText(this.text()); this.onToast?.('로그를 복사했습니다'); }
    catch { this.download(); }
  }

  download() {
    const blob = new Blob([this.text()], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `input-log-${Date.now()}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
}
