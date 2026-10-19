// 앱 설정: localStorage에 저장 (작고 동기적으로 필요한 값). 실패 시 메모리 값으로 동작.
import { Emitter, clamp } from './util.js';

const KEY = 'flexnote.settings.v1';

export const PEN_COLORS = ['#111111', '#e53935', '#1e63d6', '#2e9d4f', '#f08c00', '#8e44ad', '#795548', '#ffffff'];
export const HL_COLORS = ['#fff176', '#a5f3a1', '#9fd8ff', '#ffb3d1', '#ffcc80', '#d1b3ff'];

export const DEFAULTS = {
  theme: 'system', // system | light | dark

  // S Pen / 펜
  penButtonAction: 'menu', // menu | eraser | none
  penHoverButton: true, // 호버 중 버튼 입력(buttons=2)도 메뉴로 처리
  holdEnabled: true,
  holdMs: 700, // 300~5000
  holdTolerance: 10, // CSS px (버튼을 누르면 펜 끝이 조금 움직이므로 여유 있게)
  holdCondition: 'start', // start: 펜을 댄 직후 움직이지 않을 때만 / anytime: 필기 도중 멈춰도
  penDoubleTap: true, // 펜으로 같은 곳을 빠르게 두 번 탭 → 도구 메뉴 (버튼 신호를 주지 않는 기기의 대안)
  pressure: true,
  smoothing: 2, // 0~10
  prediction: true,

  // 팜 리젝션 / 터치
  fingerDraw: false, // 손가락으로 필기 (펜이 없는 기기용)
  palmSizeEnabled: true,
  palmSize: 90, // 접촉면 지름(px) 이상이면 손바닥으로 간주 (실기기 손가락 43px 관측)
  penGuardMs: 300, // 펜을 뗀 뒤 이 시간 동안 새 터치를 무시
  hoverGuard: false, // 펜이 화면 위에 떠 있는 동안 새 터치 무시
  undoRestorePan: true, // 펜이 닿기 직전 시작된 한 손가락 이동은 되돌림
  twoFingerUndo: true,
  threeFingerRedo: true,
  inertia: true,

  // 마우스
  mouseDraw: true,

  // 도구별 설정
  tool: 'pen',
  pen: { color: '#111111', width: 2.2, recent: ['#111111', '#e53935', '#1e63d6'] },
  hl: { color: '#fff176', width: 14, recent: ['#fff176', '#a5f3a1', '#9fd8ff'] },
  eraser: { mode: 'stroke', size: 16, autoReturn: false }, // stroke | area, size: 화면 px, autoReturn: 한 번 지우면 이전 도구로
  shape: { kind: 'rect', color: '#1e63d6', width: 2 },
  text: { color: '#111111', size: 16 },
  lasso: {},

  debug: false,
  sv: 2, // 설정 버전 (기본값 변경 시 마이그레이션)
};

function merge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  if (!over || typeof over !== 'object') return out;
  for (const k of Object.keys(base)) {
    if (!(k in over)) continue;
    const b = base[k], o = over[k];
    if (b && typeof b === 'object' && !Array.isArray(b)) out[k] = merge(b, o);
    else if (typeof b === typeof o && (!Array.isArray(b) || Array.isArray(o))) out[k] = o;
  }
  return out;
}

/** 예전 기본값을 그대로 쓰던 사용자만 새 기본값으로 옮긴다 (직접 바꾼 값은 유지) */
function migrate(saved) {
  if (!saved || typeof saved !== 'object') return;
  if ((saved.sv || 1) < 2) {
    if (saved.palmSize === 40) saved.palmSize = 90; // 손가락(43px)을 손바닥으로 오판하던 값
    if (saved.holdTolerance === 6) saved.holdTolerance = 10;
    saved.sv = 2;
  }
}

function sanitize(s) {
  s.holdMs = clamp(Math.round(+s.holdMs || DEFAULTS.holdMs), 300, 5000);
  s.holdTolerance = clamp(+s.holdTolerance || DEFAULTS.holdTolerance, 1, 40);
  s.smoothing = clamp(Math.round(+s.smoothing), 0, 10);
  s.palmSize = clamp(+s.palmSize || DEFAULTS.palmSize, 15, 200);
  s.penGuardMs = clamp(+s.penGuardMs, 0, 2000);
  s.pen.width = clamp(+s.pen.width || 2, 0.3, 30);
  s.hl.width = clamp(+s.hl.width || 14, 2, 60);
  s.eraser.size = clamp(+s.eraser.size || 16, 4, 120);
  s.shape.width = clamp(+s.shape.width || 2, 0.3, 30);
  s.text.size = clamp(+s.text.size || 16, 6, 120);
  if (!['system', 'light', 'dark'].includes(s.theme)) s.theme = 'system';
  if (!['menu', 'eraser', 'none'].includes(s.penButtonAction)) s.penButtonAction = 'menu';
  if (!['start', 'anytime'].includes(s.holdCondition)) s.holdCondition = 'start';
  if (!['pen', 'hl', 'eraser', 'lasso', 'text', 'shape', 'link'].includes(s.tool)) s.tool = 'pen';
  return s;
}

class Settings extends Emitter {
  constructor() {
    super();
    this.persistOk = true;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { this.persistOk = false; }
    migrate(saved);
    this.v = sanitize(merge(structuredClone(DEFAULTS), saved));
  }
  get(k) { return this.v[k]; }
  /** set('pen.color', '#000') 형태의 경로 지원 */
  set(path, value) {
    const parts = path.split('.');
    let o = this.v;
    for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
    o[parts[parts.length - 1]] = value;
    sanitize(this.v);
    this.save();
    this.emit('change', { path, value });
  }
  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.v)); this.persistOk = true; }
    catch { this.persistOk = false; }
  }
  reset() {
    this.v = sanitize(structuredClone(DEFAULTS));
    this.save();
    this.emit('change', { path: '*' });
  }
}

export const settings = new Settings();
