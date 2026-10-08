/* GoalPredict — today's ticket detail (members only)
 *
 * /api/ticket/* is behind the member guard, so an ended session answers 401
 * and the page shows the sign-in door instead of ticket data. */
'use strict';
(function () {
  const { API, fmt, icons, escapeHtml, pickRow, pickEvidence, statusBadge, emptyState, lockedState, isUnauthorized, skeletonRows } = App;
  const $ = (s) => document.querySelector(s);

  function diagnostics(diag) {
    if (!diag) return '';
    const cells = [
      ['Fixtures analyzed', diag.fixturesAnalyzed], ['Over 1.5 candidates', diag.over15Candidates],
      ['Verified odds', diag.verifiedOdds], ['Rejected matches', diag.rejectedMatches],
      ['Low confidence', diag.lowConfidence], ['High risk', diag.highRisk],
      ['Insufficient data', diag.insufficientData], ['Correlation rejected', diag.correlationRejected],
      ['Combinations tested', diag.combinationsTested], ['Qualified combos', diag.qualifiedCombinations],
    ];
    return cells.map(([k, v]) => `<div class="diag-cell"><div class="k">${escapeHtml(k)}</div><div class="v">${v === null || v === undefined ? '—' : escapeHtml(v)}</div></div>`).join('');
  }

  async function load() {
    App.session.bindHeader();
    const params = new URLSearchParams(window.location.search);
    const date = params.get('date');
    const path = date ? `/ticket/${encodeURIComponent(date)}` : '/ticket/today';
    $('#backIcon').innerHTML = icons.arrowLeft;
    $('#noTicketIcon').innerHTML = icons.alert;
    $('#pickList').innerHTML = skeletonRows(3);

    try {
      const ticket = await API.get(path);
      $('#ticketTitle').textContent = ticket.headline || "Today's Ticket";
      $('#ticketDate').textContent = `${fmt.dayLabel(ticket.date)} · market ${ticket.market ? ticket.market.label : 'Over 1.5 Goals'}`;
      $('#ticketBadge').innerHTML = statusBadge(ticket);
      App.setText('#accOdds', ticket.totalOdds ? fmt.odds(ticket.totalOdds) : '—');
      App.setText('#accPicks', ticket.selectionCount || 0);
      App.setText('#accConfidence', ticket.avgConfidence === null || ticket.avgConfidence === undefined ? '—' : fmt.pct(ticket.avgConfidence));
      $('#accStatus').innerHTML = statusBadge(ticket);

      if (ticket.status === 'QUALIFIED' && ticket.selections.length) {
        $('#noTicketBox').classList.add('hidden');
        $('#pickList').innerHTML =
          ticket.selections.map((p) => `${pickRow(p)}<details class="pick-detail"><summary>${icons.chevronDown} Why this match &amp; odds snapshot</summary><div class="detail-body">${pickEvidence(p)}
            <div class="detail-line"><span class="muted">Bookmaker price (frozen)</span><span class="score-pill">${escapeHtml(p.odds.value)} · ${escapeHtml(p.odds.bookmaker)}</span></div>
            <div class="detail-line"><span class="muted">Odds verified on server</span><span>${escapeHtml(fmt.dateTimeLabel(p.odds.verifiedAt))}</span></div>
            <div class="detail-line"><span class="muted">Kickoff</span><span>${escapeHtml(fmt.kickoffLabel(p.kickoffAt))}</span></div>
            ${p.score ? `<div class="detail-line"><span class="muted">Final score (90 min)</span><span class="score-pill">${p.score.home}-${p.score.away} (${p.score.total} goals)</span></div>` : ''}
          </div></details>`).join('');
      } else {
        $('#pickList').innerHTML = '';
        $('#noTicketBox').classList.remove('hidden');
        const nt = ticket.noTicket || {};
        App.setText('#noTicketTitle', ticket.status === 'DATA_SOURCE_UNAVAILABLE' ? 'Data source temporarily unavailable' : 'No qualifying ticket');
        App.setText('#noTicketMessage', nt.message || 'No valid Over 1.5 combination was found within the 2.00-4.00 target range.');
        $('#diagGrid').innerHTML = diagnostics(nt.diagnostics);
      }
    } catch (err) {
      $('#pickList').innerHTML = isUnauthorized(err)
        ? lockedState("Login to access today's verified football selections.")
        : emptyState('alert', 'Ticket unavailable', err.message);
    }
  }
  document.addEventListener('DOMContentLoaded', load);
})();
