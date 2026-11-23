// @ohah/hwpjs → vendor/hwpjs/ (hwpjs.mjs 하나 + worker.js + hwpjs.wasm + 라이선스). 워커·WASM 은 같은 버전 그대로 복사.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
const out = new URL('../../vendor/hwpjs/', import.meta.url);
const pkg = new URL('./node_modules/@ohah/hwpjs/', import.meta.url);
mkdirSync(out, { recursive: true });
await build({ entryPoints: [new URL('./entry.js', import.meta.url).pathname], bundle: true, format: 'esm', minify: true, target: 'es2022', outfile: new URL('hwpjs.mjs', out).pathname, logLevel: 'info' });
for (const f of ['dist/worker.js', 'dist/hwpjs.wasm', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) copyFileSync(new URL(f, pkg), new URL(f.replace('dist/', ''), out));
console.log('vendor/hwpjs 갱신 완료 — node tools/gen-sw.js 를 실행하세요');
