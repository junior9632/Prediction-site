/* GoalPredict — ticket history with selections and final scores */
'use strict';
(function () {
  const { API, fmt, icons, escapeHtml, emptyState, skeletonRows } = App;
  const $ = (s) => document.querySelector(s);
  let page = 1;

  function row(t) {
    const badge = t.result === 'WON' ? `<span class="badge badge-green">${icons.check} Won</span>`
      : t.result === 'LOST' ? `<span class="badge badge-red">${icons.x} Lost</span>`
      : t.result === 'VOID' || t.result === 'PARTIAL_VOID' ? `<span class="badge badge-amber">${icons.info} ${escapeHtml(t.result)}</span>`
      : t.status === 'NO_QUALIFYING_TICKET' ? `<span class="badge badge-slate">${icons.info} No ticket</span>`
      : t.status === 'DATA_SOURCE_UNAVAILABLE' ? `<span class="badge badge-amber">${icons.alert} Data offline</span>`
      : `<span class="badge badge-slate">${icons.clock} Pending</span>`;
    const settled = t.settledOdds ? ` · settled ${fmt.odds(t.settledOdds)}` : '';
    return `<div class="history-row">
      <div class="history-date grow"><div class="d">${escapeHtml(fmt.dayLabel(t.date))}</div>
        <div class="t">Total odds <b>${t.totalOdds ? fmt.odds(t.totalOdds) : '—'}</b> · ${t.selectionCount || 0} picks${settled}</div></div>
      ${badge}
    </div>
    ${t.selections && t.selections.length ? `<details class="pick-detail"><summary>${icons.chevronDown} Selections &amp; results</summary><div class="detail-body">
      ${t.selections.map((s) => `<div class="detail-line">
        <span class="grow"><b>${escapeHtml(s.homeTeam ? s.homeTeam.name : '')}</b> <span class="muted">vs</span> <b>${escapeHtml(s.awayTeam ? s.awayTeam.name : '')}</b>
          <div class="tiny muted">${escapeHtml((s.league && s.league.name) || '')} · ${escapeHtml(fmt.kickoffLabel(s.kickoffAt))} · Over 1.5 @ ${escapeHtml(fmt.exactOdds(s.odds && s.odds.display))} (${escapeHtml((s.odds && s.odds.bookmaker) || '')})</div></span>
        <span class="row">${s.score ? `<span class="score-pill">${s.score.home}-${s.score.away}</span>` : ''}
          ${s.result === 'WON' ? `<span class="badge badge-green">Won</span>` : s.result === 'LOST' ? `<span class="badge badge-red">Lost</span>` : s.result !== 'PENDING' ? `<span class="badge badge-amber">${escapeHtml(s.result)}</span>` : `<span class="badge badge-slate">Pending</span>`}</span>
      </div>`).join('')}
    </div></details>` : ''}`;
  }

  async function load() {
    App.session.bindHeader();
    const result = $('#resultFilter').value || '';
    const list = $('#historyList');
    list.innerHTML = skeletonRows(4);
    try {
      const data = await API.get(`/tickets/history?page=${page}&limit=15${result ? `&result=${encodeURIComponent(result)}` : ''}`);
      if (!data.items.length) list.innerHTML = emptyState('history', 'No tickets yet', 'Tickets appear here after they are generated and published.');
      else list.innerHTML = data.items.map(row).join('');
      const pager = $('#pager');
      pager.innerHTML = data.pages > 1 ? `<button class="btn btn-ghost btn-sm" id="prevBtn" ${page <= 1 ? 'disabled' : ''}>← Prev</button>
        <span class="info">Page ${data.page} / ${data.pages}</span>
        <button class="btn btn-ghost btn-sm" id="nextBtn" ${page >= data.pages ? 'disabled' : ''}>Next →</button>` : '';
      const prev = $('#prevBtn'); const next = $('#nextBtn');
      if (prev) prev.onclick = () => { page -= 1; load(); };
      if (next) next.onclick = () => { page += 1; load(); };
    } catch (err) {
      list.innerHTML = emptyState('alert', 'History unavailable', err.message);
    }
  }
  document.addEventListener('DOMContentLoaded', () => {
    $('#resultFilter').addEventListener('change', () => { page = 1; load(); });
    load();
  });
})();
