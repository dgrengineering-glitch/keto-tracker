/* Keto Tracker – AI features ("Estimate from photo" and "Speak your food") using the user's own xAI (Grok) API key.
   The key lives only in this device's localStorage (separate from backups) and is sent only to api.x.ai. */
'use strict';

const AI_KEY_STORE = 'ketoTracker.xaiKey';
const LEGACY_KEY_STORES = ['ketoTracker.openaiKey']; // pre-1.5 keys – deleted on start-up, never used
const XAI_BASE = 'https://api.x.ai/v1';
const AI_ENDPOINT = XAI_BASE + '/responses';          // xAI Responses API
const AI_DEFAULT_MODEL = 'grok-4.3';                  // text + image input, structured outputs, cheapest Grok 4 tier
let aiState = null; // { dataUrl, items:[{name, grams0, grams, base:{kcal,fat,protein,carbs,fibre}, confidence}], notes }

(function purgeLegacyKeys() { try { LEGACY_KEY_STORES.forEach(k => localStorage.removeItem(k)); } catch (e) { /* ignore */ } })();
function aiKey() { try { return localStorage.getItem(AI_KEY_STORE) || ''; } catch (e) { return ''; } }
function aiModel() {
  const m = String((db.settings && db.settings.xaiModel) || '').trim();
  return m && /^grok/i.test(m) ? m : AI_DEFAULT_MODEL; // only Grok models – anything else falls back to the default
}
function maskKey(k) { return k ? (k.slice(0, 4) + '…' + k.slice(-4)) : ''; }

const AI_SYSTEM_PROMPT = `You are a nutrition estimation assistant for a UK user following a ketogenic diet.
Identify each distinct food or drink visible in the photo. Estimate the edible portion weight in grams as served, and estimate its nutrition using typical UK values (UK food composition data and typical UK product labels).
Include likely hidden ingredients – cooking oil, butter, sauces, dressings, sugar in drinks – as separate items when reasonably likely, and state those assumptions in "notes".
Rules: total_carbs_g INCLUDES fibre; net_carbs_g = total_carbs_g - fibre_g. confidence is "high", "medium" or "low". All numbers are plain numbers (no units, no ranges). Use British English.
Reply with ONLY a JSON object (no markdown) in exactly this shape:
{"items":[{"name":string,"estimated_grams":number,"kcal":number,"fat_g":number,"protein_g":number,"total_carbs_g":number,"fibre_g":number,"net_carbs_g":number,"confidence":"high"|"medium"|"low"}],"notes":string}
If there is no food in the image, return {"items":[],"notes":"<why>"}.`;

// JSON Schema for xAI structured outputs (guarantees the reply shape).
const FOOD_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          estimated_grams: { type: 'number' },
          kcal: { type: 'number' },
          fat_g: { type: 'number' },
          protein_g: { type: 'number' },
          total_carbs_g: { type: 'number' },
          fibre_g: { type: 'number' },
          net_carbs_g: { type: 'number' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] }
        },
        required: ['name', 'estimated_grams', 'kcal', 'fat_g', 'protein_g', 'total_carbs_g', 'fibre_g', 'net_carbs_g', 'confidence'],
        additionalProperties: false
      }
    },
    notes: { type: 'string' }
  },
  required: ['items', 'notes'],
  additionalProperties: false
};

/* ---------- image handling ---------- */
function downscaleImage(file, maxSide = 1024, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve({ dataUrl: c.toDataURL('image/jpeg', quality), w, h });
      } catch (e) { URL.revokeObjectURL(url); reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
    img.src = url;
  });
}

/* ---------- API ---------- */
class AiError extends Error { constructor(kind, msg) { super(msg); this.kind = kind; } }
// Shared xAI request: maps failures to AiError kinds. `bodyObj` may be a plain object (sent as JSON) or FormData.
async function xaiRequest(url, bodyObj, timeoutMs = 60000, extSignal = null) {
  const key = aiKey();
  if (!key) throw new AiError('nokey', 'No API key');
  const isForm = typeof FormData !== 'undefined' && bodyObj instanceof FormData;
  const headers = { Authorization: 'Bearer ' + key };
  if (!isForm) headers['Content-Type'] = 'application/json';
  if (extSignal && extSignal.aborted) throw new AiError('cancelled', 'cancelled');
  const ctrl = new AbortController(); let cancelled = false;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onExt = () => { cancelled = true; ctrl.abort(); };
  if (extSignal) extSignal.addEventListener('abort', onExt);
  const done = () => { clearTimeout(timer); if (extSignal) extSignal.removeEventListener('abort', onExt); };
  let res;
  try {
    res = await fetch(url, { method: 'POST', signal: ctrl.signal, headers, body: isForm ? bodyObj : JSON.stringify(bodyObj) });
  } catch (e) {
    done();
    if (cancelled) throw new AiError('cancelled', 'cancelled');
    throw new AiError('network', e && e.name === 'AbortError' ? 'timeout' : 'network');
  }
  let payload = null;
  try { payload = await res.json(); } catch (e) {
    if (cancelled) { done(); throw new AiError('cancelled', 'cancelled'); }
    if (e && e.name === 'AbortError') { done(); throw new AiError('network', 'timeout'); }
  }
  done();
  if (!res.ok) throw xaiHttpError(res.status, payload);
  if (!payload) throw new AiError('format', 'not json');
  return payload;
}
// xAI errors look like {"code":"...","error":"Incorrect API key provided..."}; also accept {"error":{"message","code"}}.
function xaiHttpError(status, payload) {
  const p = payload || {};
  const errObj = p.error && typeof p.error === 'object' ? p.error : {};
  const msg = String(typeof p.error === 'string' ? p.error : (errObj.message || p.message || ''));
  const code = String(p.code || errObj.code || errObj.type || '');
  const all = code + ' ' + msg;
  if (status === 401 || /incorrect api key|invalid api key|api key (is )?(invalid|not valid|revoked|disabled|blocked|expired)|no api key|missing api key/i.test(all)) return new AiError('badkey', 'unauthorised');
  if (/credit|licen[cs]e|spending limit|billing|balance|insufficient funds|payment required/i.test(all) && [402, 403, 429].includes(status)) return new AiError('quota', code);
  if (status === 429) return new AiError('rate', code);
  if (status === 404 || ((status === 400 || status === 403) && /model/i.test(all))) return new AiError('model', code);
  if (status === 403) return new AiError('perm', code);
  if (status === 400 && /audio|format|decode|unsupported|codec|container/i.test(all)) return new AiError('audio', code);
  return new AiError('http', 'HTTP ' + status);
}
function responseText(payload) {
  if (!payload) return '';
  if (typeof payload.output_text === 'string' && payload.output_text) return payload.output_text;
  const out = Array.isArray(payload.output) ? payload.output : [];
  for (const item of out) {
    if (item && item.type === 'message' && Array.isArray(item.content)) {
      const t = item.content.filter(c => c && c.type === 'output_text' && typeof c.text === 'string').map(c => c.text).join('');
      if (t) return t;
    }
  }
  return '';
}
// Ask Grok for food items as structured JSON. `userContent` is a string or an array of input_text/input_image parts.
async function grokJSON(systemPrompt, userContent, signal = null, timeoutMs = 60000) {
  const body = {
    model: aiModel(),
    store: false, // don't keep the photo/text on xAI's side for later retrieval (and advised when sending images)
    max_output_tokens: 6000,
    input: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ],
    text: { format: { type: 'json_schema', name: 'food_estimate', schema: FOOD_SCHEMA, strict: true } }
  };
  const payload = await xaiRequest(AI_ENDPOINT, body, timeoutMs, signal);
  const content = responseText(payload);
  if (!content) throw new AiError('format', 'empty');
  return parseAiJson(content);
}
async function estimatePhoto(dataUrl, hint, signal = null) {
  return grokJSON(AI_SYSTEM_PROMPT, [
    { type: 'input_image', image_url: dataUrl, detail: 'high' },
    { type: 'input_text', text: 'Estimate the nutrition for this meal.' + (hint ? ` Extra information from the user: ${hint}` : '') }
  ], signal);
}
function parseAiJson(content) {
  let txt = String(content).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  let j;
  try { j = JSON.parse(txt); } catch (e) {
    const m = txt.match(/\{[\s\S]*\}/);
    try { j = m ? JSON.parse(m[0]) : null; } catch (e2) { j = null; }
  }
  if (!j || !Array.isArray(j.items)) throw new AiError('format', 'not json');
  const n = v => { const x = parseFloat(v); return isFinite(x) && x >= 0 ? x : 0; };
  const items = j.items.map(it => {
    const grams = n(it.estimated_grams) || 100;
    let carbs = n(it.total_carbs_g); const fibre = n(it.fibre_g);
    if (!carbs && n(it.net_carbs_g)) carbs = n(it.net_carbs_g) + fibre;
    let kcal = n(it.kcal); const fat = n(it.fat_g), protein = n(it.protein_g);
    if (!kcal) kcal = fat * 9 + protein * 4 + Math.max(0, carbs - fibre) * 4 + fibre * 2;
    const conf = String(it.confidence || '').toLowerCase();
    return { name: String(it.name || 'Food').slice(0, 80), grams0: grams, grams, base: { kcal, fat, protein, carbs, fibre }, confidence: ['high', 'medium', 'low'].includes(conf) ? conf : 'medium' };
  }).filter(it => it.grams0 > 0);
  return { items, notes: String(j.notes || '').slice(0, 600) };
}
function aiErrorMessage(e) {
  switch (e && e.kind) {
    case 'nokey': return 'Add your xAI (Grok) API key in Settings first.';
    case 'badkey': return 'xAI rejected your API key – it may be mistyped, revoked or expired. Check it in Settings.';
    case 'quota': return 'Your xAI account has no credit left (or hit its spending limit). Add credit at console.x.ai › Billing, then try again.';
    case 'rate': return 'xAI is busy or you’ve hit a rate limit – wait a few seconds and try again.';
    case 'model': return `The model “${aiModel()}” isn’t available to your xAI API key. Check the model name in Settings (default: ${AI_DEFAULT_MODEL}), or allow that model on the key at console.x.ai › API Keys.`;
    case 'perm': return 'Your xAI API key isn’t allowed to do this. At console.x.ai › API Keys, edit the key and allow all endpoints and models (or create a new key with the defaults).';
    case 'network': return e.message === 'timeout' ? 'xAI took too long to reply – check your connection and try again.' : 'Couldn’t reach xAI – check your internet connection and try again.';
    case 'format': return 'The AI reply couldn’t be read. Try again, or add a hint describing the meal.';
    default: return 'Something went wrong asking xAI – please try again.';
  }
}

/* ---------- UI ---------- */
function noKeyHtml() {
  return `<div class="note warn"><b>One-off setup needed:</b> AI estimates use your own xAI (Grok) account – pay as you go.</div>
    <ol class="steps">
      <li>On any browser, go to <b>console.x.ai</b> and sign up or sign in.</li>
      <li>Buy a little prepaid credit under <b>Billing</b> (you pay xAI directly, per use).</li>
      <li>Open <b>API Keys</b>, tap <b>Create API key</b>, keep the default access (all models and endpoints) and copy the key (it starts with <code>xai-</code>).</li>
      <li>In Keto Tracker go to <b>Settings › AI estimates (xAI Grok)</b>, paste the key and tap <b>Save key</b>.</li>
    </ol>
    <p class="muted small">The key stays on this phone only (it isn’t included in backups) and is sent only to xAI (api.x.ai).</p>
    <div class="sheet-actions"><button id="aiGoSettings" class="btn primary big" type="button">Go to Settings</button><button class="btn big" type="button" data-close>Close</button></div>`;
}
function openPhotoSheet() {
  stopScan();
  sheetCtx = { ai: true };
  aiState = { dataUrl: null, items: [], notes: '' };
  if (!aiKey()) { openSheet(`<h2 id="sheetTitle">Estimate from photo</h2>${noKeyHtml()}`); return; }
  openSheet(`
    <h2 id="sheetTitle">Estimate from photo</h2>
    <p class="muted small">Take a photo of your plate from above, with everything visible. Grok (${esc(aiModel())}) estimates each item’s weight and macros for you to check.</p>
    <div id="aiPreview" class="ai-preview"><span class="muted small">No photo yet</span></div>
    <div class="two mt8">
      <button id="aiTake" class="btn primary" type="button">📷 Take photo</button>
      <button id="aiChoose" class="btn outline" type="button">🖼 Choose photo</button>
    </div>
    <label class="field mt12"><span class="field-label">Hint (optional)</span>
      <input id="aiHint" type="text" maxlength="200" autocomplete="off" placeholder="e.g. cooked in butter, 2 eggs"></label>
    <div id="aiErr" class="note bad" hidden></div>
    <div class="sheet-actions">
      <button id="aiRun" class="btn primary big" type="button" disabled>Estimate macros</button>
      <button class="btn big" type="button" data-close>Cancel</button>
    </div>`);
}
async function handlePhotoFile(file) {
  if (!file || !aiState) return;
  $('#aiErr').hidden = true;
  $('#aiPreview').innerHTML = '<span class="muted small"><span class="spinner"></span> Preparing photo…</span>';
  try {
    const r = await downscaleImage(file);
    aiState.dataUrl = r.dataUrl; aiState.dim = [r.w, r.h];
    $('#aiPreview').innerHTML = `<img src="${r.dataUrl}" alt="Your meal photo">`;
    $('#aiRun').disabled = false;
  } catch (e) {
    $('#aiPreview').innerHTML = '<span class="muted small">No photo yet</span>';
    showAiError('That photo couldn’t be opened. Try taking it again, or choose a different one.');
  }
}
function showAiError(msg, withSettings) {
  const el = $('#aiErr'); if (!el) { toast(msg, 4000); return; }
  el.hidden = false; el.innerHTML = esc(msg) + (withSettings ? ' <a href="#" id="aiErrSettings">Open Settings</a>' : '');
}
async function runEstimate() {
  if (!aiState || !aiState.dataUrl) return;
  const btn = $('#aiRun'); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Asking the AI…';
  $('#aiErr').hidden = true;
  try {
    const out = await estimatePhoto(aiState.dataUrl, $('#aiHint').value.trim());
    if (!out.items.length) { showAiError(out.notes ? 'No food found: ' + out.notes : 'No food could be identified in that photo.'); return; }
    aiState.items = out.items; aiState.notes = out.notes; aiState.source = 'photo';
    renderAiReview();
  } catch (e) {
    const kind = e && e.kind;
    showAiError(aiErrorMessage(e), ['nokey', 'badkey', 'model', 'quota', 'perm'].includes(kind));
  } finally {
    const b = $('#aiRun'); if (b) { b.disabled = false; b.textContent = 'Estimate macros'; }
  }
}
function aiItemMacros(it) {
  const f = it.grams0 ? it.grams / it.grams0 : 0; const b = it.base;
  const m = { kcal: b.kcal * f, fat: b.fat * f, protein: b.protein * f, carbs: b.carbs * f, fibre: b.fibre * f };
  m.net = Math.max(0, m.carbs - m.fibre); return m;
}
function renderAiReview() {
  const meal = segValue('aiMeal') || addMeal;
  const voice = aiState.source === 'voice';
  sheetCtx = { ai: true, voice };
  openSheet(`
    <h2 id="sheetTitle">Check the estimate</h2>
    <div class="note warn"><b>${voice ? 'Voice' : 'Photo'} estimates can easily be off by 20% or more</b> – especially portion sizes and hidden oils or butter. Adjust the grams if you know better.</div>
    ${aiState.dataUrl ? `<img class="ai-thumb" src="${aiState.dataUrl}" alt="">` : ''}
    ${voice ? `<div class="you-said"><span class="field-label">You said</span>“${esc(aiState.transcript || '')}” <button id="vEditText" class="linkish" type="button">Edit</button></div>` : ''}
    ${aiState.notes ? `<div class="note small"><b>AI’s assumptions:</b> ${esc(aiState.notes)}</div>` : ''}
    <div id="aiItems"></div>
    <div id="aiTotals" class="preview"></div>
    <div class="field-label">Meal</div>
    ${mealSegHtml(meal, 'aiMeal')}
    <div class="sheet-actions">
      <button id="aiAdd" class="btn primary big" type="button">Add to log</button>
      <button id="aiRetake" class="btn outline big" type="button">${voice ? '🎤 Record again' : 'Try another photo'}</button>
      <button class="btn big" type="button" data-close>Cancel</button>
    </div>`);
  renderAiItems();
}
function renderAiItems() {
  const box = $('#aiItems'); if (!box) return;
  box.innerHTML = aiState.items.length ? aiState.items.map((it, i) => `
    <div class="ai-item" data-ai="${i}">
      <div class="ai-row">
        <input class="ai-name" type="text" value="${esc(it.name)}" aria-label="Food name" data-ainame="${i}">
        <button class="f-act" type="button" data-airemove="${i}" aria-label="Remove ${esc(it.name)}">✕</button>
      </div>
      <div class="ai-row">
        <label class="ai-grams"><input type="number" inputmode="decimal" min="0" step="any" value="${r1(it.grams)}" data-aigrams="${i}" aria-label="Grams"><span class="suffix">g</span></label>
        <div class="ai-mac" data-aimac="${i}"></div>
        <span class="conf conf-${it.confidence}">${it.confidence}</span>
      </div>
    </div>`).join('') : '<div class="empty muted small center" style="padding:14px">All items removed.</div>';
  updateAiTotals();
}
function updateAiTotals() {
  const t = { kcal: 0, fat: 0, protein: 0, net: 0, fibre: 0 };
  aiState.items.forEach((it, i) => {
    const m = aiItemMacros(it);
    const el = $(`[data-aimac="${i}"]`);
    if (el) el.textContent = `${fmtInt(m.kcal)} kcal · F ${r1(m.fat)} · P ${r1(m.protein)} · net C ${r1(m.net)}`;
    ['kcal', 'fat', 'protein', 'net', 'fibre'].forEach(k => { t[k] += m[k]; });
  });
  const tot = $('#aiTotals');
  if (tot) tot.innerHTML = `<div><b>${fmtInt(t.kcal)}</b><span>kcal</span></div><div><b>${r1(t.fat)}</b><span>fat g</span></div><div><b>${r1(t.protein)}</b><span>protein g</span></div><div class="net"><b>${r1(t.net)}</b><span>net carbs g</span></div><div><b>${r1(t.fibre)}</b><span>fibre g</span></div>`;
  const add = $('#aiAdd');
  if (add) { const n = aiState.items.filter(it => it.grams > 0).length; add.disabled = !n; add.textContent = n ? `Add ${n} item${n === 1 ? '' : 's'} to ${MEAL_LABEL[segValue('aiMeal') || addMeal]}` : 'Nothing to add'; }
}
function commitAi() {
  const meal = segValue('aiMeal') || addMeal;
  const items = aiState.items.filter(it => it.grams > 0);
  if (!items.length) return;
  const date = viewDate;
  const list = (db.log[date] = dayEntries(date));
  items.forEach(it => {
    const f = 100 / it.grams0; const b = it.base;
    list.push({
      id: uid(), meal, foodId: 'ai:' + uid(), name: it.name.trim() || 'Food', brand: aiState.source === 'voice' ? 'Voice estimate' : 'Photo estimate', barcode: '',
      per100: { kcal: b.kcal * f, fat: b.fat * f, protein: b.protein * f, carbs: b.carbs * f, fibre: b.fibre * f },
      grams: it.grams, netOnLabel: false, servingG: null, servingLabel: '', image: '', ts: Date.now(), src: aiState.source === 'voice' ? 'voice' : 'ai'
    });
  });
  addMeal = meal;
  save(); aiState = null; closeSheet();
  toast(`Added ${items.length} item${items.length === 1 ? '' : 's'} to ${MEAL_LABEL[meal]}`);
  showView('today');
}

/* ---------- settings ---------- */
function renderAiSettings() {
  const k = aiKey();
  $('#aiKeyStatus').innerHTML = k ? `Key saved on this phone: <b>${esc(maskKey(k))}</b>` : 'No key saved – AI photo and voice estimates are off.';
  $('#aiKeyInput').value = '';
  $('#aiKeyInput').placeholder = k ? 'Paste a new key to replace it' : 'xai-…';
  $('#aiClearKey').hidden = !k;
  $('#aiModelInput').value = db.settings.xaiModel || '';
  $('#aiModelInput').placeholder = AI_DEFAULT_MODEL;
}
function bindAi() {
  $('#photoBtn').addEventListener('click', openPhotoSheet);
  $('#aiFileCapture').addEventListener('change', e => { const f = e.target.files && e.target.files[0]; e.target.value = ''; handlePhotoFile(f); });
  $('#aiFileChoose').addEventListener('change', e => { const f = e.target.files && e.target.files[0]; e.target.value = ''; handlePhotoFile(f); });
  $('#sheet').addEventListener('click', e => {
    if (!sheetCtx || !sheetCtx.ai) return;
    if (e.target.closest('#aiTake')) $('#aiFileCapture').click();
    else if (e.target.closest('#aiChoose')) $('#aiFileChoose').click();
    else if (e.target.closest('#aiRun')) runEstimate();
    else if (e.target.closest('#aiAdd')) commitAi();
    else if (e.target.closest('#aiRetake')) { if (sheetCtx.voice) openVoiceSheet({ autostart: true }); else openPhotoSheet(); }
    else if (e.target.closest('#vEditText')) openVoiceSheet({ text: aiState.transcript || '' });
    else if (e.target.closest('#aiGoSettings') || e.target.closest('#aiErrSettings')) { e.preventDefault(); closeSheet(); showView('settings'); setTimeout(() => $('#aiCard').scrollIntoView({ block: 'start' }), 50); }
    else if (e.target.closest('[data-airemove]')) { aiState.items.splice(+e.target.closest('[data-airemove]').dataset.airemove, 1); renderAiItems(); }
    else if (e.target.closest('[data-segname="aiMeal"]')) setTimeout(updateAiTotals, 0);
  });
  $('#sheet').addEventListener('input', e => {
    if (!sheetCtx || !sheetCtx.ai || !aiState) return;
    const g = e.target.closest('[data-aigrams]'); if (g) { aiState.items[+g.dataset.aigrams].grams = num(g.value); updateAiTotals(); }
    const n = e.target.closest('[data-ainame]'); if (n) aiState.items[+n.dataset.ainame].name = n.value;
  });
  $('#aiSaveKey').addEventListener('click', () => {
    const v = $('#aiKeyInput').value.trim().replace(/\s+/g, '');
    if (!v) { toast('Paste your xAI API key first'); return; }
    if (/^sk-/.test(v)) { toast('That isn’t an xAI key. Keto Tracker only uses xAI (Grok) – create a key at console.x.ai (it starts with “xai-”).', 4500); return; }
    if (!/^xai-[A-Za-z0-9_\-]{16,}$/.test(v)) { toast('That doesn’t look like an xAI API key (it should start with “xai-”)', 3500); return; }
    try { localStorage.setItem(AI_KEY_STORE, v); } catch (e) { toast('Couldn’t save the key'); return; }
    renderAiSettings(); toast('xAI API key saved on this phone');
  });
  $('#aiClearKey').addEventListener('click', () => {
    if (!confirm('Remove your xAI API key from this phone?')) return;
    localStorage.removeItem(AI_KEY_STORE); renderAiSettings(); toast('API key removed');
  });
  $('#aiModelInput').addEventListener('change', e => {
    const v = e.target.value.trim();
    if (v && !/^grok/i.test(v)) { toast('Only Grok models work here (e.g. grok-4.3). Leave blank for the default.', 3500); e.target.value = db.settings.xaiModel || ''; return; }
    db.settings.xaiModel = v; save(); renderAiSettings();
  });
}
