// AI 도우미 (Claude API): 회의록 정리·요약, 맞춤법·문법 검사, 번역
//
// - 사용자가 직접 발급한 Anthropic API 키를 이 기기(localStorage)에만 저장하고, 브라우저에서 api.anthropic.com 으로 바로 보낸다.
//   서버를 거치지 않으므로 키가 이 기기 밖으로 나가는 곳은 Anthropic 뿐이다. (공용 기기에서는 쓰지 말 것)
// - 공식 SDK(@anthropic-ai/sdk)를 vendor/anthropic/sdk.mjs 로 번들해 두었다. 처음 쓸 때만 불러온다.
// - 정책상 거절되면 서버가 자동으로 다른 모델로 다시 시도한다 (fallbacks: "default").

export const AI_MODEL = 'claude-opus-5-5';
const KEY_STORE = 'flexnote.aiKey';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export const TRANSLATE_LANGS = [
  ['en', '영어'], ['ko', '한국어'], ['ja', '일본어'], ['zh-CN', '중국어(간체)'], ['zh-TW', '중국어(번체)'],
  ['es', '스페인어'], ['fr', '프랑스어'], ['de', '독일어'], ['vi', '베트남어'], ['th', '태국어'], ['id', '인도네시아어'], ['ru', '러시아어'],
];
const LANG_NAME = Object.fromEntries(TRANSLATE_LANGS);

export function getApiKey() {
  try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; }
}
export function setApiKey(k) {
  try { if (k) localStorage.setItem(KEY_STORE, k.trim()); else localStorage.removeItem(KEY_STORE); } catch { /* */ }
  client = null;
}

let client = null; // {key, promise}
async function getClient() {
  const key = getApiKey();
  if (!key) throw new AiError('nokey', 'AI 기능을 쓰려면 설정 → AI 도우미에서 Anthropic API 키를 입력하세요.');
  if (!client || client.key !== key) {
    client = {
      key,
      promise: import('../vendor/anthropic/sdk.mjs').then((m) => new m.default({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 2 })),
    };
  }
  return client.promise;
}

export class AiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function friendlyError(e) {
  if (e instanceof AiError) return e;
  const st = e?.status;
  if (st === 401) return new AiError('auth', 'API 키가 올바르지 않습니다. 설정 → AI 도우미에서 키를 확인하세요.');
  if (st === 403) return new AiError('perm', '이 API 키로는 이 기능을 쓸 수 없습니다 (권한 없음).');
  if (st === 429) return new AiError('rate', '요청이 너무 많거나 사용 한도를 넘었습니다. 잠시 후 다시 시도하세요.');
  if (st === 400) return new AiError('bad', `요청 오류: ${e?.error?.error?.message || e.message}`);
  if (st >= 500) return new AiError('server', 'Anthropic 서버가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도하세요.');
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return new AiError('offline', 'AI 기능은 인터넷 연결이 필요합니다.');
  return new AiError('net', `연결 실패: ${e?.message || e}`);
}

/**
 * Claude 에 한 번 묻고 답 글을 돌려준다 (스트리밍, onText 로 진행 중인 글 전달)
 * @param {{system:string, content:Array, effort?:string, onText?:(delta:string, all:string)=>void, signal?:AbortSignal}} o
 */
export async function askClaude({ system, content, effort = 'medium', onText, signal }) {
  try {
    const c = await getClient();
    const stream = c.beta.messages.stream({
      model: AI_MODEL,
      max_tokens: 16000,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort },
      system,
      messages: [{ role: 'user', content }],
    }, { signal });
    let all = '';
    stream.on('text', (d) => { all += d; onText?.(d, all); });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') throw new AiError('refusal', 'AI가 이 내용의 처리를 거절했습니다.');
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (!text) throw new AiError('empty', 'AI가 빈 답을 보냈습니다. 다시 시도하세요.');
    return { text, truncated: msg.stop_reason === 'max_tokens', model: msg.model };
  } catch (e) {
    if (signal?.aborted) throw new AiError('abort', '중지했습니다.');
    throw friendlyError(e);
  }
}

// ───────────── 작업별 요청 ─────────────

const fmtMs = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/**
 * 회의록 정리·요약
 * @param {{segments?:{t:number,text:string}[], pageText?:string, image?:string(base64 JPEG), title?:string, date?:string}} src
 */
export function minutesRequest({ segments = [], pageText = '', image = null, title = '', date = '' }) {
  const system = [
    '당신은 회의록을 정리하는 비서입니다. 사용자가 회의 중에 녹음 받아쓰기(자동 음성 인식이라 오타·끊김이 있을 수 있음), 노트 페이지 이미지(손글씨 포함), 페이지에 입력한 글을 줍니다.',
    '이 자료만 근거로 한국어 회의록을 작성합니다. 자료에 없는 사실·이름·날짜는 지어내지 말고, 알 수 없으면 "미정"이라고 씁니다. 음성 인식 오류로 보이는 단어는 문맥상 분명할 때만 고칩니다.',
    '손글씨가 읽히지 않으면 추측하지 말고 [판독 불가]로 표시합니다.',
    '출력은 아래 형식의 일반 텍스트입니다 (마크다운 기호 #, ** 는 쓰지 않음). 해당 내용이 없는 항목은 "- 없음"으로 둡니다.',
    '',
    '■ 제목: (한 줄)',
    '■ 일시: (자료에 있으면)',
    '■ 요약',
    '- (핵심 3~5줄)',
    '■ 논의 내용',
    '- (주제별로 정리, 필요하면 들여쓴 하위 항목)',
    '■ 결정 사항',
    '- ...',
    '■ 할 일',
    '- [ ] 할 일 내용 (담당: 이름 / 기한: 날짜, 모르면 생략)',
    '■ 남은 질문',
    '- ...',
  ].join('\n');
  const content = [];
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } });
  const parts = [];
  if (title || date) parts.push(`노트: ${title}${date ? ` (${date})` : ''}`);
  if (segments.length) parts.push(`<받아쓰기>\n${segments.map((s) => `[${fmtMs(s.t)}] ${s.text}`).join('\n')}\n</받아쓰기>`);
  if (pageText.trim()) parts.push(`<페이지_글>\n${pageText.trim()}\n</페이지_글>`);
  if (image) parts.push('위 이미지는 현재 노트 페이지(손글씨 포함)입니다.');
  parts.push('이 자료로 회의록을 작성해 주세요.');
  content.push({ type: 'text', text: parts.join('\n\n') });
  return { system, content };
}

/** 여러 글 조각을 한 번에 보내고 같은 순서로 돌려받기 위한 구분 표시 */
const SEP = (i) => `<<<${i + 1}>>>`;
function packTexts(texts) { return texts.map((t, i) => `${SEP(i)}\n${t}`).join('\n'); }
export function unpackTexts(out, n) {
  const res = [];
  for (let i = 0; i < n; i++) {
    const a = out.indexOf(SEP(i));
    if (a < 0) return null;
    const from = a + SEP(i).length;
    const b = i + 1 < n ? out.indexOf(SEP(i + 1), from) : out.length;
    if (b < 0) return null;
    res.push(out.slice(from, b).replace(/^\s*\n/, '').replace(/\s+$/, ''));
  }
  return res;
}

const SEP_RULE = (n) => `입력은 ${n}개 조각이며 각 조각은 <<<번호>>> 줄로 시작합니다. 출력도 같은 <<<번호>>> 줄로 시작하는 ${n}개 조각을 같은 순서로 내고, 그 밖의 설명·머리말은 쓰지 않습니다. 줄바꿈 구조(체크리스트·표 칸의 줄 수)는 그대로 유지합니다.`;

/** 맞춤법·문법 검사: 고친 글 조각들 + 바뀐 점 설명 */
export function grammarRequest(texts) {
  const system = [
    '당신은 맞춤법·문법 교정자입니다. 각 조각의 맞춤법, 띄어쓰기, 문법, 어색한 표현만 고치고 뜻·말투·언어는 바꾸지 않습니다. 고칠 것이 없으면 원문 그대로 둡니다.',
    SEP_RULE(texts.length),
    '모든 조각 뒤에 <<<설명>>> 줄을 쓰고, 그 아래 주요 수정 사항을 "원래 → 고침 (이유)" 형식으로 짧게 나열합니다 (없으면 "고칠 곳 없음").',
  ].join('\n');
  return { system, content: [{ type: 'text', text: packTexts(texts) }] };
}

/** 번역 */
export function translateRequest(texts, lang) {
  const name = LANG_NAME[lang] || lang;
  const system = [
    `당신은 전문 번역가입니다. 각 조각을 자연스러운 ${name}(으)로 번역합니다. 이미 ${name}인 조각은 그대로 둡니다. 고유명사·숫자·URL 은 유지합니다.`,
    SEP_RULE(texts.length),
  ].join('\n');
  return { system, content: [{ type: 'text', text: packTexts(texts) }] };
}

/** 설명 부분 분리 */
export function splitExplain(out) {
  const i = out.indexOf('<<<설명>>>');
  return i < 0 ? { body: out, explain: '' } : { body: out.slice(0, i), explain: out.slice(i + '<<<설명>>>'.length).trim() };
}

/** 회의록 "■ 할 일" 의 - [ ] 줄 → 체크리스트 항목 */
export function extractTodos(text) {
  const m = text.match(/■\s*할 일[^\n]*\n([\s\S]*?)(?=\n■|$)/);
  if (!m) return [];
  return m[1].split('\n').map((l) => l.match(/^\s*-\s*\[\s?[xX ]?\s?\]\s*(.+)$/)?.[1]?.trim()).filter((t) => t && t !== '없음');
}
