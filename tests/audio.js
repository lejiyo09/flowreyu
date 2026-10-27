// 음성 녹음 + 필기 따라가기 + 받아쓰기 테스트 (가짜 마이크, 가짜 음성 인식)
const h = require('./harness');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`);
(async () => {
  const { browser, page, cdp, logs } = await h.launch();
  page.on('dialog', (d) => d.accept());
  // 받아쓰기 가짜 음성 인식: 첫 세션은 0.2초에 "첫 번째 문장"을 듣고 0.7초에 끝남(무음) → 앱이 다시 시작.
  // 둘째 세션은 결과 번호가 다시 0부터: 0.9초 뒤(녹음 기준 ≈1.6초) "두 번째 문장" 확정, 안드로이드처럼 같은 확정 결과를 한 번 더 보냄
  await page.addInitScript(() => {
    class FakeSR {
      start() {
        this.n = (this.n || 0) + 1;
        const res = [];
        const emit = (i, text, isFinal) => {
          res[i] = Object.assign([{ transcript: text }], { isFinal });
          this.onresult?.({ resultIndex: i, results: res });
        };
        if (this.n === 1) {
          setTimeout(() => emit(0, '첫 번째', false), 200);
          setTimeout(() => emit(0, '첫 번째 문장', true), 400);
          setTimeout(() => this.onend?.(), 700);
        } else if (this.n === 2) {
          setTimeout(() => emit(0, '두 번째', false), 900);
          setTimeout(() => emit(0, '두 번째 문장', true), 1000);
          setTimeout(() => this.onresult?.({ resultIndex: 0, results: res }), 1100);
        }
      }
      stop() {}
    }
    window.SpeechRecognition = FakeSR;
  });
  await page.goto(process.env.APP_URL || 'http://localhost:8080/');
  await page.waitForTimeout(500);
  await page.setInputFiles('#fileInput', h.S + '/sample.pdf');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(800);
  const vp = await page.locator('#viewport').boundingBox();
  const X = (x) => vp.x + x, Y = (y) => vp.y + y;
  const strokes = () => page.evaluate(() => __flexnote.state.doc.items(0).filter((i) => i.t === 's'));

  await page.click('#btnRec');
  check('recording panel opens', await page.locator('#audioPanel').isVisible());
  await page.click('#apRecBtn');
  await page.waitForSelector('#recChip:not([hidden])', { timeout: 5000 }).catch(() => {}); // 마이크 열기는 느릴 수 있음
  check('recording starts (red timer chip)', await page.locator('#recChip').isVisible());
  await h.pen(cdp, h.line(X(150), Y(250), X(350), Y(250), 10)); // A
  await page.waitForTimeout(1500);
  await h.pen(cdp, h.line(X(150), Y(330), X(350), Y(330), 10)); // B
  await page.waitForTimeout(600);
  await page.click('#apRecBtn'); // 정지
  await page.waitForSelector('#apPlayer:not([hidden])', { timeout: 10000 });
  const [A, B] = await strokes();
  check('strokes written while recording get time stamps', A.rt && B.rt && A.rt.rec === B.rt.rec && B.rt.t - A.rt.t > 1200, JSON.stringify([A.rt, B.rt]));
  check('recording saved and listed', (await page.locator('#apList .ap-item').count()) === 1 && !(await page.locator('#recChip').isVisible()));
  const segs = await page.evaluate(async () => (await __flexnote.store.listBlobs(__flexnote.state.doc.id, 'audio'))[0].segments);
  check('transcript times stay right after the recognizer restarts (no stale times, no duplicates)', segs.length === 2 && segs[0].t < 300 && segs[1].t > 600 && segs[1].t < 1400, JSON.stringify(segs));
  check('live transcript saved with times', (await page.locator('#apTranscript button').count()) === 2 && (await page.locator('#apTranscript button').first().innerText()).includes('첫 번째 문장'));
  const blob = await page.evaluate(async () => { const a = document.querySelector('#apAudio'); return { src: !!a.src }; });
  check('audio loaded into player', blob.src);

  // 재생 위치를 A와 B 사이로 → B는 흐리게, A는 그대로
  const alphaAt = (sx, sy) => page.evaluate(([x, y]) => { const v = __flexnote.viewer; return v.inkCtx.getImageData(Math.round(x * v.dpr), Math.round(y * v.dpr), 1, 1).data[3]; }, [sx, sy]);
  await page.evaluate((t) => { const a = document.querySelector('#apAudio'); a.currentTime = t / 1000; a.dispatchEvent(new Event('pause')); }, (A.rt.t + B.rt.t) / 2);
  await page.waitForTimeout(200);
  const aA = await alphaAt(250, 250), aB = await alphaAt(250, 330);
  check('replay: ink written later is faded, earlier ink normal', aA > 200 && aB > 0 && aB < 80, `A=${aA} B=${aB}`);
  // 재생하면 끝까지 가며 B 가 나타남
  await page.click('#apPlay');
  await page.waitForTimeout(500);
  const playing = await page.evaluate(() => !document.querySelector('#apAudio').paused);
  await page.waitForFunction(() => document.querySelector('#apAudio').ended || document.querySelector('#apAudio').paused, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(200);
  check('playback runs and reveals later ink', playing && (await alphaAt(250, 330)) > 200, `playing=${playing} B=${await alphaAt(250, 330)}`);
  // 손가락으로 B 를 탭 → B 를 쓰던 순간(0.8초 앞)으로 이동해 재생
  await page.waitForTimeout(400);
  await h.touch(cdp, 'touchStart', [[X(250), Y(330), 1]]);
  await h.touch(cdp, 'touchEnd', [[X(250), Y(330), 1]]);
  await page.waitForTimeout(150);
  const ct = await page.evaluate(() => document.querySelector('#apAudio').currentTime * 1000);
  check('finger tap on ink seeks to when it was written', Math.abs(ct - (B.rt.t - 800)) < 400, `t=${Math.round(ct)} expected≈${B.rt.t - 800}`);
  await page.click('#apPlay').catch(() => {});
  // 받아쓴 글 → 포스트잇
  await page.click('#apInsertText');
  const note = await page.evaluate(() => { for (const its of __flexnote.state.doc.pages.values()) { const n = its.find((i) => i.t === 'nt'); if (n) return n.text; } });
  check('transcript inserted as sticky note', !!note && note.includes('첫 번째 문장') && note.includes('두 번째 문장'), note);
  // AI로 정확하게 받아쓰기: 녹음을 WAV 로 바꿔 Gemini 에 보내고, 받은 문장·시각으로 바꿈
  const aiReqs = [];
  await page.route('https://generativelanguage.googleapis.com/**', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    aiReqs.push(body);
    const out = JSON.stringify([{ s: 0.5, text: 'AI 첫 문장' }, { s: '0:01.5', text: 'AI 둘째 문장' }]);
    const ev = (o) => `data: ${JSON.stringify(o)}\r\n\r\n`;
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: ev({ candidates: [{ content: { parts: [{ text: out }] }, finishReason: 'STOP' }] }) });
  });
  await page.evaluate(() => localStorage.setItem('flexnote.geminiKey', 'test-key'));
  await page.click('#apAiStt');
  await page.waitForFunction(() => /완료/.test(document.querySelector('#apInterim').textContent), null, { timeout: 15000 }).catch(() => {});
  const part = aiReqs[0]?.contents?.[0]?.parts?.[0]?.inlineData;
  check('AI transcription sends the recording as 16kHz WAV (JSON answer)', aiReqs.length === 1 && part?.mimeType === 'audio/wav' && atob(part.data.slice(0, 64)).startsWith('RIFF') && aiReqs[0].generationConfig.responseMimeType === 'application/json', JSON.stringify({ n: aiReqs.length, mime: part?.mimeType }));
  const tx = await page.$$eval('#apTranscript button', (bs) => bs.map((b) => b.innerText.replace(/\s+/g, ' ')));
  check('AI transcript replaces live one with its times', tx.length === 2 && /0:00 ?AI 첫 문장/.test(tx[0]) && /0:01 ?AI 둘째 문장/.test(tx[1]), JSON.stringify(tx));
  await page.unroute('https://generativelanguage.googleapis.com/**');
  // 새로고침 후 녹음·시간 표시 유지
  await page.waitForTimeout(1200);
  await page.reload();
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(800);
  const A2 = (await strokes())[0];
  await page.click('#btnRec');
  await page.waitForTimeout(300);
  check('after reload: recording listed and stroke stamps kept', (await page.locator('#apList .ap-item').count()) === 1 && A2.rt?.rec === A.rt.rec);
  check('AI transcript kept after reload', /AI 받아쓰기/.test(await page.textContent('#apList .ap-item')));
  // 삭제
  await page.click('#apList .ap-item');
  await page.waitForSelector('#apPlayer:not([hidden])');
  await page.screenshot({ path: h.S + '/audio-panel.png' });
  await page.click('#apDelete');
  await page.waitForTimeout(400);
  check('recording can be deleted (ink stays)', (await page.locator('#apList .ap-item').count()) === 0 && (await strokes()).length === 2);
  console.log(results.join('\n'));
  const errs = logs.filter((l) => /pageerror|\[error\]/.test(l));
  if (errs.length) console.log(errs.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error(e); process.exit(1); });
