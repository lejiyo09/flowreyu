#!/usr/bin/env node
// 개발/테스트용 정적 서버 (의존성 없음)
//   node server.js [port]          → http://localhost:8080
//   node server.js 8080 --lan      → 같은 Wi-Fi 의 태블릿에서 http://<PC IP>:8080 접속 가능
// .mjs 를 올바른 MIME(text/javascript)으로 보내야 PDF.js 모듈/워커가 로드된다.
// 배포(Render 웹 서비스 등): 환경 변수 PORT 가 있으면 외부 접속을 받고, GEMINI_API_KEY 가 있으면 js/ai.js 의 내장 키로 넣어 보낸다.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const args = process.argv.slice(2);
const port = parseInt(args.find((a) => /^\d+$/.test(a)) || process.env.PORT || '8080', 10);
const lan = args.includes('--lan');
const root = __dirname;
const GEMINI_KEY = /^[\w.-]+$/.test((process.env.GEMINI_API_KEY || '').trim()) ? process.env.GEMINI_API_KEY.trim() : '';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); res.end(); return; }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(root, p));
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    if (GEMINI_KEY && file === path.join(root, 'js', 'ai.js')) {
      const body = Buffer.from(fs.readFileSync(file, 'utf8').replace(/export const BUILTIN_KEY = '[^']*';/, `export const BUILTIN_KEY = '${GEMINI_KEY}';`));
      res.writeHead(200, { 'Content-Type': TYPES['.js'], 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
      res.end(body);
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
});

server.listen(port, lan || process.env.PORT ? '0.0.0.0' : '127.0.0.1', () => {
  console.log(`FlexNote: http://localhost:${port}`);
  if (lan) {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log(`  태블릿에서: http://${a.address}:${port}`);
    }
    console.log('  ※ http://IP 접속은 보안 컨텍스트가 아니라서 오프라인 설치(서비스 워커)·영구 저장 요청이 동작하지 않습니다.');
    console.log('    USB 연결 후 `adb reverse tcp:%d tcp:%d` 를 쓰면 태블릿에서도 http://localhost:%d 로 접속할 수 있습니다.', port, port, port);
  }
});
