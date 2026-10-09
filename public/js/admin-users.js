/* GoalPredict — admin console: Users (registration approval & account management) */
'use strict';

(function () {
  const { API, fmt, icons, escapeHtml, emptyState, skeletonRows } = App;
  const $ = (s) => document.querySelector(s);

  const state = { page: 1, limit: 20, status: '', search: '', total: 0, pages: 1, lastItems: [] };

  /* ------------------------------ helpers ------------------------------ */
  function notice(kind, message) {
    const box = $('#noticeBox');
    const icon = kind === 'ok' ? icons.checkCircle : kind === 'error' ? icons.alert : icons.info;
    box.innerHTML = `<div class="alert ${kind}" style="margin-top:14px;">${icon}<div>${escapeHtml(message)}</div></div>`;
    if (kind === 'ok') setTimeout(() => { box.innerHTML = ''; }, 6000);
  }

  function statusBadge(status) {
    if (status === 'approved') return `<span class="badge badge-green">${icons.check} Approved</span>`;
    if (status === 'pending') return `<span class="badge badge-amber">${icons.clock} Pending</span>`;
    if (status === 'rejected') return `<span class="badge badge-slate">${icons.x} Rejected</span>`;
    if (status === 'suspended') return `<span class="badge badge-red">${icons.lock} Suspended</span>`;
    return `<span class="badge badge-slate">${escapeHtml(status || '—')}</span>`;
  }

  function card(k, v, d, tone) {
    return `<div class="mini-card"><div class="k">${escapeHtml(k)}</div><div class="v ${tone || ''}">${escapeHtml(v)}</div><div class="d">${escapeHtml(d || '')}</div></div>`;
  }

  function actionButtons(user) {
    const acts = user.availableActions || ['view'];
    const btns = [`<button class="btn btn-ghost btn-sm" data-act="view" data-id="${user.id}">${icons.eye} View</button>`];
    if (acts.includes('approve')) btns.push(`<button class="btn btn-primary btn-sm" data-act="approve" data-id="${user.id}">${icons.check} Approve</button>`);
    if (acts.includes('reject')) btns.push(`<button class="btn btn-danger btn-sm" data-act="reject" data-id="${user.id}">${icons.x} Reject</button>`);
    if (acts.includes('suspend')) btns.push(`<button class="btn btn-outline btn-sm" data-act="suspend" data-id="${user.id}">${icons.lock} Suspend</button>`);
    if (acts.includes('reactivate')) btns.push(`<button class="btn btn-primary btn-sm" data-act="reactivate" data-id="${user.id}">${icons.refresh} Reactivate</button>`);
    return `<span class="row wrap" style="gap:6px;justify-content:flex-end;">${btns.join('')}</span>`;
  }

  /* ------------------------------ data ------------------------------ */
  async function loadSummary() {
    const s = await API.get('/admin/users/summary');
    $('#summaryCards').innerHTML = [
      card('Total users', s.total, 'all registered accounts'),
      card('Pending approval', s.pending, 'waiting for your review', 'cyan'),
      card('Approved', s.approved, 'full member access', 'green'),
      card('Rejected', s.rejected, 'applications refused', 'red'),
      card('Suspended', s.suspended, 'access revoked', 'red'),
    ].join('');
  }

  async function loadUsers() {
    $('#tableBody').innerHTML = skeletonRows(4);
    const params = new URLSearchParams({ page: String(state.page), limit: String(state.limit) });
    if (state.status) params.set('status', state.status);
    if (state.search) params.set('search', state.search);
    const data = await API.get(`/admin/users?${params.toString()}`);
    state.total = data.total;
    state.pages = data.pages;
    state.lastItems = data.items || [];
    $('#tableTitle').textContent = data.status === 'all' || !data.status ? 'Registered users' : `${data.status[0].toUpperCase()}${data.status.slice(1)} users`;
    $('#tableMeta').textContent = data.search ? `search “${data.search}”` : '';

    if (!data.items.length) {
      $('#tableBody').innerHTML = emptyState('users', 'No users found', data.search || data.status ? 'Try a different search or filter.' : 'No registrations yet.');
    } else {
      $('#tableBody').innerHTML = `<div class="table-wrap"><table class="data">
        <thead><tr><th>ID</th><th>User</th><th>E-mail</th><th>Registered</th><th>Status</th><th>Last login</th><th style="text-align:right;">Actions</th></tr></thead>
        <tbody>${data.items.map((u) => `<tr>
          <td class="mono">${u.id}</td>
          <td><b>${escapeHtml(u.fullName || u.username)}</b><div class="tiny muted">@${escapeHtml(u.username)}</div></td>
          <td>${escapeHtml(u.email)}</td>
          <td class="tiny">${escapeHtml(fmt.dateTimeLabel(u.registeredAt))}</td>
          <td>${statusBadge(u.status)}</td>
          <td class="tiny">${escapeHtml(u.lastLoginAt ? fmt.dateTimeLabel(u.lastLoginAt) : '—')}</td>
          <td>${actionButtons(u)}</td>
        </tr>`).join('')}</tbody></table></div>`;
    }

    $('#paginationBar').style.display = 'flex';
    $('#pageInfo').textContent = `Page ${data.page} of ${data.pages} · ${data.total} user${data.total === 1 ? '' : 's'}`;
    $('#prevPage').disabled = data.page <= 1;
    $('#nextPage').disabled = data.page >= data.pages;
  }

  async function refreshAll() {
    try {
      await Promise.all([loadSummary(), loadUsers()]);
    } catch (err) {
      notice('error', err.message || 'Could not load users');
      $('#tableBody').innerHTML = `<div class="card-body">${emptyState('alert', 'Could not load users', err.message || 'Please try again.')}</div>`;
    }
  }

  /* ------------------------------ actions ------------------------------ */
  const ACTION_COPY = {
    approve: { verb: 'Approve', past: 'Approved', confirm: (u) => `Approve ${u.username}? They will immediately gain access to the dashboard, predictions and tickets.` },
    reject: { verb: 'Reject', past: 'Rejected', confirm: (u) => `Reject the application from ${u.username}? They will not be able to access member features.` },
    suspend: { verb: 'Suspend', past: 'Suspended', confirm: (u) => `Suspend ${u.username}? Their existing session is blocked immediately.` },
    reactivate: { verb: 'Reactivate', past: 'Reactivated', confirm: (u) => `Reactivate ${u.username}? They will immediately regain access to member features.` },
  };

  async function runAction(action, userId) {
    const copy = ACTION_COPY[action];
    if (!copy) return;
    // The list/detail payloads are re-fetched after the action, so the row is
    // only used for the confirmation copy.
    const row = (state.lastItems || []).find((u) => String(u.id) === String(userId)) || { id: userId, username: `#${userId}` };
    if (!window.confirm(copy.confirm(row))) return;

    let reason = null;
    if (action === 'reject' || action === 'suspend') {
      const input = window.prompt(`Optional reason for ${copy.verb.toLowerCase()}ing ${row.username} (stored in the audit log):`, '');
      if (input === null) return; // cancelled
      reason = input.trim() || null;
    }

    try {
      const res = await API.post(`/admin/users/${userId}/${action}`, reason ? { reason } : {});
      notice('ok', `${copy.past} ${row.username} — status is now “${res.user.status}”.`);
      closeDetail();
      await refreshAll();
    } catch (err) {
      notice('error', err.message || `Could not ${copy.verb.toLowerCase()} the account`);
    }
  }

  /* ------------------------------ detail modal ------------------------------ */
  function closeDetail() {
    $('#detailOverlay').style.display = 'none';
  }

  async function openDetail(userId) {
    $('#detailOverlay').style.display = 'block';
    $('#detailBody').innerHTML = skeletonRows(3);
    $('#detailActions').innerHTML = '';
    try {
      const data = await API.get(`/admin/users/${userId}`);
      const u = data.user;
      $('#detailTitle').textContent = `User #${u.id} — @${u.username}`;
      const rows = [
        ['Full name', u.fullName || '—'],
        ['Username', `@${u.username}`],
        ['E-mail', u.email],
        ['Role', u.role],
        ['Status', ''],
        ['Registered', fmt.dateTimeLabel(u.registeredAt)],
        ['Last login', u.lastLoginAt ? fmt.dateTimeLabel(u.lastLoginAt) : '—'],
        ['Approved at', u.approvedAt ? fmt.dateTimeLabel(u.approvedAt) : '—'],
        ['Approved by', u.approvedBy ? `admin: ${u.approvedBy}` : '—'],
        ['Status reason', u.statusReason || '—'],
        ['Status changed', u.statusChangedAt ? fmt.dateTimeLabel(u.statusChangedAt) : '—'],
      ];
      $('#detailBody').innerHTML = `
        <div class="mini-grid" style="display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));margin-bottom:16px;">
          ${rows.map(([k, v]) => `<div class="mini-card"><div class="k">${escapeHtml(k)}</div><div class="v" style="font-size:14px;">${k === 'Status' ? statusBadge(u.status) : escapeHtml(v)}</div></div>`).join('')}
        </div>
        <h3 class="card-title" style="margin:0 0 8px;">Administrative action history</h3>
        ${data.audit.length
          ? `<div class="table-wrap"><table class="data"><thead><tr><th>When</th><th>Action</th><th>From → To</th><th>By</th><th>Reason</th></tr></thead><tbody>${data.audit.map((a) => `<tr>
              <td class="tiny">${escapeHtml(fmt.dateTimeLabel(a.createdAt))}</td>
              <td><span class="badge badge-cyan">${escapeHtml(a.action)}</span></td>
              <td class="tiny">${escapeHtml(a.previousStatus || '—')} → ${escapeHtml(a.newStatus)}</td>
              <td class="tiny">${a.adminUsername ? escapeHtml('@' + a.adminUsername) : '—'}</td>
              <td class="tiny muted">${escapeHtml(a.reason || '—')}</td>
            </tr>`).join('')}</tbody></table></div>`
          : '<p class="small muted">No administrative actions recorded yet.</p>'}
        <p class="tiny muted" style="margin:12px 0 0;">Password hashes, session tokens and other secrets are never displayed.</p>`;
      $('#detailActions').innerHTML = actionButtons(u);
      bindActionButtons();
    } catch (err) {
      $('#detailBody').innerHTML = `<div class="alert error">${icons.alert}<div>${escapeHtml(err.message || 'Could not load the user')}</div></div>`;
    }
  }

  /* ------------------------------ wiring ------------------------------ */
  function bindActionButtons() {
    document.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = () => {
        const act = btn.dataset.act;
        if (act === 'view') return openDetail(btn.dataset.id);
        return runAction(act, btn.dataset.id);
      };
    });
  }

  function bind() {
    $('#searchBtn').onclick = () => {
      state.search = $('#searchInput').value.trim();
      state.page = 1;
      loadUsers().catch((err) => notice('error', err.message));
    };
    $('#searchInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#searchBtn').click();
    });
    $('#statusFilter').onchange = () => {
      state.status = $('#statusFilter').value;
      state.page = 1;
      loadUsers().catch((err) => notice('error', err.message));
    };
    $('#refreshBtn').onclick = () => refreshAll();
    $('#prevPage').onclick = () => {
      if (state.page > 1) {
        state.page -= 1;
        loadUsers().catch((err) => notice('error', err.message));
      }
    };
    $('#nextPage').onclick = () => {
      if (state.page < state.pages) {
        state.page += 1;
        loadUsers().catch((err) => notice('error', err.message));
      }
    };
    $('#detailClose').onclick = closeDetail;
    $('#detailOverlay').addEventListener('click', (e) => {
      if (e.target === $('#detailOverlay')) closeDetail();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeDetail();
    });
  }

  async function boot() {
    const me = await App.session.me();
    if (!me || me.type !== 'admin') {
      window.location.replace('/admin/login');
      return;
    }
    $('#whoami').textContent = `${me.account.username} · ${me.account.role}`;
    $('#logoutBtn').onclick = async () => {
      await API.post('/auth/admin/logout', {}).catch(() => {});
      App.session.reset();
      window.location.replace('/admin/login');
    };
    bind();
    await refreshAll();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
