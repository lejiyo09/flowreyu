// Word(.docx) 열기·편집·저장: 서식·표(병합·배경·정렬)·그림·링크·목록·탭 채움선·쪽 나눔·쪽 설정·머리글/쪽 번호를 옮기는지,
// 옮기지 못한 요소(메모·각주)를 알리는지, 고치지 않고 저장하면 원본 그대로인지, 고쳐서 저장한 파일을 다른 프로그램
// (python-docx, LibreOffice)이 읽는지, 다시 열면 같은 내용인지
const h = require('./harness');
const fs = require('fs');
const { execFileSync } = require('child_process');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`);
const which = (c) => { try { execFileSync('which', [c], { stdio: 'ignore' }); return true; } catch { return false; } };
(async () => {
  const { browser, page, logs } = await h.launch();
  let confirmMsg = '';
  page.on('dialog', (d) => { if (d.type() === 'confirm') confirmMsg = d.message(); d.accept(); });
  await page.goto(process.env.APP_URL || 'http://localhost:8080/');
  await page.waitForTimeout(500);
  const json = () => page.evaluate(() => document.querySelector('.typing-doc').editor.getJSON());
  const find = (j, pred, out = []) => { if (pred(j)) out.push(j); (j.content || []).forEach((c) => find(c, pred, out)); return out; };
  const text = (n) => find(n, (x) => x.type === 'text').map((x) => x.text).join('');

  // ── 열기 ──
  await page.setInputFiles('#fileInput', h.S + '/sample.docx');
  await page.waitForSelector('.typing-doc', { timeout: 20000 });
  await page.waitForTimeout(1500);
  check('DOCX opens as a typing note', await page.evaluate(() => __flexnote.state.doc.meta.kind === 'typing' && __flexnote.state.doc.meta.source.format === 'docx'));
  const warn = await page.$$eval('#drWarn li', (l) => l.map((x) => x.textContent));
  check('import report lists what could not be carried over (comment, footnote)', await page.locator('#docReportDlg[open]').count() === 1 && warn.some((w) => w.includes('메모')) && warn.some((w) => w.includes('각주')), JSON.stringify(warn));
  await page.click('#docReportDlg button[value=ok]');
  const j = await json();
  const h1 = j.content[0];
  check('heading 1 (centered)', h1.type === 'heading' && h1.attrs.level === 1 && h1.attrs.textAlign === 'center' && text(h1) === '시험 문서 제목');
  const runs = find(j.content[1], (x) => x.type === 'text');
  const mk = (t) => runs.find((r) => r.text.includes(t))?.marks || [];
  check('character formats: bold / italic / underline / color+size / highlight / subscript', mk('굵게').some((m) => m.type === 'bold') && mk('기울임').some((m) => m.type === 'italic') && mk('밑줄').some((m) => m.type === 'underline')
    && mk('빨강').some((m) => m.type === 'textStyle' && m.attrs.color === '#c00000' && m.attrs.fontSize === '14px') && mk('형광').some((m) => m.type === 'highlight') && mk('2').some((m) => m.type === 'subscript'), JSON.stringify(runs.slice(0, 12)));
  check('footnote marker kept and note text moved to the end', text(j.content[1]).includes('[1]') && JSON.stringify(j).includes('각주 내용입니다.'));
  check('hyperlink', JSON.stringify(j).includes('"href":"https://example.com/report"'));
  const toc = j.content.filter((n) => n.attrs?.tabLeader === 'dot');
  check('TOC lines: tab with dot leader (both tab forms)', toc.length === 2 && toc.every((n) => n.content.some((x) => x.type === 'tab')), JSON.stringify(toc.map(text)));
  check('bullet and numbered lists', find(j, (x) => x.type === 'bulletList').length === 1 && find(j, (x) => x.type === 'orderedList').length === 1);
  const tb = find(j, (x) => x.type === 'table')[0];
  const cells = tb.content.map((r) => r.content.map((c) => [text(c), c.attrs.colspan, c.attrs.rowspan, c.attrs.background || '']));
  check('table: horizontal + vertical merge, header shading, widths, centered', JSON.stringify(cells[0]) === '[["구분",1,1,"#d9e2f3"],["가로 병합",2,1,"#d9e2f3"]]' && JSON.stringify(cells[1][0]) === '["세로 병합",1,2,""]' && cells[2].length === 2 && /margin-left:auto/.test(tb.attrs.style) && tb.content[0].content[0].attrs.colwidth[0] === 100, JSON.stringify(cells));
  const img = find(j, (x) => x.type === 'image')[0];
  check('image (data, size) inside a centered paragraph', img && img.attrs.src.startsWith('data:image/png') && img.attrs.width === 120 && img.attrs.height === 60, JSON.stringify(img && { w: img.attrs.width, h: img.attrs.height }));
  check('page break before + page break character (2)', find(j, (x) => x.type === 'pageBreak').length === 2);
  const ind = j.content.find((n) => text(n).startsWith('들여쓰기'));
  check('indent / line spacing / space after', ind.attrs.indent === 20 && ind.attrs.lineHeight === 1.8 && ind.attrs.spaceAfter === 12, JSON.stringify(ind.attrs));
  const pg = await page.evaluate(() => __flexnote.state.doc.meta.page);
  check('page setup: A4, margins (mm), header text, page number', pg.size === 'A4' && Math.abs(pg.margin.t - 20) < 0.2 && Math.abs(pg.margin.l - 30) < 0.2 && pg.header === '연구 보고서 머리글' && pg.pageNum === 'center' && pg.fontSize === 10.5, JSON.stringify(pg));
  check('rendered on 3 pages', (await page.evaluate(() => __flexnote.viewer.pages.length)) === 3);

  // ── 고치지 않고 저장 → 원본 그대로 ──
  let [dl] = await Promise.all([page.waitForEvent('download'), page.click('#fmtBar [data-fb=saveDocx]')]);
  await dl.saveAs(h.S + '/docx-unchanged.docx');
  check('saving without edits gives back the original file byte-for-byte', Buffer.compare(fs.readFileSync(h.S + '/docx-unchanged.docx'), fs.readFileSync(h.S + '/sample.docx')) === 0);

  // ── 고치고 저장 ──
  await page.evaluate(() => { const ed = document.querySelector('.typing-doc').editor; ed.chain().focus().setTextSelection(1 + '시험 문서 제목'.length).insertContent(' (고침)').run(); });
  await page.waitForTimeout(900);
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#fmtBar [data-fb=saveDocx]')]);
  const out = h.S + '/docx-edited.docx';
  await dl.saveAs(out);
  check('saving after edits warns which original parts are not saved', /메모/.test(confirmMsg) && /각주/.test(confirmMsg), confirmMsg.slice(0, 120));
  // python-docx 로 읽기 (다른 프로그램이 여는지)
  const py = JSON.parse(execFileSync('python3', ['-I', '-c', `
import json, sys, docx
d = docx.Document(sys.argv[1])
t = d.tables[0]
print(json.dumps({"paras": [p.text for p in d.paragraphs][:3], "styles": [p.style.name for p in d.paragraphs][:2], "tables": len(d.tables),
  "cell": t.cell(0, 1).text, "merged": t.cell(0, 1)._tc is t.cell(0, 2)._tc, "vmerged": t.cell(1, 0)._tc is t.cell(2, 0)._tc,
  "images": len(d.inline_shapes), "header": d.sections[0].header.paragraphs[0].text, "w": d.sections[0].page_width.mm}, ensure_ascii=False))
`, out]).toString());
  check('python-docx reads the saved file: text, heading style, merged cells, image, header, page size', py.paras[0] === '시험 문서 제목 (고침)' && py.styles[0] === 'Heading 1' && py.tables === 1 && py.cell === '가로 병합' && py.merged && py.vmerged && py.images === 1 && py.header === '연구 보고서 머리글' && Math.abs(py.w - 210) < 0.5, JSON.stringify(py));
  // LibreOffice 로 PDF 변환 (있으면)
  if (which('soffice')) {
    const dir = h.S + '/docx-lo';
    fs.rmSync(dir, { recursive: true, force: true });
    try { execFileSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', dir, out], { stdio: 'ignore', timeout: 120000 }); } catch { /* */ }
    const pdfPath = dir + '/docx-edited.pdf';
    const pages = fs.existsSync(pdfPath) ? (fs.readFileSync(pdfPath, 'latin1').match(/\/Type\s*\/Page[^s]/g) || []).length : 0;
    check('LibreOffice opens the saved DOCX and lays it out on 3 pages', pages === 3, `pages=${pages}`);
  }
  // 다시 열기 → 같은 구조 + 고친 글
  await page.click('#btnBack');
  await page.waitForSelector('#library:not([hidden])');
  await page.setInputFiles('#fileInput', out);
  await page.waitForSelector('.typing-doc', { timeout: 20000 });
  await page.waitForTimeout(1500);
  const j2 = await json();
  const count = (jj, t) => find(jj, (x) => x.type === t).length;
  check('re-opened saved file keeps the edit', text(j2.content[0]) === '시험 문서 제목 (고침)');
  check('re-opened: same tables/cells/images/lists/breaks/tabs/links', ['table', 'tableRow', 'tableCell', 'image', 'bulletList', 'orderedList', 'pageBreak', 'tab', 'heading'].every((t) => count(j, t) === count(j2, t)) && JSON.stringify(j2).includes('example.com/report'),
    JSON.stringify(['table', 'tableCell', 'image', 'pageBreak', 'tab'].map((t) => [t, count(j, t), count(j2, t)])));
  const t2 = find(j2, (x) => x.type === 'table')[0];
  check('re-opened: merges and shading kept', t2.content[0].content[1].attrs.colspan === 2 && t2.content[1].content[0].attrs.rowspan === 2 && t2.content[0].content[0].attrs.background === '#d9e2f3');
  { const A = find(j2.content[1], (x) => x.type === 'text').map((r) => [r.text, (r.marks || []).map((m) => m.type).sort()]).filter((x) => x[0].trim()), B = runs.map((r) => [r.text, (r.marks || []).map((m) => m.type).sort()]).filter((x) => x[0].trim());
    if (JSON.stringify(A) !== JSON.stringify(B)) console.log('FMT', JSON.stringify(A), '\n   ', JSON.stringify(B)); }
  check('re-opened: same character formats', JSON.stringify(find(j2.content[1], (x) => x.type === 'text').map((r) => [r.text, (r.marks || []).map((m) => m.type).sort()]).filter((x) => x[0].trim())) === JSON.stringify(runs.map((r) => [r.text, (r.marks || []).map((m) => m.type).sort()]).filter((x) => x[0].trim())));
  check('re-opened: page setup same', JSON.stringify(await page.evaluate(() => { const p = __flexnote.state.doc.meta.page; return [p.size, p.margin, p.header, p.pageNum]; })) === JSON.stringify([pg.size, pg.margin, pg.header, pg.pageNum]));
  await page.click('#docReportDlg button[value=ok]').catch(() => {});
  // ── 아직 못 여는 형식: 알림 ──
  fs.writeFileSync(h.S + '/old.doc', Buffer.from('d0cf11e0a1b11ae1', 'hex'));
  await page.click('#btnBack');
  await page.waitForSelector('#library:not([hidden])');
  await page.setInputFiles('#fileInput', h.S + '/old.doc');
  await page.waitForTimeout(500);
  check('.doc is refused with a clear message', /\.doc/.test(await page.textContent('#toast').catch(() => '')) || /docx/.test(await page.evaluate(() => document.body.innerText)), '');
  // 새로고침 뒤 원본 정보 유지
  const errs = logs.filter((l) => l.startsWith('[pageerror]'));
  check('no page errors', !errs.length, errs.join('\n'));
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error('Error', e); process.exit(1); });
