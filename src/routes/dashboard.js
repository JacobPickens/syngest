// --- public/js/dashboard.js ---
(function(){
  'use strict';

  const cfg = (window.__DASH_CFG__ || {});
  const POLL_ROWS_MS   = Number(cfg.pollRowsMs  || 2000);
  const POLL_OUT_MS    = Number(cfg.pollOutMs   || 700);
  const POLL_DBSTAT_MS = Number(cfg.pollStatsMs || 1200);
  const MAX_ROWS       = Number(cfg.maxRows     || 200);

  // UI stagger settings (rolling insert feel)
  const INSERT_STAGGER_MS = 120;     // cadence per new IP
  const INSERT_BURST_MAX  = 6;       // max queued inserts per poll to avoid giant spikes

  let activeRun = null;
  let outputResetPending = false;
  let scheduleState = { nextRunAtMs: null, running: false, startedByDashboard: false, lastExit: null };

  const el = (id) => document.getElementById(id);

  // ---- DB table state (diff + staggered inserts) ----
  const rowByIp = new Map();         // ip -> { tr, runTable }
  const pendingAdds = [];            // queue of { ip, row, runTable }
  let pendingTimer = null;

  function fmtNum(n){
    if (n === null || n === undefined) return '—';
    try { return Number(n).toLocaleString(); } catch { return String(n); }
  }

  function fmtTs(sec){
    if (!sec) return '—';
    const d = new Date(sec * 1000);
    return d.toLocaleString();
  }

  function fmtMs(ms){
    if (!ms) return '—';
    const s = Math.max(0, Math.floor(ms/1000));
    const mm = Math.floor(s/60);
    const ss = s % 60;
    return mm.toString().padStart(2,'0') + ':' + ss.toString().padStart(2,'0');
  }

  function setRunSubtitle(meta){
    if (!meta) {
      el('runSub').textContent = 'no runs yet (runs_meta empty)';
      return;
    }
    el('runSub').textContent = meta.run_table + ' // ' + meta.source + ' // port ' + meta.port;
  }

  function clearConsole(){ el('console').textContent = ''; }

  function appendConsole(text){
    if (!text) return;
    const c = el('console');
    const atBottom = (c.scrollTop + c.clientHeight) >= (c.scrollHeight - 12);
    c.textContent += text;
    if (atBottom) c.scrollTop = c.scrollHeight;
  }

  function applyDbStats(stats){
    stats = stats || {};
    el('pUnique').textContent = fmtNum(stats.unique_ips ?? null);
    el('pObs').textContent    = fmtNum(stats.total_observations ?? null);
    el('pHot').textContent    = fmtNum(stats.ips_seen_last_60s ?? null);

    const first = stats.first_seen_min ? new Date(stats.first_seen_min * 1000) : null;
    const last  = stats.last_seen_max ? new Date(stats.last_seen_max * 1000) : null;
    el('pFirst').textContent  = first ? first.toLocaleString() : '—';
    el('pLast').textContent   = last ? last.toLocaleString() : '—';
  }

  function markRunFresh(){
    document.body.classList.add('runFresh');
    setTimeout(() => document.body.classList.remove('runFresh'), 6500);
  }

  async function pollLatestRun(){
    const r = await fetch('/api/latest-run', { cache: 'no-store' }).then(x => x.json()).catch(() => null);
    if (!r || !r.ok) return;

    const meta = r.meta;
    setRunSubtitle(meta);

    if (!meta) return;

    const runChanged = !!(activeRun && meta.run_table !== activeRun);

    if (runChanged) {
      activeRun = meta.run_table;
      clearConsole();
      outputResetPending = true;

      // new run → slightly darker base gray for a moment
      markRunFresh();

      // mark all existing rows as previous-run
      for (const [, rec] of rowByIp) {
        rec.tr.classList.remove('currentRun', 'newIp');
        rec.tr.classList.add('prevRun');
        rec.runTable = rec.runTable || 'unknown';
      }

      // clear any pending stagger inserts from old run
      pendingAdds.length = 0;
    } else if (!activeRun) {
      activeRun = meta.run_table;
      clearConsole();
      outputResetPending = true;
      markRunFresh();
    }

    el('mRun').textContent = meta.run_table;
    el('mSource').textContent = meta.source;
    el('mPort').textContent = meta.port;
    el('mCreated').textContent = new Date(meta.created_at * 1000).toLocaleString();

    const block = r.block;
    if (block && block.ip_block) {
      el('mBlock').textContent = block.ip_block;
      el('mBlockMeta').textContent =
        'picked_at=' + new Date(block.picked_at * 1000).toLocaleString() +
        ' // ns=' + block.ip_block_namespace +
        ' // file=' + block.ip_block_file;
    } else {
      el('mBlock').textContent = '—';
      el('mBlockMeta').textContent = '';
    }
  }

  function buildRowHTML(row){
    return `
      <td title="${row.ip}">${row.ip}</td>
      <td>${fmtNum(row.seen_count)}</td>
      <td>${fmtTs(row.last_seen)}</td>
      <td>${fmtTs(row.first_seen)}</td>
      <td title="${row.source}">${row.source}</td>
      <td>${row.port}</td>
    `;
  }

  function clampTableSize(){
    const tb = el('rowsBody');
    if (!tb) return;
    const rows = tb.querySelectorAll('tr.ipRow');
    if (rows.length <= MAX_ROWS) return;

    const over = rows.length - MAX_ROWS;
    for (let i = 0; i < over; i++) {
      const tr = rows[rows.length - 1 - i];
      const ip = tr && tr.getAttribute('data-ip');
      if (ip) rowByIp.delete(ip);
      tr.remove();
    }
  }

  function ensurePendingTimer(){
    if (pendingTimer) return;
    pendingTimer = setInterval(() => {
      const tb = el('rowsBody');
      if (!tb) return;

      if (pendingAdds.length === 0) {
        clearInterval(pendingTimer);
        pendingTimer = null;
        return;
      }

      const item = pendingAdds.shift();
      if (!item) return;

      // if it somehow already exists now, skip
      if (rowByIp.has(item.ip)) return;

      const tr = document.createElement('tr');
      tr.className = 'ipRow currentRun newIp';
      tr.setAttribute('data-ip', item.ip);
      tr.setAttribute('data-run', item.runTable);
      tr.innerHTML = buildRowHTML(item.row);

      // prepend => pushes list down (rolling effect)
      const firstRow = tb.firstChild;
      tb.insertBefore(tr, firstRow);

      // remove newIp class after glow finishes
      setTimeout(() => tr.classList.remove('newIp'), 1300);

      rowByIp.set(item.ip, { tr, runTable: item.runTable });

      clampTableSize();
    }, INSERT_STAGGER_MS);
  }

  async function pollRows(){
    if (!activeRun) return;

    const r = await fetch('/api/rows?run=' + encodeURIComponent(activeRun) + '&limit=' + MAX_ROWS, { cache: 'no-store' })
      .then(x => x.json()).catch(() => null);
    if (!r || !r.ok) return;

    const rows = r.rows || [];
    const tb = el('rowsBody');
    if (!tb) return;

    if (!rows.length && rowByIp.size === 0) {
      tb.innerHTML = '<tr><td colspan="6" class="small">no rows yet…</td></tr>';
      return;
    } else {
      const placeholder = tb.querySelector('tr td.small[colspan="6"]');
      if (placeholder) tb.innerHTML = '';
    }

    // mark “present in current run snapshot”
    const seenThisPoll = new Set();

    // queue new IPs (staggered insertion)
    let queuedThisPoll = 0;

    for (const row of rows) {
      const ip = row.ip;
      if (!ip) continue;
      seenThisPoll.add(ip);

      const existing = rowByIp.get(ip);

      if (!existing) {
        // if already queued, skip
        const alreadyQueued = pendingAdds.some(x => x.ip === ip);
        if (!alreadyQueued && queuedThisPoll < INSERT_BURST_MAX) {
          pendingAdds.push({ ip, row, runTable: activeRun });
          queuedThisPoll++;
        }
        continue;
      }

      // update existing row (in place)
      existing.runTable = activeRun;
      existing.tr.classList.remove('prevRun');
      existing.tr.classList.add('currentRun');
      existing.tr.setAttribute('data-run', activeRun);
      existing.tr.innerHTML = buildRowHTML(row);
    }

    // Start stagger loop if needed
    if (pendingAdds.length) ensurePendingTimer();

    // anything not in current snapshot becomes prevRun
    for (const [ip, rec] of rowByIp) {
      if (rec.runTable === activeRun && !seenThisPoll.has(ip)) {
        rec.tr.classList.remove('currentRun', 'newIp');
        rec.tr.classList.add('prevRun');
      } else if (rec.runTable !== activeRun) {
        rec.tr.classList.remove('currentRun', 'newIp');
        rec.tr.classList.add('prevRun');
      }
    }

    clampTableSize();
  }

  async function pollDbStats(){
    if (!activeRun) return;
    const r = await fetch('/api/stats?run=' + encodeURIComponent(activeRun), { cache: 'no-store' })
      .then(x => x.json()).catch(() => null);
    if (!r || !r.ok) return;
    applyDbStats(r.stats);
  }

  async function pollOutput(){
    const reset = outputResetPending ? '&reset=1' : '';
    const r = await fetch('/api/output?key=ui' + reset, { cache: 'no-store' })
      .then(x => x.json()).catch(() => null);

    if (outputResetPending) outputResetPending = false;
    if (!r || !r.ok) return;

    const running = !!r.running;
    if (r.text) appendConsole(r.text);

    el('termState').textContent = running ? 'RUNNING' : 'IDLE';
    el('consoleHint').textContent = running ? 'scan running' : 'polling…';

    scheduleState.running = running;
    el('lastUpdateTag').textContent = 'updated ' + new Date().toLocaleTimeString();
  }

  async function fetchConfig(){
    const r = await fetch('/api/config', { cache: 'no-store' }).then(x => x.json()).catch(() => null);
    if (!r || !r.ok) return;
    const v = (r.config && r.config.scanNBlocks) ? Number(r.config.scanNBlocks) : null;
    if (v && document.getElementById('nBlocks')) document.getElementById('nBlocks').value = v;
  }

  async function setBlocks(){
    const inp = document.getElementById('nBlocks');
    if (!inp) return;
    const n = Number(inp.value);
    const r = await fetch('/api/config/scan-n-blocks', {
      method:'POST',
      headers:{'content-type':'application/json'},
      body: JSON.stringify({ nBlocks: n })
    }).then(x => x.json()).catch(() => null);
    if (!r) return;
    if (!r.ok) alert(r.error || 'set failed');
  }

  async function fetchSchedule(){
    const r = await fetch('/api/schedule', { cache: 'no-store' }).then(x => x.json()).catch(() => null);
    if (!r || !r.ok) return;
    scheduleState = r.status || scheduleState;
    updateScheduleUi();
  }

  function updateScheduleUi(){
    const sched = document.querySelector('.sched');
    if (!sched) return;

    const running = !!scheduleState.running;
    sched.classList.toggle('isRunning', running);

    let stateTxt = running ? 'RUNNING' : 'IDLE';
    if (!running && scheduleState.nextRunAtMs) stateTxt = 'ARMED';
    el('schedState').textContent = stateTxt;

    const cd = el('countdown');
    if (!cd) return;

    if (running) { cd.textContent = '—'; return; }
    if (!scheduleState.nextRunAtMs) { cd.textContent = '—'; return; }

    cd.textContent = fmtMs(scheduleState.nextRunAtMs - Date.now());
  }

  async function armSchedule(){
    const vMin = Number(el('delayMin').value);
    const delaySec = Math.round(vMin * 60);
    const r = await fetch('/api/schedule/arm', {
      method:'POST',
      headers:{'content-type':'application/json'},
      body: JSON.stringify({ delaySec })
    }).then(x => x.json()).catch(() => null);
    if (!r) return;
    if (!r.ok) alert(r.error || 'arm failed');
    scheduleState = r.status || scheduleState;
    updateScheduleUi();
  }

  async function cancelSchedule(){
    const r = await fetch('/api/schedule/cancel', { method:'POST' }).then(x => x.json()).catch(() => null);
    if (!r || !r.ok) return;
    scheduleState = r.status || scheduleState;
    updateScheduleUi();
  }

  async function runNow(){
    const r = await fetch('/api/schedule/run-now', { method:'POST' }).then(x => x.json()).catch(() => null);
    if (!r) return;
    if (!r.ok) alert(r.error || 'run-now failed');
    scheduleState = r.status || scheduleState;
    updateScheduleUi();
  }

  function wireButtons(){
    const resetBtn = el('btnResetConsole');
    const bottomBtn = el('btnScrollBottom');
    if (resetBtn) resetBtn.addEventListener('click', () => { clearConsole(); outputResetPending = true; });
    if (bottomBtn) bottomBtn.addEventListener('click', () => { const c = el('console'); c.scrollTop = c.scrollHeight; });

    const armBtn = el('btnArm');
    const cancelBtn = el('btnCancel');
    const runNowBtn = el('btnRunNow');
    if (armBtn) armBtn.addEventListener('click', armSchedule);
    if (cancelBtn) cancelBtn.addEventListener('click', cancelSchedule);
    if (runNowBtn) runNowBtn.addEventListener('click', runNow);

    const setBtn = document.getElementById('btnSetBlocks');
    if (setBtn) setBtn.addEventListener('click', setBlocks);
  }

  function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

  async function doPulseBurst(){
    const repeats = 1 + Math.floor(Math.random() * 4);
    const btns = Array.from(document.querySelectorAll('button'));
    const pills = Array.from(document.querySelectorAll('.hdrPills .pill, .pill'));

    for (let i = 0; i < repeats; i++) {
      document.body.classList.add('gridPulse');

      const pickCount = Math.max(1, Math.min(btns.length, 2 + Math.floor(Math.random() * 4)));
      const pickedBtns = btns.slice().sort(() => Math.random() - 0.5).slice(0, pickCount);
      pickedBtns.forEach(b => b.classList.add('btnPulse'));

      const pillCount = Math.max(2, Math.min(pills.length, 2 + Math.floor(Math.random() * 4)));
      const pickedPills = pills.slice().sort(() => Math.random() - 0.5).slice(0, pillCount);
      pickedPills.forEach(p => p.classList.add('pillPulse'));

      await sleep(260 + Math.floor(Math.random() * 180));

      document.body.classList.remove('gridPulse');
      pickedBtns.forEach(b => b.classList.remove('btnPulse'));
      pickedPills.forEach(p => p.classList.remove('pillPulse'));

      if (i < repeats - 1) await sleep(240 + Math.floor(Math.random() * 320));
    }
  }

  function startRandomPulseLoop(){
    const tick = async () => {
      await doPulseBurst();
      const next = 25000 + Math.floor(Math.random() * 30000);
      setTimeout(tick, next);
    };
    const first = 8000 + Math.floor(Math.random() * 7000);
    setTimeout(tick, first);
  }

  async function doFuzzDisconnect(){
    document.body.classList.add('fuzzOn');
    await sleep(4000);
    document.body.classList.remove('fuzzOn');
  }

  function startRareFuzzLoop(){
    const tick = async () => {
      const next = (180000 + Math.floor(Math.random() * 180000)); // 3–6 min
      if (Math.random() < 0.40) await doFuzzDisconnect();
      setTimeout(tick, next);
    };
    const first = 90000 + Math.floor(Math.random() * 90000);
    setTimeout(tick, first);
  }

  async function boot(){
    wireButtons();

    await pollLatestRun();
    setInterval(pollLatestRun, 1500);

    setInterval(pollRows, POLL_ROWS_MS);
    setInterval(pollOutput, POLL_OUT_MS);
    setInterval(fetchSchedule, 1000);
    setInterval(pollDbStats, POLL_DBSTAT_MS);

    pollRows();
    pollOutput();
    fetchSchedule();
    fetchConfig();
    pollDbStats();

    startRandomPulseLoop();
    startRareFuzzLoop();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
