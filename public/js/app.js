/* GoalPredict — public homepage */
'use strict';

(function () {
  const { API, fmt, icons, escapeHtml, pickRow, statusBadge, emptyState, skeletonRows } = App;

  const $ = (sel) => document.querySelector(sel);

  /* The homepage is a marketing surface that reads the same two public
     endpoints every visitor can read. It never asks for account-scoped data
     and it never names the private area. */

  const PILL = {
    ok: { cls: 'hp-pill ok', text: 'Verified & published' },
    none: { cls: 'hp-pill warn', text: 'No ticket today' },
    offline: { cls: 'hp-pill bad', text: 'Data offline' },
    pending: { cls: 'hp-pill', text: 'Not published yet' },
  };

  function paintLive(ticket) {
    App.setText('#liveMarket', 'Over 1.5 Goals');
    App.setText('#liveOdds', ticket.totalOdds ? fmt.odds(ticket.totalOdds) : '—');
    App.setText('#livePicks', ticket.selectionCount || 0);
    App.setText(
      '#liveConfidence',
      ticket.avgConfidence === null || ticket.avgConfidence === undefined ? '—' : fmt.pct(ticket.avgConfidence)
    );

    const pill = $('#livePill');
    const key =
      ticket.status === 'QUALIFIED'
        ? 'ok'
        : ticket.status === 'DATA_SOURCE_UNAVAILABLE'
          ? 'offline'
          : ticket.status === 'NO_QUALIFYING_TICKET'
            ? 'none'
            : 'pending';
    const spec = PILL[key];
    if (pill) {
      pill.className = spec.cls;
      App.setText('#livePillText', spec.text);
    }

    const generated = ticket.generatedAt ? `Generated ${fmt.dateTimeLabel(ticket.generatedAt)}` : null;
    if (key === 'ok') {
      App.setText('#liveMessage', generated ? `${generated} · every price re-verified before publication.` : 'Every price re-verified before publication.');
    } else if (key === 'none') {
      const nt = ticket.noTicket || {};
      App.setText('#liveMessage', nt.message || 'No valid Over 1.5 combination landed inside the 2.00-4.00 window today.');
    } else if (key === 'offline') {
      App.setText('#liveMessage', 'The odds feed is temporarily unavailable — nothing is published instead of guessing.');
    } else {
      App.setText('#liveMessage', "Today's ticket has not been published yet.");
    }
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
    paintLive(ticket);
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
      // a browser-side failure is not the same claim as "the feed is down",
      // so it gets its own wording rather than a misleading status
      const pill = $('#livePill');
      if (pill) {
        pill.className = 'hp-pill bad';
        App.setText('#livePillText', 'Status unavailable');
      }
      App.setText('#liveMessage', 'The site could not be reached from this browser right now — reload to try again.');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
