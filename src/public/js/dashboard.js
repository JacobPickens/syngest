/* --- public/js/dashboard.js --- */
(() => {
  'use strict';

  const el = (id) => document.getElementById(id);
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  const state = {
    tailKey: 'global',
    activeRunId: null,
    runsExpanded: new Set(),
    lastRunsSig: '',
    // First paint should be instant (no pulses).
    hasInitialPillsPaint: false
  };

  /* -------------------- formatting -------------------- */

  function fmtNum(n) {
    if (n == null || Number.isNaN(Number(n))) return '—';
    return Number(n).toLocaleString('en-US');
  }

  const CHI_TZ = 'America/Chicago';

  const CHI_DTF = new Intl.DateTimeFormat('en-US', {
    timeZone: CHI_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  function fmtDateCentral(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '—';
    const parts = CHI_DTF.formatToParts(date);
    const pick = (type) => parts.find((p) => p.type === type)?.value || '';
    const y = pick('year');
    const mo = pick('month');
    const da = pick('day');
    const hh = pick('hour');
    const mm = pick('minute');
    const ss = pick('second');
    return `${y}-${mo}-${da} ${hh}:${mm}:${ss}`;
  }

  // Accept seconds or milliseconds.
  function fmtTs(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return '—';
    const ms = n > 1e12 ? n : n * 1000;
    return fmtDateCentral(new Date(ms));
  }

  function fmtCountdown(ms) {
    if (ms == null || !Number.isFinite(Number(ms))) return '—';
    const s = Math.max(0, Math.floor(Number(ms) / 1000));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
  }

  /* -------------------- UI state -------------------- */

  function setUiState(next) {
    const body = document.body;
    body.classList.remove('state-idle', 'state-grazing', 'state-ingesting');
    body.classList.add(`state-${next}`);

    const btnMap = {
      idle: el('stateIdleBtn'),
      grazing: el('stateGrazingBtn'),
      ingesting: el('stateIngestBtn')
    };

    for (const k of Object.keys(btnMap)) {
      const b = btnMap[k];
      if (!b) continue;
      if (k === next) b.classList.add('active');
      else b.classList.remove('active');
    }

    const label = el('uiStateLabel');
    if (label) {
      label.textContent =
        next === 'idle' ? 'IDLE' :
        next === 'ingesting' ? 'INGESTING' :
        'GRAZING';
    }
  }

  // Requirement: go back to idle when a graze run has completed.
  // "Armed" should not force grazing visuals.
  function deriveUiState(st) {
    const running = !!(st && st.running);
    return running ? 'grazing' : 'idle';
  }

  /* -------------------- background FX -------------------- */

  function getMode() {
    const b = document.body;
    if (b.classList.contains('state-ingesting')) return 'ingesting';
    if (b.classList.contains('state-grazing')) return 'grazing';
    return 'idle';
  }

  function pickStarColor(mode) {
    if (mode === 'ingesting') return 'rgba(255, 150, 50, .95)';
    if (mode === 'idle') return 'rgba(210, 245, 255, .95)';

    // grazing: tasteful random palette (no harsh neon-green)
    const hues = [
      190, // cyan
      210, // blue-cyan
      255, // violet
      305, // magenta
      35,  // amber
      10   // warm red
    ];
    const h = hues[Math.floor(Math.random() * hues.length)];
    const s = 92 + Math.floor(Math.random() * 6);
    const l = 68 + Math.floor(Math.random() * 6);
    return `hsl(${h} ${s}% ${l}%)`;
  }

  function spawnStar() {
    const root = document.querySelector('.shootingStars');
    if (!root) return;

    const mode = getMode();
    const star = document.createElement('div');
    star.className = 'shootingStar';

    // Start slightly off-screen, fly across diagonally.
    const startX = (Math.random() * 120) - 10; // vw
    const startY = (Math.random() * 35) - 15;  // vh (mostly top half)
    const travel = 90 + Math.random() * 55;    // vw-ish
    const fall = 45 + Math.random() * 35;      // vh-ish
    const endX = startX + travel;
    const endY = startY + fall;

    const ang = 18 + Math.random() * 22; // degrees
    const dur = (mode === 'grazing')
      ? (0.85 + Math.random() * 0.85)
      : (1.35 + Math.random() * 1.35);

    const trail = (mode === 'grazing')
      ? (150 + Math.random() * 140)
      : (120 + Math.random() * 140);

    star.style.setProperty('--x0', `${startX}vw`);
    star.style.setProperty('--y0', `${startY}vh`);
    star.style.setProperty('--x1', `${endX}vw`);
    star.style.setProperty('--y1', `${endY}vh`);
    star.style.setProperty('--ang', `${ang}deg`);
    star.style.setProperty('--dur', `${dur}s`);
    star.style.setProperty('--trail', `${Math.round(trail)}px`);
    star.style.setProperty('--star-color', pickStarColor(mode));

    root.appendChild(star);
    const killMs = Math.ceil((dur + 0.2) * 1000);
    window.setTimeout(() => star.remove(), killMs);
  }

  function scheduleStars() {
    let t = null;

    function step() {
      const mode = getMode();

      // idle: rare, grazing: frequent, ingest: steady.
      const nextMs = mode === 'grazing'
        ? (350 + Math.random() * 850)
        : mode === 'ingesting'
          ? (700 + Math.random() * 900)
          : (2400 + Math.random() * 5200);

      // In idle, not every tick spawns.
      const chance = mode === 'idle' ? 0.55 : 1.0;
      if (Math.random() < chance) spawnStar();

      t = window.setTimeout(step, nextMs);
    }

    // kick off after first paint
    t = window.setTimeout(step, 800);
    return () => { if (t) window.clearTimeout(t); };
  }

  /* -------------------- pills + header -------------------- */

  function pulsePill(id) {
    const x = el(id);
    if (!x) return;
    x.classList.remove('pillPulse');
    void x.offsetWidth;
    x.classList.add('pillPulse');
    setTimeout(() => x.classList.remove('pillPulse'), 550);
  }

  function applyPills(p) {
    if (!p) return;

    const allowPulse = state.hasInitialPillsPaint;

    const prev = {
      total: el('pTotalFound')?.textContent,
      lastRun: el('pLastRun')?.textContent,
      thisRun: el('pThisRun')?.textContent,
      first: el('pFirst')?.textContent,
      last: el('pLast')?.textContent
    };

    const thisRunText = p.thisRun && p.thisRun.running
      ? fmtNum(p.thisRun.n || 0)
      : 'Not Running';

    if (el('pTotalFound')) el('pTotalFound').textContent = fmtNum(p.totalFound || 0);
    if (el('pLastRun')) el('pLastRun').textContent = fmtNum(p.lastRun || 0);
    if (el('pThisRun')) el('pThisRun').textContent = thisRunText;
    if (el('pFirst')) el('pFirst').textContent = fmtTs(p.firstHit);
    if (el('pLast')) el('pLast').textContent = fmtTs(p.lastHit);

    if (allowPulse) {
      if (prev.total !== el('pTotalFound')?.textContent) pulsePill('pillTotalFound');
      if (prev.lastRun !== el('pLastRun')?.textContent) pulsePill('pillLastRun');
      if (prev.thisRun !== el('pThisRun')?.textContent) pulsePill('pillThisRun');
      if (prev.first !== el('pFirst')?.textContent) pulsePill('pillFirst');
      if (prev.last !== el('pLast')?.textContent) pulsePill('pillLast');
    }

    // header facts
    if (el('hFirstEver')) el('hFirstEver').textContent = fmtTs(p.firstHit);
    setUiState(deriveUiState(p.runState));

    state.activeRunId = (p.thisRun && p.thisRun.running && p.thisRun.run_id) ? p.thisRun.run_id : null;
    if (!state.hasInitialPillsPaint) state.hasInitialPillsPaint = true;
  }

  async function pollPills() {
    try {
      const r = await fetch('/api/pills');
      const j = await r.json();
      if (!j || j.ok === false) return;

      // scheduler UI bits
      updateSchedule(j.scheduler);
      applyPills(j);
      if (j && j.runState && j.runState.meta && j.runState.meta.runId) {
        if (el('activeRunTag')) el('activeRunTag').textContent = j.runState.meta.runId;
        if (el('mRun')) el('mRun').textContent = j.runState.meta.runId;
      } else {
        if (el('activeRunTag')) el('activeRunTag').textContent = '—';
        if (el('mRun')) el('mRun').textContent = '—';
      }

      if (j && j.runState && j.runState.meta && j.runState.meta.startedAtMs) {
        if (el('mCreated')) el('mCreated').textContent = fmtDateCentral(new Date(j.runState.meta.startedAtMs));
      } else {
        if (el('mCreated')) el('mCreated').textContent = '—';
      }

      if (el('mPort')) el('mPort').textContent = '80';
      if (el('mSource')) el('mSource').textContent = 'authorized';
    } catch {
      // ignore
    }
  }

  async function pollLatestBlock() {
    try {
      const r = await fetch('/api/run/latest');
      const j = await r.json();
      const meta = j && j.meta ? j.meta : null;
      const block = j && j.block ? j.block : null;

      if (el('hLastBlock')) el('hLastBlock').textContent = block && block.ip_block ? block.ip_block : '—';
      if (el('hLastTime')) el('hLastTime').textContent = meta && meta.started_at ? fmtTs(meta.started_at) : '—';
      if (el('mBlock')) el('mBlock').textContent = block && block.ip_block ? block.ip_block : '—';
    } catch {
      // ignore
    }
  }

  /* -------------------- runs view -------------------- */

  function runsSig(rows) {
    return (rows || []).map((r) => `${r.run_id}|${r.started_at}|${r.status}|${r.ips_found}|${r.blocks_scanned}`).join(';');
  }

  function clearNode(n) {
    while (n && n.firstChild) n.removeChild(n.firstChild);
  }

  function td(text) {
    const x = document.createElement('td');
    x.textContent = text;
    return x;
  }

  async function fetchRunIps(runId) {
    const r = await fetch(`/api/runs/${encodeURIComponent(runId)}/ips?limit=500`);
    return r.json();
  }

  function renderRunIpsTable(rows) {
    const wrap = document.createElement('div');
    wrap.className = 'tableWrap scrollY';
    wrap.style.maxHeight = '260px';

    const t = document.createElement('table');
    t.className = 'table';
    t.innerHTML = `
      <thead>
        <tr>
          <th>IP</th><th>Port</th><th>Source</th><th>First hit</th><th>Last hit</th><th>Seen</th>
        </tr>
      </thead>
    `;
    const tb = document.createElement('tbody');

    for (const r of rows || []) {
      const tr = document.createElement('tr');
      tr.appendChild(td(r.ip || ''));
      tr.appendChild(td(r.port != null ? String(r.port) : ''));
      tr.appendChild(td(r.source || ''));
      tr.appendChild(td(fmtTs(r.first_seen)));
      tr.appendChild(td(fmtTs(r.last_seen)));
      tr.appendChild(td(fmtNum(r.seen_count)));
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    wrap.appendChild(t);
    return wrap;
  }

  async function toggleRunExpand(runId, hostTr) {
    const key = runId;

    // remove existing detail row
    const existing = hostTr.nextElementSibling;
    if (existing && existing.dataset && existing.dataset.detailFor === key) {
      existing.remove();
      state.runsExpanded.delete(key);
      hostTr.classList.remove('expanded');
      return;
    }

    // create placeholder
    const detailTr = document.createElement('tr');
    detailTr.dataset.detailFor = key;
    const detailTd = document.createElement('td');
    detailTd.colSpan = 6;
    detailTd.className = 'muted';
    detailTd.textContent = 'loading…';
    detailTr.appendChild(detailTd);

    hostTr.insertAdjacentElement('afterend', detailTr);
    hostTr.classList.add('expanded');
    state.runsExpanded.add(key);

    try {
      const rows = await fetchRunIps(key);
      detailTd.classList.remove('muted');
      clearNode(detailTd);
      detailTd.appendChild(renderRunIpsTable(rows));
    } catch (e) {
      detailTd.className = 'muted';
      detailTd.textContent = `failed to load run IPs: ${String(e && e.message ? e.message : e)}`;
    }
  }

  function renderRuns(rows) {
    const tb = el('runsBody');
    if (!tb) return;

    const sig = runsSig(rows);
    if (sig === state.lastRunsSig) return;
    state.lastRunsSig = sig;

    tb.innerHTML = '';

    for (const r of rows || []) {
      const tr = document.createElement('tr');
      tr.className = 'runRow';
      tr.style.cursor = 'pointer';

      tr.appendChild(td(r.run_id || ''));
      tr.appendChild(td(fmtTs(r.started_at)));
      tr.appendChild(td(fmtNum(r.blocks_scanned || 0)));
      tr.appendChild(td(fmtNum(r.ips_found || 0)));
      tr.appendChild(td(r.initiated_by || '—'));
      tr.appendChild(td(r.status || '—'));

      tr.addEventListener('click', () => toggleRunExpand(r.run_id, tr));
      tb.appendChild(tr);
    }

    if (!rows || rows.length === 0) {
      const tr = document.createElement('tr');
      const x = document.createElement('td');
      x.colSpan = 6;
      x.className = 'muted';
      x.textContent = 'Must have completed a graze first.';
      tr.appendChild(x);
      tb.appendChild(tr);
    }

    if (el('rowsTag')) el('rowsTag').textContent = `${rows ? rows.length : 0} runs`;
  }

  async function pollRuns() {
    try {
      const r = await fetch('/api/runs?limit=25');
      const rows = await r.json();
      renderRuns(rows);
    } catch {
      // ignore
    }
  }

  /* -------------------- run details tab -------------------- */

  function setDetailsEmpty(msg) {
    const e = el('detailsEmpty');
    const w = el('detailsTableWrap');
    if (e) e.textContent = msg || '';
    if (e) e.style.display = 'block';
    if (w) w.style.display = 'none';
  }

  function renderDetails(rows) {
    const tb = el('detailsBody');
    const e = el('detailsEmpty');
    const w = el('detailsTableWrap');
    if (!tb || !e || !w) return;

    tb.innerHTML = '';

    for (const r of rows || []) {
      const tr = document.createElement('tr');
      tr.appendChild(td(r.ip || ''));
      tr.appendChild(td(r.port != null ? String(r.port) : ''));
      tr.appendChild(td(r.source || ''));
      tr.appendChild(td(fmtTs(r.first_seen)));
      tr.appendChild(td(fmtTs(r.last_seen)));
      tr.appendChild(td(fmtNum(r.seen_count)));
      tb.appendChild(tr);
    }

    e.style.display = 'none';
    w.style.display = 'block';
  }

  async function pollDetails() {
    // if running, show current run (activeRunId); else show last completed run
    try {
      let runId = state.activeRunId;

      if (!runId) {
        const r0 = await fetch('/api/runs?limit=1');
        const rows0 = await r0.json();
        if (Array.isArray(rows0) && rows0[0] && rows0[0].run_id) runId = rows0[0].run_id;
      }

      if (!runId) {
        setDetailsEmpty('Must have completed a graze first.');
        return;
      }

      const rows = await fetchRunIps(runId);
      renderDetails(rows);
    } catch {
      setDetailsEmpty('Must have completed a graze first.');
    }
  }

  /* -------------------- blocks list -------------------- */

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderAllowedBlocks(payload) {
    const body = el('allowedBlocksBody');
    if (!body) return;

    const rows = (payload && payload.rows) ? payload.rows : [];
    const totals = payload && payload.totals ? payload.totals : { blocks: 0, scans: 0, ips: 0 };

    if (!Array.isArray(rows) || rows.length === 0) {
      body.innerHTML = '<tr><td colspan="4" class="muted">No blocks configured.</td></tr>';
      if (el('allowedTag')) el('allowedTag').textContent = '0 blocks';
      if (el('allowedBlocksCount')) el('allowedBlocksCount').textContent = '0';
      if (el('allowedBlocksScans')) el('allowedBlocksScans').textContent = '0';
      if (el('allowedBlocksIps')) el('allowedBlocksIps').textContent = '0';
      return;
    }

    let html = '';
    for (const r of rows) {
      const block = r.ip_block || '';
      const last = r.last_scanned_at ? fmtTs(r.last_scanned_at) : '—';
      const scans = fmtNum(r.times_scanned || 0);
      const ips = fmtNum(r.ips_found || 0);
      html += '<tr>' +
        '<td class="mono">' + escapeHtml(block) + '</td>' +
        '<td class="mono">' + escapeHtml(last) + '</td>' +
        '<td class="mono">' + escapeHtml(scans) + '</td>' +
        '<td class="mono">' + escapeHtml(ips) + '</td>' +
      '</tr>';
    }
    body.innerHTML = html;

    if (el('allowedTag')) el('allowedTag').textContent = String(rows.length) + ' blocks';
    if (el('allowedBlocksCount')) el('allowedBlocksCount').textContent = fmtNum(totals.blocks || rows.length);
    if (el('allowedBlocksScans')) el('allowedBlocksScans').textContent = fmtNum(totals.scans || 0);
    if (el('allowedBlocksIps')) el('allowedBlocksIps').textContent = fmtNum(totals.ips || 0);
  }

  async function pollAllowedBlocks() {
    try {
      const r = await fetch('/api/allowed-blocks');
      const j = await r.json();
      if (!j || j.ok === false) return;
      renderAllowedBlocks(j);
    } catch {
      // ignore
    }
  }

  /* -------------------- terminal tail -------------------- */

  function appendConsole(text) {
    if (!text) return;
    const c = el('console');
    if (!c) return;

    const atBottom = (c.scrollHeight - c.scrollTop - c.clientHeight) < 30;
    c.textContent += text;

    if (c.textContent.length > 160000) {
      c.textContent = c.textContent.slice(-120000);
    }
    if (atBottom) c.scrollTop = c.scrollHeight;
  }

  async function pollTail() {
    try {
      const r = await fetch(`/api/tail?key=${encodeURIComponent(state.tailKey)}`);
      const j = await r.json();
      if (!j || j.ok === false) return;

      appendConsole(j.text || '');
      if (el('tailTag')) el('tailTag').textContent = (j.totalBytes != null) ? fmtNum(j.totalBytes) : '—';
      if (el('lastUpdateTag')) el('lastUpdateTag').textContent = fmtDateCentral(new Date());
    } catch {
      // ignore
    }
  }

  /* -------------------- scheduler controls -------------------- */

  function updateSchedule(st) {
    if (!st) return;
    const running = !!st.running;

    if (el('schedState')) el('schedState').textContent = running ? 'RUNNING' : (st.armed ? 'ARMED' : 'IDLE');

    const now = Date.now();
    if (el('countdown')) {
      el('countdown').textContent = st.nextRunAtMs ? fmtCountdown(st.nextRunAtMs - now) : '—';
    }

    const btnArm = el('armBtn');
    const btnDisarm = el('disarmBtn');
    const btnRun = el('runNowBtn');

    if (btnArm) btnArm.disabled = running;
    if (btnDisarm) btnDisarm.disabled = running;
    if (btnRun) btnRun.disabled = running;
  }

  async function postJson(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    return r.json();
  }

  function bindControls() {
    const form = el('schedForm');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const delayMin = Number(el('delayMin')?.value || 15);
        const delaySec = Math.max(60, Math.floor(delayMin * 60));
        await postJson('/api/schedule/arm', { delaySec }).catch(() => null);
        pollPills();
      });
    }

    if (el('disarmBtn')) {
      el('disarmBtn').addEventListener('click', async () => {
        await fetch('/api/schedule/disarm', { method: 'POST' }).catch(() => null);
        pollPills();
      });
    }

    if (el('runNowBtn')) {
      el('runNowBtn').addEventListener('click', async () => {
        await fetch('/api/schedule/run-now', { method: 'POST' }).catch(() => null);
        pollPills();
      });
    }

    // tab buttons
    const runsBtn = el('tabRunsBtn');
    const detailsBtn = el('tabDetailsBtn');

    function activateTab(which) {
      const runsView = el('runsView');
      const detailsView = el('detailsView');

      if (runsBtn) runsBtn.classList.toggle('active', which === 'runs');
      if (detailsBtn) detailsBtn.classList.toggle('active', which === 'details');

      if (runsView) runsView.style.display = which === 'runs' ? '' : 'none';
      if (detailsView) detailsView.style.display = which === 'details' ? '' : 'none';
    }

    if (runsBtn) runsBtn.addEventListener('click', () => activateTab('runs'));
    if (detailsBtn) detailsBtn.addEventListener('click', () => activateTab('details'));
  }

  /* -------------------- loop -------------------- */

  bindControls();

  // background FX loop
  if (!window.__syngestFxManaged) scheduleStars();

  // first paint fast
  pollPills();
  pollLatestBlock();
  pollRuns();
  pollDetails();
  pollBlocks();
  pollTail();

  setInterval(pollPills, 1500);
  setInterval(pollLatestBlock, 4000);
  setInterval(pollRuns, 2500);
  setInterval(pollDetails, 1500);
  setInterval(pollBlocks, 5000);
  setInterval(pollTail, 500);
})();
