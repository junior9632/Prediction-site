/* GoalPredict — public homepage (sports-intelligence landing page) */
'use strict';

/**
 * Everything rendered here comes from deliberately PUBLIC endpoints:
 *   /api/health           data-source state
 *   /api/ticket/today     today's published ticket
 *   /api/tickets/history  settled ticket history
 *   /api/analytics        aggregate platform statistics
 *   /api/predictions      per-fixture model output
 *
 * The page never calls the account-scoped dashboard API — that data is session
 * bound and is served only to the signed-in member area. Sections fail
 * independently, so a missing feed degrades to an honest empty state instead
 * of breaking the page.
 */
(function () {
  const { API, fmt, icons, escapeHtml, pickRow, statusBadge, emptyState, skeletonRows } = App;

  const $ = (sel) => document.querySelector(sel);
  const setText = (sel, value) => App.setText(sel, value);

  /* ------------------------------- hero -------------------------------- */

  function paintStats(ticket) {
    setText('#statMarket', 'Over 1.5 Goals');
    setText('#statOdds', ticket.totalOdds ? fmt.odds(ticket.totalOdds) : '—');
    setText('#statPicks', ticket.selectionCount || 0);
    setText('#statConfidence', ticket.avgConfidence === null || ticket.avgConfidence === undefined ? '—' : fmt.pct(ticket.avgConfidence));

    const statusNode = $('#statStatus');
    const chip = $('#liveStatusChip');
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
    if (statusNode) {
      statusNode.textContent = label;
      statusNode.className = `v ${tone === 'green' ? 'green' : tone === 'red' ? 'red' : ''}`;
    }
    if (chip) {
      chip.className = `badge ${tone === 'green' ? 'badge-green' : tone === 'red' ? 'badge-red' : 'badge-amber'}`;
      chip.textContent = label;
    }
  }

  function paintSummary(ticket) {
    setText('#accPicks', ticket.selectionCount || 0);
    setText('#accOdds', ticket.totalOdds ? fmt.odds(ticket.totalOdds) : '—');
    setText('#accConfidence', ticket.avgConfidence === null || ticket.avgConfidence === undefined ? '—' : fmt.pct(ticket.avgConfidence));
    const wrap = $('#accStatusWrap');
    if (wrap) wrap.innerHTML = statusBadge(ticket);
    setText('#accGenerated', ticket.generatedAt ? `Generated ${fmt.dateTimeLabel(ticket.generatedAt)} · verified on our servers` : 'Not generated yet');
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
    if (!list || !noBox) return;

    if (ticket.status === 'QUALIFIED' && ticket.selections && ticket.selections.length) {
      noBox.classList.add('hidden');
      list.innerHTML = ticket.selections.map((p) => pickRow(p)).join('');
    } else {
      list.innerHTML = '';
      noBox.classList.remove('hidden');
      const nt = ticket.noTicket || {};
      setText('#noTicketTitle', ticket.status === 'DATA_SOURCE_UNAVAILABLE' ? 'Data source temporarily unavailable' : 'No qualifying ticket');
      setText('#noTicketMessage', nt.message || 'No valid Over 1.5 combination was found within the 2.00-4.00 target range.');
      const alert = $('#noTicketAlert');
      if (alert) alert.className = `alert ${ticket.status === 'DATA_SOURCE_UNAVAILABLE' ? 'error' : 'warn'}`;
      paintDiagnostics(nt.diagnostics);
    }
  }

  function paintRecent(history) {
    const box = $('#recentResults');
    if (!box) return;
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

  /* --------------------------- public record --------------------------- */

  function paintRecord(stats) {
    const tickets = (stats && stats.tickets) || {};
    const streaks = (stats && stats.streaks) || {};
    const flat = (stats && stats.flatStake) || null;

    const settled = tickets.settled === null || tickets.settled === undefined ? null : Number(tickets.settled);
    setText('#hpStatSettled', settled === null ? '—' : settled);
    setText('#hpStatSettledNote', tickets.total ? `${tickets.total} published · ${tickets.noTicketDays || 0} no-ticket days` : 'published & settled');
    setText('#hpStatWinRate', tickets.winRate === null || tickets.winRate === undefined ? '—' : `${tickets.winRate}%`);
    setText('#hpStatAvgOdds', tickets.avgOdds === null || tickets.avgOdds === undefined ? '—' : fmt.odds(tickets.avgOdds));
    setText('#hpStatStreak', streaks.longestWinningStreak === null || streaks.longestWinningStreak === undefined ? '—' : streaks.longestWinningStreak);

    const roiNode = $('#hpStatRoi');
    if (roiNode) {
      const roi = flat && flat.roi !== null && flat.roi !== undefined ? Number(flat.roi) : null;
      const profit = flat && flat.profit !== null && flat.profit !== undefined ? Number(flat.profit) : null;
      if (roi === null) {
        roiNode.textContent = '—';
        roiNode.className = 'v';
      } else {
        roiNode.textContent = `${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`;
        roiNode.className = `v ${roi >= 0 ? 'green' : 'amber'}`;
        if (profit !== null) {
          const note = roiNode.parentElement && roiNode.parentElement.querySelector('.d');
          if (note) note.textContent = `${profit >= 0 ? '+' : ''}${profit.toFixed(2)} units profit · 1u flat stake`;
        }
      }
    }
  }

  /* ------------------------ public match analysis ----------------------- */

  function metricCell(label, value, tone = '') {
    return `<div><div class="k">${escapeHtml(label)}</div><div class="v ${tone}">${escapeHtml(value)}</div></div>`;
  }

  function matchCard(p) {
    const league = (p.league && p.league.name) || 'League';
    const logo = p.league && p.league.logo ? `<img src="${escapeHtml(p.league.logo)}" alt="" loading="lazy">` : '';
    const home = (p.homeTeam && p.homeTeam.name) || 'Home';
    const away = (p.awayTeam && p.awayTeam.name) || 'Away';
    const confidence = Number(p.confidence);
    const barWidth = Number.isFinite(confidence) ? Math.max(4, Math.min(100, Math.round(confidence))) : 4;
    const xg = p.expectedGoals && p.expectedGoals.total !== null && p.expectedGoals.total !== undefined ? fmt.num(p.expectedGoals.total) : '—';
    const rate = (v) => (v === null || v === undefined ? '—' : fmt.pct(v));
    const odds = p.odds && p.odds.available
      ? `<span class="hp-odds"><span class="val">${escapeHtml(fmt.odds(p.odds.value))}</span><span class="tiny muted">${escapeHtml(p.odds.bookmaker || '')}</span></span>`
      : `<span class="badge badge-slate">${icons.info} Odds unavailable</span>`;

    return `<article class="hp-match">
      <div class="hp-match-top">
        <span class="hp-match-league">${logo}<span>${escapeHtml(league)}</span></span>
        ${p.eligible ? `<span class="badge badge-green">${icons.check} Model pick</span>` : `<span class="badge badge-slate">${escapeHtml(p.rejectReason || 'Watching')}</span>`}
      </div>
      <div class="hp-match-teams">${escapeHtml(home)}<span class="vs">vs</span>${escapeHtml(away)}</div>
      <div class="hp-match-meta">
        <span>${icons.calendar} ${escapeHtml(fmt.kickoffLabel(p.kickoffAt))}</span>
        <span>Over 1.5 Goals</span>
      </div>
      <div class="hp-bar" role="img" aria-label="Model confidence ${Number.isFinite(confidence) ? Math.round(confidence) : '—'}%"><i style="width:${barWidth}%"></i></div>
      <div class="hp-match-metrics">
        ${metricCell('Confidence', Number.isFinite(confidence) ? fmt.pct(confidence) : '—', 'cyan')}
        ${metricCell('xG total', xg)}
        ${metricCell('H/A over 1.5', `${rate(p.over15Rates && p.over15Rates.home)}/${rate(p.over15Rates && p.over15Rates.away)}`)}
      </div>
      <div class="hp-match-foot">
        ${odds}
        <a class="small" href="/predictions.html">Breakdown →</a>
      </div>
    </article>`;
  }

  function paintMatches(data) {
    const box = $('#hpMatches');
    const note = $('#hpMatchesNote');
    if (!box) return;
    const items = (data && data.items) || [];
    if (!items.length) {
      box.innerHTML = `<div class="hp-match" style="grid-column:1/-1;">
        ${emptyState('target', 'No match analysis published yet', 'The engine scores every fixture it syncs. As soon as today’s data is available, the model output appears here.')}
      </div>`;
      if (note) note.textContent = '';
      return;
    }
    box.innerHTML = items.map(matchCard).join('');
    if (note) {
      note.textContent = `${data.total || items.length} fixture(s) analysed for ${fmt.dayLabel(data.date)} · model output only, not a guarantee.`;
    }
  }

  /* --------------------------- data source pill ------------------------ */

  function paintDataSource(health) {
    const pill = $('#dataSourcePill');
    if (!pill) return;
    const source = (health && health.dataSource) || {};
    const configured = Boolean(source.configured);
    const available = Boolean(source.available);
    const ok = configured && available;
    pill.className = `hp-pill ${ok ? 'ok' : 'warn'}`;
    pill.innerHTML = `<span class="dot"></span> ${escapeHtml(
      !configured ? 'Data source not configured' : available ? `Data source live · ${source.state || 'OK'}` : 'Data source temporarily unavailable'
    )}`;
  }

  /* -------------------------------- init ------------------------------- */

  async function init() {
    App.session.bindHeader();

    const list = $('#pickList');
    if (list) list.innerHTML = skeletonRows(3);

    const ticket = await API.get('/ticket/today').catch((err) => ({ __error: err }));
    if (ticket && ticket.__error) {
      if (list) {
        list.innerHTML = emptyState('alert', 'Could not load today’s ticket', ticket.__error.message || 'The API is unreachable right now.');
      }
    } else {
      paintTicket(ticket);
    }

    const [health, history, stats, matches] = await Promise.all([
      API.get('/health').catch(() => null),
      API.get('/tickets/history?limit=5').catch(() => null),
      API.get('/analytics').catch(() => null),
      API.get(`/predictions?date=${new Date().toISOString().slice(0, 10)}&limit=6&eligible=1`).catch(() => null),
    ]);

    paintDataSource(health);
    paintRecent(history);
    paintRecord(stats);
    paintMatches(matches);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
