/* --- public/js/dashboard.js --- */
/* :contentReference[oaicite:0]{index=0} */
(() => {
  'use strict';

  const el = (id) => document.getElementById(id);
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  const state = {
    tailKey: 'global',
    activeRun: null,
    lastRowsSig: '',
    schedule: null
  };

  let scheduleState = null;
  let firstEverAtSec = null;

  function fmtNum(n){
    if (n == null || Number.isNaN(Number(n))) return '—';
    return Number(n).toLocaleString('en-US');
  }

  function fmtTs(sec){
    if (!sec || !Number.isFinite(Number(sec))) return '—';
    const d = new Date(Number(sec) * 1000);
    return d.toISOString().replace('T',' ').replace('Z','Z');
  }

  function fmtMs(ms){
    if (ms == null || !Number.isFinite(Number(ms))) return '—';
    const s = Math.max(0, Math.floor(Number(ms)/1000));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return String(m).padStart(2,'0') + ':' + String(r).padStart(2,'0');
  }

  function setHeaderFacts(meta, block, firstEverSec){
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

  function setMeta(meta, block){
    if (!meta) {
      el('activeRunTag').textContent = 'no runs';
      el('mRun').textContent = '—';
      el('mCreated').textContent = '—';
      el('mPort').textContent = '—';
      el('mSource').textContent = '—';
      el('mBlock').textContent = '—';
      return;
    }

    el('activeRunTag').textContent = meta.run_table || '—';
    el('mRun').textContent = meta.run_table || '—';
    el('mCreated').textContent = fmtTs(meta.created_at);
    el('mPort').textContent = meta.port != null ? String(meta.port) : '—';
    el('mSource').textContent = meta.source || '—';
    el('mBlock').textContent = (block && block.ip_block) ? block.ip_block : '—';
  }

  function pulse(id){
    const x = el(id);
    if (!x) return;
    x.classList.remove('pillPulse');
    // force reflow
    void x.offsetWidth;
    x.classList.add('pillPulse');
    setTimeout(() => x.classList.remove('pillPulse'), 550);
  }

  function applyDbStats(stats){
    if (!stats) return;

    const prev = {
      unique: el('pUnique').textContent,
      total: el('pTotal').textContent,
      hot: el('pHot').textContent,
      first: el('pFirst').textContent,
      last: el('pLast').textContent
    };

    const next = {
      unique: fmtNum(stats.unique_ips),
      total: fmtNum(stats.total_observations),
      hot: fmtNum(stats.hot_unique_ips),
      first: fmtTs(stats.first_seen),
      last: fmtTs(stats.last_seen)
    };

    el('pUnique').textContent = next.unique;
    el('pTotal').textContent = next.total;
    el('pHot').textContent = next.hot;
    el('pFirst').textContent = next.first;
    el('pLast').textContent = next.last;

    if (prev.unique !== next.unique) pulse('pillUnique');
    if (prev.total !== next.total) pulse('pillTotal');
    if (prev.hot !== next.hot) pulse('pillHot');
    if (prev.first !== next.first) pulse('pillFirst');
    if (prev.last !== next.last) pulse('pillLast');
  }

  function rowSig(rows){
    if (!rows || !rows.length) return '';
    return rows.map(r => `${r.ip}|${r.last_seen}|${r.seen_count}|${r._run}`).join(';');
  }

  function renderRows(rows){
    const tb = el('rowsBody');
    if (!tb) return;

    const sig = rowSig(rows);
    if (sig === state.lastRowsSig) return;
    state.lastRowsSig = sig;

    const currentRun = state.activeRun;

    tb.innerHTML = '';
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.className = 'ipRow ' + ((r._run && currentRun && r._run === currentRun) ? 'currentRun' : 'prevRun');

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
          setTimeout(() => { tr.classList.remove('newIp'); tr.classList.remove('settle'); }, 1150);
        });
      }
    }
  }

  function appendConsole(text){
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

  function appendConsoleLine(line){
    const s = String(line ?? '');
    appendConsole(s.endsWith('\n') ? s : s + '\n');
  }

  async function pollTail(){
    try {
      const r = await fetch(`/api/tail?key=${encodeURIComponent(state.tailKey)}`);
      const j = await r.json();
      if (j && j.text) appendConsole(j.text);
      el('tailTag').textContent = j && j.source ? j.source : '—';
      el('lastUpdateTag').textContent = new Date().toISOString().replace('T',' ').replace('Z','Z');
    } catch {}
  }

  async function pollLatestRun(){
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

      // support either naming from server
      const firstEver =
        (j.meta && (j.meta.first_ever_created_at || j.meta.firstEverCreatedAt)) ||
        j.first_ever_created_at ||
        j.firstEverCreatedAt ||
        null;

      setMeta(j.meta, j.block || null);
      setHeaderFacts(j.meta, j.block || null, firstEver);

      // keep pills refreshing whenever we have an active run
      await pollDbStats();
      await pollRows();
    } catch {}
  }

  async function pollDbStats(){
    if (!state.activeRun) return;
    try {
      const r = await fetch(`/api/run/${encodeURIComponent(state.activeRun)}/stats`);
      const j = await r.json();
      applyDbStats(j);
    } catch {}
  }

  async function pollRows(){
    if (!state.activeRun) return;
    try {
      const r = await fetch(`/api/run/${encodeURIComponent(state.activeRun)}/rows?limit=50`);
      const j = await r.json();
      renderRows(Array.isArray(j) ? j : []);
      el('rowsTag').textContent = `${Array.isArray(j) ? j.length : 0} rows`;
    } catch {}
  }

  function updateScheduleUi(){
    const st = scheduleState || {};
    const armed = !!st.armed;
    el('schedState').textContent = armed ? 'ARMED' : 'DISARMED';

    if (armed && st.nextRunAtMs && Number.isFinite(Number(st.nextRunAtMs))) {
      const ms = Number(st.nextRunAtMs) - Date.now();
      el('countdown').textContent = fmtMs(ms);
    } else if (armed) {
      el('countdown').textContent = '—';
    } else {
      el('countdown').textContent = '—';
    }

    // lock form during run
    const schedCard = document.querySelector('.sched');
    if (schedCard) {
      if (st.running) schedCard.classList.add('isRunning');
      else schedCard.classList.remove('isRunning');
    }
  }

  async function fetchSchedule(reset){
    try {
      const r = await fetch(`/api/schedule/status${reset ? '?reset=1' : ''}`);
      const j = await r.json();
      scheduleState = j;
      updateScheduleUi();
    } catch {}
  }

  async function armSchedule(){
    const raw = (el('delayMin') && el('delayMin').value != null) ? String(el('delayMin').value) : '';
    const vMin = Number(raw);
    if (!Number.isFinite(vMin) || vMin <= 0) {
      el('schedState').textContent = 'ERR';
      appendConsoleLine(`[ui] invalid delay_minutes: "${raw}"`);
      return;
    }

    const delaySec = Math.max(1, Math.round(vMin * 60));

    try {
      const r = await fetch('/api/schedule/arm', {
        method: 'POST',
        headers: { 'content-type':'application/json' },
        body: JSON.stringify({ delaySec })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        el('schedState').textContent = 'ERR';
        appendConsoleLine(`[ui] arm failed (${r.status}): ${j && j.error ? j.error : 'unknown error'}`);
        return;
      }
      scheduleState = j;
      updateScheduleUi();
      await fetchSchedule(true);
    } catch (e) {
      el('schedState').textContent = 'ERR';
      appendConsoleLine(`[ui] arm failed: ${String(e && e.message ? e.message : e)}`);
    }
  }

  async function disarmSchedule(){
    try {
      await fetch('/api/schedule/disarm', { method:'POST' });
      await fetchSchedule(true);
    } catch {}
  }

  async function runNow(){
    try {
      await fetch('/api/schedule/run-now', { method:'POST' });
      await fetchSchedule(true);
    } catch {}
  }

  // ✅ Styling-only: add drop-in action classes by ID (no behavior changes)
  function applyActionButtonClasses(){
    const armBtn =
      (el('armBtn')) ||
      (el('btnArm')) ||
      (document.querySelector('#schedForm button[type="submit"]')) ||
      null;

    const disarmBtn = el('disarmBtn') || el('btnCancel') || null;
    const runNowBtn = el('runNowBtn') || el('btnRunNow') || null;

    if (armBtn) armBtn.classList.add('btn-ok');
    if (disarmBtn) disarmBtn.classList.add('btn-danger');
    if (runNowBtn) runNowBtn.classList.add('btn-run');
  }

  function init(){
    // remove noPulse once JS is live (prevents initial flash animation)
    document.body.classList.remove('noPulse');

    // apply action button styling classes
    applyActionButtonClasses();

    el('schedForm').addEventListener('submit', (e) => {
      e.preventDefault();
      armSchedule();
    });
    el('disarmBtn').addEventListener('click', disarmSchedule);
    el('runNowBtn').addEventListener('click', runNow);

    // polls
    setInterval(pollTail, 1000);
    setInterval(() => fetchSchedule(false), 1000);
    setInterval(pollLatestRun, 2000);

    // kick
    pollTail();
    fetchSchedule(true);
    pollLatestRun();
  }

  init();
})();
