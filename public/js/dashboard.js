/* --- public/js/dashboard.js --- */
(() => {
  'use strict';

  const el = (id) => document.getElementById(id);
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  const state = {
    tailKey: 'global',
    activeRun: null,
    lastRowsSig: '',
    feedSeries: [], // hot uniques over time (per minute-ish)
    feedMaxPoints: 60
  };

  let scheduleState = null;
  let firstEverAtSec = null;

  /* -------------------- formatting -------------------- */

  function fmtNum(n) {
    if (n == null || Number.isNaN(Number(n))) return '—';
    return Number(n).toLocaleString('en-US');
  }

  function fmtTs(sec) {
    if (!sec || !Number.isFinite(Number(sec))) return '—';
    const d = new Date(Number(sec) * 1000);
    return d.toISOString().replace('T', ' ').replace('Z', 'Z');
  }

  function fmtMs(ms) {
    if (ms == null || !Number.isFinite(Number(ms))) return '—';
    const s = Math.max(0, Math.floor(Number(ms) / 1000));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
  }

  /* -------------------- state toggle -------------------- */

  const STATE_KEY = 'syngest_ui_state';

  function setUiState(next) {
    const body = document.body;

    body.classList.remove('state-idle', 'state-grazing', 'state-ingesting');
    body.classList.add(`state-${next}`);

    // update toggle buttons
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

    // label
    const label = el('uiStateLabel');
    if (label) {
      label.textContent =
        next === 'idle' ? 'IDLE' :
        next === 'ingesting' ? 'INGESTING' :
        'GRAZING';
    }

    try { localStorage.setItem(STATE_KEY, next); } catch {}
  }

  function initUiState() {
    let v = null;
    try { v = localStorage.getItem(STATE_KEY); } catch {}
    if (v !== 'idle' && v !== 'grazing' && v !== 'ingesting') v = 'grazing';
    setUiState(v);
  }

  /* -------------------- header + pills -------------------- */

  function setHeaderFacts(meta, block, firstEverSec) {
    if (firstEverSec && Number.isFinite(Number(firstEverSec))) {
      if (firstEverAtSec == null) firstEverAtSec = Number(firstEverSec);
      else firstEverAtSec = Math.min(firstEverAtSec, Number(firstEverSec));
    }

    const lastBlock = block && block.ip_block ? block.ip_block : '—';
    const lastAt = meta && meta.created_at ? fmtTs(meta.created_at) : '—';
    const firstEver = firstEverAtSec ? fmtTs(firstEverAtSec) : '—';

    if (el('hLastBlock')) el('hLastBlock').textContent = lastBlock;
    if (el('hLastTime')) el('hLastTime').textContent = lastAt;
    if (el('hFirstEver')) el('hFirstEver').textContent = firstEver;
  }

  function setMeta(meta, block) {
    if (!meta) {
      if (el('activeRunTag')) el('activeRunTag').textContent = '—';
      if (el('mRun')) el('mRun').textContent = '—';
      if (el('mCreated')) el('mCreated').textContent = '—';
      if (el('mPort')) el('mPort').textContent = '—';
      if (el('mSource')) el('mSource').textContent = '—';
      if (el('mBlock')) el('mBlock').textContent = '—';
      return;
    }

    if (el('activeRunTag')) el('activeRunTag').textContent = meta.run_table || '—';
    if (el('mRun')) el('mRun').textContent = meta.run_table || '—';
    if (el('mCreated')) el('mCreated').textContent = fmtTs(meta.created_at);
    if (el('mPort')) el('mPort').textContent = meta.port != null ? String(meta.port) : '—';
    if (el('mSource')) el('mSource').textContent = meta.source || '—';
    if (el('mBlock')) el('mBlock').textContent = (block && block.ip_block) ? block.ip_block : '—';
  }

  function pulse(id) {
    const x = el(id);
    if (!x) return;
    x.classList.remove('pillPulse');
    // force reflow
    void x.offsetWidth;
    x.classList.add('pillPulse');
    setTimeout(() => x.classList.remove('pillPulse'), 550);
  }

  function applyDbStats(stats) {
    if (!stats) return;

    const prev = {
      unique: el('pUnique')?.textContent,
      total: el('pTotal')?.textContent,
      hot: el('pHot')?.textContent,
      first: el('pFirst')?.textContent,
      last: el('pLast')?.textContent
    };

    const next = {
      unique: fmtNum(stats.unique_ips),
      total: fmtNum(stats.total_observations),
      hot: fmtNum(stats.hot_unique_ips),
      first: fmtTs(stats.first_seen),
      last: fmtTs(stats.last_seen)
    };

    if (el('pUnique')) el('pUnique').textContent = next.unique;
    if (el('pTotal')) el('pTotal').textContent = next.total;
    if (el('pHot')) el('pHot').textContent = next.hot;
    if (el('pFirst')) el('pFirst').textContent = next.first;
    if (el('pLast')) el('pLast').textContent = next.last;

    if (prev.unique !== next.unique) pulse('pillUnique');
    if (prev.total !== next.total) pulse('pillTotal');
    if (prev.hot !== next.hot) pulse('pillHot');
    if (prev.first !== next.first) pulse('pillFirst');
    if (prev.last !== next.last) pulse('pillLast');

    // feed rate (use hot uniques as a real “hits/min” signal)
    if (el('feedRateVal')) el('feedRateVal').textContent = fmtNum(stats.hot_unique_ips ?? 0);

    pushFeedPoint(Number(stats.hot_unique_ips ?? 0));
    drawFeedChart();
  }

  /* -------------------- validated hits table -------------------- */

  function rowSig(rows) {
    if (!rows || !rows.length) return '';
    return rows.map((r) => `${r.ip}|${r.last_seen}|${r.seen_count}|${r._run}`).join(';');
  }

  function renderRows(rows) {
    const tb = el('rowsBody');
    if (!tb) return;

    const sig = rowSig(rows);
    if (sig === state.lastRowsSig) return;
    state.lastRowsSig = sig;

    const currentRun = state.activeRun;

    tb.innerHTML = '';
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.className =
        'ipRow ' +
        ((r._run && currentRun && r._run === currentRun) ? 'currentRun' : 'prevRun');

      const td = (v) => {
        const x = document.createElement('td');
        x.textContent = v;
        return x;
      };

      tr.appendChild(td(r.ip || ''));
      tr.appendChild(td(r.port != null ? String(r.port) : ''));
      tr.appendChild(td(r.source || ''));
      tr.appendChild(td(fmtTs(r.first_seen)));
      tr.appendChild(td(fmtTs(r.last_seen)));
      tr.appendChild(td(fmtNum(r.seen_count)));

      tb.appendChild(tr);

      // new row animation: scale then settle
      if (r._isNew) {
        tr.classList.add('newIp');
        requestAnimationFrame(() => {
          setTimeout(() => tr.classList.add('settle'), 30);
          setTimeout(() => {
            tr.classList.remove('newIp');
            tr.classList.remove('settle');
          }, 1150);
        });
      }
    }
  }

  /* -------------------- terminal tail -------------------- */

  function appendConsole(text) {
    if (!text) return;
    const c = el('console');
    if (!c) return;

    const atBottom = (c.scrollHeight - c.scrollTop - c.clientHeight) < 30;
    c.textContent += text;

    // cap (keep last ~160kb)
    if (c.textContent.length > 160000) {
      c.textContent = c.textContent.slice(-120000);
    }
    if (atBottom) c.scrollTop = c.scrollHeight;
  }

  async function pollTail() {
    try {
      const r = await fetch(`/api/tail?key=${encodeURIComponent(state.tailKey)}`);
      const j = await r.json();
      if (j && j.text) appendConsole(j.text);

      if (el('tailTag')) el('tailTag').textContent = j && j.source ? j.source : '—';
      if (el('lastUpdateTag')) {
        el('lastUpdateTag').textContent = new Date().toISOString().replace('T', ' ').replace('Z', 'Z');
      }
    } catch {}
  }

  /* -------------------- run + db polling -------------------- */

  async function pollLatestRun() {
    try {
      const r = await fetch('/api/run/latest');
      const j = await r.json();

      if (!j || !j.meta) {
        state.activeRun = null;
        setMeta(null, null);
        setHeaderFacts(null, null, null);
        return;
      }

      state.activeRun = j.meta.run_table || null;

      // server may expose either naming
      const firstEver =
        (j.meta && (j.meta.first_ever_created_at || j.meta.firstEverCreatedAt)) ||
        j.first_ever_created_at ||
        j.firstEverCreatedAt ||
        null;

      setMeta(j.meta, j.block || null);
      setHeaderFacts(j.meta, j.block || null, firstEver);

      // keep pills + table refreshing whenever we have an active run
      await pollDbStats();
      await pollRows();
    } catch {}
  }

  async function pollDbStats() {
    if (!state.activeRun) return;
    try {
      const r = await fetch(`/api/run/${encodeURIComponent(state.activeRun)}/stats`);
      const j = await r.json();
      applyDbStats(j);
    } catch {}
  }

  async function pollRows() {
    if (!state.activeRun) return;
    try {
      const r = await fetch(`/api/run/${encodeURIComponent(state.activeRun)}/rows?limit=50`);
      const j = await r.json();

      const rows = Array.isArray(j) ? j : [];
      renderRows(rows);

      if (el('rowsTag')) el('rowsTag').textContent = `${rows.length} rows`;
    } catch {}
  }

  /* -------------------- grazing log (blocks) -------------------- */

  function renderBlocks(rows) {
    const ul = el('blocksList');
    if (!ul) return;

    ul.innerHTML = '';
    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'no blocks yet';
      ul.appendChild(li);
      return;
    }

    for (const b of rows) {
      const li = document.createElement('li');
      const left = document.createElement('span');
      left.className = 'b';
      left.textContent = b.ip_block || '—';

      const right = document.createElement('span');
      right.className = 't';
      right.textContent = b.picked_at ? fmtTs(b.picked_at) : '—';

      li.appendChild(left);
      li.appendChild(right);
      ul.appendChild(li);
    }
  }

  async function pollBlocks() {
    try {
      const r = await fetch('/api/blocks/recent?limit=8');
      const j = await r.json();
      const rows = Array.isArray(j) ? j : [];
      renderBlocks(rows);
      if (el('blocksTag')) el('blocksTag').textContent = `${rows.length} blocks`;
    } catch {}
  }

  /* -------------------- scheduler -------------------- */

  function updateScheduleUi() {
    const st = scheduleState || {};
    const armed = !!st.armed;

    if (el('schedState')) el('schedState').textContent = armed ? 'ARMED' : 'DISARMED';

    if (armed && st.nextRunAtMs && Number.isFinite(Number(st.nextRunAtMs))) {
      const ms = Number(st.nextRunAtMs) - Date.now();
      if (el('countdown')) el('countdown').textContent = fmtMs(ms);
    } else {
      if (el('countdown')) el('countdown').textContent = '—';
    }

    // lock controls during run
    const controls = document.querySelector('.panel.controls');
    if (controls) {
      if (st.running) controls.classList.add('isRunning');
      else controls.classList.remove('isRunning');
    }
  }

  async function fetchSchedule(reset) {
    try {
      const r = await fetch(`/api/schedule/status${reset ? '?reset=1' : ''}`);
      const j = await r.json();
      scheduleState = j;
      updateScheduleUi();
    } catch {}
  }

  async function armSchedule() {
    const raw = (el('delayMin') && el('delayMin').value != null) ? String(el('delayMin').value) : '';
    const vMin = Number(raw);
    if (!Number.isFinite(vMin) || vMin <= 0) {
      if (el('schedState')) el('schedState').textContent = 'ERR';
      appendConsole(`[ui] invalid intake cycle minutes: "${raw}"\n`);
      return;
    }

    const delaySec = Math.max(1, Math.round(vMin * 60));

    try {
      const r = await fetch('/api/schedule/arm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ delaySec })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (el('schedState')) el('schedState').textContent = 'ERR';
        appendConsole(`[ui] arm failed (${r.status}): ${j && j.error ? j.error : 'unknown error'}\n`);
        return;
      }
      scheduleState = j;
      updateScheduleUi();
      await fetchSchedule(true);
    } catch (e) {
      if (el('schedState')) el('schedState').textContent = 'ERR';
      appendConsole(`[ui] arm failed: ${String(e && e.message ? e.message : e)}\n`);
    }
  }

  async function disarmSchedule() {
    try {
      await fetch('/api/schedule/disarm', { method: 'POST' });
      await fetchSchedule(true);
    } catch {}
  }

  async function runNow() {
    try {
      await fetch('/api/schedule/run-now', { method: 'POST' });
      await fetchSchedule(true);
    } catch {}
  }

  function applyActionButtonClasses() {
    const armBtn = el('armBtn');
    const disarmBtn = el('disarmBtn');
    const runNowBtn = el('runNowBtn');

    if (armBtn) armBtn.classList.add('btn-ok');
    if (disarmBtn) disarmBtn.classList.add('btn-danger');
    if (runNowBtn) runNowBtn.classList.add('btn-run');
  }

  /* -------------------- feed chart -------------------- */

  function pushFeedPoint(v) {
    if (!Number.isFinite(v)) v = 0;
    state.feedSeries.push(v);
    if (state.feedSeries.length > state.feedMaxPoints) {
      state.feedSeries.splice(0, state.feedSeries.length - state.feedMaxPoints);
    }
  }

  function drawFeedChart() {
    const canvas = el('feedChart');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const series = state.feedSeries;
    if (!series.length) return;

    const max = Math.max(1, ...series);
    const pad = 12;

    // resolve colors from current state
    const cs = getComputedStyle(document.body);
    const accentA = (cs.getPropertyValue('--accent-a') || '#19C2A0').trim();
    const accentB = (cs.getPropertyValue('--accent-b') || '#2BA6F7').trim();
    const text2 = (cs.getPropertyValue('--text2') || '#A3E5D8').trim();

    // background grid
    ctx.globalAlpha = 0.22;
    ctx.strokeStyle = text2;
    ctx.lineWidth = 1;
    for (let i = 1; i < 6; i++) {
      const y = pad + ((h - pad * 2) * i) / 6;
      ctx.beginPath();
      ctx.moveTo(pad, y);
      ctx.lineTo(w - pad, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // line
    ctx.lineWidth = 2;
    ctx.strokeStyle = accentA;
    ctx.beginPath();

    for (let i = 0; i < series.length; i++) {
      const x = pad + ((w - pad * 2) * i) / Math.max(1, (series.length - 1));
      const y = h - pad - ((h - pad * 2) * (series[i] / max));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // glow line
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = 6;
    ctx.strokeStyle = accentB;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /* -------------------- init -------------------- */

  function init() {
    initUiState();

    // remove noPulse once JS is live (prevents initial flash animation)
    document.body.classList.remove('noPulse');

    // toggle wiring
    el('stateIdleBtn')?.addEventListener('click', () => setUiState('idle'));
    el('stateGrazingBtn')?.addEventListener('click', () => setUiState('grazing'));
    el('stateIngestBtn')?.addEventListener('click', () => setUiState('ingesting'));

    // “INGEST” button is a UI preview: toggles ingesting state (no backend behavior)
    document.querySelector('.btnEnergy')?.addEventListener('click', () => setUiState('ingesting'));

    // action button styling classes
    applyActionButtonClasses();

    // scheduler wiring
    el('schedForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      armSchedule();
    });
    el('disarmBtn')?.addEventListener('click', disarmSchedule);
    el('runNowBtn')?.addEventListener('click', runNow);

    // polls
    setInterval(pollTail, 1000);
    setInterval(() => fetchSchedule(false), 1000);
    setInterval(pollLatestRun, 2000);
    setInterval(pollBlocks, 4000);

    // kick
    pollTail();
    fetchSchedule(true);
    pollLatestRun();
    pollBlocks();
  }

  init();
})();
