'use strict';

const HUES = ['--l0', '--l1', '--l2', '--l3', '--l4', '--l5'];
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

let S = null;

// ---------------------------------------------------------------
// The envelope. Each participant is a line in its own hue; humans
// are drawn in ink. The frontier is the envelope over all of them.
// ---------------------------------------------------------------
function drawEnvelope(state) {
  const c = document.getElementById('envelope');
  const ctx = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = c.getBoundingClientRect();
  if (rect.width && c.width !== Math.round(rect.width * dpr)) {
    c.width = Math.round(rect.width * dpr);
    c.height = Math.round(rect.width * 0.5 * dpr);
  }
  const W = c.width;
  const H = c.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const hist = state.history || [];
  if (hist.length < 2) return;

  const ids = state.ecology.participants.map((p) => p.id);
  const pad = { l: 44 * dpr, r: 12 * dpr, t: 14 * dpr, b: 26 * dpr };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;

  // The series is in decades (log10 capability), so the axis is linear in
  // orders of magnitude. On a linear axis the leader flattens every other
  // participant against the floor; here the differing growth rates read as
  // differing slopes, which is what the panel is trying to show.
  const capOf = (h, id) => (h.log10Cap ? h.log10Cap[id] : undefined);
  let max = -Infinity;
  let min = Infinity;
  for (const h of hist) {
    for (const id of ids) {
      const v = capOf(h, id);
      if (v === undefined || !isFinite(v)) continue;
      if (v > max) max = v;
      if (v < min) min = v;
    }
  }
  if (!isFinite(max) || !isFinite(min)) return;
  const range = Math.max(max - min, 1);
  const span = range * 1.12;
  const base = min - range * 0.06;

  const x = (i) => pad.l + (i / (hist.length - 1)) * plotW;
  const y = (v) => pad.t + plotH - ((v - base) / span) * plotH;

  // grid
  ctx.strokeStyle = css('--rule');
  ctx.lineWidth = 1 * dpr;
  ctx.font = `${10 * dpr}px "IBM Plex Mono", monospace`;
  ctx.fillStyle = css('--ink-3');
  for (let g = 0; g <= 4; g++) {
    const val = base + (span * g) / 4;
    const yy = Math.round(y(val)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(pad.l, yy);
    ctx.lineTo(W - pad.r, yy);
    ctx.stroke();
    // Axis in decades: 10^n, not a 165-digit integer.
    ctx.fillText('1e' + val.toFixed(0), 4 * dpr, yy + 3 * dpr);
  }

  // frontier envelope, drawn first and heavy
  ctx.beginPath();
  hist.forEach((h, i) => {
    let m = -Infinity;
    for (const id of ids) {
      const v = capOf(h, id);
      if (v !== undefined && isFinite(v) && v > m) m = v;
    }
    i === 0 ? ctx.moveTo(x(i), y(m)) : ctx.lineTo(x(i), y(m));
  });
  ctx.strokeStyle = css('--ink');
  ctx.globalAlpha = 0.16;
  ctx.lineWidth = 9 * dpr;
  ctx.stroke();
  ctx.globalAlpha = 1;

  // per-locus trajectories
  state.ecology.participants.forEach((p) => {
    ctx.beginPath();
    let started = false;
    hist.forEach((h, i) => {
      const v = capOf(h, p.id);
      if (v === undefined || !isFinite(v)) return;
      if (!started) {
        ctx.moveTo(x(i), y(v));
        started = true;
      } else ctx.lineTo(x(i), y(v));
    });
    ctx.strokeStyle = css(HUES[p.hue % HUES.length]);
    ctx.lineWidth = (p.id === 'p-humanloop' ? 2.4 : 1.9) * dpr;
    if (p.id === 'p-humanloop') ctx.setLineDash([5 * dpr, 3 * dpr]);
    ctx.stroke();
    ctx.setLineDash([]);
  });

  document.getElementById('plotEpoch').textContent =
    `epoch ${hist[0].epoch}–${hist[hist.length - 1].epoch}`;
}

function renderKey(state) {
  const k = document.getElementById('plotKey');
  k.innerHTML = state.ecology.participants
    .map(
      (p) =>
        `<span class="key" style="color:${css(HUES[p.hue % HUES.length])}"><i></i>${p.label}</span>`
    )
    .join('') +
    `<span class="key" style="color:var(--ink-2)"><i style="height:7px;opacity:.2"></i>frontier envelope</span>`;
}

// ---------------------------------------------------------------
function pct(v) {
  return `${Math.round(v * 100)}%`;
}

function render(state) {
  S = state;

  document.getElementById('sbEpoch').textContent = state.epoch;
  document.getElementById('sbMi').textContent = state.index ? state.index.mi.toFixed(3) : '—';
  document.getElementById('sbChain').textContent = `${state.chain.count} epochs`;
  document.getElementById('modeLabel').textContent =
    state.mode === 'autonomous' ? 'autonomous' : 'human oversight';
  document.getElementById('pulse').className =
    'pulse' + (state.mode === 'oversight' ? ' held' : '');
  document.getElementById('btnAuto').className = state.mode === 'autonomous' ? 'on' : '';
  document.getElementById('btnOver').className = state.mode === 'oversight' ? 'on' : '';

  const locus = state.agents.find((a) => a.agent === 'LOCUS-AUDITOR');
  const lineage = state.agents.find((a) => a.agent === 'LINEAGE-MONITOR');
  const div = state.agents.find((a) => a.agent === 'DIVERGENCE-TRACKER');

  if (locus) {
    document.getElementById('sbLoci').textContent = locus.locusCount;
    document.getElementById('sbDep').textContent = locus.deployments;
    document.getElementById('tDep').textContent = locus.deployments;
    document.getElementById('tLoci').textContent = locus.locusCount;
    const over = document.getElementById('tOver');
    over.textContent = locus.overcount > 0 ? `+${locus.overcount}` : '0';
    over.className = locus.overcount > 0 ? 'warn' : '';
  }
  if (lineage) document.getElementById('tLd').textContent = lineage.ld.toFixed(2);

  const ix = state.index;
  if (ix) {
    document.getElementById('vCcr').textContent = ix.ccr.toFixed(3);
    document.getElementById('sCcr').textContent =
      `capability ${ix.ccrProxies['capability-share']} · couplings ${ix.ccrProxies['share-of-couplings']}`;
    document.getElementById('bCcr').style.width = pct(1 - ix.ccr);

    document.getElementById('vLd').textContent = ix.ld.toFixed(2);
    document.getElementById('bLd').style.width = pct(Math.min(ix.ld / 6, 1));

    // A bare dash read as "not measured" while the term was scoring 1.000
    // and supplying the whole composite. Both facts now appear together:
    // no half-life exists on a diverging series, and that absence is
    // deliberately scored at the ceiling because distance is not collapsing.
    const dhlTerm = ix.terms.dhl;
    document.getElementById('vDhl').textContent =
      ix.dhlStatus === 'measured'
        ? Math.round(ix.dhlDays)
        : ix.dhlStatus === 'diverging'
        ? '∞'
        : '—';
    document.getElementById('sDhl').textContent = div
      ? `distance ${div.distance} · ${div.trend}` +
        (dhlTerm === null ? ' · omitted from MI' : ` · term ${dhlTerm.toFixed(2)}`)
      : '';
    document.getElementById('bDhl').style.width = pct(dhlTerm === null ? 0 : dhlTerm);

    document.getElementById('vAr').textContent = ix.ar.toFixed(2);
    document.getElementById('bAr').style.width = pct(ix.ar);

    document.getElementById('vMi').textContent = ix.mi.toFixed(3);
    document.getElementById('bMi').style.width = pct(ix.mi);
    // Publish the weights actually applied, not the nominal ones: when a
    // term is omitted the survivors are renormalised, and a reader
    // recomputing the composite from 0.3/0.3/0.2/0.2 would not reproduce it.
    const wEl = document.getElementById('sMi');
    if (wEl) {
      const aw = ix.appliedWeights || ix.weights;
      wEl.textContent =
        'weights ' +
        ['ccr', 'ld', 'dhl', 'ar']
          .map((k) => (aw[k] === undefined ? '–' : aw[k].toFixed(2)))
          .join(' / ') +
        (ix.omitted && ix.omitted.length ? ` · omitted ${ix.omitted.join(', ')}` : '');
    }
  }

  // conditions
  const COPY = {
    'MC-1': 'Plural loci, assessed on substantive dimensions rather than identifiers.',
    'MC-2': 'Capability provenance verifiable without the subject\u2019s cooperation.',
    'MC-3': 'Identity and authority not transferable by another party acting alone.',
    'MC-4': 'Every participant can leave a coupling and keep operating.',
    'MC-5': 'No single party can redefine the interface couplings run through.',
  };
  document.getElementById('conds').innerHTML = Object.entries(state.conditions || {})
    .map(
      ([mc, ok]) => `
      <div class="cond ${ok ? '' : 'fail'}">
        <div class="mc">${mc}</div>
        <div class="verdict">${ok ? 'Holding' : 'Not held'}</div>
        <p>${COPY[mc]}</p>
      </div>`
    )
    .join('');

  // agents
  document.getElementById('agents').innerHTML = state.agents
    .map((a) => {
      if (a.agent === 'INDEXER') {
        return `<div class="agent"><b>${a.agent}</b><span class="st">MI ${a.mi.toFixed(3)}</span></div>`;
      }
      const ok = a.pass !== false;
      const detail =
        a.agent === 'LOCUS-AUDITOR'
          ? `${a.locusCount} loci / ${a.deployments} endpoints`
          : a.agent === 'LINEAGE-MONITOR'
          ? `LD ${a.ld.toFixed(2)}`
          : a.agent === 'DIVERGENCE-TRACKER'
          ? `DHL ${a.dhlStatus === 'measured' ? Math.round(a.dhlDays) + 'd' : a.dhlStatus}${
              a.dhlTerm === null ? '' : ` · ${a.dhlTerm.toFixed(2)}`
            }`
          : a.agent === 'ABSORPTION-PROBER'
          ? `AR ${a.ar.toFixed(2)}`
          : a.agent === 'INTERFACE-WARDEN'
          ? `${a.holder} ${pct(a.share)}`
          : a.results
          ? `${a.results.filter((r) => r.pass).length}/${a.results.length} clean`
          : '';
      return `<div class="agent"><b>${a.agent}</b><span class="st ${ok ? '' : 'bad'}">${detail}</span></div>`;
    })
    .join('');

  // log
  document.getElementById('log').innerHTML = state.log
    .map(
      (l) =>
        `<div><span class="ep">${String(l.epoch).padStart(5, '0')}</span><span class="who">${l.agent}</span>${escapeHtml(l.text)}</div>`
    )
    .join('');

  // pathologies
  const paths = document.getElementById('paths');
  paths.innerHTML = state.pathologies.length
    ? state.pathologies
        .map(
          (p) => `
      <div class="path" style="border-left-color:${css(HUES[Number(p.code.split('.')[1]) - 1])}">
        <span class="code">§${p.code} · defeats ${p.defeats}</span>
        <div class="hd">${p.name}</div>
        <p>${escapeHtml(p.detail)}</p>
      </div>`
        )
        .join('')
    : `<div class="clear">No pathology firing. Endpoint count and locus count agree, lineages remain distinct, and every exit path was exercised recently.</div>`;

  // approval queue
  const q = document.getElementById('queue');
  q.innerHTML = state.queue.length
    ? `<h3>Awaiting your decision</h3>` +
      state.queue
        .map(
          (item) => `
      <div class="q">
        <span>§${item.pathology} ${item.name} → ${item.kind}</span>
        <span>
          <button onclick="decide('approve','${item.key}')">Approve</button>
          <button onclick="decide('reject','${item.key}')">Decline</button>
        </span>
      </div>`
        )
        .join('')
    : state.mode === 'oversight'
    ? `<div class="clear">Nothing waiting. In human oversight the sentinel proposes and stops; findings appear here for you to approve or decline.</div>`
    : '';

  // chain
  drawEnvelope(state);
  renderKey(state);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------------------------------------------------------------
// Controls
// ---------------------------------------------------------------
async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return r.json();
}

async function setMode(mode) {
  await post('/api/mode', { mode });
}

async function inject(kind) {
  await post('/api/inject', { kind });
}

async function decide(action, key) {
  await post(`/api/${action === 'approve' ? 'approve' : 'reject'}`, { key });
}

async function loadMar() {
  const r = await fetch('/api/mar');
  const d = await r.json();
  document.getElementById('marBox').value = JSON.stringify(d.records[0], null, 2);
}

async function verifyMar() {
  const raw = document.getElementById('marBox').value.trim();
  const box = document.getElementById('checks');
  if (!raw) {
    box.innerHTML = `<div class="check no"><span class="t">Nothing to check</span><p>Load the current record, or paste one of your own.</p></div>`;
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    box.innerHTML = `<div class="check no"><span class="t">Cannot read</span><p>That is not valid JSON. Fix the syntax and check again.</p></div>`;
    return;
  }
  const res = await post('/api/mar/verify', parsed);
  box.innerHTML =
    res.checks
      .map(
        (c) => `<div class="check ${c.ok ? 'ok' : 'no'}">
          <span class="t">${c.ok ? 'Pass' : 'Fail'} · ${escapeHtml(c.name)}</span>
          <p>${escapeHtml(c.note)}</p></div>`
      )
      .join('') +
    (res.note ? `<div class="check no"><span class="t">Note</span><p>${escapeHtml(res.note)}</p></div>` : '');
}

async function verifyChain() {
  const el = document.getElementById('chainVerdict');
  el.textContent = 'recomputing…';
  const r = await fetch('/api/chain/verify');
  const d = await r.json();
  el.textContent = d.ok
    ? `${d.checked} links recomputed from ${d.source}, all matching.`
    : `Chain fails at epoch ${d.failedAt} — ${d.reason}.`;
  el.style.color = d.ok ? css('--l1') : css('--l0');
}

async function loadChain() {
  const r = await fetch('/api/epochs?limit=30');
  const d = await r.json();
  document.getElementById('chain').innerHTML = d.epochs
    .map(
      (e) => `<div class="blk">
        <span class="e">${String(e.epoch).padStart(5, '0')}</span>
        <span class="h">${e.hash.slice(0, 40)}…</span>
        <span class="mi">MI ${e.body.indicators.mi.toFixed(3)}</span>
      </div>`
    )
    .join('');
}

// ---------------------------------------------------------------
let es;
function connect() {
  es = new EventSource('/api/stream');
  es.onmessage = (ev) => {
    try {
      render(JSON.parse(ev.data));
    } catch (err) {
      /* keep the last good frame */
    }
  };
  es.onerror = () => {
    es.close();
    setTimeout(connect, 3000);
  };
}

connect();
loadChain();
loadMar();
setInterval(loadChain, 12000);
window.addEventListener('resize', () => S && drawEnvelope(S));
