#!/usr/bin/env node
// 배포 서버(Render 등)의 빌드 단계용: 환경 변수 GEMINI_API_KEY 를 js/ai.js 의 BUILTIN_KEY 에 넣고 sw.js 를 갱신한다.
// 키를 저장소에 커밋하지 않고도 모든 기기에서 입력 없이 AI 를 쓰게 하기 위함.
//   Render → Build Command: node tools/inject-key.js   (Publish Directory: .)
// 주의: 배포된 사이트의 js/ai.js 에는 키가 들어가므로 방문자는 볼 수 있다 → Google Cloud 콘솔에서 웹사이트 제한을 걸 것.
const fs = require('fs');
const path = require('path');

const key = (process.env.GEMINI_API_KEY || '').trim();
const file = path.join(__dirname, '..', 'js', 'ai.js');
if (!key) {
  console.log('GEMINI_API_KEY 가 없어 내장 키 없이 배포합니다 (설정에서 키 입력 필요).');
} else {
  if (!/^[\w.-]+$/.test(key)) { console.error('GEMINI_API_KEY 형식이 이상합니다 (영문·숫자·._- 만 허용).'); process.exit(1); }
  const src = fs.readFileSync(file, 'utf8');
  const re = /export const BUILTIN_KEY = '[^']*';/;
  if (!re.test(src)) { console.error('js/ai.js 에서 BUILTIN_KEY 줄을 찾지 못했습니다.'); process.exit(1); }
  fs.writeFileSync(file, src.replace(re, `export const BUILTIN_KEY = '${key}';`));
  console.log(`BUILTIN_KEY 넣음 (${key.slice(0, 4)}…${key.slice(-3)})`);
}
// 바뀐 ai.js 로 오프라인 캐시 버전을 다시 만든다 (사용자 기기가 새 파일을 받도록)
require('./gen-sw.js');
