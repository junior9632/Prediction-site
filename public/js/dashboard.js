'use strict';
document.addEventListener('DOMContentLoaded', async () => {
  const $ = (s) => document.querySelector(s);
  const { API, fmt, escapeHtml, emptyState } = App;

  function setText(selector, value) {
    const node = $(selector);
    if (node) node.textContent = value;
  }

  function clearActivity() {
    // never leave the feed behind: wipe it whenever the session may have ended
    const card = $('#activityCard');
    if (card) card.classList.add('hidden');
    setText('#activitySummary', '');
    setText('#activityFeed', '');
  }

  function summaryCell(key, value) {
    return `<div class="acc-cell"><div class="k">${escapeHtml(key)}</div><div class="v">${escapeHtml(value)}</div></div>`;
  }

  function activityRow(item) {
    const tone = ['good', 'info', 'warn'].includes(item.tone) ? item.tone : '';
    return `<div class="activity-row">
      <span class="activity-dot ${tone}" aria-hidden="true"></span>
      <span class="grow"><b>${escapeHtml(item.title)}</b>
        <div class="tiny muted">${escapeHtml(item.detail)}</div></span>
      <span class="tiny muted" title="${escapeHtml(fmt.dateTimeLabel(item.at))}">${escapeHtml(fmt.ago(item.at))}</span>
    </div>`;
  }

  async function loadActivity() {
    try {
      const data = await API.get('/dashboard/activity');
      const account = data.account || {};
      const summary = data.summary || {};
      setText('#activitySummary', '');
      $('#activitySummary').innerHTML = [
        summaryCell('Plan', account.plan || 'Member'),
        summaryCell('Recorded events', String(summary.recordedEvents || 0)),
        summaryCell('Last activity', summary.lastActivityAt ? fmt.ago(summary.lastActivityAt) : '—'),
      ].join('');
      $('#activityFeed').innerHTML = data.items && data.items.length
        ? data.items.map(activityRow).join('')
        : emptyState('history', 'No activity yet', 'Sign-ins, password changes and security events appear here.');
      $('#activityCard').classList.remove('hidden');
      return true;
    } catch (_err) {
      clearActivity();
      return false;
    }
  }

  let me;
  try { me = await API.get('/auth/me'); } catch (_) { window.location.replace('/account.html'); return; }
  if (!me) { window.location.replace('/account.html'); return; }
  const account = me.account || {};
  const name = account.username || 'Member';
  $('#welcomeName').textContent = name;
  $('#profileName').textContent = name;
  $('#profileEmail').textContent = account.email || '—';
  $('#avatar').textContent = name.slice(0, 2).toUpperCase();
  if (account.memberSince) $('#memberSince').textContent = 'Member since ' + App.fmt.dayLabel(account.memberSince);
  await loadActivity();
  try {
    const ticket = await API.get('/ticket/today');
    const status = ticket.status === 'QUALIFIED' ? 'Published' : ticket.status === 'NO_QUALIFYING_TICKET' ? 'No qualifying ticket' : 'Data temporarily unavailable';
    $('#ticketStatus').textContent = status;
    $('#ticketMessage').textContent = (ticket.noTicket && ticket.noTicket.message) || (ticket.status === 'QUALIFIED' ? 'Today’s ticket is available to review.' : 'We do not publish a ticket unless the verified data meets our criteria.');
  } catch (_) { $('#ticketStatus').textContent = 'Status unavailable'; $('#ticketMessage').textContent = 'Please try again shortly.'; }
  $('#logoutBtn').addEventListener('click', async () => {
    clearActivity(); // never leave the feed on screen after signing out
    try { await API.post('/auth/logout', {}); } catch (_) {}
    window.location.replace('/');
  });

  // A page restored from the back/forward cache must never show a stale feed:
  // wipe it, then re-validate the session against the server.
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    clearActivity();
    void (async () => {
      try { await API.get('/auth/me'); } catch (_) { window.location.replace('/account.html'); return; }
      await loadActivity();
    })();
  });
});
