/* GoalPredict — member dashboard (session required, enforced by the server) */
'use strict';

document.addEventListener('DOMContentLoaded', async () => {
  const { API, fmt, icons, escapeHtml, emptyState } = App;
  const $ = (s) => document.querySelector(s);

  const SIGN_IN = '/account.html';

  /* ---------------------------- session ---------------------------- */
  const goToSignIn = () => window.location.replace(SIGN_IN);

  /**
   * Remove everything account specific from the DOM.
   *
   * Used before signing out and before re-validating a page restored from the
   * browser's back/forward cache: a snapshot taken while signed in must never
   * be shown to a session that is gone (shared computer, expired token).
   */
  function clearActivity() {
    const card = $('#activityCard');
    if (card) card.classList.add('hidden');
    const feed = $('#activityFeed');
    if (feed) feed.innerHTML = '';
    for (const id of ['#activityUser', '#activityPlan', '#activitySince', '#activityLastLogin', '#activityCount', '#activityGenerated']) {
      App.setText(id, '—');
    }
    App.setText('#welcomeName', 'there');
    App.setText('#profileName', '—');
    App.setText('#profileEmail', '—');
  }

  /** Re-check the session with the server; returns false when it is gone. */
  async function revalidate() {
    let session = null;
    try {
      session = await API.get('/auth/me');
    } catch (_) {
      session = null;
    }
    if (!session) {
      goToSignIn();
      return false;
    }
    await loadActivity();
    return true;
  }

  // Back/forward cache: the browser can restore this page with its frozen DOM
  // after the user signed out (or the session expired). Nothing is trusted from
  // the snapshot — it is wiped and re-validated against the server first.
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    clearActivity();
    revalidate();
  });

  let me;
  try {
    me = await API.get('/auth/me');
  } catch (_) {
    goToSignIn();
    return;
  }
  if (!me) {
    goToSignIn();
    return;
  }

  /* ----------------------------- profile ---------------------------- */
  const account = me.account || {};
  const name = account.username || 'Member';
  $('#welcomeName').textContent = name;
  $('#profileName').textContent = name;
  $('#profileEmail').textContent = account.email || '—';
  $('#avatar').textContent = name.slice(0, 2).toUpperCase();
  if (account.memberSince) $('#memberSince').textContent = 'Member since ' + fmt.dayLabel(account.memberSince);

  /* --------------------------- dashboard activity -------------------- */
  /**
   * The activity feed is fetched from GET /api/dashboard/activity, which the
   * server answers with 401 for anyone without a verified session. The card
   * stays hidden until the authenticated payload arrives, so a failed session
   * can never leave private dashboard data on screen.
   */
  const ACTIVITY_ICONS = {
    USER_REGISTERED: 'sparkles',
    USER_LOGIN: 'lock',
    USER_LOGOUT: 'logout',
    USER_PASSWORD_CHANGED: 'shield',
    LOGIN_FAILED: 'alert',
    ACCOUNT_LOCKED: 'alert',
    ADMIN_LOGIN: 'shield',
    ADMIN_LOGOUT: 'logout',
    ADMIN_PASSWORD_CHANGED: 'shield',
  };

  function paintActivitySummary(data) {
    const a = data.account || {};
    const s = data.summary || {};
    App.setText('#activityUser', a.username || '—');
    App.setText('#activityPlan', a.plan || '—');
    App.setText('#activitySince', a.memberSince ? fmt.dayLabel(a.memberSince) : '—');
    App.setText('#activityLastLogin', a.lastLoginAt ? fmt.dateTimeLabel(a.lastLoginAt) : '—');
    App.setText('#activityCount', s.recordedEvents === null || s.recordedEvents === undefined ? '—' : s.recordedEvents);
    App.setText('#activityGenerated', data.generatedAt ? `Updated ${fmt.timeLabel(data.generatedAt)}` : '—');
  }

  function paintActivityFeed(items) {
    const box = $('#activityFeed');
    if (!items.length) {
      box.innerHTML = emptyState('activity', 'No recorded activity yet', 'Sign-ins, password changes and account events will appear here.');
      return;
    }
    box.innerHTML = items
      .map((item) => {
        const icon = icons[ACTIVITY_ICONS[item.event] || 'activity'] || icons.activity;
        return `<div class="activity-row">
          <span class="activity-icon ${escapeHtml(item.tone || 'info')}" aria-hidden="true">${icon}</span>
          <div class="activity-main">
            <div class="t">${escapeHtml(item.title || item.event)}</div>
            <div class="d">${escapeHtml(item.detail || '')}</div>
            <div class="when">${escapeHtml(fmt.dateTimeLabel(item.at))} · ${escapeHtml(fmt.ago(item.at))}</div>
          </div>
        </div>`;
      })
      .join('');
  }

  async function loadActivity() {
    const card = $('#activityCard');
    try {
      const data = await API.get('/dashboard/activity');
      paintActivitySummary(data || {});
      paintActivityFeed((data && data.items) || []);
      if (card) card.classList.remove('hidden');
      const note = $('#activityNote');
      if (note && data && data.summary && data.summary.shownEvents < data.summary.recordedEvents) {
        note.textContent = `Showing the ${data.summary.shownEvents} most recent of ${data.summary.recordedEvents} recorded events on your account.`;
      }
    } catch (err) {
      if (err && (err.status === 401 || err.status === 403)) {
        // the session is gone (expired, revoked, disabled) — leave no data behind
        goToSignIn();
        return;
      }
      const box = $('#activityFeed');
      if (box) box.innerHTML = emptyState('alert', 'Activity unavailable', 'Your dashboard activity could not be loaded right now.');
    }
  }

  /* --------------------------- platform status ---------------------- */
  try {
    const ticket = await API.get('/ticket/today');
    const status = ticket.status === 'QUALIFIED' ? 'Published' : ticket.status === 'NO_QUALIFYING_TICKET' ? 'No qualifying ticket' : 'Data temporarily unavailable';
    $('#ticketStatus').textContent = status;
    $('#ticketMessage').textContent = (ticket.noTicket && ticket.noTicket.message) || (ticket.status === 'QUALIFIED' ? 'Today’s ticket is available to review.' : 'We do not publish a ticket unless the verified data meets our criteria.');
  } catch (_) {
    $('#ticketStatus').textContent = 'Status unavailable';
    $('#ticketMessage').textContent = 'Please try again shortly.';
  }

  await loadActivity();

  $('#logoutBtn').addEventListener('click', async () => {
    clearActivity(); // never leave the feed in the DOM, not even for a snapshot
    try { await API.post('/auth/logout', {}); } catch (_) {}
    window.location.replace('/');
  });
});
