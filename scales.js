/* Keto Tracker – scale import bridge: URL/Shortcut import, clipboard/paste extraction, CSV import.
   iOS Safari has no Web Bluetooth, so readings arrive via the scale maker's app / Apple Health. */
'use strict';

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
let csvState = null;

/* ---------- parsing helpers ---------- */
function cellNum(s) {
  if (s == null) return null;
  const str = String(s).trim().replace(/(\d),(\d)/g, '$1.$2');
  const m = str.match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}
function toKg(v, unit) {
  if (v == null) return null;
  unit = String(unit || 'kg').toLowerCase();
  if (/lb|pound/.test(unit)) return v / 2.2046226;
  if (/^st|stone/.test(unit)) return v * 6.35029318;
  return v;
}
function pct(v) { // accepts 24.1 or 0.241
  if (v == null || !isFinite(v)) return null;
  if (v > 0 && v <= 1) v *= 100;
  return v > 0.5 && v < 95 ? Math.round(v * 10) / 10 : null;
}
function monthNum(name) { return MONTHS[String(name).slice(0, 3).toLowerCase()] || null; }
function validKey(y, m, d) {
  if (y < 100) y += 2000;
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  if (y < 2000 || keyOf(dt) > addDays(todayKey(), 1)) return null;
  return keyOf(dt);
}
function timeMins(s) {
  const t = String(s).match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?/i);
  if (!t) return 0;
  let h = +t[1]; const ap = (t[3] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
  return h * 60 + +t[2];
}
// order: 'dmy' (UK, default) or 'mdy' (US) for ambiguous slashed dates
function parseDateCell(s, order = 'dmy') {
  s = String(s == null ? '' : s).trim();
  if (!s) return null;
  let m, key = null;
  if (/^\d{10}(\d{3})?$/.test(s)) { const d = new Date(s.length === 13 ? +s : +s * 1000); return { key: keyOf(d), mins: d.getHours() * 60 + d.getMinutes() }; }
  if ((m = s.match(/(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/))) key = validKey(+m[1], +m[2], +m[3]);
  else if ((m = s.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/))) key = order === 'mdy' ? validKey(+m[3], +m[1], +m[2]) : validKey(+m[3], +m[2], +m[1]);
  else if ((m = s.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s+(\d{4})/i)) && monthNum(m[2])) key = validKey(+m[3], monthNum(m[2]), +m[1]);
  else if ((m = s.match(/([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i)) && monthNum(m[1])) key = validKey(+m[3], monthNum(m[1]), +m[2]);
  if (!key) return null;
  return { key, mins: timeMins(s.slice(s.indexOf(m[0]) + m[0].length)) };
}
function detectDateOrder(values) {
  let dmy = false, mdy = false;
  values.forEach(v => { const m = String(v || '').match(/^\s*(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/); if (m) { if (+m[1] > 12) dmy = true; if (+m[2] > 12) mdy = true; } });
  return mdy && !dmy ? 'mdy' : 'dmy';
}

/* ---------- URL / Shortcut import ---------- */
function parseImportParams(qs) {
  const p = new URLSearchParams(String(qs || '').replace(/^[?#]/, ''));
  const get = (...names) => { for (const n of names) { const v = p.get(n); if (v != null && String(v).trim() !== '') return String(v).trim(); } return null; };
  const wRaw = get('weight', 'w', 'kg', 'lb');
  const unitText = (get('unit', 'u') || (wRaw || '').replace(/[-\d.,\s]/g, '') || (p.has('lb') && !p.has('weight') ? 'lb' : 'kg')).toLowerCase();
  const weight = toKg(cellNum(wRaw), unitText);
  const massOrPct = (raw) => {
    if (raw == null) return null;
    const v = cellNum(raw);
    if (/kg|lb|st/i.test(raw) && weight) return pct(toKg(v, raw.match(/kg|lb|st/i)[0]) / weight * 100);
    return pct(v);
  };
  let bf = massOrPct(get('bf', 'fat', 'bodyfat', 'body_fat', 'fatpct'));
  const lbmRaw = get('lbm', 'lean', 'leanmass');
  if (bf == null && lbmRaw && weight) {
    const lbmUnit = /kg|lb|st/i.test(lbmRaw) ? lbmRaw.match(/kg|lb|st/i)[0] : unitText;
    const lbm = toKg(cellNum(lbmRaw), lbmUnit);
    if (lbm > 0 && lbm < weight) bf = pct((1 - lbm / weight) * 100);
  }
  const dateRaw = get('date', 'd');
  const d = dateRaw ? parseDateCell(dateRaw, 'dmy') : null;
  return {
    weight: weight && weight > 20 && weight < 400 ? Math.round(weight * 100) / 100 : null,
    bf, muscle: massOrPct(get('muscle', 'mm', 'skeletal')), water: massOrPct(get('water', 'hydration', 'tbw')),
    date: d ? d.key : todayKey(), dateGiven: !!d
  };
}
function handleImportRoute() {
  const h = location.hash || '';
  let qs = null;
  if (/^#\/?import\b/.test(h)) qs = h.includes('?') ? h.slice(h.indexOf('?') + 1) : '';
  else if (/[?&](weight|w|kg|lb)=/.test(location.search)) qs = location.search.slice(1);
  if (qs == null) return false;
  try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
  const d = parseImportParams(qs);
  showView('body');
  if (!d.weight) { toast('That import link didn’t include a weight reading'); return true; }
  openWeighConfirm(d, 'From the Apple Health shortcut / import link');
  return true;
}

/* ---------- free-text (paste) extraction ---------- */
function extractFromText(text) {
  const t = String(text || '').replace(/(\d),(\d)/g, '$1.$2');
  if (/[?&#]?\b(weight|bf)=/.test(t)) { // an import link or its query string
    const q = t.includes('?') ? t.slice(t.indexOf('?') + 1) : t;
    return parseImportParams(q.trim().split(/\s/)[0]);
  }
  const out = { weight: null, bf: null, muscle: null, water: null, date: todayKey(), dateGiven: false };
  let m;
  if ((m = t.match(/(\d{1,2})\s*st(?:one)?s?\.?\s*(\d{1,2}(?:\.\d+)?)?\s*(?:lb|lbs|pounds?)?/i))) out.weight = toKg(+m[1] * 14 + (m[2] ? +m[2] : 0), 'lb');
  else if ((m = t.match(/weight[^0-9\n]{0,25}(\d{2,3}(?:\.\d+)?)\s*(kg|kgs|lb|lbs|pounds?)?/i))) out.weight = toKg(+m[1], m[2] || 'kg');
  else if ((m = t.match(/(\d{2,3}(?:\.\d+)?)\s*(kg|lb|lbs)\b/i))) out.weight = toKg(+m[1], m[2]);
  if (out.weight) out.weight = Math.round(out.weight * 100) / 100;
  const firstPct = (patterns) => { for (const re of patterns) { const x = t.match(re); if (x) return pct(+x[1]); } return null; };
  const massPct = (re) => { const x = t.match(re); return x && out.weight ? pct(toKg(+x[1], x[2]) / out.weight * 100) : null; };
  out.bf = firstPct([
    /body\s*fat(?:\s*(?:percentage|rate|%))?[^0-9\n]{0,20}(\d{1,2}(?:\.\d+)?)\s*%/i,
    /\bbfr?\b[^0-9\n]{0,10}(\d{1,2}(?:\.\d+)?)\s*%/i,
    /(?:^|[^a-z])fat(?:\s*(?:percentage|rate|%))?[^0-9\n]{0,20}(\d{1,2}(?:\.\d+)?)\s*%/i,
    /body\s*fat[^0-9\n]{0,20}(\d{1,2}(?:\.\d+)?)(?!\s*(?:\.\d)?\s*(?:kg|lb))/i
  ]) ?? massPct(/fat\s*mass[^0-9\n]{0,20}(\d{1,3}(?:\.\d+)?)\s*(kg|lb)/i);
  out.muscle = firstPct([
    /skeletal\s*muscle(?:\s*(?:mass|rate|percentage|%))?[^0-9\n]{0,20}(\d{1,2}(?:\.\d+)?)\s*%/i,
    /muscle(?:\s*(?:mass|rate|percentage|%))?[^0-9\n]{0,20}(\d{1,2}(?:\.\d+)?)\s*%/i
  ]) ?? massPct(/muscle(?:\s*mass)?[^0-9\n]{0,20}(\d{1,3}(?:\.\d+)?)\s*(kg|lb)/i);
  out.water = firstPct([
    /(?:body\s*water|water|hydration)(?:\s*(?:rate|percentage|%))?[^0-9\n]{0,20}(\d{1,2}(?:\.\d+)?)\s*%/i
  ]) ?? massPct(/(?:body\s*water|water|hydration)[^0-9\n]{0,20}(\d{1,3}(?:\.\d+)?)\s*(kg|lb)/i);
  const dm = t.match(/\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4}|\d{1,2}(?:st|nd|rd|th)?\s+[a-z]{3,9}\.?,?\s+\d{4}|[a-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}/i);
  if (dm) { const d = parseDateCell(dm[0], 'dmy'); if (d) { out.date = d.key; out.dateGiven = true; } }
  return out;
}

/* ---------- confirm & save a single weigh-in ---------- */
function openWeighConfirm(d, source) {
  stopScan();
  sheetCtx = { weighImport: true };
  const exists = (db.body.weighIns || []).some(e => e.date === d.date);
  const v = x => (x == null ? '' : r1(x));
  openSheet(`
    <h2 id="sheetTitle">Import weigh-in</h2>
    <div class="muted small">${esc(source || '')}</div>
    <div class="two mt12">
      <label class="field"><span class="field-label">Date</span><input id="iwDate" type="date" value="${d.date}" max="${todayKey()}"></label>
      <div class="field"><span class="field-label">Weight (${db.body.weightUnit === 'stlb' ? 'st/lb' : 'kg'})</span>${weightInputsHtml('iw', d.weight)}</div>
    </div>
    <div class="pct-grid">
      <label class="field"><span class="field-label">Body fat %</span><input id="iwBf" type="number" inputmode="decimal" step="0.1" value="${v(d.bf)}"></label>
      <label class="field"><span class="field-label">Muscle %</span><input id="iwMuscle" type="number" inputmode="decimal" step="0.1" value="${v(d.muscle)}"></label>
      <label class="field"><span class="field-label">Water %</span><input id="iwWater" type="number" inputmode="decimal" step="0.1" value="${v(d.water)}"></label>
    </div>
    <div id="iwNote" class="note ${exists ? 'warn' : ''}">${exists ? 'You already have a weigh-in on this date – saving will replace it.' : 'Check the values, then save. Muscle and water rarely sync to Apple Health – type them in from your scale app if you want them.'}</div>
    <div class="sheet-actions">
      <button id="iwSave" class="btn primary big" type="button">Save weigh-in</button>
      <button class="btn big" type="button" data-close>Cancel</button>
    </div>`);
}
function saveWeighConfirm() {
  const date = $('#iwDate').value || todayKey();
  const weight = readWeight('iw');
  if (!(weight > 20 && weight < 400)) { toast('Enter a weight'); return; }
  const f = id => pct(numOrNull($(id).value));
  db.body.weighIns = (db.body.weighIns || []).filter(e => e.date !== date);
  db.body.weighIns.push({ id: uid(), date, weight: Math.round(weight * 100) / 100, bf: f('#iwBf'), muscle: f('#iwMuscle'), water: f('#iwWater'), src: 'import' });
  save(); closeSheet();
  toast(`Weigh-in saved – trend and plan updated`);
  showView('body');
}

/* ---------- CSV ---------- */
function parseCSV(text) {
  text = String(text || '').replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/).find(l => l.trim()) || '';
  const counts = [',', ';', '\t'].map(d => [d, firstLine.split(d).length]);
  const delim = counts.sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); field = ''; if (row.some(x => x.trim() !== '')) rows.push(row); row = []; }
    else field += c;
  }
  row.push(field); if (row.some(x => x.trim() !== '')) rows.push(row);
  const headers = (rows.shift() || []).map(h => h.trim());
  return { headers, rows, delim };
}
function unitFromHeader(h, dflt) { h = h.toLowerCase(); return /\blbs?\b|pound|\(lb/.test(h) ? 'lb' : /\bst\b|stone/.test(h) ? 'st' : /kg/.test(h) ? 'kg' : dflt; }
function detectMapping(headers, rows) {
  const h = headers.map(x => x.toLowerCase());
  const find = (inc, exc) => h.findIndex(x => inc.test(x) && !(exc && exc.test(x)));
  const map = { date: -1, weight: -1, weightUnit: 'kg', bf: -1, bfUnit: '%', muscle: -1, muscleUnit: '%', water: -1, waterUnit: '%', dateOrder: 'auto' };
  map.date = find(/date|time|timestamp|measured|recorded/);
  if (map.date < 0) map.date = find(/^day$/);
  map.weight = find(/weight|body ?mass|^mass$|^kg$|^lbs?$/, /lean|muscle|fat|bone|water|protein|visceral|bmi|goal|target|change|diff|ideal/);
  if (map.weight >= 0) {
    const vals = rows.map(r => cellNum(r[map.weight])).filter(v => v != null).sort((a, b) => a - b);
    const med = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
    map.weightUnit = unitFromHeader(h[map.weight], med > 140 ? 'lb' : 'kg');
  }
  const massUnit = (i) => unitFromHeader(h[i], '%') === '%' ? (/mass|weight/.test(h[i]) ? (map.weightUnit === 'st' ? 'kg' : map.weightUnit) : '%') : unitFromHeader(h[i], 'kg');
  let i = find(/body ?fat|^fat ?(%|rate|percent)|^bf|fat ?percent|fat \(%|fat\(%/, /mass|\(kg|\(lb|kg\)|lb\)|visceral|subcut|free|lean/);
  if (i >= 0) { map.bf = i; map.bfUnit = '%'; }
  else { i = find(/fat ?mass|fat ?weight|^fat \(kg|^fat \(lb|^fat$/, /free|lean|visceral|subcut/); if (i >= 0) { map.bf = i; map.bfUnit = massUnit(i); } }
  i = find(/skeletal ?muscle.*%|muscle.*%|muscle ?rate|muscle ?percent/);
  if (i < 0) i = find(/skeletal ?muscle/, /mass|kg|lb/);
  if (i >= 0) { map.muscle = i; map.muscleUnit = '%'; }
  else { i = find(/muscle/); if (i >= 0) { map.muscle = i; map.muscleUnit = massUnit(i); } }
  i = find(/water.*%|water ?rate|water ?percent|hydration.*%|tbw ?%/);
  if (i < 0) i = find(/body ?water|^water|hydration/, /kg|lb|mass/);
  if (i >= 0) { map.water = i; map.waterUnit = /kg|lb|mass/.test(h[i]) ? massUnit(i) : '%'; }
  else { i = find(/water|hydration/); if (i >= 0) { map.water = i; map.waterUnit = massUnit(i); } }
  return map;
}
function csvToWeighIns(parsed, map) {
  const order = map.dateOrder === 'auto' ? detectDateOrder(parsed.rows.map(r => r[map.date])) : map.dateOrder;
  const existing = new Set((db.body.weighIns || []).map(e => e.date));
  let invalid = 0; const all = [];
  if (map.date < 0 || map.weight < 0) return { entries: [], invalid: parsed.rows.length, dupExisting: 0, dupFile: 0, order };
  parsed.rows.forEach(r => {
    const d = parseDateCell(r[map.date], order);
    const wkg = toKg(cellNum(r[map.weight]), map.weightUnit);
    if (!d || !(wkg > 20 && wkg < 400)) { invalid++; return; }
    const comp = (idx, unit) => {
      if (idx < 0) return null;
      const v = cellNum(r[idx]); if (v == null) return null;
      return unit === '%' ? pct(v) : pct(toKg(v, unit) / wkg * 100);
    };
    all.push({ date: d.key, mins: d.mins, weight: Math.round(wkg * 100) / 100, bf: comp(map.bf, map.bfUnit), muscle: comp(map.muscle, map.muscleUnit), water: comp(map.water, map.waterUnit) });
  });
  all.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.mins - b.mins);
  const seen = new Set(); let dupFile = 0, dupExisting = 0; const entries = [];
  all.forEach(e => {
    if (seen.has(e.date)) { dupFile++; return; }
    seen.add(e.date);
    if (existing.has(e.date)) { dupExisting++; return; }
    entries.push(e);
  });
  return { entries, invalid, dupExisting, dupFile, order };
}
function colSelect(id, sel) {
  return `<select id="${id}"><option value="-1">— none —</option>${csvState.parsed.headers.map((h, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${esc(h || 'Column ' + (i + 1))}</option>`).join('')}</select>`;
}
function unitSelect(id, sel, opts) { return `<select id="${id}">${opts.map(([v, l]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${l}</option>`).join('')}</select>`; }
function openCsvSheet(fileName, text) {
  const parsed = parseCSV(text);
  if (!parsed.headers.length || !parsed.rows.length) { toast('That file has no data rows'); return; }
  const map = detectMapping(parsed.headers, parsed.rows);
  csvState = { parsed, map, fileName };
  const detectedAll = map.date >= 0 && map.weight >= 0;
  const compUnits = [['%', '%'], ['kg', 'kg'], ['lb', 'lb']];
  openSheet(`
    <h2 id="sheetTitle">Import CSV</h2>
    <div class="muted small">${esc(fileName)} · ${parsed.rows.length} rows · ${parsed.headers.length} columns</div>
    <div id="csvDetectNote" class="note ${detectedAll ? '' : 'warn'} mt8">${detectedAll ? 'Columns detected automatically – check them below.' : 'We couldn’t detect the date and weight columns automatically. Please choose which column is which below.'}</div>
    <div class="map-grid">
      <label class="field"><span class="field-label">Date column</span>${colSelect('cmDate', map.date)}</label>
      <label class="field"><span class="field-label">Date format</span>${unitSelect('cmOrder', 'auto', [['auto', 'Auto (UK if unclear)'], ['dmy', 'DD/MM/YYYY (UK)'], ['mdy', 'MM/DD/YYYY (US)']])}</label>
      <label class="field"><span class="field-label">Weight column</span>${colSelect('cmWeight', map.weight)}</label>
      <label class="field"><span class="field-label">Weight unit</span>${unitSelect('cmWUnit', map.weightUnit, [['kg', 'kg'], ['lb', 'lb'], ['st', 'stone (decimal)']])}</label>
      <label class="field"><span class="field-label">Body fat column</span>${colSelect('cmBf', map.bf)}</label>
      <label class="field"><span class="field-label">Body fat is in</span>${unitSelect('cmBfUnit', map.bfUnit, compUnits)}</label>
      <label class="field"><span class="field-label">Muscle column</span>${colSelect('cmMuscle', map.muscle)}</label>
      <label class="field"><span class="field-label">Muscle is in</span>${unitSelect('cmMuscleUnit', map.muscleUnit, compUnits)}</label>
      <label class="field"><span class="field-label">Water column</span>${colSelect('cmWater', map.water)}</label>
      <label class="field"><span class="field-label">Water is in</span>${unitSelect('cmWaterUnit', map.waterUnit, compUnits)}</label>
    </div>
    <div id="csvPreview"></div>
    <div class="sheet-actions">
      <button id="csvImport" class="btn primary big" type="button">Import</button>
      <button class="btn big" type="button" data-close>Cancel</button>
    </div>`);
  updateCsvPreview();
}
function readCsvMap() {
  const m = csvState.map; const g = id => +$('#' + id).value;
  Object.assign(m, { date: g('cmDate'), weight: g('cmWeight'), bf: g('cmBf'), muscle: g('cmMuscle'), water: g('cmWater'),
    weightUnit: $('#cmWUnit').value, bfUnit: $('#cmBfUnit').value, muscleUnit: $('#cmMuscleUnit').value, waterUnit: $('#cmWaterUnit').value, dateOrder: $('#cmOrder').value });
  return m;
}
function updateCsvPreview() {
  if (!csvState || !$('#csvPreview')) return;
  const res = csvToWeighIns(csvState.parsed, readCsvMap());
  csvState.result = res;
  const n = res.entries.length;
  const btn = $('#csvImport'); btn.disabled = !n; btn.textContent = n ? `Import ${n} weigh-in${n === 1 ? '' : 's'}` : 'Nothing to import';
  const bits = [];
  if (res.dupExisting) bits.push(`${res.dupExisting} already in your log (skipped)`);
  if (res.dupFile) bits.push(`${res.dupFile} extra same-day reading${res.dupFile === 1 ? '' : 's'} (earliest of each day kept)`);
  if (res.invalid) bits.push(`${res.invalid} row${res.invalid === 1 ? '' : 's'} without a valid date/weight`);
  const v = x => (x == null ? '—' : r1(x) + '%');
  $('#csvPreview').innerHTML = `<div class="small"><b>${n} new weigh-in${n === 1 ? '' : 's'}</b>${bits.length ? ' · ' + bits.join(' · ') : ''}</div>
    ${n ? `<div class="table-wrap" style="max-height:220px"><table class="ptable"><thead><tr><th>Date</th><th>Weight</th><th>Fat</th><th>Muscle</th><th>Water</th></tr></thead>
    <tbody>${res.entries.slice(-8).reverse().map(e => `<tr><td>${shortDate(e.date)}</td><td>${fmtW(e.weight)}</td><td>${v(e.bf)}</td><td>${v(e.muscle)}</td><td>${v(e.water)}</td></tr>`).join('')}</tbody></table></div>
    ${n > 8 ? `<div class="muted small mt8">Showing the latest 8 of ${n}.</div>` : ''}` : ''}`;
}
function commitCsv() {
  const res = csvState && csvState.result; if (!res || !res.entries.length) return;
  res.entries.forEach(e => db.body.weighIns.push({ id: uid(), date: e.date, weight: e.weight, bf: e.bf, muscle: e.muscle, water: e.water, src: 'csv' }));
  save(); const n = res.entries.length; csvState = null; closeSheet();
  toast(`Imported ${n} weigh-in${n === 1 ? '' : 's'} – trend and plan updated`, 3200);
  showView('body');
}

/* ---------- Shortcut help ---------- */
function appBaseUrl() { return location.origin + location.pathname; }
function openShortcutHelp() {
  const base = appBaseUrl();
  const tpl = `${base}#/import?weight=[Weight value]&unit=[Weight unit]&bf=[Body fat value]&date=[Weight start date]`;
  sheetCtx = { help: true };
  openSheet(`
    <h2 id="sheetTitle">Set up one-tap import</h2>
    <p class="small">Most scale apps – <b>Renpho, Withings, Eufy, Fitbit, Garmin</b> and others – can send your weight and body fat to <b>Apple Health</b>. A free Apple <b>Shortcut</b> can then pass the latest reading to Keto Tracker. You only set this up once.</p>
    <div class="note small"><b>Before you start:</b> in your scale app’s settings, turn on syncing with Apple Health (often under “Integrations”, “Connected apps” or “Health”). Muscle and water % usually <b>don’t</b> sync to Health – you can type those in on the confirm screen if you want them.</div>
    <ol class="steps">
      <li>Open the <b>Shortcuts</b> app (it comes with your iPhone). Tap <b>+</b> at the top right. Tap the name at the top and call it <b>Log weigh-in</b>.</li>
      <li>Tap <b>Add Action</b>, search for <b>Find Health Samples</b> and tap it. Tap <b>Type</b> and choose <b>Weight</b>. Tap <b>Sort by</b> → <b>Start Date</b>, set <b>Order</b> to <b>Latest First</b>, switch on <b>Limit</b> and set it to <b>1</b>.</li>
      <li>Add another <b>Find Health Samples</b> action set up the same way, but with Type <b>Body Fat Percentage</b>.</li>
      <li><i>(Optional)</i> Add a third one for <b>Lean Body Mass</b> if your scale records it.</li>
      <li>Add a <b>Text</b> action and type in the address below. Where it says <b>[…]</b>, delete that bit and insert a variable instead: tap just above the keyboard to choose the matching <b>Health Samples</b> result, then tap the blue variable and pick <b>Value</b>, <b>Unit</b> or <b>Start Date</b> as shown. For the date, also choose <b>Date Format: ISO 8601</b>.</li>
    </ol>
    <div class="codebox" id="tplBox">${esc(tpl)}</div>
    <button id="copyTpl" class="btn outline block mt8" type="button">Copy this address</button>
    <ol class="steps" start="6">
      <li><b>Finish the shortcut</b> – choose one:
        <ul>
          <li><b>If you use Keto Tracker from your Home Screen (recommended):</b> add the action <b>Copy to Clipboard</b>. Then, after running the shortcut, open Keto Tracker and tap <b>Paste weigh-in from clipboard</b> on the Body screen.</li>
          <li><b>If you use Keto Tracker in Safari:</b> add the action <b>Open URLs</b> instead – the app opens with the reading ready to save.</li>
        </ul>
        <span class="muted small">Why two options? On iPhone, a Home Screen web app keeps its data separately from Safari, and Shortcuts can only open links in Safari.</span></li>
      <li>Tap <b>Done</b>. Run the shortcut once – when asked, allow access to <b>Weight</b> and <b>Body Fat Percentage</b> (and Lean Body Mass) in Health.</li>
      <li><i>(Optional)</i> For true one-tap: in the shortcut, tap the <b>ⓘ</b>/share button → <b>Add to Home Screen</b>. Or make it run automatically: Shortcuts → <b>Automation</b> → <b>+</b> → <b>App</b> → choose your scale app → <b>Is Closed</b> → Run Immediately → pick <b>Log weigh-in</b>.</li>
    </ol>
    <p class="small">If your Health app shows weight in pounds or stones, that’s fine – the <b>unit</b> part tells Keto Tracker which it is.</p>
    <button id="tryImport" class="btn block" type="button">Try it with example numbers</button>
    <div class="sheet-actions"><button class="btn big" type="button" data-close>Close</button></div>`);
}

/* ---------- bindings ---------- */
function bindScales() {
  $('#shortcutHelpBtn').addEventListener('click', openShortcutHelp);
  $('#clipImportBtn').addEventListener('click', async () => {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch (e) { /* denied or unsupported */ }
    if (!text) { toast('Couldn’t read the clipboard – paste into the box below instead', 3500); $('#pasteDetails').open = true; $('#pasteText').focus(); return; }
    const d = extractFromText(text);
    if (!d.weight) { toast('No weight found in the copied text'); $('#pasteDetails').open = true; $('#pasteText').value = text; return; }
    openWeighConfirm(d, 'From your clipboard');
  });
  $('#pasteBtn').addEventListener('click', () => {
    const text = $('#pasteText').value;
    const d = extractFromText(text);
    if (!d.weight && d.bf == null) { toast('Couldn’t find a weight in that text'); return; }
    openWeighConfirm(d, 'From pasted text');
  });
  $('#csvBtn').addEventListener('click', () => $('#csvFile').click());
  $('#csvFile').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    if (!f) return;
    const r = new FileReader();
    r.onload = () => openCsvSheet(f.name, r.result);
    r.onerror = () => toast('Couldn’t read that file');
    r.readAsText(f);
  });
  $('#sheet').addEventListener('click', (e) => {
    if (e.target.closest('#iwSave')) saveWeighConfirm();
    else if (e.target.closest('#csvImport')) commitCsv();
    else if (e.target.closest('#copyTpl')) {
      const t = $('#tplBox').textContent;
      (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast('Address copied')).catch(() => toast('Press and hold the address to copy it'));
    } else if (e.target.closest('#tryImport')) {
      closeSheet(); location.hash = '#/import?weight=82.4&unit=kg&bf=24.1&date=' + todayKey();
    }
  });
  $('#sheet').addEventListener('change', (e) => { if (e.target.id && e.target.id.startsWith('cm')) updateCsvPreview(); if (e.target.id === 'iwDate') { const ex = db.body.weighIns.some(w => w.date === e.target.value); const n = $('#iwNote'); if (n && ex) { n.className = 'note warn'; n.textContent = 'You already have a weigh-in on this date – saving will replace it.'; } } });
  window.addEventListener('hashchange', handleImportRoute);
}
