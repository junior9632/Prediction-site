/* GoalPredict — member account page */
'use strict';
(function () {
  const { API } = App;
  const $ = (s) => document.querySelector(s);

  /**
   * Where to go once the session exists. A `?next=` parameter is honoured only
   * when it is a same-site absolute path, so it can never be turned into an
   * off-site redirect; anything else falls back to the member dashboard.
   */
  function nextTarget() {
    const raw = new URLSearchParams(window.location.search).get('next');
    if (raw && raw.startsWith('/') && !raw.startsWith('//')) return raw;
    return '/dashboard';
  }

  const show = (id) => $(id).classList.remove('hidden');
  const hide = (id) => $(id).classList.add('hidden');

  function flash(alertSel, textSel, kind, message) {
    const node = $(alertSel);
    node.className = `alert ${kind}`;
    $(textSel).textContent = message;
    node.classList.remove('hidden');
  }

  function busy(btnSel, isBusy, idleLabel) {
    const btn = $(btnSel);
    btn.disabled = isBusy;
    if (isBusy) btn.innerHTML = '<span class="spinner"></span> Working…';
    else btn.textContent = idleLabel;
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  /* --------------------- member record since joining --------------------- */
  async function paintRecord(memberSince) {
    const from = memberSince ? String(memberSince).slice(0, 10) : null;
    try {
      const data = await API.get(`/tickets/history?limit=100${from ? `&from=${encodeURIComponent(from)}` : ''}`);
      const items = (data && data.items) || [];
      const settled = items.filter((t) => t.result === 'WON' || t.result === 'LOST');
      const won = settled.filter((t) => t.result === 'WON').length;
      const lost = settled.length - won;
      const noTicket = items.filter((t) => t.status === 'NO_QUALIFYING_TICKET').length;

      $('#recTickets').textContent = String(settled.length);
      $('#recWon').textContent = String(won);
      $('#recLost').textContent = String(lost);
      $('#recHitRate').textContent = settled.length ? `${Math.round((won / settled.length) * 100)}%` : '—';
      $('#recNoTicket').textContent = String(noTicket);
      $('#recNote').textContent = data.total > items.length
        ? `Showing the most recent ${items.length} of ${data.total} tickets since ${fmtDate(memberSince)}.`
        : settled.length
          ? `All settled tickets since ${fmtDate(memberSince)}.`
          : 'No settled tickets in your membership window yet.';
    } catch (_) {
      $('#recNote').textContent = 'Ticket history is unavailable right now.';
    }
  }

  /* ------------------------------ views ------------------------------ */
  function paintMember(account) {
    $('#profUsername').textContent = account.username || '—';
    $('#profEmail').textContent = account.email || '—';
    $('#profSince').textContent = fmtDate(account.memberSince);
    $('#profLastLogin').textContent = fmtDate(account.lastLoginAt);
    show('#memberView');
    paintRecord(account.memberSince);
  }

  async function route() {
    // The shared header helper swaps Login / Create Account for the account
    // chip and reveals the member-only navigation entries. It loads no
    // prediction data — those surfaces are refused server side without a
    // session, so there is nothing for this page to paint either.
    App.session.bindHeader();
    hide('#guestView');
    hide('#memberView');
    hide('#staffView');
    const me = await API.get('/auth/me').catch(() => null);
    if (!me) return show('#guestView');
    if (me.type === 'admin') return show('#staffView');
    return paintMember(me.account || {});
  }

  /* ------------------------------ forms ------------------------------ */
  function bindLogin() {
    $('#loginForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      busy('#loginBtn', true);
      try {
        await API.post('/auth/login', { login: $('#loginId').value.trim(), password: $('#loginPassword').value });
        window.location.href = nextTarget();
      } catch (err) {
        // A pending application gets an amber notice, not a red error: the
        // credentials may be fine, the account simply awaits approval.
        const kind = err.code === 'ACCOUNT_PENDING' ? 'warn' : 'error';
        flash('#loginAlert', '#loginAlertText', kind, err.message || 'Sign in failed');
        busy('#loginBtn', false, 'Sign in');
      }
    });
  }

  function bindRegister() {
    $('#registerForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      busy('#registerBtn', true);
      try {
        const username = $('#regUsername').value.trim();
        const password = $('#regPassword').value;
        const result = await API.post('/auth/register', {
          username,
          fullName: $('#regFullName').value.trim(),
          email: $('#regEmail').value.trim(),
          password,
        });
        // The account is created as PENDING: no session is issued here. The
        // server message is the professional approval notice the visitor
        // must see; signing in happens once an administrator approves.
        $('#registerForm').reset();
        flash('#registerAlert', '#registerAlertText', 'info', (result && result.message) || 'Your account has been submitted for approval. You will be able to access your dashboard once an administrator approves your account.');
        busy('#registerBtn', false, 'Create account');
      } catch (err) {
        flash('#registerAlert', '#registerAlertText', 'error', err.message || 'Registration failed');
        busy('#registerBtn', false, 'Create account');
      }
    });
  }

  function bindPassword() {
    $('#passwordForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      busy('#passwordBtn', true);
      try {
        await API.post('/auth/change-password', {
          currentPassword: $('#curPassword').value,
          newPassword: $('#newPassword').value,
        });
        flash('#passwordAlert', '#passwordAlertText', 'success', 'Password changed.');
        $('#passwordForm').reset();
      } catch (err) {
        flash('#passwordAlert', '#passwordAlertText', 'error', err.message || 'Password change failed');
      }
      busy('#passwordBtn', false, 'Change password');
    });
  }

  function bindSignOut() {
    $('#signOutBtn').addEventListener('click', async () => {
      try {
        await API.post('/auth/logout', {});
      } catch (_) {
        /* ignore */
      }
      window.location.href = '/';
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindLogin();
    bindRegister();
    bindPassword();
    bindSignOut();
    route();
  });
})();
