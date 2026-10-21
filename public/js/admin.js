/* GoalPredict — admin console (vanilla JS) */
'use strict';

(function () {
  const { API, fmt, icons, escapeHtml, pickRow, statusBadge, emptyState, skeletonRows } = App;
  const $ = (s) => document.querySelector(s);

  let currentView = 'dashboard';
  let pollTimer = null;
  let viewVersion = 0;

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

  /**
   * The small print under the "Data source" tile. Only values the server
   * really knows are shown — the quota line disappears when the provider has
   * not reported one (never an invented number).
   */
  function dataSourceDetail(ds) {
    const q = ds.quota || null;
    const qs = ds.quotaState || null;
    if (!ds.configured) return 'key missing';
    if (qs && qs.known && qs.remaining !== null && qs.remaining !== undefined) {
      return qs.limitDay ? `${qs.remaining}/${qs.limitDay} requests left today` : `${qs.remaining} requests left today`;
    }
    if (q && q.current !== null && q.current !== undefined) {
      return `quota ${q.current}${q.limit_day ? `/${q.limit_day}` : ''}`;
    }
    return ds.verified === false ? 'no successful provider check yet' : 'quota not reported';
  }

  /**
   * When the data source is not OK, say WHY and what to do — the state alone
   * ("OPEN") never told an operator whether the key, the quota or the network
   * was the problem.
   */
  function dataSourceAlert(ds) {
    if (!ds || ds.available || (!ds.label && !ds.hint)) return '';
    const when = ds.resetsAt ? ` Resumes automatically after ${fmt.dateTimeLabel(ds.resetsAt)}.` : '';
    return `<div class="alert warn" style="margin-top:12px;">${icons.alert}<div><b>${escapeHtml(ds.state || 'unavailable')}</b> — ${escapeHtml(ds.label || 'the data source is unavailable')}.${escapeHtml(when)}${ds.hint ? `<div class="tiny muted">${escapeHtml(ds.hint)}</div>` : ''}</div></div>`;
  }

  /**
   * Why the last generation did not produce a ticket. The stored report now
   * carries the classified reason, so the console can name the cause and the
   * fix instead of showing the status alone.
   */
  function generationFailureNote(g) {
    if (!g || g.status === 'QUALIFIED' || g.status === 'NO_QUALIFYING_TICKET') return '';
    const label = g.reasonLabel || g.reason;
    if (!label && !g.reasonHint && !g.errorDetail) return '';
    const when = g.resetsAt ? ` Resumes after ${fmt.dateTimeLabel(g.resetsAt)}.` : '';
    return `<div class="alert warn" style="margin-top:10px;">${icons.alert}<div><b>${escapeHtml(g.reason || 'FAILED')}</b>${label ? ` — ${escapeHtml(label)}` : ''}.${escapeHtml(when)}${g.reasonHint ? `<div class="tiny muted">${escapeHtml(g.reasonHint)}</div>` : ''}${g.errorDetail ? `<div class="tiny muted">${escapeHtml(g.errorDetail)}</div>` : ''}</div></div>`;
  }

  function cellsGrid(cells) {
    return `<div class="diag-grid">${cells.map(([k, v, tone]) => `<div class="diag-cell"><div class="k">${escapeHtml(k)}</div><div class="v ${tone || ''}">${v === null || v === undefined || v === '' ? '—' : escapeHtml(v)}</div></div>`).join('')}</div>`;
  }

  function diagGrid(c) {
    if (!c) return '';
    return cellsGrid([
      ['Fixtures scanned', c.fixturesScanned, ''], ['Playable', c.playableFixtures, ''],
      ['Over 1.5 candidates', c.over15Candidates, ''], ['Verified odds', c.verifiedOdds, 'good'],
      ['Rejected total', c.rejectedMatches, 'warn'], ['No odds', c.rejectedNoOdds, 'warn'],
      ['Insufficient data', c.rejectedInsufficientData, 'warn'], ['Stale odds', c.rejectedStaleOdds, 'warn'],
      ['Low confidence', c.rejectedLowConfidence, 'warn'], ['High risk', c.rejectedHighRisk, 'warn'],
      ['Low quality', c.rejectedLowQuality, 'warn'], ['Correlation rejected', c.correlationRejected, 'warn'],
      ['Confidence qualified', c.confidenceQualified, 'good'], ['Risk qualified', c.riskQualified, 'good'],
      ['Final candidates', c.finalCandidates, ''], ['Combinations tested', c.combinationsTested, ''],
      ['Qualified combos', c.qualifiedCombinations, 'good'], ['Selected picks', c.selectedPicks, 'good'],
    ]);
  }

  function countMapText(map) {
    if (!map || typeof map !== 'object') return '—';
    const parts = Object.entries(map)
      .filter(([, n]) => Number(n) > 0)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, 8)
      .map(([reason, n]) => `${reason}: ${n}`);
    return parts.length ? parts.join(' · ') : 'none';
  }

  function oddsSyncGrid(sync, load) {
    if (!sync && !load) return '';
    const s = sync || {};
    const errors = Array.isArray(s.providerErrors) ? s.providerErrors : [];
    const errorText = errors.length
      ? errors.map((e) => `page ${e.page || '?'}${e.status ? ` HTTP ${e.status}` : ''}${e.reason ? ` ${e.reason}` : ''}: ${e.message || ''}`).join(' · ')
      : 'none';
    return `${cellsGrid([
      ['Odds endpoint calls', s.endpointCalls, ''],
      ['Odds rows written', s.rowsWritten, ''],
      ['Odds fixtures scanned', s.fixturesScanned, ''],
      ['Fixtures with any offers', s.fixturesWithAnyOffers, ''],
      ['Fixtures with rejected offers', s.fixturesWithRejectedOffers, 'warn'],
      ['Fixtures with verified Over 1.5', s.fixturesWithVerifiedOver15, 'good'],
      ['Unmatched provider items', s.unmatchedProviderItems, 'warn'],
      ['Provider items seen', s.providerItemsSeen, ''],
      ['Pages fetched', s.pagesFetched, ''],
      ['Paging total', s.pagingTotal, ''],
      ['Stopped reason', s.stoppedReason, ''],
      ['DB fixtures with verified Over 1.5', load && load.fixturesWithVerifiedOver15, 'good'],
    ])}<p class="small muted" style="margin-top:8px;"><b>Offer rejections</b> — ${escapeHtml(countMapText(s.offerRejectionCounts))}</p><p class="small muted"><b>Over 1.5 offer rejections</b> — ${escapeHtml(countMapText(s.over15OfferRejectionCounts))}</p><p class="small muted"><b>Provider/page errors</b> — ${escapeHtml(errorText)}</p>${load && load.offerRejectionCounts ? `<p class="small muted"><b>DB re-validation rejections</b> — ${escapeHtml(countMapText(load.offerRejectionCounts))}</p>` : ''}`;
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

  /**
   * Watch one generation run.
   *
   * A failed poll used to silently clear the interval: the panel stayed on
   * "Starting generation…" and the Generate button stayed disabled for the rest
   * of the session, so the operator could neither see the result nor start
   * again. A transient read error is now reported and retried a few times, and
   * the button is always released — a lost progress feed must never lock the
   * console.
   */
  const MAX_POLL_FAILURES = 4;
  function startPolling(runId) {
    const version = viewVersion;
    let failures = 0;
    clearInterval(pollTimer);
    const note = (html) => {
      const box = $('#progressBox');
      if (!box) return;
      let line = box.querySelector('#pollNote');
      if (!line) {
        box.insertAdjacentHTML('beforeend', `<div id="pollNote"></div>`);
        line = box.querySelector('#pollNote');
      }
      if (line) line.innerHTML = html;
    };
    const release = () => {
      const btn = $('#genBtn');
      if (btn) btn.disabled = false;
    };
    pollTimer = setInterval(async () => {
      try {
        const progress = await API.get(`/admin/generation-progress?run_id=${runId}`);
        if (version !== viewVersion) return;
        failures = 0;
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
            const r = progress.report || {};
            const why = r.reason ? `<div class="tiny muted">${escapeHtml(r.reason)}${r.label ? ` — ${escapeHtml(r.label)}` : ''}${r.resetAt ? ` (resumes after ${escapeHtml(fmt.dateTimeLabel(r.resetAt))})` : ''}</div>${r.hint ? `<div class="tiny muted">${escapeHtml(r.hint)}</div>` : ''}` : '';
            box2.insertAdjacentHTML('beforeend', `<div class="alert warn" style="margin-top:10px;">${icons.info}<div><b>${escapeHtml(progress.status)}</b> — ${escapeHtml(r.message || progress.error || '')}${why}</div></div>`);
          } else if (box2) {
            box2.insertAdjacentHTML('beforeend', `<div class="alert error" style="margin-top:10px;">${icons.alert}<div>${escapeHtml(progress.error || 'Generation failed')}</div></div>`);
          }
          setTimeout(() => { if (version === viewVersion) setView(currentView, false); }, 1500);
        }
      } catch (err) {
        if (version !== viewVersion) return;
        failures += 1;
        // Keep watching (the run continues on the server) but never leave the
        // operator with a dead panel and a disabled button.
        release();
        if (failures < MAX_POLL_FAILURES) {
          note(`<div class="alert warn" style="margin-top:10px;">${icons.alert}<div><b>Progress could not be read</b> — ${escapeHtml(err.message || 'request failed')}. Retrying (${failures}/${MAX_POLL_FAILURES})…</div></div>`);
          return;
        }
        clearInterval(pollTimer);
        const box = $('#progressBox');
        if (box) {
          box.insertAdjacentHTML('beforeend', `<div class="alert error" style="margin-top:10px;">${icons.alert}<div><b>Stopped watching this run</b> — ${escapeHtml(err.message || 'the progress endpoint failed')}. Generation continues on the server: open <a href="#today">Today's Ticket</a> or reload the console to see the result. You can start a new generation once the running one has finished.</div></div>`);
        }
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
      const version = viewVersion;
      btn.disabled = true;
      const box = $('#progressBox');
      box.style.display = 'block';
      box.innerHTML = `<div class="progress-line current"><span class="dot"></span><span>Starting generation…</span></div>`;
      try {
        const started = await API.post('/admin/generate-ticket', {});
        if (version !== viewVersion) return;
        startPolling(started.runId);
      } catch (err) {
        box.innerHTML = `<div class="alert error">${icons.alert}<div>${escapeHtml(err.message)}</div></div>`;
        btn.disabled = false;
      }
    });
  }

  /* ------------------------------- views ------------------------------- */
  async function loadDashboard() {
    const version = viewVersion;
    render(`<div class="skeleton block"></div>`);
    const o = await API.get('/admin/overview');
    if (version !== viewVersion) return;
    $('#serverTime').textContent = `server ${fmt.dateTimeLabel(o.serverTime)}`;
    const t = o.today || {};
    const ds = o.dataSource || {};
    render(`
      <div class="stat-cards">
        ${mini('Total tickets', o.analytics.tickets.total, `${o.analytics.tickets.qualified} qualified`)}
        ${mini('Win rate', o.analytics.tickets.winRate === null ? '—' : o.analytics.tickets.winRate + '%', `${o.analytics.tickets.won}W / ${o.analytics.tickets.lost}L`, o.analytics.tickets.winRate >= 50 ? 'green' : 'red')}
        ${mini('Avg ticket odds', o.analytics.tickets.avgOdds === null ? '—' : fmt.odds(o.analytics.tickets.avgOdds), `window ${o.settings.oddsWindow.min.toFixed(2)}–${o.settings.oddsWindow.max.toFixed(2)}`, 'cyan')}
        ${mini('Data source', ds.state || '—', dataSourceDetail(ds), ds.available ? 'green' : 'red')}
      </div>
      ${dataSourceAlert(ds)}
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
          .map((s) => {
            const budget = s.requestsUsed === null || s.requestsUsed === undefined ? '' : ` · api ${s.requestsUsed}${s.requestsLimit ? `/${s.requestsLimit}` : ''}`;
            const detail = s.status === 'FAILED' && s.errorDetail && s.errorDetail !== s.message ? `<div class="tiny muted">${escapeHtml(s.errorDetail)}</div>` : '';
            return `<div class="history-row"><div class="grow"><div class="d">${escapeHtml(s.job)} sync</div><div class="t">${escapeHtml(fmt.dateTimeLabel(s.startedAt))} · ${escapeHtml(s.message || s.status)}${escapeHtml(budget)}</div>${detail}</div><span class="badge ${s.status === 'SUCCESS' ? 'badge-green' : s.status === 'FAILED' ? 'badge-red' : 'badge-amber'}">${escapeHtml(s.status)}</span></div>`;
          })
          .join('') || emptyState('activity', 'No sync activity yet', 'Run a sync from the API Status screen.')}</div>`
      )}</section>
      ${o.lastGeneration ? `<section class="section">${card('Last generation', `<div class="card-body"><div class="row wrap">
          <span class="badge ${o.lastGeneration.status === 'QUALIFIED' ? 'badge-green' : o.lastGeneration.status === 'NO_QUALIFYING_TICKET' ? 'badge-slate' : 'badge-amber'}">${escapeHtml(o.lastGeneration.status)}</span>
          <span class="small muted">${escapeHtml(fmt.dateTimeLabel(o.lastGeneration.startedAt))} · ${escapeHtml(o.lastGeneration.triggerSource)} · ${o.lastGeneration.durationMs || 0} ms</span>
          <span class="small">picks <b>${o.lastGeneration.selectedPicks}</b> · odds <b>${o.lastGeneration.totalOdds || '—'}</b></span>
        </div>${generationFailureNote(o.lastGeneration)}</div>`)}</section>` : ''}`);
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
    const version = viewVersion;
    render(`<div class="skeleton block"></div>`);
    const [t, report] = await Promise.all([API.get('/ticket/today'), API.get('/admin/generation-report').catch(() => null)]);
    if (version !== viewVersion) return;
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
    <section class="section">${card('Latest generation report', `<div class="card-body">${report ? diagGrid(c) + `<p class="small muted" style="margin-top:10px;">${escapeHtml((report.report && report.report.message) || '')}</p>` + ((report.report && (report.report.oddsSync || report.report.oddsLoad)) ? `<h3 class="card-title" style="margin-top:16px;">Odds sync</h3>${oddsSyncGrid(report.report.oddsSync, report.report.oddsLoad)}` : '') + generationFailureNote({ status: report.status, reason: (report.report || {}).reason, reasonLabel: (report.report || {}).label, reasonHint: (report.report || {}).hint, resetsAt: (report.report || {}).resetAt, errorDetail: report.error }) : emptyState('history', 'No generation yet', 'Use the Dashboard to generate the first ticket.')}</div>`)}</section>`);
  }

  async function loadFixtures() {
    const version = viewVersion;
    return window.AdminFixtures.load({ API, fmt, icons, escapeHtml, card, table, render, emptyState, skeletonRows, isCurrent: () => currentView === 'fixtures' && version === viewVersion });
  }

  async function loadOdds(date) {
    const version = viewVersion;
    const day = date || new Date().toISOString().slice(0, 10);
    render(`<div class="row" style="margin-bottom:12px;"><input type="date" class="input" id="odDate" value="${day}" style="width:auto;"><button class="btn btn-ghost" id="odGo">Load</button><span class="tiny muted">Only Over 1.5 goal lines are stored. Rejected rows show why a price was refused.</span></div><div id="odBody">${skeletonRows(3)}</div>`);
    $('#odGo').onclick = () => loadOdds($('#odDate').value);
    $('#odDate').onchange = () => loadOdds($('#odDate').value);
    const data = await API.get(`/admin/odds?date=${encodeURIComponent(day)}`);
    if (version !== viewVersion) return;
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
    const version = viewVersion;
    const data = await API.get(`/admin/predictions?date=${encodeURIComponent(day)}&eligible=${eligible ? 1 : 0}&limit=200`);
    if (version !== viewVersion) return;
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
    const version = viewVersion;
    render(`<div id="hsBody">${skeletonRows(4)}</div>`);
    const data = await API.get('/admin/tickets/history?limit=60');
    if (version !== viewVersion) return;
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
    const version = viewVersion;
    render(`<div class="skeleton block"></div>`);
    const a = await API.get('/admin/analytics');
    if (version !== viewVersion) return;
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
    const version = viewVersion;
    return window.AdminSettings.load({ API, icons, escapeHtml, card, render, isCurrent: () => currentView === 'settings' && version === viewVersion });
  }

  async function loadApi() {
    const version = viewVersion;
    render(`<div class="skeleton block"></div>`);
    const [status, syncs] = await Promise.all([API.get('/admin/api-status'), API.get('/admin/sync-logs?limit=25')]);
    if (version !== viewVersion) return;
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
    let syncing = false;
    const syncButtons = Array.from(document.querySelectorAll('[data-sync]'));
    syncButtons.forEach((btn) => {
      btn.onclick = async () => {
        if (syncing) return;
        syncing = true;
        const box = $('#syncBox');
        box.classList.remove('hidden');
        box.innerHTML = `<div class="progress-line current"><span class="dot"></span><span class="spinner"></span>&nbsp;running ${escapeHtml(btn.dataset.sync)} sync…</div>`;
        syncButtons.forEach((button) => { button.disabled = true; });
        try {
          const result = await API.post('/admin/sync', { job: btn.dataset.sync });
          if (version !== viewVersion) return;
          const tone = window.AdminFixtures.syncState(result.result);
          box.innerHTML = `<div class="alert ${tone}">${tone === 'ok' ? icons.checkCircle : icons.alert}<div><b>${tone === 'ok' ? 'Sync completed' : tone === 'warn' ? 'Sync paused or partially completed' : 'Sync unavailable'}</b><pre style="margin:0;white-space:pre-wrap;">${escapeHtml(JSON.stringify(result.result, null, 2))}</pre></div></div>`;
        } catch (err) {
          box.innerHTML = `<div class="alert error">${icons.alert}<div>${escapeHtml(err.message)}</div></div>`;
        } finally {
          syncing = false;
          syncButtons.forEach((button) => { button.disabled = false; });
        }
      };
    });
  }

  async function loadLogs() {
    const version = viewVersion;
    render(`<div class="row wrap" style="margin-bottom:12px;">
      <select class="input" id="logLevel" style="width:auto;"><option value="">All levels</option><option>debug</option><option>info</option><option>warn</option><option>error</option><option>critical</option></select>
      <select class="input" id="logChannel" style="width:auto;"><option value="">All channels</option><option>audit</option><option>tickets</option><option>auth</option><option>sync</option><option>app</option></select>
      <button class="btn btn-ghost" id="logGo">Load</button>
    </div><div id="logBody">${skeletonRows(4)}</div>`);
    const go = async () => {
      const level = $('#logLevel').value;
      const channel = $('#logChannel').value;
      const data = await API.get(`/admin/system-logs?limit=100${level ? `&level=${level}` : ''}${channel ? `&channel=${channel}` : ''}`);
      if (version !== viewVersion) return;
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
    // API Management (credential configuration + connection testing) lives in
    // its own guarded module so the console shell stays readable; the helper
    // functions below are handed over explicitly, no globals are invented.
    'api-management': {
      title: 'API Management',
      load: () => {
        const version = viewVersion;
        return window.AdminApiManagement.load({ API, fmt, icons, escapeHtml, card, mini, table, render: (html) => { if (version === viewVersion) render(html); }, isCurrent: () => currentView === 'api-management' && version === viewVersion, emptyState });
      },
    },
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

  function setView(name, push = true) {
    const nextView = Object.prototype.hasOwnProperty.call(VIEWS, name) ? name : 'dashboard';
    if (window.AdminSettings.hasUnsavedChanges() && !window.confirm('Leave Settings and discard unsaved changes?')) {
      history.replaceState(null, '', `#${currentView}`);
      return;
    }
    if (currentView === 'api-management' && (window.AdminApiManagement.hasUnsavedChanges() || window.AdminApiManagement.isBusy()) && !window.confirm('Leave API Management? Unsaved key/host changes will be discarded. Any request already submitted may still finish on the server.')) {
      history.replaceState(null, '', `#${currentView}`);
      return;
    }
    currentView = nextView;
    const version = ++viewVersion;
    closeSideNav();
    document.querySelectorAll('.side-link[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === currentView));
    $('#viewTitle').textContent = VIEWS[currentView].title;
    if (location.hash !== `#${currentView}`) history[push ? 'pushState' : 'replaceState'](null, '', `#${currentView}`);
    clearInterval(pollTimer);
    VIEWS[currentView].load().catch((err) => {
      if (version === viewVersion) render(`<div class="alert error">${icons.alert}<div>${escapeHtml(err.message)}</div></div>`);
    });
  }

  async function boot() {
    App.session.onUnauthorized = () => {
      if (App.session.unauthorizedHandled) return;
      App.session.unauthorizedHandled = true;
      const here = `${window.location.pathname}${window.location.search}${window.location.hash || ''}`;
      window.location.replace(`/admin/login?next=${encodeURIComponent(here)}`);
    };
    const [me] = await Promise.all([App.session.me(), App.site.load()]);
    if (!me || me.type !== 'admin') {
      window.location.replace('/admin/login');
      return;
    }
    $('#whoami').textContent = `${me.account.username} · ${me.account.role}`;
    $('#logoutBtn').onclick = async () => {
      await API.post('/auth/admin/logout', {}).catch(() => {});
      App.session.reset();
      window.location.replace('/admin/login');
    };
    document.querySelectorAll('.side-link[data-view]').forEach((btn) => btn.addEventListener('click', () => setView(btn.dataset.view)));
    window.addEventListener('hashchange', () => setView(location.hash.slice(1), false));
    bindSideNav();
    setView((location.hash || '#dashboard').replace('#', ''), false);
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
