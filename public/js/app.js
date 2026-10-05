/* GoalPredict — homepage */
'use strict';

(function () {
  const { API, fmt, icons, escapeHtml, pickRow, statusBadge, emptyState, skeletonRows } = App;

  const $ = (sel) => document.querySelector(sel);

  function paintStats(ticket) {
    App.setText('#statMarket', 'Over 1.5 Goals');
    App.setText('#statOdds', ticket.totalOdds ? fmt.odds(ticket.totalOdds) : '—');
    App.setText('#statPicks', ticket.selectionCount || 0);
    App.setText('#statConfidence', ticket.avgConfidence === null || ticket.avgConfidence === undefined ? '—' : fmt.pct(ticket.avgConfidence));

    const statusNode = $('#statStatus');
    const statusIcon = $('#statStatusIcon');
    let label = 'Pending';
    let tone = 'green';
    if (ticket.status === 'QUALIFIED') {
      label = ticket.result === 'WON' ? 'Won' : ticket.result === 'LOST' ? 'Lost' : ticket.result === 'PENDING' ? 'Qualified' : ticket.result;
      tone = ticket.result === 'LOST' ? 'red' : 'green';
    } else if (ticket.status === 'NO_QUALIFYING_TICKET') {
      label = 'No ticket';
      tone = 'amber';
    } else if (ticket.status === 'DATA_SOURCE_UNAVAILABLE') {
      label = 'Data offline';
      tone = 'amber';
    }
    statusNode.textContent = label;
    statusNode.className = `stat-value ${tone === 'green' ? 'green' : tone === 'red' ? 'red' : ''}`;
    if (statusIcon) statusIcon.className = `stat-icon ${tone}`;
  }

  function paintSummary(ticket) {
    App.setText('#accPicks', ticket.selectionCount || 0);
    App.setText('#accOdds', ticket.totalOdds ? fmt.odds(ticket.totalOdds) : '—');
    App.setText('#accConfidence', ticket.avgConfidence === null || ticket.avgConfidence === undefined ? '—' : fmt.pct(ticket.avgConfidence));
    const wrap = $('#accStatusWrap');
    if (wrap) wrap.innerHTML = statusBadge(ticket);
    App.setText('#accGenerated', ticket.generatedAt ? `Generated ${fmt.dateTimeLabel(ticket.generatedAt)}` : 'Not generated yet');
  }

  function paintDiagnostics(diag) {
    const grid = $('#diagGrid');
    if (!grid) return;
    if (!diag) {
      grid.innerHTML = '';
      return;
    }
    const cells = [
      ['Fixtures analyzed', diag.fixturesAnalyzed, ''],
      ['Over 1.5 candidates', diag.over15Candidates, ''],
      ['Verified odds', diag.verifiedOdds, 'good'],
      ['Rejected matches', diag.rejectedMatches, 'warn'],
      ['Low confidence', diag.lowConfidence, 'warn'],
      ['High risk', diag.highRisk, 'warn'],
      ['Insufficient data', diag.insufficientData, 'warn'],
      ['Correlation rejected', diag.correlationRejected, 'warn'],
      ['Combinations tested', diag.combinationsTested, ''],
      ['Qualified combos', diag.qualifiedCombinations, 'good'],
    ];
    grid.innerHTML = cells
      .map(
        ([k, v, tone]) =>
          `<div class="diag-cell"><div class="k">${escapeHtml(k)}</div><div class="v ${tone}">${v === null || v === undefined ? '—' : escapeHtml(v)}</div></div>`
      )
      .join('');
  }

  function paintTicket(ticket) {
    paintStats(ticket);
    paintSummary(ticket);

    const list = $('#pickList');
    const noBox = $('#noTicketBox');

    if (ticket.status === 'QUALIFIED' && ticket.selections && ticket.selections.length) {
      noBox.classList.add('hidden');
      list.innerHTML = ticket.selections.map((p) => pickRow(p)).join('');
    } else {
      list.innerHTML = '';
      noBox.classList.remove('hidden');
      const nt = ticket.noTicket || {};
      App.setText('#noTicketTitle', ticket.status === 'DATA_SOURCE_UNAVAILABLE' ? 'Data source temporarily unavailable' : 'No qualifying ticket');
      App.setText('#noTicketMessage', nt.message || 'No valid Over 1.5 combination was found within the 2.00-4.00 target range.');
      const alert = $('#noTicketAlert');
      if (alert) alert.className = `alert ${ticket.status === 'DATA_SOURCE_UNAVAILABLE' ? 'error' : 'warn'}`;
      paintDiagnostics(nt.diagnostics);
    }
  }

  function paintRecent(history) {
    const box = $('#recentResults');
    const items = (history && history.items) || [];
    if (!items.length) {
      box.innerHTML = emptyState('history', 'No settled tickets yet', 'Once daily tickets are generated and matches finish, results appear here.');
      return;
    }
    box.innerHTML = items
      .map((t) => {
        const badge =
          t.result === 'WON'
            ? `<span class="badge badge-green">${icons.check} Won</span>`
            : t.result === 'LOST'
              ? `<span class="badge badge-red">${icons.x} Lost</span>`
              : t.result === 'PENDING' || t.result === 'N/A'
                ? `<span class="badge badge-slate">${icons.clock} ${t.status === 'QUALIFIED' ? 'Pending' : 'No ticket'}</span>`
                : `<span class="badge badge-amber">${icons.info} ${escapeHtml(t.result)}</span>`;
        return `<a class="history-row" style="color:inherit;text-decoration:none;" href="/ticket.html?date=${encodeURIComponent(t.date)}">
          <div class="history-date grow">
            <div class="d">${escapeHtml(fmt.dayLabel(t.date))}</div>
            <div class="t">${t.selectionCount || 0} pick${t.selectionCount === 1 ? '' : 's'}${t.totalOdds ? ` · odds ${fmt.odds(t.totalOdds)}` : ''}</div>
          </div>
          ${badge}
        </a>`;
      })
      .join('');
  }

  /* --------------------- manual generation (admin) -------------------- */
  let polling = null;

  function progressLine(entry, state) {
    return `<div class="progress-line ${state}"><span class="dot"></span><span>${escapeHtml(entry.message)}</span></div>`;
  }

  async function pollProgress(runId, box) {
    clearInterval(polling);
    polling = setInterval(async () => {
      try {
        const progress = await API.get(`/admin/generation-progress?run_id=${runId}`);
        const seen = new Set();
        const lines = [];
        (progress.progress || []).forEach((entry) => {
          if (seen.has(entry.step)) return;
          seen.add(entry.step);
          const isLast = entry.step === progress.currentStep && progress.status === 'RUNNING';
          lines.push(progressLine(entry, isLast ? 'current' : 'done'));
        });
        if (progress.status === 'RUNNING') {
          lines.push(`<div class="progress-line current"><span class="dot"></span><span class="spinner"></span>&nbsp;working…</div>`);
        }
        box.innerHTML = lines.join('');
        box.scrollTop = box.scrollHeight;

        if (progress.status !== 'RUNNING') {
          clearInterval(polling);
          const btn = $('#btnGenerate');
          if (btn) btn.disabled = false;
          setTimeout(() => window.location.reload(), 1200);
        }
      } catch (err) {
        clearInterval(polling);
      }
    }, 900);
  }

  async function bindGeneration() {
    const me = await App.session.me();
    if (!me || me.type !== 'admin') return;
    const foot = $('#generateFoot');
    if (foot) foot.classList.remove('hidden');
    const btn = $('#btnGenerate');
    if (!btn) return;

    btn.addEventListener('click', async () => {
      if (!window.confirm("Generate today's Over 1.5 ticket now? The run re-verifies every price with the data provider.")) return;
      btn.disabled = true;
      const box = $('#progressBox');
      box.classList.remove('hidden');
      box.innerHTML = progressLine({ step: 'START', message: 'Starting generation…' }, 'current');
      try {
        const started = await API.post('/admin/generate-ticket', {});
        await pollProgress(started.runId, box);
      } catch (err) {
        box.innerHTML = `<div class="alert error">${icons.alert}<div>${escapeHtml(err.message)}</div></div>`;
        btn.disabled = false;
      }
    });
  }

  async function init() {
    App.session.bindHeader();
    const list = $('#pickList');
    if (list) list.innerHTML = skeletonRows(3);

    try {
      const [ticket, history] = await Promise.all([API.get('/ticket/today'), API.get('/tickets/history?limit=5')]);
      paintTicket(ticket);
      paintRecent(history);
    } catch (err) {
      if (list) {
        list.innerHTML = emptyState('alert', 'Could not load the ticket', err.message || 'The API is unreachable right now.');
      }
    }
    bindGeneration();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
