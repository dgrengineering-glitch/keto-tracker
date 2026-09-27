/* Keto Tracker – "Estimate from photo" using the user's own OpenAI API key.
   The key lives only in this device's localStorage (separate from backups) and is sent only to api.openai.com. */
'use strict';

const AI_KEY_STORE = 'ketoTracker.openaiKey';
const AI_DEFAULT_MODEL = 'gpt-4o-mini';
const AI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
let aiState = null; // { dataUrl, items:[{name, grams0, grams, base:{kcal,fat,protein,carbs,fibre}, confidence}], notes }

function aiKey() { try { return localStorage.getItem(AI_KEY_STORE) || ''; } catch (e) { return ''; } }
function aiModel() { return (db.settings.aiModel || '').trim() || AI_DEFAULT_MODEL; }
function maskKey(k) { return k ? (k.slice(0, 3) + '…' + k.slice(-4)) : ''; }

const AI_SYSTEM_PROMPT = `You are a nutrition estimation assistant for a UK user following a ketogenic diet.
Identify each distinct food or drink visible in the photo. Estimate the edible portion weight in grams as served, and estimate its nutrition using typical UK values (UK food composition data and typical UK product labels).
Include likely hidden ingredients – cooking oil, butter, sauces, dressings, sugar in drinks – as separate items when reasonably likely, and state those assumptions in "notes".
Rules: total_carbs_g INCLUDES fibre; net_carbs_g = total_carbs_g - fibre_g. confidence is "high", "medium" or "low". All numbers are plain numbers (no units, no ranges). Use British English.
Reply with ONLY a JSON object (no markdown) in exactly this shape:
{"items":[{"name":string,"estimated_grams":number,"kcal":number,"fat_g":number,"protein_g":number,"total_carbs_g":number,"fibre_g":number,"net_carbs_g":number,"confidence":"high"|"medium"|"low"}],"totals":{"kcal":number,"fat_g":number,"protein_g":number,"total_carbs_g":number,"fibre_g":number,"net_carbs_g":number},"notes":string}
If there is no food in the image, return {"items":[],"totals":{"kcal":0,"fat_g":0,"protein_g":0,"total_carbs_g":0,"fibre_g":0,"net_carbs_g":0},"notes":"<why>"}.`;

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
// Shared OpenAI request: maps failures to AiError kinds. `init.body` may be JSON (object) or FormData.
async function openaiRequest(url, bodyObj, timeoutMs = 60000) {
  const key = aiKey();
  if (!key) throw new AiError('nokey', 'No API key');
  const isForm = typeof FormData !== 'undefined' && bodyObj instanceof FormData;
  const headers = { Authorization: 'Bearer ' + key };
  if (!isForm) headers['Content-Type'] = 'application/json';
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { method: 'POST', signal: ctrl.signal, headers, body: isForm ? bodyObj : JSON.stringify(bodyObj) });
  } catch (e) {
    clearTimeout(timer);
    throw new AiError('network', e && e.name === 'AbortError' ? 'timeout' : 'network');
  }
  clearTimeout(timer);
  let payload = null; try { payload = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok) {
    const err = (payload && payload.error) || {};
    const code = String(err.code || err.type || '');
    const msg = String(err.message || '');
    if (res.status === 401) throw new AiError('badkey', 'unauthorised');
    if (res.status === 429) throw new AiError(/quota|billing/i.test(code + ' ' + msg) ? 'quota' : 'rate', code);
    if (res.status === 404 || /model/i.test(code) || ((res.status === 400 || res.status === 403) && /model/i.test(msg))) throw new AiError('model', code);
    throw new AiError('http', 'HTTP ' + res.status);
  }
  if (!payload) throw new AiError('format', 'not json');
  return payload;
}
async function chatJSON(messages) {
  const model = aiModel();
  const body = { model, response_format: { type: 'json_object' }, max_completion_tokens: 1500, messages };
  if (/^gpt-4/i.test(model)) body.temperature = 0.2;
  const payload = await openaiRequest(AI_ENDPOINT, body);
  const content = payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content;
  if (!content) throw new AiError('format', 'empty');
  return parseAiJson(content);
}
async function callOpenAI(dataUrl, hint) {
  return chatJSON([
    { role: 'system', content: AI_SYSTEM_PROMPT },
    { role: 'user', content: [
      { type: 'text', text: 'Estimate the nutrition for this meal.' + (hint ? ` Extra information from the user: ${hint}` : '') },
      { type: 'image_url', image_url: { url: dataUrl, detail: 'auto' } }
    ] }
  ]);
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
    case 'nokey': return 'Add your OpenAI API key in Settings first.';
    case 'badkey': return 'OpenAI rejected your API key – it may be mistyped, revoked or expired. Check it in Settings.';
    case 'quota': return 'Your OpenAI account has no credit left. Add credit at platform.openai.com › Billing, then try again.';
    case 'rate': return 'OpenAI is busy or you’ve hit a rate limit – wait a few seconds and try again.';
    case 'model': return `The model “${aiModel()}” isn’t available on your OpenAI account. Check the model name in Settings (default: ${AI_DEFAULT_MODEL}).`;
    case 'network': return e.message === 'timeout' ? 'OpenAI took too long to reply – check your connection and try again.' : 'Couldn’t reach OpenAI – check your internet connection and try again.';
    case 'format': return 'The AI reply couldn’t be read. Try again, or add a hint describing the meal.';
    default: return 'Something went wrong asking OpenAI – please try again.';
  }
}

/* ---------- UI ---------- */
function noKeyHtml() {
  return `<div class="note warn"><b>One-off setup needed:</b> photo estimates use your own OpenAI account.</div>
    <ol class="steps">
      <li>On any browser, go to <b>platform.openai.com</b> and sign in (or create an account).</li>
      <li>Add a little credit under <b>Settings › Billing</b> (each photo typically costs well under 1p with ${AI_DEFAULT_MODEL}, but you pay OpenAI directly per use).</li>
      <li>Open <b>API keys</b>, tap <b>Create new secret key</b> and copy it (it starts with <code>sk-</code>).</li>
      <li>In Keto Tracker go to <b>Settings › Photo estimates (AI)</b>, paste the key and tap <b>Save key</b>.</li>
    </ol>
    <p class="muted small">The key stays on this phone only (it isn’t included in backups) and is sent only to OpenAI.</p>
    <div class="sheet-actions"><button id="aiGoSettings" class="btn primary big" type="button">Go to Settings</button><button class="btn big" type="button" data-close>Close</button></div>`;
}
function openPhotoSheet() {
  stopScan();
  sheetCtx = { ai: true };
  aiState = { dataUrl: null, items: [], notes: '' };
  if (!aiKey()) { openSheet(`<h2 id="sheetTitle">Estimate from photo</h2>${noKeyHtml()}`); return; }
  openSheet(`
    <h2 id="sheetTitle">Estimate from photo</h2>
    <p class="muted small">Take a photo of your plate from above, with everything visible. The AI (${esc(aiModel())}) estimates each item’s weight and macros for you to check.</p>
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
    const out = await callOpenAI(aiState.dataUrl, $('#aiHint').value.trim());
    if (!out.items.length) { showAiError(out.notes ? 'No food found: ' + out.notes : 'No food could be identified in that photo.'); return; }
    aiState.items = out.items; aiState.notes = out.notes; aiState.source = 'photo';
    renderAiReview();
  } catch (e) {
    const kind = e && e.kind;
    showAiError(aiErrorMessage(e), ['nokey', 'badkey', 'model', 'quota'].includes(kind));
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
  $('#aiKeyStatus').innerHTML = k ? `Key saved on this phone: <b>${esc(maskKey(k))}</b>` : 'No key saved – photo estimates are off.';
  $('#aiKeyInput').value = '';
  $('#aiKeyInput').placeholder = k ? 'Paste a new key to replace it' : 'sk-…';
  $('#aiClearKey').hidden = !k;
  $('#aiModelInput').value = db.settings.aiModel || '';
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
    const v = $('#aiKeyInput').value.trim();
    if (!v) { toast('Paste your API key first'); return; }
    if (!/^sk-[A-Za-z0-9_\-]{10,}$/.test(v)) { toast('That doesn’t look like an OpenAI key (it should start with “sk-”)', 3500); return; }
    try { localStorage.setItem(AI_KEY_STORE, v); } catch (e) { toast('Couldn’t save the key'); return; }
    renderAiSettings(); toast('API key saved on this phone');
  });
  $('#aiClearKey').addEventListener('click', () => {
    if (!confirm('Remove your OpenAI API key from this phone?')) return;
    localStorage.removeItem(AI_KEY_STORE); renderAiSettings(); toast('API key removed');
  });
  $('#aiModelInput').addEventListener('change', e => { db.settings.aiModel = e.target.value.trim(); save(); renderAiSettings(); });
}
