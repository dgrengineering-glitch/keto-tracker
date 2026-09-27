/* Keto Tracker – offline-first keto macro tracker. Data lives in localStorage. */
'use strict';

const APP_VERSION = '1.4.0';
const STORE_KEY = 'ketoTracker.v1';
const MEALS = ['breakfast', 'lunch', 'dinner', 'snacks'];
const MEAL_LABEL = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snacks: 'Snacks' };
const DEFAULT_SETTINGS = {
  kcalTarget: 1800,
  pct: { fat: 70, protein: 25, carbs: 5 }
};
const DEFAULT_BODY = { sex: 'male', age: '', heightCm: '', activity: '1.375', heightUnit: 'cm', weightUnit: 'kg', weighIns: [] };
const DEFAULT_GOAL = { type: 'lose', by: 'weight', targetWeight: '', targetBf: '', targetDate: '', rate: 0.7, surplus: 0.075, active: true };
const OFF_HOSTS = ['https://uk.openfoodfacts.org', 'https://world.openfoodfacts.org'];
const OFF_FIELDS = 'code,product_name,product_name_en,generic_name,brands,nutriments,serving_size,serving_quantity,countries_tags,image_front_small_url';

/* ---------- helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isFinite(n) ? n : 0; };
const numOrNull = (v) => { if (v === '' || v == null) return null; const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : null; };
const r0 = (n) => Math.round(n);
const r1 = (n) => { const x = Math.round(n * 10) / 10; return Number.isInteger(x) ? String(x) : x.toFixed(1); };
const fmtInt = (n) => r0(n).toLocaleString('en-GB');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

function keyOf(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function todayKey() { return keyOf(new Date()); }
function parseKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(k, n) { const d = parseKey(k); d.setDate(d.getDate() + n); return keyOf(d); }
function niceDay(k) {
  const t = todayKey();
  if (k === t) return 'Today';
  if (k === addDays(t, -1)) return 'Yesterday';
  return parseKey(k).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
}
function longDate(k) { return parseKey(k).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }
function shortDate(k) { return parseKey(k).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }); }
function defaultMeal() {
  const h = new Date().getHours();
  if (h < 11) return 'breakfast';
  if (h < 15) return 'lunch';
  if (h >= 17 && h < 22) return 'dinner';
  return 'snacks';
}

/* ---------- storage ---------- */
function normalise(d) {
  d = d && typeof d === 'object' ? d : {};
  const s = d.settings && typeof d.settings === 'object' ? d.settings : {};
  const body = { ...DEFAULT_BODY, ...(d.body && typeof d.body === 'object' ? d.body : {}) };
  if (!Array.isArray(body.weighIns)) body.weighIns = [];
  const { calc, ...settingsRest } = s; // legacy calculator fields
  return {
    version: 2,
    settings: { ...DEFAULT_SETTINGS, ...settingsRest, pct: { ...DEFAULT_SETTINGS.pct, ...(s.pct || {}) } },
    body,
    goal: { ...DEFAULT_GOAL, ...(d.goal && typeof d.goal === 'object' ? d.goal : {}) },
    dayKcal: d.dayKcal && typeof d.dayKcal === 'object' ? d.dayKcal : {},
    foods: d.foods && typeof d.foods === 'object' ? d.foods : {},
    log: d.log && typeof d.log === 'object' ? d.log : {},
    lastBackup: d.lastBackup || null,
    ui: d.ui && typeof d.ui === 'object' ? d.ui : {}
  };
}
function load() {
  try { const raw = localStorage.getItem(STORE_KEY); if (raw) return normalise(JSON.parse(raw)); }
  catch (e) { console.warn('Could not read saved data', e); }
  return normalise({});
}
function save() {
  if (typeof planCache !== 'undefined') planCache = null;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); }
  catch (e) { toast('Could not save – storage may be full'); }
}

let db = load();
let viewDate = todayKey();
let addMeal = defaultMeal();
let foodTab = 'recent';
let historyRange = 7;
let scanner = null;
let scanning = false;
let sheetCtx = null;

/* ---------- maths ---------- */
function netCarbs(carbs, fibre, netOnLabel) { return netOnLabel ? carbs : Math.max(0, carbs - fibre); }
function scale(per100, grams, netOnLabel) {
  const f = (grams || 0) / 100;
  const m = { kcal: num(per100.kcal) * f, fat: num(per100.fat) * f, protein: num(per100.protein) * f, carbs: num(per100.carbs) * f, fibre: num(per100.fibre) * f };
  m.net = netCarbs(m.carbs, m.fibre, netOnLabel);
  return m;
}
// Calorie target in force for a date: plan (if active) or manual. Past days use the target snapshotted on that day.
function effectiveKcal(k) {
  k = k || todayKey();
  if (k < todayKey() && db.dayKcal[k]) return db.dayKcal[k];
  const p = typeof planKcalFor === 'function' ? planKcalFor(k) : null;
  return p || num(db.settings.kcalTarget);
}
function kcalSource() {
  const p = typeof planKcalFor === 'function' ? planKcalFor(todayKey()) : null;
  return p ? 'plan' : 'manual';
}
function targets(day) {
  const s = db.settings; const k = effectiveKcal(day);
  return { kcal: k, fat: k * num(s.pct.fat) / 100 / 9, protein: k * num(s.pct.protein) / 100 / 4, net: k * num(s.pct.carbs) / 100 / 4 };
}
function dayEntries(k) { return Array.isArray(db.log[k]) ? db.log[k] : []; }
function dayTotals(k) {
  const t = { kcal: 0, fat: 0, protein: 0, carbs: 0, fibre: 0, net: 0, count: 0 };
  dayEntries(k).forEach(e => {
    const m = scale(e.per100 || {}, e.grams, e.netOnLabel !== false);
    ['kcal', 'fat', 'protein', 'carbs', 'fibre', 'net'].forEach(x => { t[x] += m[x]; });
    t.count++;
  });
  return t;
}
function pctOfKcal(t) {
  const macroKcal = t.fat * 9 + t.protein * 4 + t.net * 4;
  const denom = t.kcal > 0 ? t.kcal : macroKcal;
  if (!denom) return { fat: 0, protein: 0, carbs: 0 };
  return { fat: t.fat * 9 / denom * 100, protein: t.protein * 4 / denom * 100, carbs: t.net * 4 / denom * 100 };
}
function carbLevel(net, limit) {
  if (!limit) return 'ok';
  const r = net / limit;
  if (r > 1.0001) return 'over';
  if (r >= 0.8) return 'warn';
  return 'ok';
}

/* ---------- UI primitives ---------- */
let toastTimer;
function toast(msg, ms = 2600) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
function ring(frac, colour, size, stroke, centre) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const f = clamp(frac || 0, 0, 1);
  return `<div class="ring" style="width:${size}px;height:${size}px">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
      <circle class="track" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}"/>
      <circle class="prog" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${colour}" stroke-width="${stroke}"
        stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - f)}" ${f === 0 ? 'stroke-opacity="0"' : ''}/>
    </svg><div class="ring-center">${centre}</div></div>`;
}
function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
function splitBar(fat, protein, carbs, carbCls, showText = true) {
  const tot = fat + protein + carbs;
  const k = tot > 100 ? 100 / tot : 1;
  const seg = (v, cls) => `<span class="${cls}" style="width:${v * k}%">${showText && v * k >= 9 ? r0(v) + '%' : ''}</span>`;
  return `<div class="split">${seg(fat, 'seg-fat')}${seg(protein, 'seg-protein')}${seg(carbs, 'seg-carbs ' + (carbCls || ''))}</div>`;
}

/* ---------- navigation ---------- */
const TITLES = { today: 'Today', add: 'Add food', history: 'History', body: 'Body & Goals', settings: 'Settings' };
function showView(name) {
  if (name !== 'add') stopScan();
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
  $('#viewTitle').textContent = TITLES[name];
  if (name === 'today') renderToday();
  if (name === 'add') renderAdd();
  if (name === 'history') renderHistory();
  if (name === 'body') renderBody();
  if (name === 'settings') renderSettings();
  window.scrollTo(0, 0);
}

/* ---------- TODAY ---------- */
function renderToday() {
  const tk = todayKey();
  const isToday = viewDate === tk;
  $('#dateLabel').textContent = niceDay(viewDate);
  $('#dateSub').textContent = longDate(viewDate);
  $('#nextDay').disabled = viewDate >= tk;
  $('#todayBtn').hidden = isToday;

  if (isToday && db.dayKcal[tk] !== effectiveKcal(tk)) { db.dayKcal[tk] = effectiveKcal(tk); save(); }
  const t = dayTotals(viewDate), g = targets(viewDate), p = pctOfKcal(t), s = db.settings;
  const lvl = carbLevel(t.net, g.net);

  // status
  const st = $('#statusCard');
  let cls = 'ok', ico = '✅', msg = '', sub = '';
  const netLeft = g.net - t.net, kcalLeft = g.kcal - t.kcal;
  if (!t.count) {
    cls = 'neutral'; ico = '🥑';
    msg = isToday ? 'Nothing logged yet today' : 'Nothing logged on this day';
    sub = isToday ? `Scan or add your first food. Net carb limit: ${r0(g.net)} g.` : 'Tap “+ Add” on a meal to back-fill it.';
  } else if (lvl === 'over') {
    cls = 'over'; ico = '⛔';
    msg = `Over your net carb limit by ${r1(-netLeft)} g`;
    sub = isToday ? 'Keep the rest of today carb-free to stay in ketosis.' : `${r1(t.net)} g net carbs vs a ${r0(g.net)} g limit.`;
  } else if (lvl === 'warn') {
    cls = 'warn'; ico = '⚠️';
    msg = isToday ? `Close to your carb limit – ${r1(netLeft)} g net carbs left` : `Under the carb limit, but close (${r1(t.net)} g)`;
    sub = kcalLeft >= 0 ? `${fmtInt(kcalLeft)} kcal left.` : `${fmtInt(-kcalLeft)} kcal over target.`;
  } else if (kcalLeft < -g.kcal * 0.1) {
    cls = 'warn'; ico = '🙂';
    msg = 'Carbs on track, calories over target';
    sub = `${fmtInt(-kcalLeft)} kcal over · ${r1(netLeft)} g net carbs left.`;
  } else {
    cls = 'ok'; ico = '✅';
    msg = isToday ? 'On track!' : 'Keto day – stayed under the carb limit';
    sub = isToday ? `${r1(netLeft)} g net carbs and ${fmtInt(Math.max(0, kcalLeft))} kcal left.`
      : `${r1(t.net)} g net carbs · ${fmtInt(t.kcal)} kcal.`;
    if (isToday && t.protein < g.protein * 0.5 && new Date().getHours() >= 17) sub += ' Protein is a bit low today.';
  }
  st.className = 'card status ' + cls;
  st.innerHTML = `<span class="status-ico" aria-hidden="true">${ico}</span><div>${esc(msg)}<span class="status-sub">${esc(sub)}</span></div>`;

  // hero
  const kcalOver = t.kcal > g.kcal;
  $('#kcalRing').innerHTML = ring(g.kcal ? t.kcal / g.kcal : 0, kcalOver ? css('--red') : css('--kcal'), 132, 13,
    `<span class="big">${fmtInt(t.kcal)}</span><span class="lbl">of ${fmtInt(g.kcal)} kcal</span>`);
  $('#kcalEaten').textContent = fmtInt(t.kcal);
  $('#kcalTarget').innerHTML = fmtInt(g.kcal) + (isToday && kcalSource() === 'plan' ? '<span class="target-src">from goal plan</span>' : '');
  $('#kcalLeftLabel').textContent = kcalOver ? 'Over by' : 'Remaining';
  $('#kcalLeft').textContent = fmtInt(Math.abs(kcalLeft));
  $('#kcalLeft').classList.toggle('over', kcalOver);
  $('#fibreEaten').textContent = r1(t.fibre) + ' g';

  // macro cards
  const macro = (key, label, colourVar, eaten, target, actPct, tgtPct, level) => {
    const left = target - eaten;
    const colour = level === 'over' ? css('--red') : level === 'warn' ? css('--amber') : css(colourVar);
    return `<div class="macro ${level || ''}" data-macro="${key}">
      <h3>${label}</h3>
      ${ring(target ? eaten / target : 0, colour, 78, 9, `<span class="med">${target ? r0(eaten / target * 100) : 0}%</span>`)}
      <div class="grams">${r1(eaten)} / ${r0(target)} g</div>
      <div class="left">${left >= 0 ? r1(left) + ' g left' : r1(-left) + ' g over'}</div>
      <div class="pctline"><b>${r0(actPct)}%</b> of kcal<br>target ${r0(tgtPct)}%</div>
    </div>`;
  };
  $('#macroGrid').innerHTML =
    macro('fat', 'Fat', '--fat', t.fat, g.fat, p.fat, s.pct.fat, '') +
    macro('protein', 'Protein', '--protein', t.protein, g.protein, p.protein, s.pct.protein, '') +
    macro('carbs', 'Net carbs', '--carbs', t.net, g.net, p.carbs, s.pct.carbs, lvl === 'ok' ? '' : lvl);

  // split bars
  $('#splitBars').innerHTML = `
    <div class="split-row"><span class="lbl">Actual</span>${t.count ? splitBar(p.fat, p.protein, p.carbs, lvl === 'ok' ? '' : lvl) : '<div class="split"></div>'}</div>
    <div class="split-row"><span class="lbl">Target</span>${splitBar(num(s.pct.fat), num(s.pct.protein), num(s.pct.carbs), '')}</div>
    <div class="legend">
      <span><i class="dot fat"></i>Fat <b>${r0(p.fat)}%</b> / ${r0(s.pct.fat)}%</span>
      <span><i class="dot protein"></i>Protein <b>${r0(p.protein)}%</b> / ${r0(s.pct.protein)}%</span>
      <span><i class="dot carbs"></i>Net carbs <b>${r0(p.carbs)}%</b> / ${r0(s.pct.carbs)}%</span>
    </div>`;

  // meals
  const entries = dayEntries(viewDate);
  $('#meals').innerHTML = MEALS.map(m => {
    const list = entries.filter(e => e.meal === m);
    let mk = 0, mn = 0;
    const rows = list.map(e => {
      const x = scale(e.per100 || {}, e.grams, e.netOnLabel !== false); mk += x.kcal; mn += x.net;
      return `<button class="entry" type="button" data-entry="${esc(e.id)}">
        <div class="e-main"><div class="e-name">${esc(e.name)}</div><div class="e-sub">${esc(e.brand ? e.brand + ' · ' : '')}${r1(e.grams)} g</div></div>
        <div class="e-right"><div class="e-kcal">${fmtInt(x.kcal)} kcal</div><div class="e-net">${r1(x.net)} g net C</div></div>
      </button>`;
    }).join('');
    return `<div class="card meal" style="padding:0">
      <div class="meal-head"><div><h2>${MEAL_LABEL[m]}</h2><div class="meal-sum">${list.length ? `${fmtInt(mk)} kcal · ${r1(mn)} g net carbs` : ''}</div></div>
      <button class="meal-add" type="button" data-addmeal="${m}" aria-label="Add to ${MEAL_LABEL[m]}">+ Add</button></div>
      ${rows || `<div class="empty-meal">No food logged</div>`}
    </div>`;
  }).join('');

  renderHints();
}

function renderHints() {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  $('#installHint').hidden = !(isIOS && !standalone && !db.ui.installDismissed);
  const daysLogged = Object.keys(db.log).filter(k => dayEntries(k).length).length;
  const stale = !db.lastBackup || (Date.now() - db.lastBackup) > 7 * 864e5;
  $('#backupHint').hidden = !(daysLogged >= 3 && stale && viewDate === todayKey());
}

/* ---------- ADD FOOD ---------- */
function renderAdd() {
  $('#mealSeg').innerHTML = MEALS.map(m => `<button type="button" data-meal="${m}" class="${m === addMeal ? 'active' : ''}">${MEAL_LABEL[m]}</button>`).join('');
  $('#addDateNote').textContent = viewDate === todayKey() ? 'Logging to today.' : `Logging to ${longDate(viewDate)}.`;
  renderFoodList();
}

function foodSummary(f) {
  const p = f.per100 || {};
  const net = netCarbs(num(p.carbs), num(p.fibre), f.netOnLabel !== false);
  return `${r0(num(p.kcal))} kcal · ${r1(net)} g net C per 100 g`;
}
function renderFoodList() {
  $$('#foodTabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === foodTab));
  const search = $('#foodSearch');
  search.hidden = foodTab !== 'mine';
  const foods = Object.values(db.foods);
  let list, empty;
  if (foodTab === 'recent') {
    list = foods.filter(f => f.lastUsed).sort((a, b) => b.lastUsed - a.lastUsed).slice(0, 12);
    empty = 'Foods you log will appear here for one-tap re-adding.';
  } else if (foodTab === 'frequent') {
    list = foods.filter(f => (f.uses || 0) >= 1).sort((a, b) => (b.uses || 0) - (a.uses || 0) || (b.lastUsed || 0) - (a.lastUsed || 0)).slice(0, 12);
    empty = 'Your most-logged foods will appear here.';
  } else {
    const q = search.value.trim().toLowerCase();
    list = foods.filter(f => f.saved).filter(f => !q || (f.name + ' ' + (f.brand || '') + ' ' + (f.barcode || '')).toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, 'en-GB'));
    empty = q ? 'No matching foods.' : 'Foods you save (manual entries or scanned products) appear here.';
  }
  $('#foodList').innerHTML = list.length ? list.map(f => `
    <div class="food">
      <button class="food-main" type="button" data-food="${esc(f.id)}">
        <div class="f-name">${esc(f.name)}</div>
        <div class="f-sub">${esc(f.brand ? f.brand + ' · ' : '')}${foodSummary(f)}${foodTab === 'frequent' ? ` · logged ${f.uses}×` : ''}</div>
      </button>
      ${foodTab === 'mine' ? `<button class="f-act" type="button" data-editfood="${esc(f.id)}" aria-label="Edit ${esc(f.name)}">✎</button>
      <button class="f-act" type="button" data-delfood="${esc(f.id)}" aria-label="Remove ${esc(f.name)}">🗑</button>` : ''}
    </div>`).join('') : `<div class="empty">${empty}</div>`;
}

/* ---------- barcode scanning ---------- */
function lib() { return window.__Html5QrcodeLibrary__ || null; }
async function startScan() {
  const L = lib();
  if (!L) { toast('Scanner could not load – type the barcode instead'); return; }
  if (!window.isSecureContext) { toast('The camera needs a secure (https) connection'); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('Camera not available in this browser – type the barcode instead'); return; }
  const F = L.Html5QrcodeSupportedFormats;
  $('#reader').hidden = false; $('#scanStatus').hidden = false;
  $('#scanBtn').hidden = true; $('#stopScanBtn').hidden = false;
  try {
    if (!scanner) {
      scanner = new L.Html5Qrcode('reader', {
        formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E],
        verbose: false,
        experimentalFeatures: { useBarCodeDetectorIfSupported: true }
      });
    }
    await scanner.start(
      { facingMode: 'environment' },
      { fps: 12, qrbox: (w, h) => ({ width: Math.max(60, Math.floor(Math.min(w * 0.88, 340))), height: Math.max(60, Math.floor(Math.min(h * 0.45, 170))) }) },
      onScanSuccess,
      () => { /* per-frame "not found" – ignore */ }
    );
    scanning = true;
  } catch (err) {
    scanning = false;
    resetScanUI();
    const m = String((err && (err.name || err.message)) || err);
    if (/NotAllowed|Permission/i.test(m)) toast('Camera permission was denied. Allow it in Settings › Safari › Camera, or type the barcode.', 4500);
    else toast('Could not start the camera – type the barcode instead.', 3500);
    console.info('Camera start failed:', m);
  }
}
function resetScanUI() {
  $('#reader').hidden = true; $('#scanStatus').hidden = true;
  $('#scanBtn').hidden = false; $('#stopScanBtn').hidden = true;
}
async function stopScan() {
  if (scanner && scanning) {
    scanning = false;
    try { await scanner.stop(); } catch (e) { /* already stopped */ }
  }
  resetScanUI();
}
let lastScan = { code: '', at: 0 };
function onScanSuccess(text) {
  const code = String(text || '').replace(/\D/g, '');
  if (code.length < 8) return;
  if (code === lastScan.code && Date.now() - lastScan.at < 3000) return;
  lastScan = { code, at: Date.now() };
  if (navigator.vibrate) navigator.vibrate(60);
  stopScan();
  $('#barcodeInput').value = code;
  lookupBarcode(code);
}

/* ---------- Open Food Facts ---------- */
function upceToUpca(upce) {
  // expects 8 digits: number system, 6 data, check digit
  if (!/^[01]\d{7}$/.test(upce)) return null;
  const ns = upce[0], d = upce.slice(1, 7), chk = upce[7];
  let body;
  const last = d[5];
  if ('012'.includes(last)) body = d.slice(0, 2) + last + '0000' + d.slice(2, 5);
  else if (last === '3') body = d.slice(0, 3) + '00000' + d.slice(3, 5);
  else if (last === '4') body = d.slice(0, 4) + '00000' + d[4];
  else body = d.slice(0, 5) + '0000' + last;
  return ns + body + chk;
}
function barcodeCandidates(code) {
  const c = [code];
  if (code.length === 12) c.push('0' + code);
  if (code.length === 13 && code[0] === '0') c.push(code.slice(1));
  if (code.length === 8) { const a = upceToUpca(code); if (a) c.push(a, '0' + a); }
  return [...new Set(c)];
}
async function fetchOFF(code) {
  let lastErr = null;
  for (const host of OFF_HOSTS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(`${host}/api/v2/product/${encodeURIComponent(code)}.json?fields=${OFF_FIELDS}&lc=en`, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      clearTimeout(timer);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      return j && j.status === 1 && j.product ? j.product : null;
    } catch (e) { clearTimeout(timer); lastErr = e; }
  }
  throw lastErr || new Error('Network error');
}
function looksUSLabelled(p, code) {
  const c = (p.countries_tags || []).map(String);
  const us = x => /united-states|canada|puerto-rico/.test(x);
  if (c.length) return c.some(us) && !c.some(x => !us(x) && !/mexico/.test(x));
  const ean = code.length === 12 ? '0' + code : code;
  return /^(0[0-9]|1[0-3])/.test(ean) && ean.length === 13;
}
function foodFromOFF(p, code) {
  const n = p.nutriments || {};
  let kcal = numOrNull(n['energy-kcal_100g']);
  if (kcal == null) { const kj = numOrNull(n['energy-kj_100g']) ?? numOrNull(n['energy_100g']); if (kj != null) kcal = kj / 4.184; }
  const has = ['fat_100g', 'carbohydrates_100g', 'proteins_100g'].some(k => numOrNull(n[k]) != null) || kcal != null;
  const name = (p.product_name_en || p.product_name || p.generic_name || '').trim() || `Product ${code}`;
  const brand = String(p.brands || '').split(',')[0].trim();
  const existing = Object.values(db.foods).find(f => f.barcode === code);
  return {
    id: existing ? existing.id : 'off:' + code,
    barcode: code, name, brand, source: 'off',
    per100: { kcal: kcal || 0, fat: num(n.fat_100g), protein: num(n.proteins_100g), carbs: num(n.carbohydrates_100g), fibre: num(n.fiber_100g) },
    servingG: num(p.serving_quantity) > 0 ? num(p.serving_quantity) : null,
    servingLabel: p.serving_size || '',
    netOnLabel: !looksUSLabelled(p, code),
    image: p.image_front_small_url || '',
    hasNutrition: has,
    saved: existing ? !!existing.saved : false,
    uses: existing ? existing.uses : 0, lastUsed: existing ? existing.lastUsed : 0, lastGrams: existing ? existing.lastGrams : null
  };
}
let lookupBusy = false;
async function lookupBarcode(raw) {
  const code = String(raw || '').replace(/\D/g, '');
  if (code.length < 8 || code.length > 14) { toast('That doesn’t look like a barcode (8–14 digits)'); return; }
  const local = Object.values(db.foods).find(f => f.barcode && barcodeCandidates(code).includes(f.barcode));
  if (local) { openPortionSheet({ mode: 'add', food: local, note: 'From your saved foods.' }); return; }
  if (lookupBusy) return;
  lookupBusy = true; $('#lookupSpinner').hidden = false;
  let product = null, netErr = false, usedCode = code;
  try {
    for (const c of barcodeCandidates(code)) {
      product = await fetchOFF(c);
      if (product) { usedCode = c; break; }
    }
  } catch (e) { netErr = true; console.info('Lookup failed', e); }
  lookupBusy = false; $('#lookupSpinner').hidden = true;
  if (product) {
    const food = foodFromOFF(product, usedCode === code ? code : usedCode);
    if (!food.hasNutrition) {
      openManualSheet({ barcode: code, name: food.name, brand: food.brand },
        `Found “${food.name}” on Open Food Facts, but it has no nutrition data. Enter the values from the label – it’ll be saved for next time.`);
      return;
    }
    openPortionSheet({ mode: 'add', food });
  } else if (netErr) {
    openManualSheet({ barcode: code }, 'Couldn’t reach Open Food Facts (are you offline?). You can enter this food manually from the label.');
  } else {
    openManualSheet({ barcode: code }, `Barcode ${code} isn’t on Open Food Facts yet. Enter the details from the label – it’ll be saved to My foods so the next scan finds it.`);
  }
}

/* ---------- sheets ---------- */
function openSheet(html) {
  $('#sheetBody').innerHTML = html;
  $('#sheet').hidden = false; $('#sheetBackdrop').hidden = false;
  $('#sheet').scrollTop = 0;
  document.body.style.overflow = 'hidden';
}
function closeSheet() {
  $('#sheet').hidden = true; $('#sheetBackdrop').hidden = true;
  $('#sheetBody').innerHTML = ''; sheetCtx = null;
  document.body.style.overflow = '';
}
function mealSegHtml(sel, name) {
  return `<div class="seg seg-4" data-segname="${name}">${MEALS.map(m => `<button type="button" data-val="${m}" class="${m === sel ? 'active' : ''}">${MEAL_LABEL[m]}</button>`).join('')}</div>`;
}
function segValue(name) { const b = $(`[data-segname="${name}"] button.active`); return b ? b.dataset.val : null; }
function findEntry(date, id) { return dayEntries(date).find(e => e.id === id); }

function openPortionSheet(ctx) {
  stopScan();
  let food, grams, netOnLabel, meal;
  if (ctx.mode === 'edit') {
    const e = findEntry(ctx.date, ctx.entryId);
    if (!e) return;
    food = { id: e.foodId, name: e.name, brand: e.brand, barcode: e.barcode, per100: e.per100, servingG: e.servingG, servingLabel: e.servingLabel, image: e.image };
    grams = e.grams; netOnLabel = e.netOnLabel !== false; meal = e.meal;
  } else {
    food = ctx.food;
    grams = food.lastGrams || food.servingG || 100;
    netOnLabel = food.netOnLabel !== false;
    meal = ctx.meal || addMeal;
  }
  sheetCtx = { ...ctx, food };
  const p = food.per100 || {};
  const sv = food.servingG;
  const isSaved = db.foods[food.id] && db.foods[food.id].saved;
  openSheet(`
    <div class="s-head">
      ${food.image ? `<img src="${esc(food.image)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
      <div><h2 id="sheetTitle">${esc(food.name)}</h2>${food.brand ? `<div class="s-brand">${esc(food.brand)}</div>` : ''}</div>
    </div>
    ${ctx.note ? `<div class="muted small">${esc(ctx.note)}</div>` : ''}
    <div class="per100">Per 100 g: <b>${r0(num(p.kcal))} kcal</b> · fat ${r1(num(p.fat))} g · protein ${r1(num(p.protein))} g · carbs ${r1(num(p.carbs))} g · fibre ${r1(num(p.fibre))} g${food.barcode ? `<br>Barcode ${esc(food.barcode)}` : ''}</div>
    <div class="${sv ? 'two' : ''}">
      <label class="field"><span class="field-label">Portion (grams)</span>
        <input id="sGrams" type="number" inputmode="decimal" min="0" step="any" value="${r1(grams)}"></label>
      ${sv ? `<label class="field"><span class="field-label">Servings (1 = ${r1(sv)} g)</span>
        <input id="sServ" type="number" inputmode="decimal" min="0" step="any" value="${r1(grams / sv)}"></label>` : ''}
    </div>
    <div class="chips">
      ${sv ? `<button class="chip" type="button" data-g="${sv}">1 serving${food.servingLabel ? ' (' + esc(food.servingLabel) + ')' : ''}</button>` : ''}
      ${[10, 25, 50, 100, 150, 200].map(g => `<button class="chip" type="button" data-g="${g}">${g} g</button>`).join('')}
    </div>
    <label class="check"><input id="sNet" type="checkbox" ${netOnLabel ? 'checked' : ''}>
      <span>Carbs on label already exclude fibre (UK/EU)<span class="sub">Leave on for UK/EU packs. Turn off for US-style labels (“Total Carbohydrate”) so fibre is subtracted.</span></span></label>
    <div id="sPreview" class="preview"></div>
    <div class="field-label">Meal</div>
    ${mealSegHtml(meal, 'sMeal')}
    ${ctx.mode === 'add' && !isSaved ? `<label class="check mt8"><input id="sSave" type="checkbox"><span>Save to My foods</span></label>` : ''}
    <div class="sheet-actions">
      <button id="sCommit" class="btn primary big" type="button">${ctx.mode === 'edit' ? 'Save changes' : 'Add to log'}</button>
      ${ctx.mode === 'edit' ? `<button id="sDelete" class="btn danger-outline big" type="button">Delete entry</button>` : ''}
      <button class="btn big" type="button" data-close>Cancel</button>
    </div>`);
  updatePortionPreview();
}
function updatePortionPreview() {
  if (!sheetCtx || !$('#sPreview')) return;
  const grams = num($('#sGrams').value);
  const m = scale(sheetCtx.food.per100 || {}, grams, $('#sNet').checked);
  $('#sPreview').innerHTML = `
    <div><b>${fmtInt(m.kcal)}</b><span>kcal</span></div>
    <div><b>${r1(m.fat)}</b><span>fat g</span></div>
    <div><b>${r1(m.protein)}</b><span>protein g</span></div>
    <div class="net"><b>${r1(m.net)}</b><span>net carbs g</span></div>
    <div><b>${r1(m.fibre)}</b><span>fibre g</span></div>`;
}
function commitPortion() {
  const ctx = sheetCtx; if (!ctx) return;
  const grams = num($('#sGrams').value);
  if (!(grams > 0)) { toast('Enter a portion size in grams'); $('#sGrams').focus(); return; }
  const netOnLabel = $('#sNet').checked;
  const meal = segValue('sMeal') || addMeal;
  const f = ctx.food;
  if (ctx.mode === 'edit') {
    const e = findEntry(ctx.date, ctx.entryId);
    if (e) { e.grams = grams; e.netOnLabel = netOnLabel; e.meal = meal; }
    if (db.foods[f.id]) db.foods[f.id].netOnLabel = netOnLabel;
    save(); closeSheet(); toast('Entry updated'); renderToday();
    return;
  }
  const date = ctx.date || viewDate;
  const entry = {
    id: uid(), meal, foodId: f.id, name: f.name, brand: f.brand || '', barcode: f.barcode || '',
    per100: { ...f.per100 }, grams, netOnLabel, servingG: f.servingG || null, servingLabel: f.servingLabel || '', image: f.image || '', ts: Date.now()
  };
  (db.log[date] = dayEntries(date)).push(entry);
  const prev = db.foods[f.id] || {};
  const saveChk = $('#sSave');
  const stored = { ...prev, ...f, netOnLabel, uses: (prev.uses || 0) + 1, lastUsed: Date.now(), lastGrams: grams, saved: !!(prev.saved || (saveChk && saveChk.checked) || f.saved) };
  delete stored.hasNutrition;
  db.foods[f.id] = stored;
  addMeal = meal;
  save(); closeSheet();
  toast(`Added to ${MEAL_LABEL[meal]}`);
  viewDate = date;
  showView('today');
}
function deleteEntry() {
  const ctx = sheetCtx; if (!ctx) return;
  if (!confirm('Delete this entry?')) return;
  db.log[ctx.date] = dayEntries(ctx.date).filter(e => e.id !== ctx.entryId);
  if (!db.log[ctx.date].length) delete db.log[ctx.date];
  save(); closeSheet(); toast('Entry deleted'); renderToday();
}

function openManualSheet(prefill = {}, notice = '', editFoodId = null) {
  stopScan();
  const f = editFoodId ? db.foods[editFoodId] : null;
  const p = f ? f.per100 : null;
  const v = (x) => (x == null || x === '' ? '' : r1(num(x)));
  sheetCtx = { manual: true, editFoodId, prefill };
  openSheet(`
    <h2 id="sheetTitle">${f ? 'Edit food' : 'Add food manually'}</h2>
    ${f ? '' : `<button id="mVoice" class="voice-btn mt8" type="button"><span class="mic" aria-hidden="true">🎤</span><span class="vb-text"><b>Speak your food</b><small>e.g. “two scrambled eggs with a slice of toast”</small></span></button>
    <div class="or-sep"><span>or type it in</span></div>`}
    ${notice ? `<div class="notice">${esc(notice)}</div>` : '<div class="muted small mt8">Copy the values from the nutrition label.</div>'}
    <label class="field mt12"><span class="field-label">Food name *</span><input id="mName" type="text" autocomplete="off" value="${esc(f ? f.name : prefill.name || '')}" placeholder="e.g. Greek yoghurt"></label>
    <div class="two">
      <label class="field"><span class="field-label">Brand</span><input id="mBrand" type="text" autocomplete="off" value="${esc(f ? f.brand || '' : prefill.brand || '')}"></label>
      <label class="field"><span class="field-label">Barcode</span><input id="mBarcode" type="text" inputmode="numeric" autocomplete="off" value="${esc(f ? f.barcode || '' : prefill.barcode || '')}"></label>
    </div>
    <div class="field-label">Values are</div>
    <div class="seg seg-2" data-segname="mMode">
      <button type="button" data-val="per100" class="${f ? 'active' : ''}">Per 100 g</button>
      <button type="button" data-val="portion" class="${f ? '' : 'active'}">Per portion</button>
    </div>
    <label class="field mt12"><span class="field-label">Portion size (g) *</span><input id="mGrams" type="number" inputmode="decimal" min="0" step="any" value="${f ? v(f.servingG || f.lastGrams || 100) : ''}" placeholder="e.g. 150"></label>
    <div class="two">
      <label class="field"><span class="field-label">Calories (kcal)</span><input id="mKcal" type="number" inputmode="decimal" min="0" step="any" value="${p ? v(p.kcal) : ''}" placeholder="auto if blank"></label>
      <label class="field"><span class="field-label">Fat (g)</span><input id="mFat" type="number" inputmode="decimal" min="0" step="any" value="${p ? v(p.fat) : ''}"></label>
      <label class="field"><span class="field-label">Protein (g)</span><input id="mProtein" type="number" inputmode="decimal" min="0" step="any" value="${p ? v(p.protein) : ''}"></label>
      <label class="field"><span class="field-label">Carbohydrate (g)</span><input id="mCarbs" type="number" inputmode="decimal" min="0" step="any" value="${p ? v(p.carbs) : ''}"></label>
      <label class="field"><span class="field-label">Fibre (g)</span><input id="mFibre" type="number" inputmode="decimal" min="0" step="any" value="${p ? v(p.fibre) : ''}"></label>
    </div>
    <label class="check"><input id="mNet" type="checkbox" ${f && f.netOnLabel === false ? '' : 'checked'}>
      <span>Carbs on label already exclude fibre (UK/EU)<span class="sub">Turn off for US-style labels – fibre will then be subtracted to give net carbs.</span></span></label>
    <div id="mPreview" class="preview"></div>
    ${f ? '' : `<div class="field-label">Meal</div>${mealSegHtml(addMeal, 'mMeal')}
    <label class="check mt8"><input id="mSave" type="checkbox" checked><span>Save to My foods</span></label>`}
    <div class="sheet-actions">
      ${f ? `<button id="mSaveOnly" class="btn primary big" type="button">Save food</button>`
      : `<button id="mCommit" class="btn primary big" type="button">Add to log</button>
         <button id="mSaveOnly" class="btn outline big" type="button">Save to My foods only</button>`}
      <button class="btn big" type="button" data-close>Cancel</button>
    </div>`);
  updateManualPreview();
}
function readManual() {
  const mode = segValue('mMode') || 'portion';
  const grams = num($('#mGrams').value);
  const vals = { fat: num($('#mFat').value), protein: num($('#mProtein').value), carbs: num($('#mCarbs').value), fibre: num($('#mFibre').value) };
  const netOnLabel = $('#mNet').checked;
  let kcal = numOrNull($('#mKcal').value);
  let kcalAuto = false;
  if (kcal == null) {
    const net = netCarbs(vals.carbs, vals.fibre, netOnLabel);
    kcal = vals.fat * 9 + vals.protein * 4 + net * 4 + vals.fibre * 2; kcalAuto = true;
  }
  vals.kcal = kcal;
  let per100 = vals;
  if (mode === 'portion') {
    per100 = {};
    Object.keys(vals).forEach(k => { per100[k] = grams > 0 ? vals[k] * 100 / grams : 0; });
  }
  return { mode, grams, per100, netOnLabel, kcalAuto, name: $('#mName').value.trim(), brand: $('#mBrand').value.trim(), barcode: $('#mBarcode').value.replace(/\D/g, '') };
}
function updateManualPreview() {
  if (!$('#mPreview')) return;
  const d = readManual();
  const m = scale(d.per100, d.grams, d.netOnLabel);
  $('#mPreview').innerHTML = d.grams > 0 ? `
    <div><b>${fmtInt(m.kcal)}</b><span>kcal${d.kcalAuto ? '*' : ''}</span></div>
    <div><b>${r1(m.fat)}</b><span>fat g</span></div>
    <div><b>${r1(m.protein)}</b><span>protein g</span></div>
    <div class="net"><b>${r1(m.net)}</b><span>net carbs g</span></div>
    <div><b>${r1(m.fibre)}</b><span>fibre g</span></div>` : '<div style="grid-column:1/-1" class="muted small">Enter a portion size to see the totals</div>';
}
function commitManual(addToLog) {
  const d = readManual();
  if (!d.name) { toast('Please enter a food name'); $('#mName').focus(); return; }
  if (!(d.grams > 0)) { toast('Please enter the portion size in grams'); $('#mGrams').focus(); return; }
  const ctx = sheetCtx;
  const editId = ctx && ctx.editFoodId;
  const prev = editId ? db.foods[editId] : (d.barcode ? Object.values(db.foods).find(f => f.barcode === d.barcode) : null);
  const id = prev ? prev.id : 'custom:' + uid();
  const saveChk = $('#mSave');
  const food = {
    ...(prev || {}), id, source: prev && prev.source ? prev.source : 'custom', name: d.name, brand: d.brand, barcode: d.barcode,
    per100: d.per100, servingG: d.mode === 'portion' ? d.grams : (prev && prev.servingG) || null,
    servingLabel: d.mode === 'portion' ? '' : (prev && prev.servingLabel) || '',
    netOnLabel: d.netOnLabel, saved: editId ? true : !!(saveChk ? saveChk.checked : true) || !addToLog || !!(prev && prev.saved)
  };
  if (!addToLog) food.saved = true;
  if (addToLog) {
    const meal = segValue('mMeal') || addMeal;
    const entry = { id: uid(), meal, foodId: id, name: food.name, brand: food.brand, barcode: food.barcode, per100: { ...food.per100 }, grams: d.grams, netOnLabel: d.netOnLabel, servingG: food.servingG, servingLabel: food.servingLabel, image: '', ts: Date.now() };
    (db.log[viewDate] = dayEntries(viewDate)).push(entry);
    food.uses = (food.uses || 0) + 1; food.lastUsed = Date.now(); food.lastGrams = d.grams;
    addMeal = meal;
  }
  db.foods[id] = food;
  save(); closeSheet();
  if (addToLog) { toast(`Added to ${MEAL_LABEL[addMeal]}`); showView('today'); }
  else { toast(editId ? 'Food updated' : 'Saved to My foods'); foodTab = 'mine'; renderAdd(); }
}

/* ---------- HISTORY ---------- */
function computeStreaks() {
  const limit = targets().net;
  const tk = todayKey();
  const ok = k => { const t = dayTotals(k); return t.count > 0 && t.net <= targets(k).net + 1e-9; };
  let cur = 0, k = tk;
  if (!dayEntries(tk).length) k = addDays(tk, -1); // today still in progress
  for (let i = 0; i < 3660 && ok(k); i++) { cur++; k = addDays(k, -1); }
  const keys = Object.keys(db.log).filter(x => dayEntries(x).length).sort();
  let best = 0;
  if (keys.length) {
    let run = 0, d = keys[0];
    for (let i = 0; i < 3660 && d <= tk; i++) { if (ok(d)) { run++; best = Math.max(best, run); } else if (d !== tk) run = 0; d = addDays(d, 1); }
  }
  return { cur, best: Math.max(best, cur), limit };
}
function renderHistory() {
  $$('#rangeSeg button').forEach(b => b.classList.toggle('active', +b.dataset.range === historyRange));
  const g = targets(), s = db.settings, tk = todayKey();
  const days = []; for (let i = historyRange - 1; i >= 0; i--) days.push(addDays(tk, -i));
  const data = days.map(k => ({ k, t: dayTotals(k) }));
  const logged = data.filter(d => d.t.count);

  const st = computeStreaks();
  $('#streakCard').innerHTML = `<div class="flame" aria-hidden="true">${st.cur ? '🔥' : '🥑'}</div>
    <div><div class="s-num">${st.cur} <span class="s-lbl">day${st.cur === 1 ? '' : 's'} keto streak</span></div>
    <div class="s-sub">Consecutive logged days at or under your net carb limit (${r0(st.limit)} g today)${dayEntries(tk).length ? '' : ' (today counts once you log food)'}. Best: ${st.best} day${st.best === 1 ? '' : 's'}.</div></div>`;

  const avg = (f) => logged.length ? logged.reduce((a, d) => a + f(d.t), 0) / logged.length : 0;
  const tot = logged.reduce((a, d) => { ['kcal', 'fat', 'protein', 'net'].forEach(x => a[x] += d.t[x]); return a; }, { kcal: 0, fat: 0, protein: 0, net: 0 });
  const ap = pctOfKcal(tot);
  const under = logged.filter(d => d.t.net <= targets(d.k).net + 1e-9).length;
  $('#avgCard').innerHTML = `<h2 class="card-title">Averages (${logged.length} of ${historyRange} days logged)</h2>
    <div class="avg-grid">
      <div><span class="stat-label">Calories</span><span class="stat-val">${fmtInt(avg(t => t.kcal))}</span> <span class="muted small">/ ${fmtInt(g.kcal)}</span></div>
      <div><span class="stat-label">Net carbs</span><span class="stat-val">${r1(avg(t => t.net))} g</span> <span class="muted small">/ ${r0(g.net)} g</span></div>
      <div><span class="stat-label">Days under carb limit</span><span class="stat-val">${under} / ${logged.length}</span></div>
      <div><span class="stat-label">Protein</span><span class="stat-val">${r0(avg(t => t.protein))} g</span> <span class="muted small">/ ${r0(g.protein)} g</span></div>
    </div>
    <div class="split-row mt12"><span class="lbl">Actual</span>${logged.length ? splitBar(ap.fat, ap.protein, ap.carbs, carbLevel(avg(t => t.net), g.net) === 'over' ? 'over' : '') : '<div class="split"></div>'}</div>
    <div class="split-row"><span class="lbl">Target</span>${splitBar(num(s.pct.fat), num(s.pct.protein), num(s.pct.carbs))}</div>
    <div class="legend"><span><i class="dot fat"></i>Fat <b>${r0(ap.fat)}%</b> / ${r0(s.pct.fat)}%</span><span><i class="dot protein"></i>Protein <b>${r0(ap.protein)}%</b> / ${r0(s.pct.protein)}%</span><span><i class="dot carbs"></i>Net carbs <b>${r0(ap.carbs)}%</b> / ${r0(s.pct.carbs)}%</span></div>`;

  // chart
  const maxV = Math.max(g.net * 1.5, ...data.map(d => d.t.net), 1);
  const bars = data.map(d => {
    const lv = d.t.count ? carbLevel(d.t.net, targets(d.k).net) : 'none';
    const h = d.t.count ? Math.max(2, d.t.net / maxV * 100) : 2;
    return `<div class="bar-wrap" data-day="${d.k}" title="${shortDate(d.k)}: ${r1(d.t.net)} g"><div class="bar ${lv}" style="height:${h}%"></div></div>`;
  }).join('');
  const limitPos = (g.net / maxV) * 100;
  const every = historyRange > 7 ? 5 : 1;
  const labels = data.map((d, i) => `<span>${(historyRange === 7 ? parseKey(d.k).toLocaleDateString('en-GB', { weekday: 'short' }) : ((historyRange - 1 - i) % every === 0 ? parseKey(d.k).getDate() : ''))}</span>`).join('');
  $('#carbChart').innerHTML = bars + `<div class="limit" style="bottom:${limitPos}%"><span>limit ${r0(g.net)} g</span></div>`;
  let xl = $('#chartX'); if (!xl) { xl = document.createElement('div'); xl.id = 'chartX'; xl.className = 'chart-x'; $('#carbChart').after(xl); }
  xl.innerHTML = labels;

  // day list (newest first)
  $('#dayList').innerHTML = data.slice().reverse().map(d => {
    const t = d.t; const p = pctOfKcal(t); const lv = t.count ? carbLevel(t.net, targets(d.k).net) : 'none';
    return `<button class="day-row" type="button" data-day="${d.k}">
      <div><div class="d-date">${d.k === tk ? 'Today' : shortDate(d.k)}</div>
      <div class="d-kcal">${t.count ? `${fmtInt(t.kcal)} kcal · F ${r0(p.fat)}% · P ${r0(p.protein)}% · C ${r0(p.carbs)}%` : 'Nothing logged'}</div></div>
      <span class="pill ${lv}">${t.count ? r1(t.net) + ' g net' : '—'}</span>
      ${t.count ? splitBar(p.fat, p.protein, p.carbs, lv === 'ok' ? '' : lv, false) : ''}
    </button>`;
  }).join('');
}

/* ---------- SETTINGS ---------- */
function renderSettings() {
  const s = db.settings;
  $('#setKcal').value = s.kcalTarget;
  $('#setFat').value = s.pct.fat; $('#setProtein').value = s.pct.protein; $('#setCarbs').value = s.pct.carbs;
  $('#appVersion').textContent = 'v' + APP_VERSION;
  $('#usePlan').checked = !!db.goal.active;
  updateTargetInfo(); updateBackupInfo(); renderAiSettings();
}
function updateTargetInfo() {
  const s = db.settings, g = targets();
  const planK = typeof planKcalFor === 'function' ? planKcalFor(todayKey()) : null;
  const pl = buildPlan();
  $('#planSrcInfo').textContent = db.goal.active
    ? (planK ? `Active – this week’s plan target is ${fmtInt(planK)} kcal/day.` : `No usable plan yet${pl && pl.error ? ' (' + pl.error.replace(/\.$/, '') + ')' : ''} – set one up in Body & Goals. Using the manual target below meanwhile.`)
    : 'Off – the manual target below is used.';
  $('#setKcalLabel').textContent = planK ? 'Manual calorie target (used when the plan is off)' : 'Calorie target (kcal per day)';
  const sum = num(s.pct.fat) + num(s.pct.protein) + num(s.pct.carbs);
  const note = $('#pctNote');
  if (Math.abs(sum - 100) < 0.01) { note.className = 'note'; note.textContent = ''; }
  else if (sum < 100) {
    note.className = 'note warn';
    note.textContent = `Heads up: your split totals ${r1(sum)}%, so ${r1(100 - sum)}% of your calories (${fmtInt(g.kcal * (100 - sum) / 100)} kcal) aren’t assigned to any macro. That’s fine if intended – otherwise adjust the percentages (e.g. add the rest to fat or protein). Nothing is changed automatically.`;
  } else {
    note.className = 'note warn';
    note.textContent = `Heads up: your split totals ${r1(sum)}% – more than 100%. The gram targets below will add up to more than your calorie target.`;
  }
  $('#gramTargets').innerHTML = `
    <div><b>${r0(g.fat)} g</b><span>Fat</span></div>
    <div><b>${r0(g.protein)} g</b><span>Protein</span></div>
    <div><b>${r0(g.net)} g</b><span>Net carbs</span></div>`;
}
function saveTargets() {
  const s = db.settings;
  const k = num($('#setKcal').value);
  if (k >= 500 && k <= 10000) s.kcalTarget = Math.round(k);
  ['fat', 'protein', 'carbs'].forEach(m => {
    const el = $('#set' + m[0].toUpperCase() + m.slice(1));
    const v = numOrNull(el.value);
    if (v != null && v >= 0 && v <= 100) s.pct[m] = v;
  });
  save(); updateTargetInfo();
}
function updateBackupInfo() {
  const days = Object.keys(db.log).filter(k => dayEntries(k).length).length;
  $('#backupInfo').textContent = `${days} day${days === 1 ? '' : 's'} logged, ${Object.values(db.foods).filter(f => f.saved).length} saved foods. ` +
    (db.lastBackup ? `Last backup: ${new Date(db.lastBackup).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}.` : 'No backup yet.');
}
async function exportBackup() {
  const payload = { app: 'keto-tracker', exportedAt: new Date().toISOString(), ...db, lastBackup: Date.now() };
  const json = JSON.stringify(payload, null, 1);
  const name = `keto-tracker-backup-${todayKey()}.json`;
  const blob = new Blob([json], { type: 'application/json' });
  let done = false;
  try {
    const file = new File([blob], name, { type: 'application/json' });
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIOS && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Keto Tracker backup' });
      done = true;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return; // user cancelled share sheet
  }
  if (!done) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }
  db.lastBackup = Date.now(); save(); updateBackupInfo();
  toast('Backup exported – keep it somewhere safe (e.g. iCloud Drive)', 3500);
}
function importBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try { data = JSON.parse(reader.result); } catch (e) { toast('That file isn’t a valid backup (not JSON)'); return; }
    if (!data || typeof data !== 'object' || (!data.log && !data.foods && !data.settings)) { toast('That file doesn’t look like a Keto Tracker backup'); return; }
    const days = data.log ? Object.keys(data.log).length : 0;
    const foods = data.foods ? Object.keys(data.foods).length : 0;
    if (!confirm(`Restore this backup${data.exportedAt ? ' from ' + new Date(data.exportedAt).toLocaleString('en-GB') : ''}?\n\n${days} days of log and ${foods} foods.\n\nThis REPLACES the data currently on this phone.`)) return;
    const { app, exportedAt, ...rest } = data;
    db = normalise(rest); planCache = null;
    save(); viewDate = todayKey();
    toast('Backup restored'); renderSettings();
  };
  reader.onerror = () => toast('Could not read that file');
  reader.readAsText(file);
}

/* ---------- events ---------- */
function bind() {
  $$('.tab').forEach(t => t.addEventListener('click', () => showView(t.dataset.view)));
  $('#prevDay').addEventListener('click', () => { viewDate = addDays(viewDate, -1); renderToday(); });
  $('#nextDay').addEventListener('click', () => { if (viewDate < todayKey()) { viewDate = addDays(viewDate, 1); renderToday(); } });
  $('#todayBtn').addEventListener('click', () => { viewDate = todayKey(); renderToday(); });
  $('#dismissInstall').addEventListener('click', () => { db.ui.installDismissed = true; save(); renderHints(); });
  $('#backupHintLink').addEventListener('click', (e) => { e.preventDefault(); showView('settings'); });

  $('#meals').addEventListener('click', (e) => {
    const add = e.target.closest('[data-addmeal]');
    if (add) { addMeal = add.dataset.addmeal; showView('add'); return; }
    const en = e.target.closest('[data-entry]');
    if (en) openPortionSheet({ mode: 'edit', date: viewDate, entryId: en.dataset.entry });
  });

  $('#mealSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-meal]'); if (b) { addMeal = b.dataset.meal; renderAdd(); } });
  $('#scanBtn').addEventListener('click', startScan);
  $('#stopScanBtn').addEventListener('click', stopScan);
  $('#barcodeForm').addEventListener('submit', (e) => { e.preventDefault(); $('#barcodeInput').blur(); lookupBarcode($('#barcodeInput').value); });
  $('#manualBtn').addEventListener('click', () => openManualSheet({}));
  $('#foodTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) { foodTab = b.dataset.tab; renderFoodList(); } });
  $('#foodSearch').addEventListener('input', renderFoodList);
  $('#foodList').addEventListener('click', (e) => {
    const f = e.target.closest('[data-food]');
    if (f) { const food = db.foods[f.dataset.food]; if (food) openPortionSheet({ mode: 'add', food }); return; }
    const ed = e.target.closest('[data-editfood]');
    if (ed) { openManualSheet({}, '', ed.dataset.editfood); return; }
    const del = e.target.closest('[data-delfood]');
    if (del) {
      const food = db.foods[del.dataset.delfood];
      if (food && confirm(`Remove “${food.name}” from My foods? Past log entries are kept.`)) { delete db.foods[food.id]; save(); renderFoodList(); toast('Removed'); }
    }
  });

  // sheet (delegated)
  $('#sheetBackdrop').addEventListener('click', closeSheet);
  $('#sheet').addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) { closeSheet(); return; }
    const segBtn = e.target.closest('[data-segname] button');
    if (segBtn) { $$('button', segBtn.parentElement).forEach(b => b.classList.toggle('active', b === segBtn)); updateManualPreview(); return; }
    const chip = e.target.closest('[data-g]');
    if (chip) { $('#sGrams').value = r1(num(chip.dataset.g)); syncServ(); updatePortionPreview(); return; }
    if (e.target.closest('#sCommit')) return commitPortion();
    if (e.target.closest('#sDelete')) return deleteEntry();
    if (e.target.closest('#mCommit')) return commitManual(true);
    if (e.target.closest('#mSaveOnly')) return commitManual(false);
  });
  $('#sheet').addEventListener('input', (e) => {
    if (e.target.id === 'sGrams') { syncServ(); updatePortionPreview(); }
    else if (e.target.id === 'sServ') { const sv = sheetCtx && sheetCtx.food.servingG; if (sv) $('#sGrams').value = r1(num(e.target.value) * sv); updatePortionPreview(); }
    else if (e.target.id && e.target.id.startsWith('m')) updateManualPreview();
  });
  $('#sheet').addEventListener('change', (e) => {
    if (e.target.id === 'sNet') updatePortionPreview();
    if (e.target.id === 'mNet') updateManualPreview();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

  // history
  $('#rangeSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-range]'); if (b) { historyRange = +b.dataset.range; renderHistory(); } });
  const goDay = (e) => { const d = e.target.closest('[data-day]'); if (d) { viewDate = d.dataset.day; showView('today'); } };
  $('#dayList').addEventListener('click', goDay);
  $('#carbChart').addEventListener('click', goDay);

  // settings
  ['#setKcal', '#setFat', '#setProtein', '#setCarbs'].forEach(s => $(s).addEventListener('input', saveTargets));
  $('#usePlan').addEventListener('change', (e) => { db.goal.active = e.target.checked; save(); updateTargetInfo(); });
  bindBody();
  bindAi();
  bindVoice();
  $('#exportBtn').addEventListener('click', exportBackup);
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (f) importBackup(f); e.target.value = ''; });
  $('#clearBtn').addEventListener('click', () => {
    if (!confirm('Delete ALL your data (log, foods and settings) from this phone? This cannot be undone. Export a backup first if unsure.')) return;
    localStorage.removeItem(STORE_KEY); localStorage.removeItem('ketoTracker.openaiKey'); db = normalise({}); viewDate = todayKey(); save(); renderSettings(); toast('All data deleted');
  });

  // keep "today" correct if the app is left open past midnight
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { if ($('#view-today').classList.contains('active')) renderToday(); }
    else stopScan();
  });
}
function syncServ() {
  const sv = sheetCtx && sheetCtx.food.servingG; const el = $('#sServ');
  if (sv && el) el.value = r1(num($('#sGrams').value) / sv);
}

/* ---------- start ---------- */
function init() {
  bind();
  showView('today');
  handleImportRoute();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(e => console.info('SW registration failed', e)));
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
