/* GoalPredict — browse and refresh real fixture data, never fabricate it. */
'use strict';

(function () {
  const $ = (selector) => document.querySelector(selector);

  function syncState(result) {
    if (!result || result.status === 'DATA_SOURCE_UNAVAILABLE' || result.status === 'FAILED' || result.status === 'ERROR' || result.dataSourceAvailable === false) return 'error';
    if (result.status === 'SKIPPED' || result.quotaPaused || (result.skippedDates && result.skippedDates.length)) return 'warn';
    const children = ['fixtures', 'odds', 'results'].filter((key) => result[key] && typeof result[key] === 'object').map((key) => syncState(result[key]));
    if (children.includes('error')) return 'error';
    return children.includes('warn') ? 'warn' : 'ok';
  }

  async function load({ API, fmt, icons, escapeHtml, card, table, render, emptyState, skeletonRows, isCurrent = () => true }) {
    const today = new Date().toISOString().slice(0, 10);
    render(`<div id="fixturesView">
      <form id="fixtureFilters" class="row wrap fixture-toolbar">
        <div class="field"><label for="fxDate">Fixture date (UTC)</label><input type="date" class="input" id="fxDate" value="${today}" required></div>
        <button type="submit" class="btn btn-ghost" id="fxGo">${icons.refresh} Reload</button>
        <button type="button" class="btn btn-primary" id="fxSync">${icons.refresh} Sync selected date</button>
        <a class="btn btn-ghost" href="#settings">Sync settings</a>
      </form>
      <p class="tiny muted">The date filter uses UTC. Kickoff times use <span data-display-timezone>${escapeHtml(fmt.zoneLabel())}</span>. Syncing refreshes the selected date from the provider, respects tracked leagues and the request reserve, and never generates a ticket.</p>
      <div id="fxMessage" role="status" aria-live="polite"></div>
      <div class="row wrap fixture-toolbar">
        <div class="field grow"><label for="fxSearch">Search fixtures</label><input type="search" class="input" id="fxSearch" placeholder="Team, league or country"></div>
        <div class="field"><label for="fxStatus">Status</label><select class="input" id="fxStatus"><option value="all">All fixtures</option><option value="playable">Playable / upcoming</option><option value="live">In play</option><option value="finished">Finished</option><option value="other">Other / unavailable</option></select></div>
      </div>
      <div id="fxBody">${skeletonRows(3)}</div><div id="fxPager" class="fixture-pager"></div>
    </div>`);
    const root = $('#fixturesView');
    const active = () => isCurrent() && $('#fixturesView') === root;
    let requestId = 0;
    let items = [];
    let page = 1;
    let syncing = false;
    let loading = false;
    const pageSize = 50;
    const setMessage = (html) => { if (active()) $('#fxMessage').innerHTML = html; };
    const dateValid = () => {
      const date = $('#fxDate');
      return date.value && /^\d{4}-\d{2}-\d{2}$/.test(date.value) && date.reportValidity();
    };
    const paint = () => {
      if (!active() || loading) return;
      const search = $('#fxSearch').value.trim().toLowerCase();
      const status = $('#fxStatus').value;
      const filtered = items.filter((fixture) => {
        const state = status === 'all' || (status === 'playable' && fixture.playable) || (status === 'live' && fixture.live) || (status === 'finished' && fixture.finished) || (status === 'other' && !fixture.playable && !fixture.live && !fixture.finished);
        return state && [fixture.home, fixture.away, fixture.league, fixture.country, fixture.id].join(' ').toLowerCase().includes(search);
      });
      const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
      page = Math.max(1, Math.min(page, pages));
      const visible = filtered.slice((page - 1) * pageSize, page * pageSize);
      $('#fxBody').innerHTML = !items.length
        ? emptyState('calendar', 'No fixtures stored for this date', 'Use Sync selected date to fetch real fixtures. If the date remains empty, check your API connection, plan coverage and tracked league settings.')
        : !filtered.length
          ? emptyState('calendar', 'No matching fixtures', 'Clear the search or choose All fixtures to see the stored matches.')
          : card(`${filtered.length} matching · ${items.length} fixtures stored`, '<p class="tiny muted" style="padding:0 16px;">Scroll the table horizontally on small screens to see every column.</p>' + table(
            ['Kickoff', 'League', 'Match', 'Status', 'Playable', '90-minute score', 'Last synced'],
            visible.map((f) => `<tr><td>${escapeHtml(fmt.dateTimeLabel(f.kickoffAt))}</td><td>${escapeHtml(f.league || '—')}<div class="tiny muted">${escapeHtml(f.country || '')}</div></td><td><b>${escapeHtml(f.home || 'Unknown team')}</b> vs <b>${escapeHtml(f.away || 'Unknown team')}</b><div class="tiny muted">#${escapeHtml(f.id)}</div></td><td title="${escapeHtml(f.statusLabel || f.status || '')}">${escapeHtml(f.statusLabel || f.status || 'Unknown')}</td><td><span class="badge ${f.playable ? 'badge-green' : 'badge-slate'}">${f.playable ? 'yes' : 'no'}</span></td><td>${escapeHtml(f.score === null || f.score === undefined ? '—' : f.score)}</td><td class="tiny" title="${escapeHtml(fmt.dateTimeLabel(f.fetchedAt))}">${escapeHtml(fmt.ago(f.fetchedAt))}</td></tr>`).join('')
          ));
      $('#fxPager').innerHTML = filtered.length ? `<span class="small muted">Showing ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, filtered.length)} of ${filtered.length}</span><div class="row"><button type="button" class="btn btn-ghost btn-sm" id="fxPrev" ${page <= 1 ? 'disabled' : ''}>Previous</button><span class="tiny muted">${page} / ${pages}</span><button type="button" class="btn btn-ghost btn-sm" id="fxNext" ${page >= pages ? 'disabled' : ''}>Next</button></div>` : '';
      if ($('#fxPrev')) $('#fxPrev').onclick = () => { page -= 1; paint(); };
      if ($('#fxNext')) $('#fxNext').onclick = () => { page += 1; paint(); };
    };
    const loadRows = async () => {
      if (!active()) return;
      if (!dateValid()) { $('#fxDate').reportValidity(); return; }
      const seq = ++requestId;
      loading = true;
      const date = $('#fxDate').value;
      $('#fxGo').disabled = true;
      $('#fxBody').innerHTML = skeletonRows(3);
      $('#fxPager').innerHTML = '';
      try {
        const data = await API.get(`/admin/fixtures?date=${encodeURIComponent(date)}`);
        if (!active() || seq !== requestId) return;
        loading = false;
        items = data.items;
        page = 1;
        paint();
      } catch (err) {
        if (!active() || seq !== requestId) return;
        loading = false;
        items = [];
        $('#fxBody').innerHTML = emptyState('alert', 'Fixtures could not be loaded', `${err.message}. Use Reload to retry.`);
      } finally {
        if (active() && seq === requestId) $('#fxGo').disabled = syncing;
      }
    };
    $('#fixtureFilters').onsubmit = (event) => { event.preventDefault(); return loadRows(); };
    $('#fxDate').onchange = () => { setMessage(''); return loadRows(); };
    $('#fxSearch').oninput = () => { page = 1; paint(); };
    $('#fxStatus').onchange = () => { page = 1; paint(); };
    $('#fxSync').onclick = async () => {
      if (syncing || !dateValid()) { $('#fxDate').reportValidity(); return; }
      const date = $('#fxDate').value;
      if (!window.confirm(`Sync fixtures for ${date} (UTC)? This uses your provider's request allowance and does not generate a ticket.`)) return;
      syncing = true;
      ['#fxSync', '#fxGo', '#fxDate'].forEach((selector) => { $(selector).disabled = true; });
      setMessage(`<div class="alert info">${icons.refresh}<div>Syncing ${escapeHtml(date)}… Keep this page open. No ticket is being generated.</div></div>`);
      try {
        const response = await API.post('/admin/sync', { job: 'fixtures', date });
        if (!active()) return;
        const result = response.result;
        const tone = syncState(result);
        if (tone !== 'ok') {
          setMessage(`<div class="alert ${tone}">${icons.alert}<div><b>${tone === 'warn' ? 'Sync paused' : 'Sync unavailable'}</b> — ${escapeHtml(result.label || result.error || result.reason || 'The sync did not complete.')}${result.hint ? `<div class="small">${escapeHtml(result.hint)}</div>` : ''}<a href="#api-management">Check API connection</a></div></div>`);
        } else {
          setMessage(`<div class="alert ok">${icons.checkCircle}<div>${escapeHtml(result.upcoming)} fixture(s) refreshed for ${escapeHtml(date)}. No ticket was generated.</div></div>`);
        }
        await loadRows();
      } catch (err) {
        setMessage(`<div class="alert error">${icons.alert}<div>Sync failed: ${escapeHtml(err.message)}. You can retry or check <a href="#api-management">API Management</a>.</div></div>`);
      } finally {
        syncing = false;
        if (active()) ['#fxSync', '#fxGo', '#fxDate'].forEach((selector) => { $(selector).disabled = false; });
      }
    };
    await loadRows();
  }

  window.AdminFixtures = { load, syncState };
})();
