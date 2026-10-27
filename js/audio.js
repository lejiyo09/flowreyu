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
    // 강의·회의처럼 멀리서 말하는 소리도 잡히게 자동 음량 보정, 단일 채널
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    const mime = pickMime();
    const opts = { audioBitsPerSecond: 64000 }; // 말소리는 64kbps 면 충분 (파일 크기 절반 → AI 받아쓰기도 가벼움)
    if (mime) opts.mimeType = mime;
    const recorder = new MediaRecorder(stream, opts);
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
    // 음성 인식은 무음 뒤 끝나서 다시 시작되고, 그때마다 결과 번호가 0부터 다시 매겨진다.
    // 그래서 '번호 → 처음 들은 시각'은 인식 세션마다 새로 만든다 (안 그러면 두 번째 세션부터 앞 세션의 시각이 붙음)
    const now = () => Math.round(performance.now() - rec.t0);
    let sess = null;
    const newSession = () => { sess = { starts: new Map(), done: new Set(), speech: null, last: null }; };
    newSession();
    sr.onstart = newSession;
    sr.onspeechstart = () => { sess.speech = now(); };
    sr.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (sess.done.has(i)) continue; // 안드로이드 크롬은 확정된 결과를 다시 보내기도 함
        const r = e.results[i];
        const text = r[0]?.transcript?.trim();
        if (!text) continue;
        if (!sess.starts.has(i)) {
          // 말을 시작한 시각: 이 세션의 첫 문장은 '말소리 감지' 시각, 그 뒤는 처음 들린 때에서 인식 지연(약 0.8초)만큼 앞
          const t0 = sess.speech != null && sess.starts.size === 0 ? sess.speech : now() - 800;
          const prev = rec.segments[rec.segments.length - 1];
          sess.starts.set(i, Math.max(0, prev ? prev.t + 1 : 0, t0)); // 시간이 거꾸로 가지 않게
        }
        if (!r.isFinal) { this.emit('interim', { text }); continue; }
        sess.done.add(i);
        const last = sess.last; // {seg, at} 이 세션에서 마지막으로 확정한 문장
        // 안드로이드: 같은 문장을 점점 길게 누적해 다시 확정하는 경우 → 새 문장이 아니라 앞 문장을 늘린 것
        if (last && (text === last.seg.text || (text.startsWith(last.seg.text) && now() - last.at < 8000))) {
          last.seg.text = text;
          last.at = now();
        } else {
          const seg = { t: sess.starts.get(i), text };
          rec.segments.push(seg);
          sess.last = { seg, at: now() };
        }
        this.emit('transcript', { segments: rec.segments });
      }
    };
    sr.onerror = (e) => this.emit('stt', { available: true, error: e.error });
    // 음성 인식은 몇십 초 무음이면 스스로 끝나므로 녹음 중이면 다시 시작
    sr.onend = () => { if (this.rec === rec) { newSession(); try { sr.start(); } catch { /* */ } } };
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

/**
 * 녹음 파일 → AI 받아쓰기용 조각들: 16kHz 모노 WAV(base64)를 chunkSec 초씩 잘라 차례로 돌려준다.
 * 조각마다 따로 보내 시각을 조각 기준으로 받으면 긴 녹음에서도 시각이 밀리지 않는다.
 */
export async function* wavChunks(blob, chunkSec = 240) {
  const RATE = 16000;
  const ctx = new OfflineAudioContext(1, RATE, RATE); // 이 컨텍스트로 풀면 16kHz 로 바뀌어 나온다
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  const len = buf.length, ch = buf.numberOfChannels;
  const step = chunkSec * RATE;
  for (let a = 0; a < len; a += step) {
    const n = Math.min(step, len - a);
    const out = new DataView(new ArrayBuffer(44 + n * 2));
    const str = (o, t) => { for (let i = 0; i < t.length; i++) out.setUint8(o + i, t.charCodeAt(i)); };
    str(0, 'RIFF'); out.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
    out.setUint32(24, RATE, true); out.setUint32(28, RATE * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
    str(36, 'data'); out.setUint32(40, n * 2, true);
    const chans = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (const d of chans) v += d[a + i];
      v = Math.max(-1, Math.min(1, v / ch));
      out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
    const b64 = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).split(',')[1]);
      fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(new Blob([out.buffer], { type: 'audio/wav' }));
    });
    yield { wav: b64, startMs: Math.round((a / RATE) * 1000), durMs: Math.round((n / RATE) * 1000), totalMs: Math.round((len / RATE) * 1000) };
  }
}
