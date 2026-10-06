'use strict';
document.addEventListener('DOMContentLoaded', async () => {
  const $ = (s) => document.querySelector(s);
  let me;
  try { me = await App.API.get('/auth/me'); } catch (_) { window.location.replace('/account.html'); return; }
  if (!me) { window.location.replace('/account.html'); return; }
  const account = me.account || {};
  const name = account.username || 'Member';
  $('#welcomeName').textContent = name;
  $('#profileName').textContent = name;
  $('#profileEmail').textContent = account.email || '—';
  $('#avatar').textContent = name.slice(0, 2).toUpperCase();
  if (account.memberSince) $('#memberSince').textContent = 'Member since ' + App.fmt.dayLabel(account.memberSince);
  try {
    const ticket = await App.API.get('/ticket/today');
    const status = ticket.status === 'QUALIFIED' ? 'Published' : ticket.status === 'NO_QUALIFYING_TICKET' ? 'No qualifying ticket' : 'Data temporarily unavailable';
    $('#ticketStatus').textContent = status;
    $('#ticketMessage').textContent = (ticket.noTicket && ticket.noTicket.message) || (ticket.status === 'QUALIFIED' ? 'Today’s ticket is available to review.' : 'We do not publish a ticket unless the verified data meets our criteria.');
  } catch (_) { $('#ticketStatus').textContent = 'Status unavailable'; $('#ticketMessage').textContent = 'Please try again shortly.'; }
  $('#logoutBtn').addEventListener('click', async () => {
    try { await App.API.post('/auth/logout', {}); } catch (_) {}
    window.location.replace('/');
  });
});