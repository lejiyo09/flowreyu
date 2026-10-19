// 음성 녹음 + 필기 위치 매핑 + 실시간 받아쓰기
//
// - 녹음하는 동안 쓴 필기(펜·형광펜·도형·글상자)에는 {rec: 녹음 id, t: 녹음 시작 후 ms} 가 붙는다
// - 재생하면 아직 "쓰기 전" 필기는 흐리게 보이고 재생 위치에 맞춰 차례로 나타난다
// - 받아쓰기는 브라우저의 음성 인식(Web Speech API)을 쓴다. 크롬에서는 구글 서버로 음성이 전송되므로
//   인터넷이 필요하고, 지원하지 않는 브라우저에서는 녹음만 된다.
import { Emitter, uid } from './util.js';

function pickMime() {
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of cands) if (MediaRecorder.isTypeSupported?.(m)) return m;
  return '';
}

export const SpeechRecognitionCtor = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition || null) : null;

export class AudioRecorder extends Emitter {
  constructor() {
    super();
    this.state = 'idle'; // idle | recording
    this.rec = null; // {id, t0, chunks, recorder, stream, segments, mime}
    this.sr = null;
  }

  get supported() { return typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia; }
  get recording() { return this.state === 'recording'; }

  /** 녹음 중이면 지금 시각의 필기 표시 {rec, t} */
  stamp() {
    if (!this.rec) return null;
    return { rec: this.rec.id, t: Math.round(performance.now() - this.rec.t0) };
  }

  elapsed() { return this.rec ? performance.now() - this.rec.t0 : 0; }

  async start({ stt = true, lang = 'ko-KR' } = {}) {
    if (this.rec) return;
    if (!this.supported) throw new Error('이 브라우저는 녹음을 지원하지 않습니다');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mime = pickMime();
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const rec = { id: uid('rec'), t0: performance.now(), created: Date.now(), chunks: [], recorder, stream, segments: [], mime: recorder.mimeType || mime || 'audio/webm' };
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
    recorder.start(1000); // 1초마다 조각 저장 (중간에 앱이 꺼져도 대부분 보존되도록 stop 에서 합침)
    this.rec = rec;
    this.state = 'recording';
    if (stt) this.startSpeech(rec, lang);
    this.emit('state', { state: 'recording' });
  }

  /** 실시간 받아쓰기: 문장이 확정될 때마다 {t, text} 저장 (t = 말하기 시작한 시각) */
  startSpeech(rec, lang) {
    if (!SpeechRecognitionCtor) { this.emit('stt', { available: false }); return; }
    let sr;
    try { sr = new SpeechRecognitionCtor(); } catch { this.emit('stt', { available: false }); return; }
    sr.lang = lang;
    sr.continuous = true;
    sr.interimResults = true;
    const starts = new Map(); // 결과 index → 그 문장을 처음 들은 시각
    sr.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (!starts.has(i)) starts.set(i, Math.max(0, Math.round(performance.now() - rec.t0) - 800));
        const text = r[0]?.transcript?.trim();
        if (r.isFinal && text) {
          rec.segments.push({ t: starts.get(i), text });
          this.emit('transcript', { segments: rec.segments });
        } else if (text) this.emit('interim', { text });
      }
    };
    sr.onerror = (e) => this.emit('stt', { available: true, error: e.error });
    // 음성 인식은 몇십 초 무음이면 스스로 끝나므로 녹음 중이면 다시 시작
    sr.onend = () => { if (this.rec === rec) { try { sr.start(); } catch { /* */ } } };
    try { sr.start(); this.sr = sr; this.emit('stt', { available: true }); } catch { this.emit('stt', { available: false }); }
  }

  /** 녹음 끝 → {id, blob, duration, mime, created, segments} */
  async stop() {
    const rec = this.rec;
    if (!rec) return null;
    this.rec = null;
    this.state = 'idle';
    if (this.sr) { const s = this.sr; this.sr = null; try { s.onend = null; s.stop(); } catch { /* */ } }
    const done = new Promise((res) => { rec.recorder.onstop = res; });
    try { rec.recorder.stop(); } catch { /* */ }
    await done;
    rec.stream.getTracks().forEach((t) => t.stop());
    const duration = Math.round(performance.now() - rec.t0);
    const blob = new Blob(rec.chunks, { type: rec.mime.split(';')[0] });
    this.emit('state', { state: 'idle' });
    return { id: rec.id, blob, duration, mime: rec.mime, created: rec.created, segments: rec.segments };
  }
}

export function fmtTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
