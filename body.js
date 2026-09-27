/* Keto Tracker – Body & Goals: weigh-ins, trends, Katch-McArdle / Mifflin-St Jeor, goal projection.
   Loaded before app.js; uses helpers ($, db, num, r0, r1 …) from app.js at call time. */
'use strict';

const KCAL_PER_KG = 7700;
const LB_PER_KG = 2.2046226;
const FAT_SHARE = 0.85; // share of weight lost assumed to be fat (rest lean tissue/water)
let planCache = null;

/* ---------- units ---------- */
function kgToStLb(kg) { const lb = kg * LB_PER_KG; let st = Math.floor(lb / 14); let rem = Math.round((lb - st * 14) * 10) / 10; if (rem >= 14) { st++; rem -= 14; } return { st, lb: rem }; }
function fmtW(kg, unit) {
  if (kg == null || !isFinite(kg)) return '—';
  unit = unit || db.body.weightUnit;
  if (unit === 'stlb') { const s = kgToStLb(kg); return `${s.st} st ${r1(s.lb)} lb`; }
  return `${r1(kg)} kg`;
}
function fmtWd(kg, unit) { // weight change
  unit = unit || db.body.weightUnit;
  return unit === 'stlb' ? `${r1(kg * LB_PER_KG)} lb` : `${r1(kg)} kg`;
}
function weightInputsHtml(prefix, kg) {
  if (db.body.weightUnit === 'stlb') {
    const s = kg ? kgToStLb(kg) : { st: '', lb: '' };
    return `<div class="w-pair"><label><input id="${prefix}St" type="number" inputmode="numeric" min="0" max="50" value="${s.st}" aria-label="stone"><span class="suffix">st</span></label>
      <label><input id="${prefix}Lb" type="number" inputmode="decimal" min="0" max="13.9" step="0.1" value="${s.lb === '' ? '' : r1(s.lb)}" aria-label="pounds"><span class="suffix">lb</span></label></div>`;
  }
  return `<input id="${prefix}Kg" type="number" inputmode="decimal" min="20" max="400" step="0.1" value="${kg ? r1(kg) : ''}" placeholder="kg" aria-label="kilograms">`;
}
function readWeight(prefix) {
  if (db.body.weightUnit === 'stlb') {
    const st = numOrNull($('#' + prefix + 'St') && $('#' + prefix + 'St').value), lb = numOrNull($('#' + prefix + 'Lb') && $('#' + prefix + 'Lb').value);
    if (st == null && lb == null) return null;
    const kg = ((st || 0) * 14 + (lb || 0)) / LB_PER_KG; return kg > 0 ? kg : null;
  }
  const kg = numOrNull($('#' + prefix + 'Kg') && $('#' + prefix + 'Kg').value); return kg > 0 ? kg : null;
}
function heightInputsHtml() {
  const cm = num(db.body.heightCm);
  if (db.body.heightUnit === 'ftin') {
    const totalIn = cm ? cm / 2.54 : 0; let ft = Math.floor(totalIn / 12); let inch = Math.round(totalIn - ft * 12); if (inch === 12) { ft++; inch = 0; }
    return `<div class="w-pair"><label><input id="bFt" type="number" inputmode="numeric" min="3" max="8" value="${cm ? ft : ''}" aria-label="feet"><span class="suffix">ft</span></label>
      <label><input id="bIn" type="number" inputmode="decimal" min="0" max="11.9" value="${cm ? inch : ''}" aria-label="inches"><span class="suffix">in</span></label></div>`;
  }
  return `<input id="bCm" type="number" inputmode="decimal" min="100" max="250" value="${cm ? r1(cm) : ''}" placeholder="cm" aria-label="height in cm">`;
}
function readHeight() {
  if (db.body.heightUnit === 'ftin') {
    const ft = numOrNull($('#bFt').value), inch = numOrNull($('#bIn').value);
    if (ft == null && inch == null) return null;
    const cm = ((ft || 0) * 12 + (inch || 0)) * 2.54; return cm > 0 ? cm : null;
  }
  const cm = numOrNull($('#bCm').value); return cm > 0 ? cm : null;
}

/* ---------- trend ---------- */
function sortedWeighIns() { return (db.body.weighIns || []).slice().sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0); }
// rolling average of up to 7 entries within the 7 days ending at `endKey`
function rollingAvg(list, endKey, field) {
  const start = addDays(endKey, -6);
  const w = list.filter(e => e.date >= start && e.date <= endKey && numOrNull(e[field]) != null).slice(-7);
  if (!w.length) return null;
  return w.reduce((a, e) => a + num(e[field]), 0) / w.length;
}
function lbmBoer(kg, cm, sex) {
  if (!(kg > 0 && cm > 0)) return null;
  return sex === 'female' ? 0.252 * kg + 0.473 * cm - 48.3 : 0.407 * kg + 0.267 * cm - 19.2;
}
function mifflinBmr(kg, cm, age, sex) {
  if (!(kg > 0 && cm > 0 && age > 0)) return null;
  return 10 * kg + 6.25 * cm - 5 * age + (sex === 'female' ? -161 : 5);
}
function katchBmr(lbm) { return 370 + 21.6 * lbm; }
function currentStats() {
  const list = sortedWeighIns();
  if (!list.length) return null;
  const last = list[list.length - 1].date;
  const weight = rollingAvg(list, last, 'weight');
  if (!weight) return null;
  const bfPct = rollingAvg(list, last, 'bf');
  const b = db.body;
  let lbm, bf, bfEstimated = false;
  if (bfPct != null) { bf = bfPct / 100; lbm = weight * (1 - bf); }
  else {
    lbm = lbmBoer(weight, num(b.heightCm), b.sex);
    if (lbm == null) return { weight, date: last, n: list.length, incomplete: true };
    bf = 1 - lbm / weight; bfEstimated = true;
  }
  const act = num(b.activity) || 1.375;
  const bmrK = katchBmr(lbm), bmrM = mifflinBmr(weight, num(b.heightCm), num(b.age), b.sex);
  return {
    weight, bf, bfEstimated, lbm, date: last, n: list.length,
    muscle: rollingAvg(list, last, 'muscle'), water: rollingAvg(list, last, 'water'),
    bmrK, tdeeK: bmrK * act, bmrM, tdeeM: bmrM != null ? bmrM * act : null, act
  };
}

/* ---------- plan ---------- */
function daysBetween(a, b) { return Math.round((parseKey(b) - parseKey(a)) / 864e5); }
function buildPlan() {
  if (planCache) return planCache;
  planCache = computePlan();
  return planCache;
}
function computePlan() {
  const b = db.body, g = db.goal;
  const cur = currentStats();
  if (!cur) return { error: 'Log a weigh-in to create a plan.' };
  if (cur.incomplete) return { error: 'Add your height (or a body fat %) so lean body mass can be worked out.' };
  const female = b.sex === 'female';
  const floorKcal = female ? 1200 : 1500;
  const leanBf = female ? 0.25 : 0.15;
  const act = cur.act;
  const H = num(b.heightCm), age = num(b.age);
  const warnings = [];
  const type = g.type || 'lose';
  const start = cur.date;
  let W = cur.weight, lbm = cur.lbm, fat = W - lbm;
  let targetW = null;

  if (type === 'lose') {
    if (g.by === 'bf') {
      const tbf = num(g.targetBf) / 100;
      if (!(tbf > 0.03 && tbf < 0.6)) return { error: 'Enter a target body fat % (e.g. 20).', cur };
      if (tbf >= cur.bf) return { error: `Your target body fat (${r1(tbf * 100)}%) isn’t below your current trend (${r1(cur.bf * 100)}%).`, cur };
      targetW = W - (fat - tbf * W) / (FAT_SHARE - tbf);
    } else {
      targetW = num(g.targetWeight);
      if (!(targetW > 0)) return { error: 'Enter a target weight.', cur };
      if (targetW >= W) return { error: `Your target weight isn’t below your current trend weight (${fmtW(W)}).`, cur };
    }
  } else if (type === 'gain') {
    targetW = num(g.gainTarget);
    if (!(targetW > 0)) return { error: 'Enter a target weight.', cur };
    if (targetW <= W) return { error: `Your target weight isn’t above your current trend weight (${fmtW(W)}).`, cur };
  }

  let rate = clamp(num(g.rate) || 0.7, 0.25, 1.0); // % body weight per week
  const surplus = clamp(num(g.surplus) || 0.075, 0.05, 0.10);
  let requiredRate = null, weeksAvail = null;
  if (type !== 'maintain' && g.targetDate) {
    weeksAvail = daysBetween(start, g.targetDate) / 7;
    if (weeksAvail <= 0) warnings.push({ lvl: 'warn', msg: 'Your target date is before your latest weigh-in, so it has been ignored.' });
    else if (type === 'lose') {
      requiredRate = (1 - Math.pow(targetW / W, 1 / weeksAvail)) * 100;
      if (requiredRate <= 1.0) rate = Math.max(0.25, requiredRate);
    }
  }

  const rows = [];
  let reached = false, cappedWeeks = 0, weeksFloat = 0;
  const maxWeeks = type === 'maintain' ? 12 : 260;
  for (let wk = 0; wk < maxWeeks; wk++) {
    const bmrK = katchBmr(lbm), tdee = bmrK * act;
    const bmrM = mifflinBmr(W, H, age, b.sex);
    const bf = fat / W;
    let kcal, change = 0, weekRate = 0, capped = false;
    if (type === 'lose') {
      weekRate = bf < leanBf ? Math.min(rate, 0.5) : rate;
      const deficit = (W * weekRate / 100) * KCAL_PER_KG / 7;
      const minK = Math.max(bmrK, tdee * 0.75, floorKcal);
      kcal = tdee - deficit;
      if (kcal < minK) { kcal = minK; capped = true; cappedWeeks++; }
      if (kcal >= tdee) { kcal = tdee; }
      change = -(tdee - kcal) * 7 / KCAL_PER_KG;
    } else if (type === 'gain') {
      kcal = tdee * (1 + surplus);
      change = (kcal - tdee) * 7 / KCAL_PER_KG;
    } else {
      kcal = tdee;
    }
    const row = { week: wk, date: addDays(start, wk * 7), weight: W, bf, lbm, tdee, bmrK, bmrM, kcal: Math.round(kcal / 10) * 10, change, capped, rate: weekRate };
    rows.push(row);
    if (type === 'maintain') continue;
    if (type === 'lose' && change > -0.001) { warnings.push({ lvl: 'bad', msg: 'At your current estimates there is no room for a safe deficit (the calorie floor is at or above maintenance). Consider increasing activity rather than eating less.' }); break; }
    const next = W + change;
    if ((type === 'lose' && next <= targetW) || (type === 'gain' && next >= targetW)) {
      weeksFloat = wk + (targetW - W) / change;
      if (type === 'lose') { const d = W - targetW; fat -= d * FAT_SHARE; lbm -= d * (1 - FAT_SHARE); } else { const d = targetW - W; fat += d / 2; lbm += d / 2; }
      W = targetW; reached = true; break;
    }
    if (type === 'lose') { fat += change * FAT_SHARE; lbm += change * (1 - FAT_SHARE); } else { fat += change / 2; lbm += change / 2; }
    W = next;
  }
  if (type !== 'maintain' && !reached && !warnings.some(w => w.lvl === 'bad')) warnings.push({ lvl: 'warn', msg: 'The goal is more than 5 years away at a safe rate – consider a nearer interim goal.' });

  let goalDate = null, maintenanceKcal = null;
  if (reached) {
    goalDate = addDays(start, Math.ceil(weeksFloat * 7));
    maintenanceKcal = Math.round(katchBmr(lbm) * act / 10) * 10;
    rows.push({ week: rows.length, date: goalDate, weight: W, bf: fat / W, lbm, tdee: katchBmr(lbm) * act, kcal: maintenanceKcal, goal: true });
  }
  if (requiredRate != null && type === 'lose') {
    if (requiredRate > 1.0) warnings.push({ lvl: 'bad', msg: `Reaching your goal by ${shortDate(g.targetDate)} would need about ${r1(requiredRate)}% of body weight per week – faster than the 1%/week maximum recommended for keeping muscle. The safe projected date is ${goalDate ? longDate(goalDate) : 'shown below'}.` });
    else if (goalDate && goalDate > g.targetDate) warnings.push({ lvl: 'warn', msg: `The calorie safety limits slow things down, so your target date isn’t quite reachable. Safe projected date: ${longDate(goalDate)}.` });
    else if (goalDate) warnings.push({ lvl: 'ok', msg: `Your target date works: about ${r1(rate)}% of body weight per week gets you there by ${longDate(goalDate)}.` });
  }
  if (type === 'gain' && g.targetDate && goalDate && goalDate > g.targetDate) warnings.push({ lvl: 'warn', msg: `A lean gain (${r0(surplus * 100)}% surplus) gets there by ${longDate(goalDate)} – later than your target date. Faster gains are mostly fat.` });
  if (cappedWeeks && type === 'lose') warnings.push({ lvl: 'warn', msg: 'Calories are held at a safety floor (BMR, 25% below maintenance, or the minimum), so loss is a little slower than the chosen rate in some weeks.' });

  // current week
  const elapsed = daysBetween(start, todayKey());
  let curIdx = Math.max(0, Math.floor(elapsed / 7));
  let current;
  if (curIdx >= rows.length - (reached ? 1 : 0)) {
    current = reached ? rows[rows.length - 1] : rows[rows.length - 1];
    curIdx = rows.indexOf(current);
  } else current = rows[curIdx];

  // protein check at current plan calories
  const protPct = num(db.settings.pct.protein);
  const protSplitG = current.kcal * protPct / 100 / 4;
  const protMin = 1.6 * cur.lbm, protMax = 2.2 * cur.lbm;

  return { cur, type, rows, reached, goalDate, targetW, rate, surplus, warnings, current, curIdx, protSplitG, protMin, protMax, protPct, start, maintenanceKcal, requiredRate };
}
function planKcalFor(k) {
  if (!db.goal || !db.goal.active) return null;
  const p = buildPlan();
  if (!p || p.error) return null;
  // find the row covering date k
  let row = null;
  for (const r of p.rows) { if (r.date <= k) row = r; else break; }
  return (row || p.rows[0]).kcal;
}

/* ---------- charts ---------- */
function lineChart(series, opts = {}) {
  // series: [{points:[[x,y]], colour, dash, dots, width}], x numeric (days), y numeric
  const W = 340, H = opts.h || 170, pl = 38, pr = 10, pt = 10, pb = 22;
  const all = series.flatMap(s => s.points);
  if (!all.length) return '';
  let xmin = Math.min(...all.map(p => p[0])), xmax = Math.max(...all.map(p => p[0]));
  let ymin = Math.min(...all.map(p => p[1]), ...(opts.hlines || []).map(h => h.y)), ymax = Math.max(...all.map(p => p[1]), ...(opts.hlines || []).map(h => h.y));
  if (xmax === xmin) { xmin -= 1; xmax += 1; }
  if (opts.minRange && ymax - ymin < opts.minRange) { const mid = (ymax + ymin) / 2; ymin = mid - opts.minRange / 2; ymax = mid + opts.minRange / 2; }
  const pad = (ymax - ymin) * 0.12 || 1; ymin -= pad; ymax += pad;
  const X = x => pl + (x - xmin) / (xmax - xmin) * (W - pl - pr);
  const Y = y => pt + (1 - (y - ymin) / (ymax - ymin)) * (H - pt - pb);
  const ticks = 4; let grid = '';
  for (let i = 0; i <= ticks; i++) {
    const v = ymin + (ymax - ymin) * i / ticks, y = Y(v);
    grid += `<line class="grid" x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}"/><text x="${pl - 4}" y="${y + 3}" text-anchor="end">${opts.yfmt ? opts.yfmt(v) : fmtInt(Math.round(v / 10) * 10)}</text>`;
  }
  const xl = opts.xlabels || [];
  const xlab = xl.map(([x, t], i) => `<text x="${X(x)}" y="${H - 6}" text-anchor="${xl.length > 1 && i === 0 ? 'start' : xl.length > 1 && i === xl.length - 1 ? 'end' : 'middle'}">${esc(t)}</text>`).join('');
  const hl = (opts.hlines || []).map(h => `<line x1="${pl}" x2="${W - pr}" y1="${Y(h.y)}" y2="${Y(h.y)}" stroke="${h.colour}" stroke-width="1.5" stroke-dasharray="5 4"/>`).join('');
  const lines = series.map(s => {
    const pts = s.points.map(p => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ');
    const dots = s.dots ? s.points.map(p => `<circle cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="2.6" fill="${s.colour}" opacity="${s.dotOpacity || 1}"/>`).join('') : '';
    const line = s.noLine ? '' : `<polyline points="${pts}" fill="none" stroke="${s.colour}" stroke-width="${s.width || 2.5}" stroke-linejoin="round" stroke-linecap="round" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''}/>`;
    return line + dots;
  }).join('');
  return `<svg class="svg-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || 'chart')}">${grid}${hl}${lines}${xlab}</svg>`;
}
function dispW(kg) { return db.body.weightUnit === 'stlb' ? kg * LB_PER_KG / 14 : kg; }
function dispWfmt(v) { return db.body.weightUnit === 'stlb' ? r1(v) + 'st' : r0(v); }

/* ---------- render ---------- */
function renderBody() {
  const b = db.body, g = db.goal;
  $$('#bSexSeg button').forEach(x => x.classList.toggle('active', x.dataset.sex === b.sex));
  $$('#hUnitSeg button').forEach(x => x.classList.toggle('active', x.dataset.u === b.heightUnit));
  $$('#wUnitSeg button').forEach(x => x.classList.toggle('active', x.dataset.u === b.weightUnit));
  $('#bAge').value = b.age || '';
  $('#bActivity').value = b.activity || '1.375';
  $('#heightInputs').innerHTML = heightInputsHtml();
  if (!$('#wDate').value) $('#wDate').value = todayKey();
  $('#wDate').max = todayKey();
  const last = sortedWeighIns().slice(-1)[0];
  if (!$('#weightInputs').dataset.init || $('#weightInputs').dataset.unit !== b.weightUnit) {
    $('#weightInputs').innerHTML = weightInputsHtml('w', null);
    $('#weightInputs').dataset.init = '1'; $('#weightInputs').dataset.unit = b.weightUnit;
    const ph = last ? fmtW(last.weight) : '';
    const first = $('#weightInputs input'); if (first && ph) first.placeholder = 'last ' + ph;
  }
  $$('#gTypeSeg button').forEach(x => x.classList.toggle('active', x.dataset.gt === (g.type || 'lose')));
  $('#gActive').checked = !!g.active;
  renderGoalInputs();
  renderBodyStats();
  renderPlan();
}
function renderGoalInputs() {
  const g = db.goal, type = g.type || 'lose';
  let html = '';
  if (type === 'lose') {
    html += `<div class="field-label">Target</div>
      <div id="gBySeg" class="seg seg-2"><button type="button" data-by="weight" class="${g.by !== 'bf' ? 'active' : ''}">Goal weight</button><button type="button" data-by="bf" class="${g.by === 'bf' ? 'active' : ''}">Goal body fat %</button></div>
      <div class="two mt12">
        ${g.by === 'bf'
        ? `<label class="field"><span class="field-label">Target body fat %</span><input id="gBf" type="number" inputmode="decimal" min="5" max="50" step="0.5" value="${g.targetBf || ''}" placeholder="e.g. 18"></label>`
        : `<div class="field"><span class="field-label">Target weight (${db.body.weightUnit === 'stlb' ? 'st/lb' : 'kg'})</span>${weightInputsHtml('gW', num(g.targetWeight) || null)}</div>`}
        <label class="field"><span class="field-label">Target date (optional)</span><input id="gDate" type="date" value="${g.targetDate || ''}" min="${todayKey()}"></label>
      </div>
      <label class="field"><span class="field-label">Rate of loss</span>
        <select id="gRate">
          ${[[0.5, 'Steady – 0.5% of body weight/week'], [0.7, 'Recommended – 0.7%/week'], [0.85, 'Brisk – 0.85%/week'], [1.0, 'Maximum – 1%/week']].map(([v, l]) => `<option value="${v}" ${num(g.rate || 0.7) === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></label>
      <p class="muted small" style="margin-top:-4px">If you set a target date that’s achievable, the plan uses the gentlest rate that meets it.</p>`;
  } else if (type === 'gain') {
    html += `<div class="two">
        <div class="field"><span class="field-label">Target weight (${db.body.weightUnit === 'stlb' ? 'st/lb' : 'kg'})</span>${weightInputsHtml('gW', num(g.gainTarget) || null)}</div>
        <label class="field"><span class="field-label">Target date (optional)</span><input id="gDate" type="date" value="${g.targetDate || ''}" min="${todayKey()}"></label>
      </div>
      <label class="field"><span class="field-label">Calorie surplus</span>
        <select id="gSurplus">${[[0.05, 'Lean – 5% above maintenance'], [0.075, 'Moderate – 7.5%'], [0.10, 'Faster – 10%']].map(([v, l]) => `<option value="${v}" ${num(g.surplus || 0.075) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
  } else {
    html += `<p class="muted small">Maintenance: calories are set to your estimated TDEE at your current trend weight, and update as your weigh-ins change.</p>`;
  }
  $('#goalInputs').innerHTML = html;
}
function renderBodyStats() {
  const c = currentStats();
  const el = $('#bodyStats');
  const list = sortedWeighIns();
  if (!c) { el.innerHTML = '<p class="muted small">No weigh-ins yet. Log one above to see your trend, lean mass and maintenance calories.</p>'; $('#weightChart').innerHTML = ''; $('#weighList').innerHTML = ''; return; }
  if (c.incomplete) {
    el.innerHTML = `<div class="stats-grid"><div><span class="stat-label">Weight trend</span><span class="stat-val">${fmtW(c.weight)}</span></div></div><p class="muted small">Add your height (or log body fat %) to calculate lean mass and calories.</p>`;
  } else {
    const est = c.bfEstimated ? ' <span class="est">estimated</span>' : '';
    el.innerHTML = `<div class="stats-grid">
      <div><span class="stat-label">Weight trend</span><span class="stat-val">${fmtW(c.weight)}</span></div>
      <div><span class="stat-label">Body fat trend${est}</span><span class="stat-val">${r1(c.bf * 100)}%</span></div>
      <div><span class="stat-label">Lean body mass${est}</span><span class="stat-val">${fmtW(c.lbm)}</span></div>
      <div><span class="stat-label">Fat mass</span><span class="stat-val">${fmtW(c.weight - c.lbm)}</span></div>
      ${c.muscle != null ? `<div><span class="stat-label">Muscle % (scales)</span><span class="stat-val">${r1(c.muscle)}%</span></div>` : ''}
      ${c.water != null ? `<div><span class="stat-label">Water % (scales)</span><span class="stat-val">${r1(c.water)}%</span></div>` : ''}
    </div>
    <div class="cmp"><table>
      <tr><th>Method</th><th>BMR</th><th>Maintenance (TDEE)</th></tr>
      <tr><td><b>Katch-McArdle</b> (used)</td><td>${fmtInt(c.bmrK)}</td><td><b>${fmtInt(c.tdeeK)} kcal</b></td></tr>
      <tr><td>Mifflin-St Jeor</td><td>${c.bmrM != null ? fmtInt(c.bmrM) : '—'}</td><td>${c.tdeeM != null ? fmtInt(c.tdeeM) + ' kcal' : '<span class="muted">add age &amp; height</span>'}</td></tr>
    </table></div>
    <p class="muted small">Based on ${Math.min(7, list.filter(e => e.date >= addDays(c.date, -6)).length)} weigh-in(s) in the 7 days to ${shortDate(c.date)}. Muscle and water % are shown for reference only – they aren’t used in the calculations.</p>`;
  }
  // chart of raw weigh-ins + trend
  const recent = list.slice(-60);
  if (recent.length >= 2) {
    const base = recent[0].date;
    const raw = recent.map(e => [daysBetween(base, e.date), dispW(e.weight)]);
    const trend = recent.map(e => [daysBetween(base, e.date), dispW(rollingAvg(list, e.date, 'weight'))]);
    const xl = [[0, shortDate(recent[0].date).replace(/^\w+ /, '')], [raw[raw.length - 1][0], shortDate(recent[recent.length - 1].date).replace(/^\w+ /, '')]];
    $('#weightChart').innerHTML = lineChart([
      { points: raw, colour: css('--muted'), noLine: true, dots: true, dotOpacity: .6 },
      { points: trend, colour: css('--primary') }
    ], { xlabels: xl, yfmt: dispWfmt, label: 'Weight trend' }) +
      `<div class="chart-legend"><span><i style="background:${css('--muted')}"></i>Daily readings</span><span><i style="background:${css('--primary')}"></i>7-day trend</span></div>`;
  } else $('#weightChart').innerHTML = '<p class="muted small">Log a few more weigh-ins to see a trend chart.</p>';
  $('#weighList').innerHTML = list.slice().reverse().slice(0, 60).map(e => `<div class="wrow">
      <span><b>${shortDate(e.date)}</b> · ${fmtW(e.weight)}${e.bf != null ? ` · ${r1(e.bf)}% fat` : ''}${e.muscle != null ? ` · ${r1(e.muscle)}% muscle` : ''}${e.water != null ? ` · ${r1(e.water)}% water` : ''}</span>
      <button class="f-act" type="button" data-delweigh="${esc(e.id)}" aria-label="Delete weigh-in">🗑</button></div>`).join('');
}
function renderPlan() {
  const out = $('#planOut');
  const p = buildPlan();
  if (p.error) { out.innerHTML = `<div class="note warn">${esc(p.error)}</div>`; return; }
  const c = p.cur, cw = p.current;
  const tdeeNow = cw.tdee;
  const diff = cw.kcal - tdeeNow;
  const warn = p.warnings.map(w => `<div class="note ${w.lvl === 'bad' ? 'bad' : w.lvl === 'warn' ? 'warn' : ''}">${esc(w.msg)}</div>`).join('');
  const protShort = p.protSplitG < p.protMin;
  const protHtml = `<div class="note ${protShort ? 'warn' : ''}">Protein: your ${r0(p.protPct)}% split gives <b>${r0(p.protSplitG)} g/day</b> at ${fmtInt(cw.kcal)} kcal. Recommended for keeping muscle: <b>${r0(p.protMin)}–${r0(p.protMax)} g/day</b> (1.6–2.2 g per kg lean mass${c.bfEstimated ? ', estimated' : ''}).${protShort ? ` That’s about ${r0(p.protMin - p.protSplitG)} g short – consider raising protein to ~${Math.ceil(p.protMin * 4 / cw.kcal * 100)}% in Settings (and reducing fat to match).` : ' ✓'}</div>`;
  let summary = `<div class="plan-summary">
    <div class="wide"><span>${cw.goal ? 'Goal reached (projected) – maintenance' : `This week’s daily calories (week ${cw.week + 1})`}</span><b>${fmtInt(cw.kcal)} kcal</b>
      <span>${cw.goal ? '' : diff < -5 ? `${fmtInt(-diff)} kcal below maintenance (${fmtInt(tdeeNow)})` : diff > 5 ? `${fmtInt(diff)} kcal above maintenance (${fmtInt(tdeeNow)})` : 'at maintenance'}</span></div>`;
  if (p.type !== 'maintain') {
    summary += `<div><span>Goal</span><b>${fmtW(p.targetW)}</b><span>${p.type === 'lose' ? `≈ ${r1(p.rows[p.rows.length - 1].bf * 100)}% body fat` : ''}</span></div>
      <div><span>Estimated goal date</span><b>${p.goalDate ? shortDate(p.goalDate) : '—'}</b><span>${p.goalDate ? `${Math.max(1, Math.round(daysBetween(p.start, p.goalDate) / 7))} weeks` : ''}</span></div>
      <div><span>Expected change this week</span><b>${cw.goal ? '—' : (cw.change > 0 ? '+' : '') + fmtWd(cw.change)}</b><span>${p.type === 'lose' && !cw.goal ? `${r1(-cw.change / cw.weight * 100)}% of body weight` : ''}</span></div>
      <div><span>Total to ${p.type === 'lose' ? 'lose' : 'gain'}</span><b>${fmtWd(Math.abs(c.weight - p.targetW))}</b><span>from ${fmtW(c.weight)}</span></div>`;
  }
  summary += '</div>';

  // projection chart
  let chart = '';
  if (p.type !== 'maintain' && p.rows.length >= 2) {
    const wPts = p.rows.map(r => [daysBetween(p.start, r.date), dispW(r.weight)]);
    const last = p.rows[p.rows.length - 1];
    chart = `<h3 class="card-title mt12" style="margin-bottom:4px">Projected weight</h3>` + lineChart([{ points: wPts, colour: css('--primary') }], {
      hlines: [{ y: dispW(p.targetW), colour: css('--amber') }], yfmt: dispWfmt, label: 'Projected weight',
      xlabels: [[0, 'now'], [daysBetween(p.start, last.date), shortDate(last.date).replace(/^\w+ /, '')]]
    }) + `<div class="chart-legend"><span><i style="background:${css('--primary')}"></i>Projected weight</span><span><i style="background:${css('--amber')}"></i>Goal</span></div>`;
    const kPts = p.rows.filter(r => !r.goal).map(r => [daysBetween(p.start, r.date), r.kcal]);
    if (kPts.length >= 2) chart += `<h3 class="card-title mt12" style="margin-bottom:4px">Daily calorie target</h3>` + lineChart([{ points: kPts, colour: css('--kcal') }], { h: 130, minRange: 300, label: 'Daily calorie target', xlabels: [[0, 'now'], [kPts[kPts.length - 1][0], 'wk ' + (kPts.length)]] });
  }
  const table = `<div class="table-wrap"><table class="ptable">
    <thead><tr><th>Week</th><th>Starting</th><th>Weight</th><th>Body fat</th><th>kcal/day</th></tr></thead>
    <tbody>${p.rows.map((r, i) => `<tr class="${r.goal ? 'goal' : i === p.curIdx ? 'current' : ''}">
      <td>${r.goal ? '🎯 Goal' : r.week + 1}</td><td>${shortDate(r.date).replace(/^\w+ /, '')}</td><td>${fmtW(r.weight)}</td><td>${r1(r.bf * 100)}%</td><td>${fmtInt(r.kcal)}${r.capped ? '*' : ''}</td></tr>`).join('')}</tbody>
  </table></div>
  <p class="muted small">Week 1 starts from your latest weigh-in trend (${shortDate(p.start)}). Maintenance is recalculated each week from the projected weight; * = held at a safety floor. Log weigh-ins regularly and the plan re-projects from your real trend.</p>`;
  out.innerHTML = warn + summary + protHtml + chart + table;
}

/* ---------- actions ---------- */
function saveProfile() {
  const b = db.body;
  b.age = $('#bAge').value;
  const h = readHeight(); b.heightCm = h ? Math.round(h * 10) / 10 : '';
  b.activity = $('#bActivity').value;
  save(); renderBodyStats(); renderPlan();
}
function saveWeighIn() {
  const date = $('#wDate').value || todayKey();
  const weight = readWeight('w');
  if (!(weight > 20 && weight < 400)) { toast('Enter your weight'); return; }
  const f = id => { const v = numOrNull($(id).value); return v != null && v > 0 && v < 100 ? v : null; };
  const entry = { id: uid(), date, weight: Math.round(weight * 100) / 100, bf: f('#wBf'), muscle: f('#wMuscle'), water: f('#wWater') };
  db.body.weighIns = (db.body.weighIns || []).filter(e => e.date !== date);
  db.body.weighIns.push(entry);
  save();
  $$('#weightInputs input, #wBf, #wMuscle, #wWater').forEach(i => { i.value = ''; });
  $('#weightInputs').dataset.init = '';
  toast(`Weigh-in saved for ${niceDay(date).toLowerCase() === 'today' ? 'today' : shortDate(date)}`);
  renderBody();
}
function saveGoal() {
  const g = db.goal, type = g.type || 'lose';
  if (type !== 'maintain') {
    if ($('#gDate')) g.targetDate = $('#gDate').value || '';
    if (type === 'lose' && g.by === 'bf') { if ($('#gBf')) g.targetBf = $('#gBf').value; }
    else { const w = readWeight('gW'); const v = w ? Math.round(w * 100) / 100 : ''; if (type === 'gain') g.gainTarget = v; else g.targetWeight = v; }
    if ($('#gRate')) g.rate = num($('#gRate').value);
    if ($('#gSurplus')) g.surplus = num($('#gSurplus').value);
  }
  save(); renderPlan();
}
function bindBody() {
  $('#bSexSeg').addEventListener('click', e => { const x = e.target.closest('[data-sex]'); if (x) { db.body.sex = x.dataset.sex; save(); renderBody(); } });
  $('#hUnitSeg').addEventListener('click', e => { const x = e.target.closest('[data-u]'); if (x) { saveProfile(); db.body.heightUnit = x.dataset.u; save(); renderBody(); } });
  $('#wUnitSeg').addEventListener('click', e => { const x = e.target.closest('[data-u]'); if (x) { saveGoal(); db.body.weightUnit = x.dataset.u; save(); renderBody(); } });
  $('#bAge').addEventListener('input', saveProfile);
  $('#bActivity').addEventListener('change', saveProfile);
  $('#heightInputs').addEventListener('input', saveProfile);
  $('#wSave').addEventListener('click', saveWeighIn);
  $('#weighList').addEventListener('click', e => {
    const x = e.target.closest('[data-delweigh]');
    if (x && confirm('Delete this weigh-in?')) { db.body.weighIns = db.body.weighIns.filter(w => w.id !== x.dataset.delweigh); save(); renderBody(); }
  });
  $('#gTypeSeg').addEventListener('click', e => { const x = e.target.closest('[data-gt]'); if (x) { saveGoal(); db.goal.type = x.dataset.gt; save(); renderBody(); } });
  $('#goalInputs').addEventListener('click', e => { const x = e.target.closest('[data-by]'); if (x) { saveGoal(); db.goal.by = x.dataset.by; save(); renderGoalInputs(); renderPlan(); } });
  $('#goalInputs').addEventListener('input', saveGoal);
  $('#goalInputs').addEventListener('change', saveGoal);
  bindScales();
  $('#gActive').addEventListener('change', e => { db.goal.active = e.target.checked; save(); renderPlan(); toast(e.target.checked ? 'Daily calorie target now follows your plan' : 'Using your manual calorie target'); });
}
