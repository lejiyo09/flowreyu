// 앱 설정: localStorage에 저장 (작고 동기적으로 필요한 값). 실패 시 메모리 값으로 동작.
import { Emitter, clamp } from './util.js';

const KEY = 'flexnote.settings.v1';

export const PEN_COLORS = ['#111111', '#e53935', '#1e63d6', '#2e9d4f', '#f08c00', '#8e44ad', '#795548', '#ffffff'];
export const HL_COLORS = ['#fff176', '#a5f3a1', '#9fd8ff', '#ffb3d1', '#ffcc80', '#d1b3ff'];

/** 제스처에 지정할 수 있는 동작 */
export const GESTURE_ACTIONS = [
  ['none', '사용 안 함'],
  ['menu', '도구 메뉴'],
  ['undo', '실행 취소'],
  ['redo', '다시 실행'],
  ['toggleEraser', '지우개 ↔ 이전 도구'],
  ['prevTool', '직전에 쓴 도구로'],
  ['tool:pen', '펜'],
  ['tool:hl', '형광펜'],
  ['tool:eraser', '지우개'],
  ['tool:lasso', '올가미'],
  ['tool:text', '텍스트'],
  ['tool:shape', '도형'],
  ['tool:link', '링크'],
  ['insertImage', '그림 넣기'],
  ['insertNote', '포스트잇 붙이기'],
  ['insertChecklist', '체크리스트 넣기'],
  ['insertTable', '표 넣기'],
  ['toggleRecord', '녹음 시작/정지'],
  ['aiPanel', 'AI 도우미 열기'],
  ['layers', '레이어 패널 열기'],
  ['toggleFinger', '손가락 쓰기 켜기/끄기'],
  ['toggleRuler', '자 켜기/끄기'],
  ['toggleProt', '각도기 켜기/끄기'],
  ['thumbs', '페이지 목록 열기/닫기'],
  ['fitWidth', '폭 맞춤'],
];
/** 제스처 목록: [키, 이름, 설명, 추가 동작] */
export const GESTURES = [
  ['penButton', 'S Pen 버튼 + 터치', '버튼 신호를 브라우저에 보내는 기기에서만 동작 (갤럭시 탭 크롬은 보내지 않음)', [['eraserHold', '누르는 동안 지우개']]],
  ['penHold', '펜 꾹 누르기', '펜을 대고 움직이지 않으면 (시간·허용 거리는 아래에서)', []],
  ['penDoubleTap', '펜 두 번 탭', '같은 곳을 빠르게 두 번 탭 (찍힌 점은 지워짐)', []],
  ['twoFingerTap', '두 손가락 탭', '', []],
  ['threeFingerTap', '세 손가락 탭', '', []],
  ['fingerHold', '손가락 꾹 누르기', '한 손가락을 대고 0.6초 움직이지 않으면', []],
];

export const DEFAULTS = {
  theme: 'system', // system | light | dark

  // S Pen / 펜
  penHoverButton: true, // 호버 중 버튼 입력(buttons=2)도 메뉴로 처리
  holdMs: 700, // 300~5000
  holdTolerance: 10, // CSS px (버튼을 누르면 펜 끝이 조금 움직이므로 여유 있게)
  holdCondition: 'start', // start: 펜을 댄 직후 움직이지 않을 때만 / anytime: 필기 도중 멈춰도
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
  inertia: true,

  // 마우스
  mouseDraw: true,

  // 도구별 설정
  tool: 'pen',
  pen: { color: '#111111', width: 2.2, recent: ['#111111', '#e53935', '#1e63d6'] },
  hl: { color: '#fff176', width: 14, recent: ['#fff176', '#a5f3a1', '#9fd8ff'] },
  eraser: { mode: 'stroke', size: 16, autoReturn: false, text: false }, // stroke | area, size: 화면 px, autoReturn: 한 번 지우면 이전 도구로, text: 텍스트도 지우기
  shape: { kind: 'rect', color: '#1e63d6', width: 2 },
  text: { color: '#111111', size: 16 },
  note: { color: '#fff59d' }, // 포스트잇 색
  lasso: {},
  ai: { effort: 'medium', lang: 'en', model: 'gemini-3-flash-preview' }, // AI 도우미 (API 키는 따로 저장: ai.js)

  // 제스처 → 동작 (GESTURE_ACTIONS 의 id)
  gestures: {
    penButton: 'menu',
    penHold: 'menu',
    penDoubleTap: 'menu',
    twoFingerTap: 'undo',
    threeFingerTap: 'redo',
    fingerHold: 'none',
  },

  debug: false,
  sv: 3, // 설정 버전 (기본값 변경 시 마이그레이션)
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
  if (saved.sv < 3) {
    // 켜고 끄기만 하던 제스처 설정을 "제스처 → 동작" 지정으로 옮긴다
    const g = (saved.gestures = { ...(saved.gestures || {}) });
    if (saved.penButtonAction) g.penButton = { menu: 'menu', eraser: 'eraserHold', none: 'none' }[saved.penButtonAction] || 'menu';
    if (saved.holdEnabled === false) g.penHold = 'none';
    if (saved.penDoubleTap === false) g.penDoubleTap = 'none';
    if (saved.twoFingerUndo === false) g.twoFingerTap = 'none';
    if (saved.threeFingerRedo === false) g.threeFingerTap = 'none';
    for (const k of ['penButtonAction', 'holdEnabled', 'penDoubleTap', 'twoFingerUndo', 'threeFingerRedo']) delete saved[k];
    saved.sv = 3;
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
  const ids = new Set(GESTURE_ACTIONS.map(([id]) => id));
  for (const [key, , , extra] of GESTURES) {
    const ok = ids.has(s.gestures[key]) || extra.some(([id]) => id === s.gestures[key]);
    if (!ok) s.gestures[key] = DEFAULTS.gestures[key];
  }
  if (!['low', 'medium', 'high'].includes(s.ai.effort)) s.ai.effort = 'medium';
  // 목록에 없는 모델(예전 기본값의 Pro 등)은 기본값으로
  if (!['gemini-3-flash-preview', 'gemini-flash-latest', 'gemini-flash-lite-latest'].includes(s.ai.model)) s.ai.model = DEFAULTS.ai.model;
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
