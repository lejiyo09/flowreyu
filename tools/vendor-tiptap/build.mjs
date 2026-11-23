// vendor/tiptap/tiptap.mjs (+ 라이선스), vendor/katex/ (CSS·글꼴) 만들기
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs';
const out = new URL('../../vendor/', import.meta.url).pathname;
mkdirSync(out + 'tiptap', { recursive: true });
await build({ entryPoints: ['entry.js'], bundle: true, format: 'esm', minify: true, target: 'es2020', outfile: out + 'tiptap/tiptap.mjs', legalComments: 'none' });
// 라이선스 모음 (모두 MIT)
const lic = [];
for (const dir of ['@tiptap/core', '@tiptap/pm', 'prosemirror-model', 'prosemirror-view', 'prosemirror-state', 'prosemirror-tables', 'katex']) {
  try { const p = `node_modules/${dir}/`; const f = readdirSync(p).find((x) => /^licen[sc]e/i.test(x)); if (f) lic.push(`── ${dir} ──\n` + readFileSync(p + f, 'utf8')); } catch { /* */ }
}
writeFileSync(out + 'tiptap/LICENSES.txt', lic.join('\n\n'));
// DOCX(zip) 읽기·쓰기
mkdirSync(out + 'fflate', { recursive: true });
await build({ stdin: { contents: "export { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';", resolveDir: '.' }, bundle: true, format: 'esm', minify: true, target: 'es2020', outfile: out + 'fflate/fflate.mjs', legalComments: 'none' });
cpSync('node_modules/fflate/LICENSE', out + 'fflate/LICENSE');
mkdirSync(out + 'katex', { recursive: true });
cpSync('node_modules/katex/dist/katex.min.css', out + 'katex/katex.min.css');
cpSync('node_modules/katex/dist/fonts', out + 'katex/fonts', { recursive: true, filter: (s) => !/\.(ttf|woff)$/.test(s) || s.endsWith('.woff2') || !s.includes('.') });
cpSync('node_modules/katex/LICENSE', out + 'katex/LICENSE');
console.log('done');
