/* GoalPredict — member account page */
'use strict';
(function () {
  const { API } = App;
  const $ = (s) => document.querySelector(s);

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
    hide('#guestView');
    hide('#memberView');
    hide('#adminView');
    const me = await API.get('/auth/me').catch(() => null);
    if (!me) return show('#guestView');
    if (me.type === 'admin') return show('#adminView');
    return paintMember(me.account || {});
  }

  /* ------------------------------ forms ------------------------------ */
  function bindLogin() {
    $('#loginForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      busy('#loginBtn', true);
      try {
        await API.post('/auth/login', { login: $('#loginId').value.trim(), password: $('#loginPassword').value });
        window.location.reload();
      } catch (err) {
        flash('#loginAlert', '#loginAlertText', 'error', err.message || 'Sign in failed');
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
        await API.post('/auth/register', { username, email: $('#regEmail').value.trim(), password });
        // sign straight in with the new credentials
        await API.post('/auth/login', { login: username, password });
        window.location.reload();
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
