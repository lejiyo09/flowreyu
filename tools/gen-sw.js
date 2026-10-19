#!/usr/bin/env node
// 서비스 워커 사전 캐시 목록 생성: 앱 실행에 필요한 모든 파일을 나열하고 내용 해시로 버전을 만든다.
//   node tools/gen-sw.js          → sw.js 의 목록/버전 갱신
//   node tools/gen-sw.js --check  → 목록이 최신인지 검사 (테스트용, 다르면 exit 1)
// 파일을 추가·수정하면 반드시 실행할 것. 버전이 바뀌어야 사용자 기기의 캐시가 새 코드로 교체된다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const INCLUDE = ['index.html', 'manifest.webmanifest', 'css', 'js', 'icons', 'vendor'];
const SKIP = /(\.map|LICENSE(\.md)?|\.d\.mts)$/;

function walk(rel, out) {
  const abs = path.join(root, rel);
  const st = fs.statSync(abs);
  if (st.isDirectory()) for (const f of fs.readdirSync(abs).sort()) walk(path.posix.join(rel, f), out);
  else if (!SKIP.test(rel)) out.push(rel);
  return out;
}

const files = INCLUDE.flatMap((p) => walk(p, []));
const hash = crypto.createHash('sha256');
for (const f of files) { hash.update(f); hash.update(fs.readFileSync(path.join(root, f))); }
const version = hash.digest('hex').slice(0, 12);

const swPath = path.join(root, 'sw.js');
const sw = fs.readFileSync(swPath, 'utf8');
const block = `// <precache> (tools/gen-sw.js 가 생성 — 직접 고치지 말 것)\nconst VERSION = '${version}';\nconst PRECACHE = ${JSON.stringify(['./', ...files], null, 0).replace(/","/g, '",\n  "').replace('["', '[\n  "').replace('"]', '",\n]')};\n// </precache>`;
const next = sw.replace(/\/\/ <precache>[\s\S]*?\/\/ <\/precache>/, block);
if (process.argv.includes('--check')) {
  if (next !== sw) { console.error('sw.js 사전 캐시 목록이 오래됐습니다. `node tools/gen-sw.js` 를 실행하세요.'); process.exit(1); }
  console.log(`sw.js 최신 (버전 ${version}, 파일 ${files.length}개)`);
} else {
  fs.writeFileSync(swPath, next);
  console.log(`sw.js 갱신: 버전 ${version}, 파일 ${files.length}개`);
}
