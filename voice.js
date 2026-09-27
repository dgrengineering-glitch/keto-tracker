/* Keto Tracker – "Speak your food": record → OpenAI transcription → AI decode → shared review card.
   Fallbacks: live dictation via SpeechRecognition, or type / use the iPhone keyboard mic. */
'use strict';

const TRANSCRIBE_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const TRANSCRIBE_MODELS = ['gpt-4o-mini-transcribe', 'whisper-1'];
const VOICE_MAX_SECS = 30;
// Timeouts are `let` so tests can shorten them.
let VOICE_STOP_FALLBACK_MS = 1500;  // if MediaRecorder never fires 'stop' (seen on iOS WebKit), assemble chunks anyway
let VOICE_API_TIMEOUT_MS = 45000;   // transcription / decode request timeout
// Single source of truth for the voice sheet. state: idle | starting | recording | stopping | processing | dictating
const V = { state: 'idle', session: 0, rec: null, dict: null, abort: null, timer: null, meter: null, lastTap: 0 };

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
function isIOSDevice() { return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
function pickMime() {
  const opts = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
  return opts.find(t => { try { return MediaRecorder.isTypeSupported(t); } catch (e) { return false; } }) || '';
}
function extFor(mime) { return /mp4|m4a|aac/.test(mime) ? 'mp4' : /ogg/.test(mime) ? 'ogg' : /wav/.test(mime) ? 'wav' : 'webm'; }
function fmtSecs(s) { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function voiceSheetOpen() { return !!(sheetCtx && sheetCtx.voiceSheet && $('#vStage')); }

/* ---------- teardown (always safe to call, idempotent) ---------- */
function stopTracks(stream) { try { stream && stream.getTracks().forEach(t => { try { t.stop(); } catch (e) { /* ignore */ } }); } catch (e) { /* ignore */ } }
function stopTimer() { if (V.timer) { clearInterval(V.timer); V.timer = null; } }
function stopMeter() {
  const m = V.meter; V.meter = null;
  if (!m) return;
  try { if (m.raf) cancelAnimationFrame(m.raf); } catch (e) { /* ignore */ }
  try { m.src && m.src.disconnect(); } catch (e) { /* ignore */ }
  try { m.ctx && m.ctx.close && m.ctx.close().catch(() => {}); } catch (e) { /* ignore */ }
  stopTracks(m.clone);
}
// Invalidate any in-flight work and release the microphone.
function teardownVoice() {
  V.session++;
  if (V.abort) { try { V.abort.abort(); } catch (e) { /* ignore */ } V.abort = null; }
  stopTimer(); stopMeter();
  if (V.rec) {
    const r = V.rec; V.rec = null;
    try { r.recorder.ondataavailable = null; r.recorder.onstop = null; r.recorder.onerror = null; if (r.recorder.state !== 'inactive') r.recorder.stop(); } catch (e) { /* ignore */ }
    stopTracks(r.stream);
  }
  if (V.dict) {
    const d = V.dict; V.dict = null;
    try { d.onresult = null; d.onerror = null; d.onend = null; d.abort(); } catch (e) { /* ignore */ }
  }
  V.state = 'idle';
}
// kept for older callers
function cleanupVoice() { teardownVoice(); }
function setVoiceState(state, extra) {
  V.state = state;
  renderVoiceStage(state, extra);
  const busy = state !== 'idle';
  const d = $('#vDecode'); if (d) d.disabled = busy;
  const m = $('#vManual'); if (m) m.disabled = false;
}
function cancelVoice() {
  const was = V.state;
  teardownVoice();
  if (!voiceSheetOpen()) return;
  setVoiceState('idle', { again: true });
  if (was !== 'idle') toast(was === 'processing' || was === 'stopping' ? 'Cancelled' : 'Recording cancelled');
}

/* ---------- sheet ---------- */
function openVoiceSheet(opts = {}) {
  stopScan(); teardownVoice();
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
      <button class="btn big" type="button" data-close>Close</button>
    </div>`);
  setVoiceState('idle');
  if (opts.autostart) {
    if (hasKey && canRecord()) startRecording();
    else if (srClass()) startDictation();
  }
}
function renderVoiceStage(state, extra = {}) {
  const el = $('#vStage'); if (!el) return;
  const hasKey = !!aiKey();
  const sr = !!srClass();
  const cancelBtn = (label) => `<button id="vCancel" class="btn big block mt8 v-cancel" type="button">${label || 'Cancel'}</button>`;
  if (state === 'recording' || state === 'dictating') {
    const meter = V.meter ? '<span class="rec-level"><i id="vLevel"></i></span>' : '<span class="rec-pulse" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>';
    el.innerHTML = `<button id="vStop" class="rec-btn" type="button" aria-label="Tap to stop">
        <span class="rec-dot" aria-hidden="true"></span>
        <span class="rec-time" id="vTime">0:00</span>
        <span class="rec-label">${state === 'recording' ? 'Recording…' : 'Listening…'} <b>Tap to stop</b></span>
        ${meter}
        <span class="rec-sub">${state === 'recording' ? `Stops automatically at ${fmtSecs(VOICE_MAX_SECS)}` : 'Live dictation – words appear below'}</span>
      </button>${cancelBtn(state === 'recording' ? 'Cancel recording' : 'Cancel')}`;
  } else if (state === 'starting' || state === 'stopping' || state === 'processing') {
    const label = extra.label || (state === 'starting' ? 'Starting the microphone…' : state === 'stopping' ? 'Processing…' : 'Processing…');
    el.innerHTML = `<div class="rec-busy" role="status" aria-live="polite"><span class="spinner big-spin"></span><div id="vBusyLabel">${esc(label)}</div></div>${cancelBtn()}`;
  } else {
    const primary = hasKey && canRecord()
      ? `<button id="vRecord" class="voice-btn" type="button"><span class="mic" aria-hidden="true">🎤</span><span class="vb-text"><b>${extra.again ? 'Record again' : 'Tap to start recording'}</b><small>Up to ${VOICE_MAX_SECS} seconds – say what you ate and how much</small></span></button>`
      : '';
    const dictBtn = sr ? `<button id="vDictate" class="btn ${primary ? 'outline' : 'primary big'} block mt8" type="button">🗣 Dictate live${hasKey ? ' instead' : ''} (no key needed)</button>` : '';
    const none = !primary && !sr ? `<div class="note small">Recording isn’t available here – type what you ate below, or use the 🎤 on the iPhone keyboard.</div>` : '';
    el.innerHTML = primary + dictBtn + none;
  }
}
function setBusyLabel(t) { const l = $('#vBusyLabel'); if (l) l.textContent = t; }
function voiceError(msg, opts = {}) {
  const el = $('#vErr'); if (!el) { toast(msg, 4500); return; }
  el.hidden = false;
  el.innerHTML = esc(msg) + (opts.settings ? ' <a href="#" id="vErrSettings">Open Settings</a>' : '') +
    (opts.typeIt ? ' <button id="vTypeIt" class="linkish" type="button">⌨️ Type it instead</button>' : '');
}
function clearVoiceError() { const el = $('#vErr'); if (el) el.hidden = true; }
function micDeniedMessage() {
  const standalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  return standalone
    ? 'Keto Tracker isn’t allowed to use the microphone. Close the app completely and reopen it, then tap Allow when asked. If it still won’t ask, go to iPhone Settings › Safari › Microphone and choose Ask or Allow.'
    : 'Microphone access was blocked. On iPhone go to Settings › Safari › Microphone and choose Ask or Allow (or tap “aA” in the address bar › Website Settings › Microphone), then try again. You can also type below or use the keyboard 🎤.';
}

/* ---------- recording (MediaRecorder) ---------- */
async function startRecording() {
  if (V.state !== 'idle') return;
  teardownVoice();
  const session = V.session;
  clearVoiceError();
  setVoiceState('starting');
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch (e) {
    if (session !== V.session) return;
    const n = (e && e.name) || '';
    setVoiceState('idle');
    if (/NotAllowed|Permission|Security/i.test(n)) voiceError(micDeniedMessage(), { typeIt: true });
    else if (/NotFound|Overconstrained/i.test(n)) voiceError('No microphone was found.', { typeIt: true });
    else voiceError('Couldn’t start the microphone.', { typeIt: true });
    return;
  }
  if (session !== V.session || !voiceSheetOpen()) { stopTracks(stream); return; } // cancelled / closed meanwhile
  const mime = pickMime();
  let recorder;
  try { recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
  catch (e) { stopTracks(stream); setVoiceState('idle'); voiceError('Recording isn’t supported here.', { typeIt: true }); return; }
  const r = { recorder, stream, chunks: [], mime: recorder.mimeType || mime || 'audio/webm', started: Date.now(), session };
  recorder.ondataavailable = ev => { if (ev.data && ev.data.size) r.chunks.push(ev.data); };
  recorder.onerror = () => { if (V.rec === r && V.state === 'recording') stopRecording(); };
  try { recorder.start(1000); } // timeslice so chunks accumulate even if the final 'dataavailable'/'stop' never arrive
  catch (e) { stopTracks(stream); setVoiceState('idle'); voiceError('Couldn’t start recording.', { typeIt: true }); return; }
  V.rec = r;
  // Level meter is decorative. On iOS an AudioContext tapping the mic can stall MediaRecorder, so it’s skipped there.
  if (!isIOSDevice()) startLevelMeter(stream, session);
  setVoiceState('recording');
  V.timer = setInterval(() => {
    if (session !== V.session || V.state !== 'recording') return;
    const secs = (Date.now() - r.started) / 1000;
    const t = $('#vTime'); if (t) t.textContent = fmtSecs(secs);
    if (secs >= VOICE_MAX_SECS) stopRecording();
  }, 250);
}
function startLevelMeter(stream, session) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const clone = stream.clone(); // never share the recorder’s own track with the analyser
    let ctx;
    try { ctx = new AC(); } catch (e) { stopTracks(clone); return; }
    const m = { ctx, clone, raf: 0, src: null };
    try {
      m.src = ctx.createMediaStreamSource(clone);
      const an = ctx.createAnalyser(); an.fftSize = 256; m.src.connect(an);
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {});
      const buf = new Uint8Array(an.fftSize); let last = 0;
      const tick = (ts) => {
        if (V.meter !== m || session !== V.session) return;
        if (ts - last > 80) {
          last = ts;
          try {
            an.getByteTimeDomainData(buf); let sum = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
            const lvl = Math.min(1, Math.sqrt(sum / buf.length) * 4); const bar = $('#vLevel'); if (bar) bar.style.width = Math.round(8 + lvl * 92) + '%';
          } catch (e) { stopMeter(); return; }
        }
        m.raf = requestAnimationFrame(tick);
      };
      V.meter = m;
      m.raf = requestAnimationFrame(tick);
    } catch (e) { V.meter = m; stopMeter(); }
  } catch (e) { /* level meter is optional */ }
}
// Resolve with a Blob on 'stop' OR after a fallback timeout – never hangs.
function finishRecorder(r, ms) {
  return new Promise(resolve => {
    let done = false, timer = null;
    const finish = () => {
      if (done) return; done = true; clearTimeout(timer);
      let blob; try { blob = new Blob(r.chunks, { type: String(r.mime).split(';')[0] }); } catch (e) { blob = new Blob([]); }
      resolve(blob);
    };
    timer = setTimeout(finish, ms);
    try { r.recorder.addEventListener('stop', () => setTimeout(finish, 50), { once: true }); } catch (e) { /* ignore */ }
    try {
      const st = r.recorder.state;
      if (st === 'recording' || st === 'paused') {
        try { r.recorder.requestData(); } catch (e) { /* not all browsers allow this */ }
        r.recorder.stop();
      } else finish();
    } catch (e) { finish(); }
  });
}
async function stopRecording() {
  if (V.state !== 'recording' || !V.rec) return; // ignore repeat taps
  const r = V.rec; const session = r.session;
  setVoiceState('stopping', { label: 'Processing…' });   // immediate feedback – never looks frozen
  stopTimer(); stopMeter();
  let blob = null;
  try { blob = await finishRecorder(r, VOICE_STOP_FALLBACK_MS); }
  catch (e) { blob = null; }
  finally {
    stopTracks(r.stream);
    if (V.rec === r) V.rec = null;
  }
  if (session !== V.session) return; // cancelled while finishing
  const secs = (Date.now() - r.started) / 1000;
  if (!blob || blob.size < 800 || secs < 0.8) {
    setVoiceState('idle', { again: true });
    voiceError('Didn’t catch that – tap to record again and speak for a few seconds.', { typeIt: true });
    return;
  }
  await processAudio(blob, r.mime, session);
}
async function processAudio(blob, mime, session) {
  setVoiceState('processing', { label: 'Turning your speech into text…' });
  const ctrl = new AbortController(); V.abort = ctrl;
  let text = '';
  try {
    text = await transcribe(blob, mime, ctrl.signal);
  } catch (e) {
    if (session !== V.session || (e && e.kind === 'cancelled')) return;
    V.abort = null;
    setVoiceState('idle', { again: true });
    voiceError(voiceErrorMessage(e, 'transcribe'), { settings: ['nokey', 'badkey', 'quota'].includes(e && e.kind), typeIt: true });
    return;
  }
  if (session !== V.session || !voiceSheetOpen()) return;
  V.abort = null;
  if (!text) { setVoiceState('idle', { again: true }); voiceError('Didn’t catch any words – try again a little closer to the phone.', { typeIt: true }); return; }
  $('#vText').value = text;
  await decodeTranscript(session);
}
async function transcribe(blob, mime, signal) {
  let lastErr;
  for (const model of TRANSCRIBE_MODELS) {
    const fd = new FormData();
    fd.append('file', blob, 'voice.' + extFor(mime));
    fd.append('model', model);
    fd.append('language', 'en');
    fd.append('response_format', 'json');
    fd.append('prompt', 'British English. Someone describing food and drink they have eaten, with amounts, e.g. "two rashers of back bacon, a slice of wholemeal toast with butter, a mug of tea with a splash of semi-skimmed milk".');
    try {
      const payload = await openaiRequest(TRANSCRIBE_ENDPOINT, fd, VOICE_API_TIMEOUT_MS, signal);
      return String(payload.text || '').trim();
    } catch (e) {
      lastErr = e;
      if (e && e.kind === 'model') continue; // fall back to whisper-1
      throw e;
    }
  }
  throw lastErr;
}

/* ---------- live dictation (SpeechRecognition) – never runs alongside MediaRecorder ---------- */
function startDictation() {
  const SR = srClass(); if (!SR) return;
  if (V.state !== 'idle') return;
  teardownVoice();
  const session = V.session;
  clearVoiceError();
  const base = $('#vText').value.trim();
  let finalText = '';
  let d;
  try { d = new SR(); d.lang = 'en-GB'; d.interimResults = true; d.continuous = true; }
  catch (e) { voiceError('Live dictation isn’t available.', { typeIt: true }); return; }
  d.onresult = ev => {
    if (session !== V.session) return;
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) { const r = ev.results[i]; if (r.isFinal) finalText += r[0].transcript + ' '; else interim += r[0].transcript; }
    const t = $('#vText'); if (t) t.value = (base ? base + ' ' : '') + (finalText + interim).trim();
  };
  d.onerror = ev => {
    if (session !== V.session) return;
    const n = ev && ev.error;
    if (n === 'not-allowed' || n === 'service-not-allowed') voiceError(micDeniedMessage() + ' (Live dictation may also need Siri & Dictation switched on in iPhone Settings.)', { typeIt: true });
    else if (n === 'no-speech') voiceError('I didn’t hear anything – try again.', { typeIt: true });
    else if (n === 'network') voiceError('Live dictation needs an internet connection.', { typeIt: true });
    else if (n !== 'aborted') voiceError('Live dictation stopped unexpectedly.', { typeIt: true });
  };
  d.onend = () => { if (session !== V.session) return; endDictation(); };
  try { d.start(); } catch (e) { voiceError('Couldn’t start live dictation.', { typeIt: true }); return; }
  V.dict = d;
  setVoiceState('dictating');
  const started = Date.now();
  V.timer = setInterval(() => {
    if (session !== V.session) return;
    const t = $('#vTime'); if (t) t.textContent = fmtSecs((Date.now() - started) / 1000);
    if (Date.now() - started > 60000) stopDictation();
  }, 250);
}
function endDictation() {
  stopTimer();
  const d = V.dict; V.dict = null;
  if (d) { try { d.onresult = null; d.onerror = null; d.onend = null; d.abort(); } catch (e) { /* ignore */ } }
  if (voiceSheetOpen()) setVoiceState('idle', { again: true });
}
function stopDictation() {
  if (V.state !== 'dictating' || !V.dict) return;
  const d = V.dict; const session = V.session;
  try { d.stop(); } catch (e) { /* ignore */ }
  // if 'end' never arrives, force it
  setTimeout(() => { if (session === V.session && V.dict === d) endDictation(); }, VOICE_STOP_FALLBACK_MS);
}

/* ---------- decode ---------- */
async function decodeTranscript(sessionFromAudio) {
  const internal = typeof sessionFromAudio === 'number';
  if (!internal && V.state !== 'idle') return;
  if (internal && sessionFromAudio !== V.session) return;
  const text = ($('#vText').value || '').trim();
  clearVoiceError();
  if (!text) { voiceError('Say or type what you ate first.'); return; }
  if (!aiKey()) { setVoiceState('idle'); voiceError(aiErrorMessage({ kind: 'nokey' }), { settings: true }); return; }
  if (!internal) teardownVoice(); // make sure nothing is holding the mic
  const session = V.session;
  setVoiceState('processing', { label: 'Working out the food and macros…' });
  const ctrl = new AbortController(); V.abort = ctrl;
  try {
    const out = await chatJSON([
      { role: 'system', content: VOICE_SYSTEM_PROMPT },
      { role: 'user', content: `What I ate: ${text}` }
    ], ctrl.signal, VOICE_API_TIMEOUT_MS);
    if (session !== V.session || !voiceSheetOpen()) return;
    V.abort = null;
    if (!out.items.length) { setVoiceState('idle', { again: true }); voiceError(out.notes ? 'No food found: ' + out.notes : 'I couldn’t find any food in that – try describing it again.'); return; }
    V.state = 'idle';
    aiState = { dataUrl: null, items: out.items, notes: out.notes, source: 'voice', transcript: text };
    renderAiReview();
  } catch (e) {
    if (session !== V.session || (e && e.kind === 'cancelled')) return;
    V.abort = null;
    setVoiceState('idle', { again: true });
    voiceError(voiceErrorMessage(e, 'decode'), { settings: ['nokey', 'badkey', 'model', 'quota'].includes(e && e.kind) });
  }
}
function voiceErrorMessage(e, stage) {
  if (e && e.kind === 'format') return stage === 'transcribe' ? 'The transcription reply couldn’t be read – please try again.' : 'The AI reply couldn’t be read. Try again, or describe the food a little differently.';
  if (e && e.kind === 'model' && stage === 'transcribe') return 'OpenAI’s transcription models aren’t available on your account.';
  if (e && e.kind === 'network' && e.message === 'timeout') return stage === 'transcribe' ? 'OpenAI took too long to transcribe your recording – check your connection and try again.' : 'OpenAI took too long to reply – check your connection and try again.';
  return aiErrorMessage(e);
}

/* ---------- bindings ---------- */
function handleVoiceTap(e) {
  const t = e.target;
  if (t.closest('#mVoice')) { if (e.type !== 'click') return; e.preventDefault(); openVoiceSheet({ autostart: true }); return; }
  if (!sheetCtx || !sheetCtx.voiceSheet) return;
  const stopBtn = t.closest('#vStop'), cancelBtn = t.closest('#vCancel');
  if (stopBtn || cancelBtn) {
    // Handle on pointerup for responsiveness; ignore the click that follows (and any double taps).
    const now = Date.now();
    if (e.type === 'click' && now - V.lastTap < 700) return;
    if (e.type === 'pointerup') V.lastTap = now;
    if (cancelBtn) cancelVoice();
    else if (V.state === 'recording') stopRecording();
    else if (V.state === 'dictating') stopDictation();
    return;
  }
  if (e.type !== 'click') return;
  if (t.closest('#vRecord')) startRecording();
  else if (t.closest('#vDictate')) startDictation();
  else if (t.closest('#vDecode')) decodeTranscript();
  else if (t.closest('#vTypeIt')) { clearVoiceError(); const x = $('#vText'); if (x) { x.focus(); x.scrollIntoView({ block: 'center' }); } }
  else if (t.closest('#vManual')) { const txt = $('#vText').value.trim(); teardownVoice(); openManualSheet({ name: txt.slice(0, 80) }); }
  else if (t.closest('#vGoSettings') || t.closest('#vErrSettings')) { e.preventDefault(); teardownVoice(); closeSheet(); showView('settings'); setTimeout(() => $('#aiCard').scrollIntoView({ block: 'start' }), 50); }
  else if (t.closest('[data-close]')) teardownVoice();
}
function backgroundTeardown() {
  if (V.state === 'recording' || V.state === 'dictating' || V.state === 'starting') {
    teardownVoice();
    if (voiceSheetOpen()) { setVoiceState('idle', { again: true }); voiceError('Recording stopped because Keto Tracker went into the background – tap to record again.', { typeIt: true }); }
  }
}
function bindVoice() {
  const sheet = $('#sheet');
  sheet.addEventListener('click', handleVoiceTap, true);
  sheet.addEventListener('pointerup', handleVoiceTap, true);
  $('#sheetBackdrop').addEventListener('click', teardownVoice);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') backgroundTeardown(); });
  window.addEventListener('pagehide', () => { backgroundTeardown(); teardownVoice(); });
}
