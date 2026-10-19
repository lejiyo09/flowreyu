// AI 도우미 테스트: api.anthropic.com 을 가짜 응답(SSE)으로 바꿔서 요청 형식·결과 반영·오류 처리를 검사
const h = require('./harness');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`);

function sse(text, { stop = 'end_turn', model = 'claude-opus-5-5' } = {}) {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const chunks = text.match(/[\s\S]{1,7}/g) || [];
  return ev('message_start', { message: { id: 'msg_t', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } })
    + ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    + chunks.map((c) => ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: c } })).join('')
    + ev('content_block_stop', { index: 0 })
    + ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } })
    + ev('message_stop', {});
}

(async () => {
  const { browser, context, page, logs } = await h.launch();
  const reqs = [];
  let mode = 'ok';
  await context.route('https://api.anthropic.com/**', async (route) => {
    const r = route.request();
    const body = JSON.parse(r.postData() || '{}');
    reqs.push({ url: r.url(), headers: r.headers(), body });
    if (mode === 'auth') return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) });
    if (mode === 'slow') await h.sleep(4000);
    const sys = String(body.system || '');
    let out;
    if (mode === 'refusal') out = sse('', { stop: 'refusal' });
    else if (sys.includes('회의록')) out = sse('■ 제목: 주간 회의\n■ 요약\n- 일정 확인\n■ 할 일\n- [ ] 보고서 작성 (담당: 김)\n- [ ] 회의실 예약\n■ 남은 질문\n- 없음');
    else if (sys.includes('교정자')) out = sse('<<<1>>>\n안녕하세요. 반갑습니다.\n<<<2>>>\n우유 사기\n<<<3>>>\n점수\n<<<설명>>>\n반갑읍니다 → 반갑습니다 (맞춤법)');
    else if (sys.includes('번역가')) out = sse('<<<1>>>\nこんにちは。\n<<<2>>>\n牛乳を買う\n<<<3>>>\n点数');
    else out = sse('?');
    return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_t' }, body: out });
  });

  await page.goto(process.env.APP_URL || 'http://localhost:8080/');
  await page.waitForTimeout(500);
  await page.evaluate(() => localStorage.removeItem('flexnote.aiKey'));
  await page.setInputFiles('#fileInput', h.S + '/sample.pdf');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(800);

  // 글 객체 넣기: 포스트잇, 체크리스트, 표
  await page.evaluate(() => {
    const d = __flexnote.state.doc;
    d.add(0, { id: 'nt_a', t: 'nt', x: 60, y: 60, w: 160, h: 120, c: '#fff59d', fs: 14, text: '안녕 하세요. 반갑읍니다.' });
    d.add(0, { id: 'cl_a', t: 'cl', x: 60, y: 260, w: 200, fs: 14, c: '#1c1f24', rows: [{ text: '우유 사기', done: true }] });
    d.add(0, { id: 'tb_a', t: 'tb', x: 60, y: 360, w: 200, h: 60, fs: 12, cells: [['점수', ''], ['', '']] });
  });
  await page.waitForTimeout(200);

  // 키 없음 → 안내
  await page.click('#btnAi');
  await page.waitForTimeout(200);
  check('panel opens; no-key notice shown', await page.locator('#aiPanel').isVisible() && await page.locator('#aiNoKey').isVisible());
  await page.click('#aiTabs button[value=grammar]');
  check('grammar target counts 3 text pieces', /글 3개/.test(await page.textContent('#aiTarget')), await page.textContent('#aiTarget'));
  await page.click('#aiRun');
  await page.waitForTimeout(200);
  check('no request without key', reqs.length === 0);

  // 설정에서 키 입력
  await page.click('#aiOpenSettings');
  await page.waitForTimeout(200);
  await page.fill('#setAiKey', 'sk-ant-test-123');
  await page.dispatchEvent('#setAiKey', 'change');
  check('key saved locally', (await page.evaluate(() => localStorage.getItem('flexnote.aiKey'))) === 'sk-ant-test-123');
  check('key not inside settings JSON', !(await page.evaluate(() => localStorage.getItem('flexnote.settings.v1') || '')).includes('sk-ant'));
  await page.evaluate(() => document.querySelector('#settingsDlg').close());

  // 맞춤법 검사
  await page.click('#btnAi');
  await page.waitForTimeout(150);
  await page.click('#aiTabs button[value=grammar]');
  await page.click('#aiRun');
  await page.waitForSelector('#aiResultActions:not([hidden])', { timeout: 15000 }).catch(() => {});
  const rq = reqs[0];
  check('request sent with api key header', rq && rq.headers['x-api-key'] === 'sk-ant-test-123', JSON.stringify(rq?.headers['x-api-key']));
  check('model claude-opus-5-5, streaming', rq?.body.model === 'claude-opus-5-5' && rq?.body.stream === true);
  check('server-side fallback default + beta header', rq?.body.fallbacks === 'default' && /server-side-fallback-2026-07-01/.test(rq?.headers['anthropic-beta'] || ''), rq?.headers['anthropic-beta']);
  check('adaptive thinking + effort medium', rq?.body.thinking?.type === 'adaptive' && rq?.body.output_config?.effort === 'medium');
  check('browser access header', rq?.headers['anthropic-dangerous-direct-browser-access'] === 'true');
  const sent = rq?.body.messages?.[0]?.content?.[0]?.text || '';
  check('pieces packed in order', sent.includes('<<<1>>>\n안녕 하세요. 반갑읍니다.') && sent.includes('<<<2>>>\n우유 사기') && sent.includes('<<<3>>>\n점수'), JSON.stringify(sent));
  const outTxt = await page.textContent('#aiOut');
  check('result + explanation shown', outTxt.includes('안녕하세요. 반갑습니다.') && outTxt.includes('맞춤법') && !outTxt.includes('<<<'), JSON.stringify(outTxt));
  await page.click('#aiApply');
  await page.waitForTimeout(200);
  const nt = await page.evaluate(() => __flexnote.state.doc.items(0).find((i) => i.id === 'nt_a').text);
  check('apply replaces note text', nt === '안녕하세요. 반갑습니다.', nt);
  check('checklist done state kept', await page.evaluate(() => __flexnote.state.doc.items(0).find((i) => i.id === 'cl_a').rows[0].done));
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  check('undo restores original', (await page.evaluate(() => __flexnote.state.doc.items(0).find((i) => i.id === 'nt_a').text)) === '안녕 하세요. 반갑읍니다.');

  // 번역 (일본어)
  await page.click('#aiTabs button[value=translate]');
  await page.selectOption('#aiLang', 'ja');
  await page.click('#aiRun');
  await page.waitForFunction(() => document.querySelector('#aiOut').textContent.includes('こんにちは'), null, { timeout: 15000 }).catch(() => {});
  check('translate prompt names target language', String(reqs[1]?.body.system).includes('일본어'));
  await page.click('#aiApply');
  await page.waitForTimeout(150);
  const tb = await page.evaluate(() => __flexnote.state.doc.items(0).find((i) => i.id === 'tb_a').cells);
  check('apply translation to table cell & checklist row', tb[0][0] === '点数' && (await page.evaluate(() => __flexnote.state.doc.items(0).find((i) => i.id === 'cl_a').rows[0].text)) === '牛乳を買う', JSON.stringify(tb));
  check('target language remembered', (await page.evaluate(() => __flexnote.settings.get('ai').lang)) === 'ja');

  // 회의록 (받아쓰기 있는 녹음 1개)
  await page.evaluate(() => __flexnote.store.putBlob({ id: 'rec_t', docId: __flexnote.state.doc.id, kind: 'audio', data: new Blob(['x']), duration: 65000, mime: 'audio/webm', created: Date.now(), segments: [{ t: 1000, text: '이번 주 일정을 확인합니다' }, { t: 62000, text: '보고서는 김 대리가 작성' }], name: '녹음 1' }));
  await page.click('#aiClose');
  await page.click('#btnAi');
  await page.waitForTimeout(200);
  await page.click('#aiTabs button[value=minutes]');
  check('recording with transcript preselected', (await page.inputValue('#aiRec')) === 'rec_t');
  await page.click('#aiRun');
  await page.waitForSelector('#aiTodos:not([hidden])', { timeout: 15000 }).catch(() => {});
  const mc = reqs[2]?.body.messages?.[0]?.content || [];
  check('minutes sends page image (jpeg) + page text', mc[0]?.type === 'image' && mc[0]?.source?.media_type === 'image/jpeg' && mc[0]?.source?.data?.length > 1000 && mc[1]?.text.includes('<페이지_글>') && mc[1]?.text.includes('[1:02] 보고서는 김 대리가 작성'), JSON.stringify(mc.map((c) => c.type)));
  const before = await page.evaluate(() => __flexnote.state.doc.items(0).length);
  await page.click('#aiTodos');
  await page.waitForTimeout(150);
  const cls = await page.evaluate(() => __flexnote.state.doc.items(__flexnote.viewer.currentPage()).filter((i) => i.t === 'cl').map((i) => i.rows.map((r) => r.text)));
  check('todos become checklist', cls.some((r) => r.length === 2 && r[0] === '보고서 작성 (담당: 김)' && r[1] === '회의실 예약'), JSON.stringify(cls));
  await page.click('#aiAsNote');
  await page.waitForTimeout(150);
  const notes = await page.evaluate(() => __flexnote.state.doc.items(__flexnote.viewer.currentPage()).filter((i) => i.t === 'nt').map((i) => i.text));
  check('minutes pasted as note', notes.some((t) => t.startsWith('■ 제목: 주간 회의')) && (await page.evaluate(() => __flexnote.state.doc.items(0).length)) === before + 2);

  // 오류: 잘못된 키 / 거절 / 중지
  mode = 'auth';
  await page.click('#aiRun');
  await page.waitForFunction(() => document.querySelector('#aiOut').classList.contains('err'), null, { timeout: 15000 }).catch(() => {});
  check('401 → friendly key message', (await page.textContent('#aiOut')).includes('API 키가 올바르지 않습니다'), await page.textContent('#aiOut'));
  mode = 'refusal';
  await page.click('#aiRun');
  await page.waitForFunction(() => document.querySelector('#aiOut').textContent.includes('거절'), null, { timeout: 15000 }).catch(() => {});
  check('refusal stop_reason handled', (await page.textContent('#aiOut')).includes('거절'));
  mode = 'slow';
  await page.click('#aiRun');
  await page.waitForTimeout(500);
  check('stop button visible while running', await page.locator('#aiStop').isVisible());
  await page.click('#aiStop');
  await page.waitForFunction(() => document.querySelector('#aiOut').textContent.includes('중지'), null, { timeout: 8000 }).catch(() => {});
  check('stop aborts request', (await page.textContent('#aiOut')).includes('중지') && !(await page.locator('#aiRun').isDisabled()));

  // 설정 → 생각 깊이
  await page.evaluate(() => __flexnote.settings.set('ai', { ...__flexnote.settings.get('ai'), effort: 'high' }));
  mode = 'ok';
  await page.click('#aiTabs button[value=grammar]');
  await page.click('#aiRun');
  await page.waitForSelector('#aiResultActions:not([hidden])', { timeout: 15000 }).catch(() => {});
  check('effort setting applied', reqs.at(-1)?.body.output_config?.effort === 'high');

  const errs = logs.filter((l) => l.startsWith('[pageerror]'));
  check('no page errors', !errs.length, errs.join('\n'));
  console.log(results.join('\n'));
  await browser.close();
})().catch((e) => { console.log(results.join('\n')); console.error('Error', e); process.exit(1); });
