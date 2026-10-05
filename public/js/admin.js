/* GoalPredict — admin console (vanilla JS) */
'use strict';

(function () {
  const { API, fmt, icons, escapeHtml, pickRow, statusBadge, emptyState, skeletonRows } = App;
  const $ = (s) => document.querySelector(s);

  let currentView = 'dashboard';
  let pollTimer = null;

  /* ------------------------------ helpers ------------------------------ */
  function render(html) {
    $('#viewRoot').innerHTML = html;
  }

  function card(title, bodyHtml, headRight) {
    return `<div class="card"><div class="card-head"><h2 class="card-title">${escapeHtml(title)}</h2><span>${headRight || ''}</span></div>${bodyHtml}</div>`;
  }

  function mini(k, v, d, tone) {
    return `<div class="mini-card"><div class="k">${escapeHtml(k)}</div><div class="v ${tone || ''}">${escapeHtml(v)}</div><div class="d">${escapeHtml(d || '')}</div></div>`;
  }

  function table(headers, rowsHtml, emptyRow) {
    return `<div class="table-wrap"><table class="data"><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rowsHtml || `<tr><td colspan="${headers.length}" class="muted">${escapeHtml(emptyRow || 'No rows')}</td></tr>`}</tbody></table></div>`;
  }

  function diagGrid(c) {
    if (!c) return '';
    const cells = [
      ['Fixtures scanned', c.fixturesScanned, ''], ['Playable', c.playableFixtures, ''],
      ['Over 1.5 candidates', c.over15Candidates, ''], ['Verified odds', c.verifiedOdds, 'good'],
      ['Rejected total', c.rejectedMatches, 'warn'], ['No odds', c.rejectedNoOdds, 'warn'],
      ['Insufficient data', c.rejectedInsufficientData, 'warn'], ['Stale odds', c.rejectedStaleOdds, 'warn'],
      ['Low confidence', c.rejectedLowConfidence, 'warn'], ['High risk', c.rejectedHighRisk, 'warn'],
      ['Low quality', c.rejectedLowQuality, 'warn'], ['Correlation rejected', c.correlationRejected, 'warn'],
      ['Confidence qualified', c.confidenceQualified, 'good'], ['Risk qualified', c.riskQualified, 'good'],
      ['Final candidates', c.finalCandidates, ''], ['Combinations tested', c.combinationsTested, ''],
      ['Qualified combos', c.qualifiedCombinations, 'good'], ['Selected picks', c.selectedPicks, 'good'],
    ];
    return `<div class="diag-grid">${cells.map(([k, v, tone]) => `<div class="diag-cell"><div class="k">${escapeHtml(k)}</div><div class="v ${tone}">${v === null || v === undefined ? '—' : escapeHtml(v)}</div></div>`).join('')}</div>`;
  }

  /* ---------------------------- generation ----------------------------- */
  function progressHtml(progress) {
    const seen = new Set();
    const lines = [];
    (progress.progress || []).forEach((entry) => {
      if (seen.has(entry.step)) return;
      seen.add(entry.step);
      const state = progress.status === 'RUNNING' && entry.step === progress.currentStep ? 'current' : 'done';
      lines.push(`<div class="progress-line ${state}"><span class="dot"></span><span>${escapeHtml(entry.message)}</span></div>`);
    });
    if (progress.status === 'RUNNING') lines.push(`<div class="progress-line current"><span class="dot"></span><span class="spinner"></span>&nbsp;working…</div>`);
    return lines.join('');
  }

  function startPolling(runId) {
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const progress = await API.get(`/admin/generation-progress?run_id=${runId}`);
        const box = $('#progressBox');
        if (box) {
          box.innerHTML = progressHtml(progress);
          box.scrollTop = box.scrollHeight;
        }
        const statusNode = $('#genStatus');
        if (statusNode) statusNode.innerHTML = statusBadge({ status: progress.status === 'RUNNING' ? 'PENDING' : progress.status, result: 'PENDING' });
        if (progress.status !== 'RUNNING') {
          clearInterval(pollTimer);
          const btn = $('#genBtn');
          if (btn) btn.disabled = false;
          const box2 = $('#progressBox');
          if (box2 && progress.status === 'QUALIFIED') {
            box2.insertAdjacentHTML('beforeend', `<div class="alert ok" style="margin-top:10px;">${icons.checkCircle}<div><b>TICKET QUALIFIED</b> — ${escapeHtml((progress.report && progress.report.totalOdds) || '')} from ${escapeHtml((progress.report && progress.report.selectedPicks) || 0)} picks.</div></div>`);
          } else if (box2 && progress.status !== 'ERROR') {
            box2.insertAdjacentHTML('beforeend', `<div class="alert warn" style="margin-top:10px;">${icons.info}<div><b>${escapeHtml(progress.status)}</b> — ${escapeHtml((progress.report && progress.report.message) || progress.error || '')}</div></div>`);
          } else if (box2) {
            box2.insertAdjacentHTML('beforeend', `<div class="alert error" style="margin-top:10px;">${icons.alert}<div>${escapeHtml(progress.error || 'Generation failed')}</div></div>`);
          }
          setTimeout(() => VIEWS[currentView].load(), 1500);
        }
      } catch (_) {
        clearInterval(pollTimer);
      }
    }, 900);
  }

  function generationPanel(overview) {
    const running = overview && overview.generationRunning;
    return `<div class="card-body">
      <div class="row wrap">
        <button class="btn btn-primary btn-lg" id="genBtn" ${running ? 'disabled' : ''}>${icons.bolt} Generate Today's Ticket</button>
        <span id="genStatus">${statusBadge(overview && overview.today ? overview.today : { status: 'PENDING' })}</span>
        <span class="tiny muted">Manual only · automatic generation is permanently OFF</span>
      </div>
      <div class="progress-box section" id="progressBox" style="display:none;"></div>
    </div>`;
  }

  async function bindGenerate() {
    const btn = $('#genBtn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (!window.confirm("Generate today's Over 1.5 ticket? Every price is re-verified with API-Football before publication.")) return;
      btn.disabled = true;
      const box = $('#progressBox');
      box.style.display = 'block';
      box.innerHTML = `<div class="progress-line current"><span class="dot"></span><span>Starting generation…</span></div>`;
      try {
        const started = await API.post('/admin/generate-ticket', {});
        startPolling(started.runId);
      } catch (err) {
        box.innerHTML = `<div class="alert error">${icons.alert}<div>${escapeHtml(err.message)}</div></div>`;
        btn.disabled = false;
      }
    });
  }

  /* ------------------------------- views ------------------------------- */
  async function loadDashboard() {
    render(`<div class="skeleton block"></div>`);
    const o = await API.get('/admin/overview');
    $('#serverTime').textContent = `server ${fmt.dateTimeLabel(o.serverTime)}`;
    const t = o.today || {};
    render(`
      <div class="stat-cards">
        ${mini('Total tickets', o.analytics.tickets.total, `${o.analytics.tickets.qualified} qualified`)}
        ${mini('Win rate', o.analytics.tickets.winRate === null ? '—' : o.analytics.tickets.winRate + '%', `${o.analytics.tickets.won}W / ${o.analytics.tickets.lost}L`, o.analytics.tickets.winRate >= 50 ? 'green' : 'red')}
        ${mini('Avg ticket odds', o.analytics.tickets.avgOdds === null ? '—' : fmt.odds(o.analytics.tickets.avgOdds), `window ${o.settings.oddsWindow.min.toFixed(2)}–${o.settings.oddsWindow.max.toFixed(2)}`, 'cyan')}
        ${mini('Data source', o.dataSource.state, o.dataSource.configured ? `quota ${o.dataSource.quota ? `${o.dataSource.quota.current}/${o.dataSource.quota.limit_day}` : 'n/a'}` : 'key missing', o.dataSource.available ? 'green' : 'red')}
      </div>
      <section class="section">${card("Manual generation", generationPanel(o), `<span class="tiny muted">${escapeHtml(fmt.dayLabel(t.date || new Date()))}</span>`)}</section>
      <section class="section">
        <div class="stat-cards">
          ${mini("Today's fixtures", o.dataToday.fixtures, `${o.dataToday.playableFixtures} playable`)}
          ${mini('Fixtures w/ Over 1.5 odds', o.dataToday.fixturesWithVerifiedOdds, 'verified by the server', 'cyan')}
          ${mini('Verified odds rows', o.dataToday.verifiedOddsRows, 'stored in the odds table')}
          ${mini('Auto generation', 'OFF', 'locked setting', 'green')}
        </div>
      </section>
      <section class="section">${card(
        'Recent activity',
        `<div>${(o.recentSyncs || [])
          .map((s) => `<div class="history-row"><div class="grow"><div class="d">${escapeHtml(s.job)} sync</div><div class="t">${escapeHtml(fmt.dateTimeLabel(s.startedAt))} · ${escapeHtml(s.message || s.status)}</div></div><span class="badge ${s.status === 'SUCCESS' ? 'badge-green' : s.status === 'FAILED' ? 'badge-red' : 'badge-amber'}">${escapeHtml(s.status)}</span></div>`)
          .join('') || emptyState('activity', 'No sync activity yet', 'Run a sync from the API Status screen.')}</div>`
      )}</section>
      ${o.lastGeneration ? `<section class="section">${card('Last generation', `<div class="card-body"><div class="row wrap">
          <span class="badge ${o.lastGeneration.status === 'QUALIFIED' ? 'badge-green' : o.lastGeneration.status === 'NO_QUALIFYING_TICKET' ? 'badge-slate' : 'badge-amber'}">${escapeHtml(o.lastGeneration.status)}</span>
          <span class="small muted">${escapeHtml(fmt.dateTimeLabel(o.lastGeneration.startedAt))} · ${escapeHtml(o.lastGeneration.triggerSource)} · ${o.lastGeneration.durationMs || 0} ms</span>
          <span class="small">picks <b>${o.lastGeneration.selectedPicks}</b> · odds <b>${o.lastGeneration.totalOdds || '—'}</b></span>
        </div></div>`)}</section>` : ''}`);
    await bindGenerate();
    if (o.generationRunning) {
      const gens = await API.get('/admin/generations?limit=1');
      if (gens.length) {
        const box = $('#progressBox');
        box.style.display = 'block';
        startPolling(gens[0].runId);
      }
    }
  }

  async function loadToday() {
    render(`<div class="skeleton block"></div>`);
    const [t, report] = await Promise.all([API.get('/ticket/today'), API.get('/admin/generation-report').catch(() => null)]);
    const c = report ? report.counters : null;
    render(`${card(
      `Ticket for ${fmt.dayLabel(t.date)}`,
      `<div class="card-head" style="border-top:0;">${''}<span id="ticketBadge">${statusBadge(t)}</span></div>
       <div class="acc-summary">
         <div class="acc-cell"><div class="k">Market</div><div class="v">Over 1.5 Goals</div></div>
         <div class="acc-cell"><div class="k">Total odds</div><div class="v cyan">${escapeHtml(t.totalOdds ? fmt.odds(t.totalOdds) : '—')}</div></div>
         <div class="acc-cell"><div class="k">Selections</div><div class="v">${t.selectionCount || 0}</div></div>
         <div class="acc-cell"><div class="k">Confidence</div><div class="v">${t.avgConfidence === null || t.avgConfidence === undefined ? '—' : fmt.pct(t.avgConfidence)}</div></div>
         <div class="acc-cell"><div class="k">Est. probability</div><div class="v">${t.estimatedProbability === null || t.estimatedProbability === undefined ? '—' : fmt.pct(t.estimatedProbability * 100)}</div></div>
       </div>
       <div class="pick-list">${(t.selections || []).map((p) => pickRow(p)).join('') || ''}</div>
       ${t.status !== 'QUALIFIED' ? `<div class="card-body"><div class="alert warn">${icons.info}<div><b>${escapeHtml(t.status)}</b> — ${escapeHtml((t.noTicket && t.noTicket.message) || '')}</div></div><div class="diag-grid section">${diagGrid(c)}</div></div>` : ''}`,
      `<a class="btn btn-ghost btn-sm" href="/ticket.html">Open public page</a>`
    )}
    <section class="section">${card('Latest generation report', `<div class="card-body">${report ? diagGrid(c) + `<p class="small muted" style="margin-top:10px;">${escapeHtml((report.report && report.report.message) || '')}</p>` : emptyState('history', 'No generation yet', 'Use the Dashboard to generate the first ticket.')}</div>`)}</section>`);
  }

  async function loadFixtures(date) {
    const day = date || new Date().toISOString().slice(0, 10);
    render(`<div class="row" style="margin-bottom:12px;"><input type="date" class="input" id="fxDate" value="${day}" style="width:auto;"><button class="btn btn-ghost" id="fxGo">Load</button></div><div id="fxBody">${skeletonRows(3)}</div>`);
    $('#fxGo').onclick = () => loadFixtures($('#fxDate').value);
    $('#fxDate').onchange = () => loadFixtures($('#fxDate').value);
    const data = await API.get(`/admin/fixtures?date=${encodeURIComponent(day)}`);
    $('#fxBody').innerHTML = card(
      `${data.total} fixtures synced`,
      table(
        ['Kickoff (local)', 'League', 'Match', 'Status', 'Playable', 'Score'],
        data.items
          .map(
            (f) =>
              `<tr><td>${escapeHtml(fmt.dateTimeLabel(f.kickoffAt))}</td><td>${escapeHtml(f.league || '—')}<div class="tiny muted">${escapeHtml(f.country || '')}</div></td><td><b>${escapeHtml(f.home)}</b> vs <b>${escapeHtml(f.away)}</b></td><td>${escapeHtml(f.status || '—')}</td><td>${f.playable ? '<span class="badge badge-green">yes</span>' : '<span class="badge badge-slate">no</span>'}</td><td>${escapeHtml(f.score || '—')}</td></tr>`
          )
          .join('')
      )
    );
  }

  async function loadOdds(date) {
    const day = date || new Date().toISOString().slice(0, 10);
    render(`<div class="row" style="margin-bottom:12px;"><input type="date" class="input" id="odDate" value="${day}" style="width:auto;"><button class="btn btn-ghost" id="odGo">Load</button><span class="tiny muted">Only Over 1.5 goal lines are stored. Rejected rows show why a price was refused.</span></div><div id="odBody">${skeletonRows(3)}</div>`);
    $('#odGo').onclick = () => loadOdds($('#odDate').value);
    $('#odDate').onchange = () => loadOdds($('#odDate').value);
    const data = await API.get(`/admin/odds?date=${encodeURIComponent(day)}`);
    $('#odBody').innerHTML = card(
      `${data.verified} verified of ${data.total} stored Over 1.5 rows`,
      table(
        ['Match', 'Bookmaker', 'Bet / value', 'Line', 'Odds', 'State', 'Reason', 'Updated'],
        data.items
          .map(
            (o) =>
              `<tr><td>${escapeHtml(o.match || o.fixtureId)}</td><td>${escapeHtml(o.bookmaker)}</td><td class="tiny">${escapeHtml(o.betName)} / ${escapeHtml(o.valueName)}</td><td>${escapeHtml(o.goalLine)}</td><td><b>${escapeHtml(o.odds)}</b></td><td>${o.verified ? '<span class="badge badge-green">verified</span>' : '<span class="badge badge-red">rejected</span>'}</td><td class="tiny muted">${escapeHtml(o.rejectReason || '—')}</td><td class="tiny">${escapeHtml(fmt.ago(o.fetchedAt))}</td></tr>`
          )
          .join('')
      )
    );
  }

  async function loadPredictions(date) {
    const day = date || new Date().toISOString().slice(0, 10);
    render(`<div class="row" style="margin-bottom:12px;"><input type="date" class="input" id="prDate" value="${day}" style="width:auto;"><label class="row tiny muted"><input type="checkbox" id="prEligible"> eligible only</label><button class="btn btn-ghost" id="prGo">Load</button></div><div id="prBody">${skeletonRows(3)}</div>`);
    const go = () => loadPredictionsDone($('#prDate').value, $('#prEligible').checked);
    $('#prGo').onclick = go;
    $('#prDate').onchange = go;
    $('#prEligible').onchange = go;
    await loadPredictionsDone(day, false);
  }

  async function loadPredictionsDone(day, eligible) {
    const data = await API.get(`/admin/predictions?date=${encodeURIComponent(day)}&eligible=${eligible ? 1 : 0}&limit=200`);
    $('#prBody').innerHTML = card(
      `${data.total} predictions`,
      table(
        ['Match', 'Confidence', 'Quality', 'Risk', 'Model P', 'Odds', 'State'],
        data.items
          .map(
            (p) =>
              `<tr><td><b>${escapeHtml(p.homeTeam ? p.homeTeam.name : '')}</b> vs <b>${escapeHtml(p.awayTeam ? p.awayTeam.name : '')}</b><div class="tiny muted">${escapeHtml(fmt.kickoffLabel(p.kickoffAt))} · ${escapeHtml((p.league && p.league.name) || '')}</div></td><td>${fmt.pct(p.confidence)}</td><td>${fmt.pct(p.quality)}</td><td>${fmt.pct(p.risk)}</td><td>${p.modelProbability === null ? '—' : fmt.pct(p.modelProbability * 100)}</td><td>${p.odds && p.odds.available ? escapeHtml(p.odds.value) : '<span class="muted">n/a</span>'}</td><td>${p.eligible ? '<span class="badge badge-green">eligible</span>' : `<span class="badge badge-slate">${escapeHtml(p.rejectReason || 'rejected')}</span>`}</td></tr>`
          )
          .join('')
      )
    );
  }

  async function loadHistory() {
    render(`<div id="hsBody">${skeletonRows(4)}</div>`);
    const data = await API.get('/admin/tickets/history?limit=60');
    $('#hsBody').innerHTML = card(
      `${data.total} ticket days`,
      table(
        ['Date', 'Status', 'Picks', 'Odds', 'Result', 'Settled odds', 'Generated'],
        data.items
          .map(
            (t) =>
              `<tr><td><b>${escapeHtml(fmt.dayLabel(t.date))}</b></td><td>${statusBadge(t)}</td><td>${t.selectionCount || 0}</td><td>${t.totalOdds ? fmt.odds(t.totalOdds) : '—'}</td><td>${escapeHtml(t.result || '—')}</td><td>${t.settledOdds ? fmt.odds(t.settledOdds) : '—'}</td><td class="tiny">${escapeHtml(t.generatedAt ? fmt.dateTimeLabel(t.generatedAt) : '—')}</td></tr>`
          )
          .join('')
      )
    );
  }

  async function loadAnalytics() {
    render(`<div class="skeleton block"></div>`);
    const a = await API.get('/admin/analytics');
    render(`<div class="stat-cards">
        ${mini('Total tickets', a.tickets.total, `${a.tickets.noTicketDays} no-ticket days`)}
        ${mini('Win rate', a.tickets.winRate === null ? '—' : a.tickets.winRate + '%', `${a.tickets.won}W / ${a.tickets.lost}L / ${a.tickets.void}V`, 'green')}
        ${mini('Avg odds', a.tickets.avgOdds === null ? '—' : fmt.odds(a.tickets.avgOdds), `highest ${a.tickets.highestOdds === null ? '—' : fmt.odds(a.tickets.highestOdds)}`, 'cyan')}
        ${mini('Lowest odds', a.tickets.lowestOdds === null ? '—' : fmt.odds(a.tickets.lowestOdds), 'qualified tickets only')}
        ${mini('Selection win rate', a.selections.winRate === null ? '—' : a.selections.winRate + '%', `${a.selections.total} picks stored`, 'green')}
        ${mini('Over 1.5 hit rate', a.over15.winRate === null ? '—' : a.over15.winRate + '%', `${a.over15.settled} settled matches`, 'cyan')}
        ${mini('Current streak', a.streaks.currentWinningStreak ? a.streaks.currentWinningStreak + 'W' : a.streaks.currentLosingStreak ? a.streaks.currentLosingStreak + 'L' : '—', `longest ${a.streaks.longestWinningStreak}W / ${a.streaks.longestLosingStreak}L`)}
        ${mini('Flat stake ROI', a.flatStake && a.flatStake.roi !== null ? a.flatStake.roi + '%' : '—', `profit ${a.flatStake ? fmt.num(a.flatStake.profit) : '—'} units (illustrative)`, a.flatStake && a.flatStake.profit > 0 ? 'green' : 'red')}
      </div>
      <section class="section">${card('Monthly', table(['Month', 'Tickets', 'Qualified', 'Won', 'Lost', 'Void', 'Picks', 'Avg odds', 'Win rate'], a.monthly.map((m) => `<tr><td><b>${escapeHtml(m.month)}</b></td><td>${m.tickets}</td><td>${m.qualified}</td><td>${m.won}</td><td>${m.lost}</td><td>${m.voided}</td><td>${m.selections}</td><td>${m.avgOdds === null ? '—' : fmt.odds(m.avgOdds)}</td><td>${m.winRate === null ? '—' : m.winRate + '%'}</td></tr>`).join('')))}</section>`);
  }

  async function loadSettings() {
    render(`<div class="skeleton block"></div>`);
    const data = await API.get('/admin/settings');
    const groups = {};
    data.items.forEach((item) => {
      (groups[item.group] = groups[item.group] || []).push(item);
    });
    const groupOrder = ['market', 'odds_window', 'filters', 'correlation', 'model', 'scoring', 'sync', 'site'];
    const html = groupOrder
      .filter((g) => groups[g])
      .map(
        (g) =>
          `<section class="section">${card(g.replace('_', ' '), `<div class="card-body"><div class="field-grid">${groups[g]
            .map((item) => fieldHtml(item))
            .join('')}</div></div>`)}</section>`
      )
      .join('');
    render(`${html}<div class="row" style="margin-top:14px;"><button class="btn btn-primary btn-lg" id="saveSettings">${icons.check} Save settings</button><span class="tiny muted" id="settingsMsg"></span></div>`);
    $('#saveSettings').onclick = async () => {
      const patch = {};
      document.querySelectorAll('[data-setting]').forEach((node) => {
        const key = node.dataset.setting;
        if (node.type === 'checkbox') patch[key] = node.checked ? '1' : '0';
        else patch[key] = node.value;
      });
      const msg = $('#settingsMsg');
      try {
        const result = await API.put('/admin/settings', patch);
        msg.textContent = `Saved ${result.applied.length} setting(s).${result.rejected.length ? ` Rejected: ${result.rejected.map((r) => `${r.key} (${r.reason})`).join(', ')}` : ''}`;
        msg.style.color = result.rejected.length ? '#fcd34d' : '#86efac';
      } catch (err) {
        msg.textContent = err.message;
        msg.style.color = '#fca5a5';
      }
    };
  }

  function fieldHtml(item) {
    const id = `set_${item.key}`;
    const label = `<label for="${id}">${escapeHtml(item.label)}${item.locked ? ' <span class="badge badge-slate">locked</span>' : ''}</label>`;
    const hint = item.description ? `<div class="hint">${escapeHtml(item.description)}</div>` : '';
    const disabled = item.locked ? 'disabled' : '';
    if (item.type === 'boolean') {
      return `<div class="field"><div class="toggle"><div><div class="t-label">${escapeHtml(item.label)}</div><div class="t-hint">${escapeHtml(item.description || '')}</div></div>
        <span class="switch"><input type="checkbox" id="${id}" data-setting="${escapeHtml(item.key)}" ${String(item.value) === '1' ? 'checked' : ''} ${disabled}><span class="track"></span></span></div></div>`;
    }
    if (item.type === 'json') {
      return `<div class="field" style="grid-column:1/-1;">${label}<textarea class="input" id="${id}" data-setting="${escapeHtml(item.key)}" rows="4" ${disabled}>${escapeHtml(item.value)}</textarea>${hint}</div>`;
    }
    if (item.type === 'enum') {
      return `<div class="field">${label}<select class="input" id="${id}" data-setting="${escapeHtml(item.key)}" ${disabled}>${item.options.map((o) => `<option value="${escapeHtml(o)}" ${o === item.value ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}</select>${hint}</div>`;
    }
    const attrs = item.type === 'number' ? `type="number" step="any" ${item.min !== null ? `min="${item.min}"` : ''} ${item.max !== null ? `max="${item.max}"` : ''}` : `type="text" maxlength="200"`;
    return `<div class="field">${label}<input class="input" id="${id}" data-setting="${escapeHtml(item.key)}" ${attrs} value="${escapeHtml(item.value)}" ${disabled}>${hint}</div>`;
  }

  async function loadApi() {
    render(`<div class="skeleton block"></div>`);
    const [status, syncs] = await Promise.all([API.get('/admin/api-status'), API.get('/admin/sync-logs?limit=25')]);
    render(`<div class="stat-cards">
        ${mini('Provider', status.configured ? 'API-Football Pro' : 'NOT CONFIGURED', status.baseUrl, status.configured ? 'cyan' : 'red')}
        ${mini('Circuit breaker', status.state, status.available ? 'requests allowed' : `retry in ${Math.round((status.retryInMs || 0) / 1000)}s`, status.available ? 'green' : 'red')}
        ${mini('Daily quota', status.quota ? `${status.quota.current} / ${status.quota.limit_day}` : 'unknown', 'requests used today')}
        ${mini('Cache hits', status.cacheHits || 0, `${status.calls || 0} calls · ${status.failures || 0} failures`)}
      </div>
      <section class="section">${card('Manual synchronisation', `<div class="card-body">
        <div class="row wrap">
          <button class="btn btn-ghost" data-sync="fixtures">${icons.refresh} Sync fixtures</button>
          <button class="btn btn-ghost" data-sync="odds">${icons.refresh} Sync odds</button>
          <button class="btn btn-ghost" data-sync="results">${icons.refresh} Sync results</button>
          <button class="btn btn-outline" data-sync="all">${icons.bolt} Sync everything</button>
        </div>
        <p class="tiny muted" style="margin:10px 0 0;">Sync jobs only refresh fixtures, odds and results. They can never create or publish a ticket.</p>
        <div class="progress-box section hidden" id="syncBox"></div>
      </div>`)}</section>
      <section class="section">${card('Recent sync logs', table(['Job', 'Trigger', 'Status', 'Rows', 'Calls', 'Duration', 'Started', 'Message'], syncs.map((s) => `<tr><td><b>${escapeHtml(s.job)}</b></td><td>${escapeHtml(s.trigger)}</td><td><span class="badge ${s.status === 'SUCCESS' ? 'badge-green' : s.status === 'FAILED' ? 'badge-red' : 'badge-amber'}">${escapeHtml(s.status)}</span></td><td>${s.rowsWritten}</td><td>${s.endpointCalls}</td><td>${s.durationMs === null ? '—' : s.durationMs + ' ms'}</td><td class="tiny">${escapeHtml(fmt.dateTimeLabel(s.startedAt))}</td><td class="tiny muted">${escapeHtml(s.message || s.error || '')}</td></tr>`).join('')))}</section>`);
    document.querySelectorAll('[data-sync]').forEach((btn) => {
      btn.onclick = async () => {
        const box = $('#syncBox');
        box.classList.remove('hidden');
        box.innerHTML = `<div class="progress-line current"><span class="dot"></span><span class="spinner"></span>&nbsp;running ${escapeHtml(btn.dataset.sync)} sync…</div>`;
        btn.disabled = true;
        try {
          const result = await API.post('/admin/sync', { job: btn.dataset.sync });
          box.innerHTML = `<div class="alert ok">${icons.checkCircle}<div><pre style="margin:0;white-space:pre-wrap;">${escapeHtml(JSON.stringify(result.result, null, 2))}</pre></div></div>`;
        } catch (err) {
          box.innerHTML = `<div class="alert error">${icons.alert}<div>${escapeHtml(err.message)}</div></div>`;
        } finally {
          btn.disabled = false;
        }
      };
    });
  }

  async function loadLogs() {
    render(`<div class="row wrap" style="margin-bottom:12px;">
      <select class="input" id="logLevel" style="width:auto;"><option value="">All levels</option><option>debug</option><option>info</option><option>warn</option><option>error</option><option>critical</option></select>
      <select class="input" id="logChannel" style="width:auto;"><option value="">All channels</option><option>audit</option><option>tickets</option><option>auth</option><option>sync</option><option>app</option></select>
      <button class="btn btn-ghost" id="logGo">Load</button>
    </div><div id="logBody">${skeletonRows(4)}</div>`);
    const go = async () => {
      const level = $('#logLevel').value;
      const channel = $('#logChannel').value;
      const data = await API.get(`/admin/system-logs?limit=100${level ? `&level=${level}` : ''}${channel ? `&channel=${channel}` : ''}`);
      $('#logBody').innerHTML = card(
        `${data.total} log entries`,
        `<div class="card-body" style="max-height:520px;overflow-y:auto;">${data.items
          .map(
            (l) =>
              `<div class="log-line ${escapeHtml(l.level)}"><span class="ts">${escapeHtml(fmt.dateTimeLabel(l.createdAt))}</span> [${escapeHtml(l.level.toUpperCase())}] ${escapeHtml(l.channel)} · ${escapeHtml(l.event)}${l.message ? ` — ${escapeHtml(l.message)}` : ''}${l.actorType ? ` <span class="tiny muted">(${escapeHtml(l.actorType)}${l.actorId ? '#' + l.actorId : ''}${l.ipAddress ? ' ' + escapeHtml(l.ipAddress) : ''})</span>` : ''}</div>`
          )
          .join('') || '<div class="muted small">No log entries.</div>'}</div>`
      );
    };
    $('#logGo').onclick = go;
    await go();
  }

  const VIEWS = {
    dashboard: { title: 'Dashboard', load: loadDashboard },
    today: { title: "Today's Ticket", load: loadToday },
    fixtures: { title: 'Fixtures', load: () => loadFixtures() },
    odds: { title: 'Odds Verification', load: () => loadOdds() },
    predictions: { title: 'Predictions', load: () => loadPredictions() },
    history: { title: 'Ticket History', load: loadHistory },
    analytics: { title: 'Analytics', load: loadAnalytics },
    settings: { title: 'Settings', load: loadSettings },
    api: { title: 'API Status', load: loadApi },
    logs: { title: 'System Logs', load: loadLogs },
  };

  /* ---- mobile drawer: the sidebar collapses below 900px ---- */
  function closeSideNav() {
    const nav = $('#sideNav');
    const toggle = $('#sideToggle');
    const overlay = $('#sideOverlay');
    if (!nav || !toggle || !overlay) return;
    nav.classList.remove('open');
    overlay.classList.add('hidden');
    toggle.setAttribute('aria-expanded', 'false');
  }

  function bindSideNav() {
    const nav = $('#sideNav');
    const toggle = $('#sideToggle');
    const overlay = $('#sideOverlay');
    if (!nav || !toggle || !overlay) return;
    toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      overlay.classList.toggle('hidden', !open);
      toggle.setAttribute('aria-expanded', String(open));
    });
    overlay.addEventListener('click', closeSideNav);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeSideNav();
    });
  }

  function setView(name) {
    currentView = VIEWS[name] ? name : 'dashboard';
    closeSideNav();
    document.querySelectorAll('.side-link').forEach((b) => b.classList.toggle('active', b.dataset.view === currentView));
    $('#viewTitle').textContent = VIEWS[currentView].title;
    if (location.hash !== `#${currentView}`) history.replaceState(null, '', `#${currentView}`);
    clearInterval(pollTimer);
    VIEWS[currentView].load().catch((err) => {
      render(`<div class="alert error">${icons.alert}<div>${escapeHtml(err.message)}</div></div>`);
    });
  }

  async function boot() {
    const me = await App.session.me();
    if (!me || me.type !== 'admin') {
      window.location.replace('/login.html');
      return;
    }
    $('#whoami').textContent = `${me.account.username} · ${me.account.role}`;
    $('#logoutBtn').onclick = async () => {
      await API.post('/auth/admin/logout', {}).catch(() => {});
      App.session.reset();
      window.location.replace('/login.html');
    };
    document.querySelectorAll('.side-link').forEach((btn) => btn.addEventListener('click', () => setView(btn.dataset.view)));
    bindSideNav();
    setView((location.hash || '#dashboard').replace('#', ''));
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
