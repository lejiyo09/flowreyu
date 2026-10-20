// AI 도우미 테스트: Gemini API(generativelanguage.googleapis.com)를 가짜 응답(SSE)으로 바꿔서 요청 형식·결과 반영·오류 처리를 검사
const h = require('./harness');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`);

function sse(text, { finish = 'STOP', model = 'gemini-3.8-flash' } = {}) {
  const chunks = text.match(/[\s\S]{1,7}/g) || [];
  const ev = (o) => `data: ${JSON.stringify(o)}\r\n\r\n`;
  const cand = (t, fin) => ({ candidates: [{ content: { role: 'model', parts: [{ text: t }] }, ...(fin ? { finishReason: fin } : {}), index: 0 }], modelVersion: model });
  return ev({ candidates: [{ content: { role: 'model', parts: [{ text: '생각 중', thought: true }] }, index: 0 }], modelVersion: model })
    + chunks.map((c, i) => ev(cand(c, i === chunks.length - 1 ? finish : null))).join('')
    + (chunks.length ? '' : ev(cand('', finish)));
}

(async () => {
  const { browser, context, page, logs } = await h.launch();
  const reqs = [];
  let mode = 'ok';
  await context.route('https://generativelanguage.googleapis.com/**', async (route) => {
    const r = route.request();
    const body = JSON.parse(r.postData() || '{}');
    reqs.push({ url: r.url(), headers: r.headers(), body });
    const json = (status, o) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(o) });
    if (mode === 'auth') return json(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] } });
    if (mode === 'quota') return json(429, { error: { code: 429, message: 'You exceeded your current quota', status: 'RESOURCE_EXHAUSTED', details: [{ violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] }] } });
    if (mode === 'nothink' && body.generationConfig?.thinkingConfig) return json(400, { error: { code: 400, message: 'Thinking level is not supported for this model.', status: 'INVALID_ARGUMENT' } });
    if (mode === 'slow') await h.sleep(4000);
    const sys = String(body.systemInstruction?.parts?.[0]?.text || '');
    let out;
    if (mode === 'refusal') out = sse('', { finish: 'SAFETY' });
    else if (sys.includes('회의록')) out = sse('■ 제목: 주간 회의\n■ 요약\n- 일정 확인\n■ 할 일\n- [ ] 보고서 작성 (담당: 김)\n- [ ] 회의실 예약\n■ 남은 질문\n- 없음');
    else if (sys.includes('교정자')) out = sse('<<<1>>>\n안녕하세요. 반갑습니다.\n<<<2>>>\n우유 사기\n<<<3>>>\n점수\n<<<설명>>>\n반갑읍니다 → 반갑습니다 (맞춤법)');
    else if (sys.includes('번역가')) out = sse('<<<1>>>\nこんにちは。\n<<<2>>>\n牛乳を買う\n<<<3>>>\n点数');
    else out = sse('?');
    return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: out });
  });

  await page.goto(process.env.APP_URL || 'http://localhost:8080/');
  await page.waitForTimeout(500);
  await page.evaluate(() => localStorage.removeItem('flexnote.geminiKey'));
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
  await page.fill('#setAiKey', 'AQ.test-key-123');
  await page.dispatchEvent('#setAiKey', 'change');
  check('key saved locally', (await page.evaluate(() => localStorage.getItem('flexnote.geminiKey'))) === 'AQ.test-key-123');
  check('key not inside settings JSON', !(await page.evaluate(() => localStorage.getItem('flexnote.settings.v1') || '')).includes('AQ.test'));
  check('model select lists Gemini models (3 Flash default)', (await page.inputValue('#setAiModel')) === 'gemini-3-flash-preview' && (await page.locator('#setAiModel option').count()) === 3);
  await page.evaluate(() => document.querySelector('#settingsDlg').close());

  // 맞춤법 검사
  await page.click('#btnAi');
  await page.waitForTimeout(150);
  await page.click('#aiTabs button[value=grammar]');
  await page.click('#aiRun');
  await page.waitForSelector('#aiResultActions:not([hidden])', { timeout: 15000 }).catch(() => {});
  const rq = reqs[0];
  check('request sent with api key header (not in URL)', rq && rq.headers['x-goog-api-key'] === 'AQ.test-key-123' && !rq.url.includes('key='), rq?.url);
  check('flash model, streaming SSE endpoint', /\/models\/gemini-3-flash-preview:streamGenerateContent\?alt=sse$/.test(rq?.url || ''), rq?.url);
  check('system instruction + grammar uses low thinking', /교정자/.test(rq?.body.systemInstruction?.parts?.[0]?.text) && rq?.body.generationConfig?.thinkingConfig?.thinkingLevel === 'low');
  const sent = rq?.body.contents?.[0]?.parts?.[0]?.text || '';
  check('pieces packed in order', sent.includes('<<<1>>>\n안녕 하세요. 반갑읍니다.') && sent.includes('<<<2>>>\n우유 사기') && sent.includes('<<<3>>>\n점수'), JSON.stringify(sent));
  const outTxt = await page.textContent('#aiOut');
  check('result + explanation shown (thought parts hidden)', outTxt.includes('안녕하세요. 반갑습니다.') && outTxt.includes('맞춤법') && !outTxt.includes('<<<') && !outTxt.includes('생각 중'), JSON.stringify(outTxt));
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
  check('translate prompt names target language', String(reqs[1]?.body.systemInstruction?.parts?.[0]?.text).includes('일본어'));
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
  const mc = reqs[2]?.body.contents?.[0]?.parts || [];
  check('minutes uses effort setting (medium)', reqs[2]?.body.generationConfig?.thinkingConfig?.thinkingLevel === 'medium');
  check('minutes sends page image (jpeg) + page text + transcript', mc[0]?.inlineData?.mimeType === 'image/jpeg' && mc[0]?.inlineData?.data?.length > 1000 && mc[1]?.text.includes('<페이지_글>') && mc[1]?.text.includes('[1:02] 보고서는 김 대리가 작성'), JSON.stringify(mc.map((c) => Object.keys(c))));
  const before = await page.evaluate(() => __flexnote.state.doc.items(0).length);
  await page.click('#aiTodos');
  await page.waitForTimeout(150);
  const cls = await page.evaluate(() => __flexnote.state.doc.items(__flexnote.viewer.currentPage()).filter((i) => i.t === 'cl').map((i) => i.rows.map((r) => r.text)));
  check('todos become checklist', cls.some((r) => r.length === 2 && r[0] === '보고서 작성 (담당: 김)' && r[1] === '회의실 예약'), JSON.stringify(cls));
  await page.click('#aiAsNote');
  await page.waitForTimeout(150);
  const notes = await page.evaluate(() => __flexnote.state.doc.items(__flexnote.viewer.currentPage()).filter((i) => i.t === 'nt').map((i) => i.text));
  check('minutes pasted as note', notes.some((t) => t.startsWith('■ 제목: 주간 회의')) && (await page.evaluate(() => __flexnote.state.doc.items(0).length)) === before + 2);

  // #gk=키 링크로 한 번 열면 이 기기에 키 저장 + 주소에서 지움
  await page.goto((process.env.APP_URL || 'http://localhost:8080/') + '#gk=AQ.link-key-9');
  await page.waitForTimeout(600);
  check('#gk= link stores key and strips it from URL', (await page.evaluate(() => localStorage.getItem('flexnote.geminiKey'))) === 'AQ.link-key-9' && !page.url().includes('gk='), page.url());
  await page.evaluate(() => localStorage.setItem('flexnote.geminiKey', 'AQ.test-key-123'));
  await page.click('.doc-card, #library [data-doc]').catch(() => {});
  await page.waitForSelector('#editor:not([hidden])', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(800);
  if (!(await page.locator('#editor').isVisible())) { await page.setInputFiles('#fileInput', h.S + '/sample.pdf'); await page.waitForSelector('#editor:not([hidden])'); await page.waitForTimeout(800); }
  if (await page.locator('#aiPanel').isHidden()) await page.click('#btnAi');
  await page.waitForTimeout(200);
  await page.click('#aiTabs button[value=minutes]');
  // 오류: 잘못된 키 / 거절 / 중지
  mode = 'auth';
  await page.click('#aiRun');
  await page.waitForFunction(() => document.querySelector('#aiOut').classList.contains('err'), null, { timeout: 15000 }).catch(() => {});
  check('401 → friendly key message', (await page.textContent('#aiOut')).includes('API 키가 올바르지 않습니다'), await page.textContent('#aiOut'));
  mode = 'refusal';
  await page.click('#aiRun');
  await page.waitForFunction(() => document.querySelector('#aiOut').textContent.includes('거절'), null, { timeout: 15000 }).catch(() => {});
  check('safety block handled', (await page.textContent('#aiOut')).includes('거절'));
  mode = 'quota';
  await page.click('#aiRun');
  await page.waitForFunction(() => document.querySelector('#aiOut').textContent.includes('한도'), null, { timeout: 15000 }).catch(() => {});
  check('free-tier 429 → quota message', (await page.textContent('#aiOut')).includes('무료 사용량 한도'), await page.textContent('#aiOut'));
  mode = 'nothink';
  const n0 = reqs.length;
  await page.click('#aiTabs button[value=grammar]');
  await page.click('#aiRun');
  await page.waitForSelector('#aiResultActions:not([hidden])', { timeout: 15000 }).catch(() => {});
  check('retries without thinkingConfig when unsupported', reqs.length === n0 + 2 && !reqs.at(-1).body.generationConfig.thinkingConfig && (await page.textContent('#aiOut')).includes('반갑습니다'));
  await page.click('#aiTabs button[value=minutes]');
  mode = 'slow';
  await page.click('#aiRun');
  await page.waitForTimeout(1600);
  check('stop button + elapsed seconds while waiting', await page.locator('#aiStop').isVisible() && /생각하는 중… [12]초/.test(await page.textContent('#aiOut')), await page.textContent('#aiOut'));
  await page.click('#aiStop');
  await page.waitForFunction(() => document.querySelector('#aiOut').textContent.includes('중지'), null, { timeout: 8000 }).catch(() => {});
  check('stop aborts request', (await page.textContent('#aiOut')).includes('중지') && !(await page.locator('#aiRun').isDisabled()));

  // 설정 → 생각 깊이
  await page.evaluate(() => __flexnote.settings.set('ai', { ...__flexnote.settings.get('ai'), effort: 'high', model: 'gemini-flash-lite-latest' }));
  mode = 'ok';
  await page.click('#aiTabs button[value=grammar]');
  await page.click('#aiRun');
  await page.waitForSelector('#aiResultActions:not([hidden])', { timeout: 15000 }).catch(() => {});
  check('model setting applied; high → grammar medium', reqs.at(-1)?.body.generationConfig?.thinkingConfig?.thinkingLevel === 'medium' && reqs.at(-1)?.url.includes('/gemini-flash-lite-latest:'));
  await page.evaluate(() => { localStorage.setItem('flexnote.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('flexnote.settings.v1')), ai: { effort: 'medium', lang: 'en', model: 'gemini-pro-latest' } })); });
  await page.reload();
  await page.waitForTimeout(800);
  check('saved Pro model falls back to Gemini 3 Flash', (await page.evaluate(() => __flexnote.settings.get('ai').model)) === 'gemini-3-flash-preview');

  const errs = logs.filter((l) => l.startsWith('[pageerror]'));
  check('no page errors', !errs.length, errs.join('\n'));
  console.log(results.join('\n'));
  await browser.close();
})().catch((e) => { console.log(results.join('\n')); console.error('Error', e); process.exit(1); });
