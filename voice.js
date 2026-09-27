/* Keto Tracker – "Speak your food": record → OpenAI transcription → AI decode → shared review card.
   Fallbacks: live dictation via SpeechRecognition, or type / use the iPhone keyboard mic. */
'use strict';

const TRANSCRIBE_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const TRANSCRIBE_MODELS = ['gpt-4o-mini-transcribe', 'whisper-1'];
const VOICE_MAX_SECS = 30;
let rec = null;      // { recorder, stream, chunks, mime, started, timer, raf, audioCtx, stopping }
let dict = null;     // SpeechRecognition instance

const VOICE_SYSTEM_PROMPT = `You are a nutrition estimation assistant for a UK user following a ketogenic diet.
The user has described, in their own words (transcribed from speech, so expect minor transcription errors), food or drink they have eaten.
Split it into distinct items. Estimate each item's weight in grams using typical UK portion sizes unless the user states an amount (e.g. a medium egg ~58 g as bought / ~50 g edible, a slice of bread from a standard UK loaf ~36–40 g, a rasher of back bacon ~25 g raw, a knob of butter ~10 g, a splash of milk ~30 ml, a mug of tea/coffee ~250 ml). Use typical UK nutrition values (UK food composition data and UK product labels).
Include likely hidden ingredients (butter or oil used for cooking, milk in tea/coffee) only if the description implies them, and state assumptions in "notes".
Rules: total_carbs_g INCLUDES fibre; net_carbs_g = total_carbs_g - fibre_g. confidence is "high", "medium" or "low". All numbers are plain numbers (no units, no ranges). Use British English.
Reply with ONLY a JSON object (no markdown) in exactly this shape:
{"items":[{"name":string,"estimated_grams":number,"kcal":number,"fat_g":number,"protein_g":number,"total_carbs_g":number,"fibre_g":number,"net_carbs_g":number,"confidence":"high"|"medium"|"low"}],"notes":string}
If the text does not describe any food or drink, return {"items":[],"notes":"<why>"}.`;

function srClass() { return window.SpeechRecognition || window.webkitSpeechRecognition || null; }
function canRecord() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder); }
function pickMime() {
  const opts = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
  return opts.find(t => { try { return MediaRecorder.isTypeSupported(t); } catch (e) { return false; } }) || '';
}
function extFor(mime) { return /mp4|m4a|aac/.test(mime) ? 'mp4' : /ogg/.test(mime) ? 'ogg' : /wav/.test(mime) ? 'wav' : 'webm'; }
function fmtSecs(s) { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

/* ---------- sheet ---------- */
function openVoiceSheet(opts = {}) {
  stopScan(); cleanupVoice();
  sheetCtx = { voiceSheet: true };
  const hasKey = !!aiKey();
  openSheet(`
    <h2 id="sheetTitle">Speak your food</h2>
    <div id="vStage"></div>
    <label class="field mt12"><span class="field-label">What you ate (edit if needed)</span>
      <textarea id="vText" rows="3" placeholder="e.g. two scrambled eggs with a slice of toast and butter">${esc(opts.text || '')}</textarea></label>
    <p class="muted small" style="margin-top:-4px">Tip: you can also tap the 🎤 on the iPhone keyboard to dictate straight into this box.</p>
    <div id="vErr" class="note bad" hidden></div>
    ${hasKey ? '' : `<div class="note warn small"><b>Decoding needs your OpenAI key.</b> Get one at platform.openai.com › API keys, then paste it in Settings › Photo estimates (AI). <a href="#" id="vGoSettings">Open Settings</a></div>`}
    <div class="sheet-actions">
      <button id="vDecode" class="btn primary big" type="button">✨ Decode with AI</button>
      <button id="vManual" class="btn outline big" type="button">Type it in manually instead</button>
      <button class="btn big" type="button" data-close>Cancel</button>
    </div>`);
  renderVoiceStage('idle');
  if (opts.autostart) {
    if (hasKey && canRecord()) startRecording();
    else if (srClass()) startDictation();
  }
}
function renderVoiceStage(state, extra = {}) {
  const el = $('#vStage'); if (!el) return;
  const hasKey = !!aiKey();
  const sr = !!srClass();
  if (state === 'recording' || state === 'dictating') {
    el.innerHTML = `<button id="vStop" class="rec-btn" type="button" aria-label="Tap to stop">
        <span class="rec-dot" aria-hidden="true"></span>
        <span class="rec-time" id="vTime">0:00</span>
        <span class="rec-label">${state === 'recording' ? 'Recording…' : 'Listening…'} <b>Tap to stop</b></span>
        <span class="rec-level"><i id="vLevel"></i></span>
        <span class="rec-sub">${state === 'recording' ? `Stops automatically at ${fmtSecs(VOICE_MAX_SECS)}` : 'Live dictation – words appear below'}</span>
      </button>`;
  } else if (state === 'transcribing' || state === 'decoding') {
    el.innerHTML = `<div class="rec-busy"><span class="spinner big-spin"></span><div>${state === 'transcribing' ? 'Turning your speech into text…' : 'Working out the food and macros…'}</div></div>`;
  } else {
    const primary = hasKey && canRecord()
      ? `<button id="vRecord" class="voice-btn" type="button"><span class="mic" aria-hidden="true">🎤</span><span class="vb-text"><b>${extra.again ? 'Record again' : 'Tap to start recording'}</b><small>Up to ${VOICE_MAX_SECS} seconds – say what you ate and how much</small></span></button>`
      : '';
    const dictBtn = sr ? `<button id="vDictate" class="btn ${primary ? 'outline' : 'primary big'} block mt8" type="button">🗣 Dictate live${hasKey ? ' instead' : ''} (no key needed)</button>` : '';
    const none = !primary && !sr ? `<div class="note small">Recording isn’t available here – type what you ate below, or use the 🎤 on the iPhone keyboard.</div>` : '';
    el.innerHTML = primary + dictBtn + none;
  }
}
function voiceError(msg, withSettings) {
  const el = $('#vErr'); if (!el) { toast(msg, 4500); return; }
  el.hidden = false;
  el.innerHTML = esc(msg) + (withSettings ? ' <a href="#" id="vErrSettings">Open Settings</a>' : '');
}
function micDeniedMessage() {
  const standalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  return standalone
    ? 'Keto Tracker isn’t allowed to use the microphone. Close the app completely and reopen it, then tap Allow when asked. If it still won’t ask, go to iPhone Settings › Safari › Microphone and choose Ask or Allow.'
    : 'Microphone access was blocked. On iPhone go to Settings › Safari › Microphone and choose Ask or Allow (or tap “aA” in the address bar › Website Settings › Microphone), then try again. You can also type below or use the keyboard 🎤.';
}

/* ---------- recording (MediaRecorder) ---------- */
async function startRecording() {
  cleanupVoice();
  $('#vErr').hidden = true;
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch (e) {
    const n = (e && e.name) || '';
    if (/NotAllowed|Permission|Security/i.test(n)) voiceError(micDeniedMessage());
    else if (/NotFound|Overconstrained/i.test(n)) voiceError('No microphone was found. Type what you ate below instead.');
    else voiceError('Couldn’t start the microphone. Type what you ate below, or use the keyboard 🎤.');
    renderVoiceStage('idle');
    return;
  }
  if (!$('#vStage')) { stream.getTracks().forEach(t => t.stop()); return; } // sheet closed meanwhile
  const mime = pickMime();
  let recorder;
  try { recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
  catch (e) { stream.getTracks().forEach(t => t.stop()); voiceError('Recording isn’t supported here – type what you ate below instead.'); renderVoiceStage('idle'); return; }
  rec = { recorder, stream, chunks: [], mime: recorder.mimeType || mime || 'audio/webm', started: Date.now(), stopping: false };
  recorder.ondataavailable = ev => { if (ev.data && ev.data.size) rec && rec.chunks.push(ev.data); };
  recorder.onstop = onRecordingStopped;
  recorder.start(250);
  renderVoiceStage('recording');
  rec.timer = setInterval(() => {
    if (!rec) return;
    const secs = (Date.now() - rec.started) / 1000;
    const t = $('#vTime'); if (t) t.textContent = fmtSecs(secs);
    if (secs >= VOICE_MAX_SECS) stopRecording();
  }, 200);
  startLevelMeter(stream);
}
function startLevelMeter(stream) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC || !rec) return;
    const ctx = new AC(); if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const src = ctx.createMediaStreamSource(stream); const an = ctx.createAnalyser(); an.fftSize = 512; src.connect(an);
    const buf = new Uint8Array(an.fftSize); rec.audioCtx = ctx;
    const tick = () => {
      if (!rec || rec.stopping) return;
      an.getByteTimeDomainData(buf); let sum = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      const lvl = Math.min(1, Math.sqrt(sum / buf.length) * 4); const bar = $('#vLevel'); if (bar) bar.style.width = Math.round(8 + lvl * 92) + '%';
      rec.raf = requestAnimationFrame(tick);
    };
    tick();
  } catch (e) { /* level meter is optional */ }
}
function stopRecording() {
  if (!rec || rec.stopping) return;
  rec.stopping = true;
  clearInterval(rec.timer);
  try { if (rec.recorder.state !== 'inactive') rec.recorder.stop(); else onRecordingStopped(); } catch (e) { onRecordingStopped(); }
}
async function onRecordingStopped() {
  if (!rec) return;
  const { chunks, mime, stream, started } = rec;
  const secs = (Date.now() - started) / 1000;
  releaseRec();
  stream.getTracks().forEach(t => t.stop());
  if (!$('#vStage')) return;
  const blob = new Blob(chunks, { type: mime.split(';')[0] });
  if (secs < 0.8 || blob.size < 800) { voiceError('That was too short to hear anything – tap to record again and speak for a few seconds.'); renderVoiceStage('idle', { again: true }); return; }
  renderVoiceStage('transcribing');
  try {
    const text = await transcribe(blob, mime);
    if (!$('#vText')) return;
    if (!text) { voiceError('I didn’t catch any words. Try again a little closer to the phone, or type below.'); renderVoiceStage('idle', { again: true }); return; }
    $('#vText').value = text;
    await decodeTranscript();
  } catch (e) {
    renderVoiceStage('idle', { again: true });
    voiceError(voiceErrorMessage(e, 'transcribe'), ['nokey', 'badkey', 'quota'].includes(e && e.kind));
  }
}
function releaseRec() {
  if (!rec) return;
  clearInterval(rec.timer); if (rec.raf) cancelAnimationFrame(rec.raf);
  try { rec.audioCtx && rec.audioCtx.close(); } catch (e) { /* ignore */ }
  rec = null;
}
function cleanupVoice() {
  if (rec) { const s = rec.stream; rec.stopping = true; try { rec.recorder.onstop = null; if (rec.recorder.state !== 'inactive') rec.recorder.stop(); } catch (e) { /* ignore */ } releaseRec(); try { s.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ } }
  if (dict) { try { dict.onend = null; dict.abort(); } catch (e) { /* ignore */ } dict = null; clearInterval(dictTimer); }
}
async function transcribe(blob, mime) {
  let lastErr;
  for (const model of TRANSCRIBE_MODELS) {
    const fd = new FormData();
    fd.append('file', blob, 'voice.' + extFor(mime));
    fd.append('model', model);
    fd.append('language', 'en');
    fd.append('response_format', 'json');
    fd.append('prompt', 'British English. Someone describing food and drink they have eaten, with amounts, e.g. "two rashers of back bacon, a slice of wholemeal toast with butter, a mug of tea with a splash of semi-skimmed milk".');
    try {
      const payload = await openaiRequest(TRANSCRIBE_ENDPOINT, fd, 60000);
      return String(payload.text || '').trim();
    } catch (e) {
      lastErr = e;
      if (e && e.kind === 'model') continue; // fall back to whisper-1
      throw e;
    }
  }
  throw lastErr;
}

/* ---------- live dictation (SpeechRecognition) ---------- */
let dictTimer = null;
function startDictation() {
  const SR = srClass(); if (!SR) return;
  cleanupVoice(); $('#vErr').hidden = true;
  const base = $('#vText').value.trim();
  let finalText = '';
  try {
    dict = new SR(); dict.lang = 'en-GB'; dict.interimResults = true; dict.continuous = true;
  } catch (e) { voiceError('Live dictation isn’t available – type below or use the keyboard 🎤.'); return; }
  dict.onresult = ev => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) { const r = ev.results[i]; if (r.isFinal) finalText += r[0].transcript + ' '; else interim += r[0].transcript; }
    const t = $('#vText'); if (t) t.value = (base ? base + ' ' : '') + (finalText + interim).trim();
  };
  dict.onerror = ev => {
    const n = ev && ev.error;
    if (n === 'not-allowed' || n === 'service-not-allowed') voiceError(micDeniedMessage() + ' (Speech Recognition may also need Siri & Dictation switched on in iPhone Settings.)');
    else if (n === 'no-speech') voiceError('I didn’t hear anything – try again, or type below.');
    else if (n === 'network') voiceError('Live dictation needs an internet connection – type below instead.');
    else if (n !== 'aborted') voiceError('Live dictation stopped unexpectedly – type below or use the keyboard 🎤.');
  };
  dict.onend = () => { clearInterval(dictTimer); dict = null; if ($('#vStage')) renderVoiceStage('idle', { again: true }); };
  try { dict.start(); } catch (e) { dict = null; voiceError('Couldn’t start live dictation – type below instead.'); return; }
  renderVoiceStage('dictating');
  const started = Date.now();
  dictTimer = setInterval(() => { const t = $('#vTime'); if (t) t.textContent = fmtSecs((Date.now() - started) / 1000); if (Date.now() - started > 60000 && dict) dict.stop(); }, 250);
}
function stopDictation() { if (dict) { try { dict.stop(); } catch (e) { /* ignore */ } } }

/* ---------- decode ---------- */
async function decodeTranscript() {
  const text = ($('#vText').value || '').trim();
  $('#vErr').hidden = true;
  if (!text) { voiceError('Say or type what you ate first.'); return; }
  if (!aiKey()) { voiceError(aiErrorMessage({ kind: 'nokey' }), true); return; }
  cleanupVoice();
  renderVoiceStage('decoding');
  const btn = $('#vDecode'); if (btn) btn.disabled = true;
  try {
    const out = await chatJSON([
      { role: 'system', content: VOICE_SYSTEM_PROMPT },
      { role: 'user', content: `What I ate: ${text}` }
    ]);
    if (!$('#vStage')) return;
    if (!out.items.length) { renderVoiceStage('idle', { again: true }); voiceError(out.notes ? 'No food found: ' + out.notes : 'I couldn’t find any food in that – try describing it again.'); return; }
    aiState = { dataUrl: null, items: out.items, notes: out.notes, source: 'voice', transcript: text };
    renderAiReview();
  } catch (e) {
    renderVoiceStage('idle', { again: true });
    voiceError(voiceErrorMessage(e, 'decode'), ['nokey', 'badkey', 'model', 'quota'].includes(e && e.kind));
  } finally {
    const b = $('#vDecode'); if (b) b.disabled = false;
  }
}
function voiceErrorMessage(e, stage) {
  if (e && e.kind === 'format') return stage === 'transcribe' ? 'The transcription reply couldn’t be read – please try again, or type below.' : 'The AI reply couldn’t be read. Try again, or describe the food a little differently.';
  if (e && e.kind === 'model' && stage === 'transcribe') return 'OpenAI’s transcription models aren’t available on your account – type below or use the keyboard 🎤 instead.';
  return aiErrorMessage(e);
}

/* ---------- bindings ---------- */
function bindVoice() {
  $('#sheet').addEventListener('click', e => {
    if (e.target.closest('#mVoice')) { e.preventDefault(); openVoiceSheet({ autostart: true }); return; }
    if (!sheetCtx || !sheetCtx.voiceSheet) return;
    if (e.target.closest('#vRecord')) startRecording();
    else if (e.target.closest('#vStop')) { if (rec) stopRecording(); else stopDictation(); }
    else if (e.target.closest('#vDictate')) startDictation();
    else if (e.target.closest('#vDecode')) decodeTranscript();
    else if (e.target.closest('#vManual')) { const t = $('#vText').value.trim(); cleanupVoice(); openManualSheet({ name: t.slice(0, 80) }); }
    else if (e.target.closest('#vGoSettings') || e.target.closest('#vErrSettings')) { e.preventDefault(); cleanupVoice(); closeSheet(); showView('settings'); setTimeout(() => $('#aiCard').scrollIntoView({ block: 'start' }), 50); }
    else if (e.target.closest('[data-close]')) cleanupVoice();
  }, true);
  $('#sheetBackdrop').addEventListener('click', cleanupVoice);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible' && rec) stopRecording(); });
}
