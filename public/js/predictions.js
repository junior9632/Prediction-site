/* GoalPredict — public Over 1.5 analysis list */
'use strict';
(function () {
  const { API, fmt, icons, escapeHtml, emptyState, skeletonRows } = App;
  const $ = (s) => document.querySelector(s);

  function cardRow(p) {
    const state = p.eligible
      ? `<span class="badge badge-green">${icons.check} Eligible</span>`
      : `<span class="badge badge-slate">${icons.info} ${escapeHtml(p.rejectReason || 'Rejected')}</span>`;
    return `<div class="history-row" style="align-items:flex-start;">
      <div class="grow">
        <div class="pick-teams" style="margin-top:0;">${escapeHtml(p.homeTeam ? p.homeTeam.name : '')}<span class="vs">vs</span>${escapeHtml(p.awayTeam ? p.awayTeam.name : '')}</div>
        <div class="pick-meta"><span>${icons.calendar} ${escapeHtml(fmt.kickoffLabel(p.kickoffAt))}</span><span>${escapeHtml((p.league && p.league.name) || '')}</span></div>
        <div class="pick-meta">
          <span>conf <b>${fmt.pct(p.confidence)}</b></span><span>quality <b>${fmt.pct(p.quality)}</b></span><span>risk <b>${fmt.pct(p.risk)}</b></span>
          <span>xG total <b>${p.expectedGoals && p.expectedGoals.total !== null ? fmt.num(p.expectedGoals.total) : '—'}</b></span>
          <span>over1.5 H/A <b>${p.over15Rates && p.over15Rates.home !== null ? fmt.pct(p.over15Rates.home) : '—'} / ${p.over15Rates && p.over15Rates.away !== null ? fmt.pct(p.over15Rates.away) : '—'}</b></span>
          ${p.odds && p.odds.available ? `<span>odds <b>${escapeHtml(p.odds.value)}</b> (${escapeHtml(p.odds.bookmaker)})</span>` : '<span class="muted">odds: DATA UNAVAILABLE</span>'}
        </div>
      </div>
      <div class="row">${state}</div>
    </div>
    <details class="pick-detail" data-fixture-id="${escapeHtml(p.fixtureId)}" id="detail-${escapeHtml(p.fixtureId)}"><summary>${icons.chevronDown} Transparent breakdown</summary><div class="detail-body" id="detail-body-${escapeHtml(p.fixtureId)}"><div class="tiny muted">Loading…</div></div></details>`;
  }

  /**
   * Load the stored breakdown for one fixture.
   *
   * The fixture id used to live only on the inner <div>, while the toggle
   * handler read it from the <details> element — so every panel requested
   * /predictions/NaN (HTTP 400) and stayed on "Loading…" forever. The id is now
   * on the <details> that is actually listened to, and a failed request clears
   * the "loaded" guard so re-opening the panel retries instead of showing a
   * dead spinner for the rest of the session.
   */
  async function loadDetail(fixtureId) {
    const id = Number(fixtureId);
    if (!Number.isSafeInteger(id) || id <= 0) return;
    const box = document.getElementById(`detail-body-${id}`);
    if (!box || box.dataset.loaded) return;
    box.dataset.loaded = '1';
    try {
      const data = await API.get(`/predictions/${fixtureId}`);
      const f = data.prediction;
      box.innerHTML = `<div class="diag-grid">
        <div class="diag-cell"><div class="k">Model P(2+)</div><div class="v">${f.modelProbability === null ? '—' : (f.modelProbability * 100).toFixed(1) + '%'}</div></div>
        <div class="diag-cell"><div class="k">Market P</div><div class="v">${f.marketProbability === null ? '—' : (f.marketProbability * 100).toFixed(1) + '%'}</div></div>
        <div class="diag-cell"><div class="k">xG home</div><div class="v">${f.expectedGoals.home === null ? '—' : fmt.num(f.expectedGoals.home)}</div></div>
        <div class="diag-cell"><div class="k">xG away</div><div class="v">${f.expectedGoals.away === null ? '—' : fmt.num(f.expectedGoals.away)}</div></div>
        <div class="diag-cell"><div class="k">League over1.5</div><div class="v">${f.over15Rates.league === null ? '—' : fmt.pct(f.over15Rates.league)}</div></div>
        <div class="diag-cell"><div class="k">H2H over1.5</div><div class="v">${f.over15Rates.h2h === null ? 'n/a' : fmt.pct(f.over15Rates.h2h)}</div></div>
      </div>
      <div class="table-wrap" style="margin-top:10px;"><table class="data"><thead><tr><th>Component</th><th>Score</th><th>Weight</th><th>Contribution</th></tr></thead><tbody>
        ${data.scoreBreakdown.map((s) => `<tr><td>${escapeHtml(s.component)}</td><td>${fmt.num(s.score)}</td><td>${fmt.num(s.weight, 3)}</td><td>${fmt.num(s.contribution, 3)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No components stored.</td></tr>'}
      </tbody></table></div>`;
    } catch (err) {
      delete box.dataset.loaded;
      box.innerHTML = `<div class="alert error">${escapeHtml(err.message)}<div class="tiny muted">Close and re-open this panel to retry.</div></div>`;
    }
  }

  async function load() {
    await App.site.load();
    App.session.bindHeader();
    const date = $('#dateInput').value || new Date().toISOString().slice(0, 10);
    const eligible = $('#eligibleOnly').checked;
    const box = $('#predList');
    box.innerHTML = skeletonRows(4);
    try {
      const data = await API.get(`/predictions?date=${encodeURIComponent(date)}&limit=100&eligible=${eligible ? 1 : 0}`);
      $('#countLabel').textContent = `${data.total} analysed · breakdown: ${Object.entries(data.rejectionBreakdown || {}).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`;
      if (!data.items.length) box.innerHTML = emptyState('target', 'No analysis stored', 'Run a sync and a generation to populate the analysis for this date.');
      else box.innerHTML = data.items.map(cardRow).join('');
      box.querySelectorAll('details.pick-detail').forEach((details) => {
        details.addEventListener('toggle', () => {
          if (!details.open) return;
          loadDetail(details.dataset.fixtureId);
        });
      });
    } catch (err) {
      box.innerHTML = emptyState('alert', 'Predictions unavailable', err.message);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const input = $('#dateInput');
    input.value = new Date().toISOString().slice(0, 10);
    input.addEventListener('change', load);
    $('#eligibleOnly').addEventListener('change', load);
    load();
  });
})();
