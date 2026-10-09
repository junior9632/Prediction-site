'use strict';

/**
 * USER MANAGEMENT & ADMIN APPROVAL SYSTEM — the acceptance matrix.
 *
 *  1.  a new registration defaults to pending approval
 *  2.  a pending user cannot access the dashboard
 *  3.  a pending user cannot access predictions or ticket endpoints
 *  4.  a pending user cannot bypass approval by directly opening a protected URL
 *  5.  an administrator can approve a pending user
 *  6.  an approved user can access authorized user features
 *  7.  an administrator can reject a pending user
 *  8.  a rejected user cannot access protected features
 *  9.  an administrator can suspend an approved user
 *  10. a suspended user's existing session is blocked from protected features
 *  11. a regular user cannot access admin user-management endpoints
 *  12. an unauthenticated visitor cannot access admin user-management endpoints
 *  13. public registration cannot create an administrator account
 *  14. search, filtering, pagination and summary statistics work correctly
 *  15. existing administrator login and football prediction features keep working
 *  16. database migrations work without deleting existing production data
 *
 * The suite boots the real Express app against the in-memory database double,
 * so it exercises the same middleware, routes and controllers as production.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'user-approval-test-secret';
delete process.env.API_FOOTBALL_KEY;
delete process.env.API_FOOTBALL_HOST;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');

const fakeDb = require('./fakeDb');
const auth = require('../server/middleware/auth');
const settingsService = require('../server/services/settingsService');
const migrate = require('../server/database/migrate');
const { createApp } = require('../server/app');

const PENDING_MESSAGE =
  'Your account has been submitted for approval. You will be able to access your dashboard once an administrator approves your account.';

const ADMIN = {
  id: 1, email: 'admin@test.local', username: 'admin',
  password_hash: bcrypt.hashSync('admin-test-pass-1', 4),
  role: 'superadmin', is_active: 1, locked_until: null, must_change_password: 0,
  created_at: '2026-08-01 09:00:00',
};
const APPROVED_MEMBER = {
  id: 41, email: 'fan@test.local', username: 'ticketfan',
  full_name: 'Test Fan',
  password_hash: bcrypt.hashSync('member-secret-99', 4),
  role: 'user', is_active: 1, status: 'approved', approved_at: '2026-09-01 10:00:00', approved_by_admin_id: 1,
  failed_logins: 0, locked_until: null, last_login_at: '2026-10-01 08:00:00',
  created_at: '2026-09-01 10:00:00', updated_at: '2026-09-01 10:00:00',
};
/** A mixed set for search / filter / pagination / summary tests. */
const SEEDED = [
  { id: 51, email: 'pending1@test.local', username: 'pendingone', full_name: 'Peter Pending', password_hash: 'x', role: 'user', is_active: 1, status: 'pending', failed_logins: 0, locked_until: null, last_login_at: null, created_at: '2026-10-01 09:00:00', updated_at: '2026-10-01 09:00:00' },
  { id: 52, email: 'pending2@test.local', username: 'pendingtwo', full_name: 'Paula Pending', password_hash: 'x', role: 'user', is_active: 1, status: 'pending', failed_logins: 0, locked_until: null, last_login_at: null, created_at: '2026-10-02 09:00:00', updated_at: '2026-10-02 09:00:00' },
  { id: 53, email: 'rejected@test.local', username: 'rejectedrick', full_name: 'Rick Rejected', password_hash: 'x', role: 'user', is_active: 0, status: 'rejected', status_reason: 'duplicate account', failed_logins: 0, locked_until: null, last_login_at: null, created_at: '2026-10-03 09:00:00', updated_at: '2026-10-03 09:00:00' },
  { id: 54, email: 'suspended@test.local', username: 'suspendedsam', full_name: 'Sam Suspended', password_hash: 'x', role: 'user', is_active: 0, status: 'suspended', status_reason: 'abuse', failed_logins: 0, locked_until: null, last_login_at: '2026-10-04 09:00:00', created_at: '2026-10-04 09:00:00', updated_at: '2026-10-04 09:00:00' },
  { id: 55, email: 'approved@test.local', username: 'approvedann', full_name: 'Ann Approved', password_hash: 'x', role: 'user', is_active: 1, status: 'approved', approved_at: '2026-10-05 09:00:00', approved_by_admin_id: 1, failed_logins: 0, locked_until: null, last_login_at: '2026-10-05 10:00:00', created_at: '2026-10-05 09:00:00', updated_at: '2026-10-05 09:00:00' },
];

let server;
let base;
let ctx;
let adminBearer;
let memberBearer;

async function req(method, urlPath, { token = null, cookie = null, csrf = null, body = null } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  if (body !== null) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

const get = (urlPath, options) => req('GET', urlPath, options);
const post = (urlPath, body, options) => req('POST', urlPath, { ...options, body });

before(async () => {
  ctx = fakeDb.install({ admins: [ADMIN], users: [APPROVED_MEMBER, ...SEEDED], settings: [], fixtures: [], teamForms: [], leagues: [] });
  settingsService.invalidateCache();
  adminBearer = auth.signToken({ sub: ADMIN.id, type: 'admin', role: ADMIN.role, username: ADMIN.username });
  memberBearer = auth.signToken({ sub: APPROVED_MEMBER.id, type: 'user', role: 'user', username: APPROVED_MEMBER.username });
  const app = createApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (ctx) ctx.restore();
  settingsService.invalidateCache();
});

/** Register a fresh account through the public endpoint and return the payload. */
async function registerUser(username, email, extra = {}) {
  return post('/api/auth/register', {
    username,
    email,
    fullName: `Full ${username}`,
    password: 'super-secret-99',
    ...extra,
  });
}

const userRow = (id) => ctx.store.users.find((u) => u.id === Number(id));
const auditRows = (id) => ctx.store.userAuditLogs.filter((a) => Number(a.user_id) === Number(id));

/* ------------------------------------------------------------------ */
/* 1. registration defaults to pending                                 */
/* ------------------------------------------------------------------ */

test('1: a new registration is created as pending and shows the approval message', async () => {
  const res = await registerUser('newfan', 'newfan@test.local');
  assert.equal(res.status, 201);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.data.status, 'pending');
  assert.equal(res.json.data.pendingApproval, true);
  assert.equal(res.json.data.message, PENDING_MESSAGE);

  const row = userRow(res.json.data.id);
  assert.ok(row, 'the account row exists');
  assert.equal(row.status, 'pending', 'the database default is pending — approval cannot be bypassed');
  assert.equal(row.is_active, 1, 'the row exists and is not disabled, the STATUS is what blocks access');
  assert.equal(row.role, 'user');
  assert.ok(row.password_hash, 'the password hash is stored');
  assert.ok(!res.headers.get('set-cookie'), 'registration issues NO session — the visitor must wait for approval');
  assert.ok(!JSON.stringify(res.json).includes(row.password_hash), 'the hash never leaves the server');
});

/* ------------------------------------------------------------------ */
/* 2-4. a pending account reaches nothing                              */
/* ------------------------------------------------------------------ */

test('2+5: a pending login attempt is refused with the approval message and no session', async () => {
  const res = await post('/api/auth/login', { login: 'newfan', password: 'super-secret-99' });
  assert.equal(res.status, 403);
  assert.equal(res.json.error.code, 'ACCOUNT_PENDING');
  assert.equal(res.json.error.message, PENDING_MESSAGE);
  assert.ok(!res.headers.get('set-cookie'), 'no session cookie is planted for a pending account');
});

test('2: a pending user cannot access the member dashboard', async () => {
  const pending = userRow(ctx.store.users.find((u) => u.username === 'newfan').id);
  const token = auth.signToken({ sub: pending.id, type: 'user', role: 'user', username: pending.username });

  const api = await get('/api/dashboard/activity', { token });
  assert.equal(api.status, 403, 'the dashboard API refuses a pending account');
  assert.equal(api.json.error.code, 'ACCOUNT_PENDING');
  assert.equal(api.json.data, undefined, 'no dashboard data is returned');

  for (const page of ['/dashboard', '/dashboard.html']) {
    const res = await get(page, { token });
    assert.equal(res.status, 302, `${page} redirects a pending account away from the dashboard`);
    assert.equal(res.headers.get('location'), '/account.html');
  }
});

test('3: a pending user cannot access predictions or ticket endpoints', async () => {
  const pending = ctx.store.users.find((u) => u.username === 'newfan');
  const token = auth.signToken({ sub: pending.id, type: 'user', role: 'user', username: pending.username });
  for (const endpoint of ['/api/predictions', '/api/ticket/today', '/api/tickets/history', '/api/analytics', '/api/fixtures', '/api/odds']) {
    const res = await get(endpoint, { token });
    assert.equal(res.status, 403, `${endpoint} refuses a pending account (got ${res.status})`);
    assert.equal(res.json.error.code, 'ACCOUNT_PENDING');
    assert.equal(res.json.data, undefined, `${endpoint} returns no data`);
  }
});

test('4: a pending user cannot bypass approval by directly opening a protected URL', async () => {
  const pending = ctx.store.users.find((u) => u.username === 'newfan');
  const token = auth.signToken({ sub: pending.id, type: 'user', role: 'user', username: pending.username });
  for (const page of ['/predictions', '/ticket', '/history', '/analytics']) {
    const res = await get(page, { token });
    assert.equal(res.status, 403, `${page} is refused (got ${res.status})`);
    assert.match(res.text, /submitted for approval/, `${page} shows the pending-approval notice`);
    assert.ok(!res.text.includes('pick-row'), `${page} leaks no prediction markup`);
  }
});

/* ------------------------------------------------------------------ */
/* 5. admin approves                                                   */
/* ------------------------------------------------------------------ */

test('5: an administrator can approve a pending user (audited, transactional)', async () => {
  const pending = ctx.store.users.find((u) => u.username === 'newfan');
  const res = await post(`/api/admin/users/${pending.id}/approve`, {}, { token: adminBearer });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.data.user.status, 'approved');
  assert.equal(res.json.data.user.active, true);
  assert.equal(res.json.data.user.approvedBy, 'admin');
  assert.ok(res.json.data.user.approvedAt, 'the approval timestamp is recorded');
  assert.ok(!JSON.stringify(res.json).includes('password_hash'), 'no password hash in the response');

  const row = userRow(pending.id);
  assert.equal(row.status, 'approved');
  assert.equal(row.is_active, 1);
  assert.equal(Number(row.approved_by_admin_id), ADMIN.id);

  const audit = auditRows(pending.id);
  assert.equal(audit.length, 1, 'exactly one audit row is written');
  assert.equal(audit[0].action, 'approved');
  assert.equal(audit[0].previous_status, 'pending');
  assert.equal(audit[0].new_status, 'approved');
  assert.equal(Number(audit[0].admin_id), ADMIN.id, 'the administrator is recorded');
  assert.ok(audit[0].created_at, 'the timestamp is recorded');

  const sys = ctx.store.systemLogs.filter((l) => l.event === 'USER_APPROVED' && Number(l.context_json && JSON.parse(l.context_json).userId) === pending.id);
  assert.equal(sys.length, 1, 'the decision also lands in the system audit trail');
});

/* ------------------------------------------------------------------ */
/* 6. the approved user gets access                                    */
/* ------------------------------------------------------------------ */

test('6: an approved user can log in and access authorized user features', async () => {
  const login = await post('/api/auth/login', { login: 'newfan', password: 'super-secret-99' });
  assert.equal(login.status, 200, 'the approved account signs in');
  assert.ok(login.json.data.token);
  const token = login.json.data.token;

  const me = await get('/api/auth/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.json.data.type, 'user');
  assert.equal(me.json.data.account.status, 'approved');

  const dashboard = await get('/api/dashboard/activity', { token });
  assert.equal(dashboard.status, 200, 'the dashboard API opens');

  for (const endpoint of ['/api/predictions', '/api/ticket/today', '/api/tickets/history', '/api/analytics']) {
    const res = await get(endpoint, { token });
    assert.ok([200, 404].includes(res.status), `${endpoint} answers the approved member (got ${res.status})`);
  }
  const page = await get('/predictions', { token });
  assert.equal(page.status, 200, 'the predictions page opens');
  const dash = await get('/dashboard', { token });
  assert.equal(dash.status, 200, 'the dashboard page opens');
});

/* ------------------------------------------------------------------ */
/* 7+8. reject                                                         */
/* ------------------------------------------------------------------ */

test('7: an administrator can reject a pending application with a reason', async () => {
  const reg = await registerUser('rejectme', 'rejectme@test.local');
  const id = reg.json.data.id;
  const res = await post(`/api/admin/users/${id}/reject`, { reason: 'duplicate account' }, { token: adminBearer });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.user.status, 'rejected');
  assert.equal(res.json.data.user.active, false);
  assert.equal(res.json.data.user.statusReason, 'duplicate account');

  const audit = auditRows(id);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, 'rejected');
  assert.equal(audit[0].reason, 'duplicate account', 'the optional reason is recorded');
  assert.equal(Number(audit[0].admin_id), ADMIN.id);
});

test('8: a rejected user cannot access protected features', async () => {
  const rejected = ctx.store.users.find((u) => u.username === 'rejectme');

  const login = await post('/api/auth/login', { login: 'rejectme', password: 'super-secret-99' });
  assert.equal(login.status, 403);
  assert.equal(login.json.error.code, 'ACCOUNT_REJECTED');
  assert.ok(!login.headers.get('set-cookie'));

  const token = auth.signToken({ sub: rejected.id, type: 'user', role: 'user', username: rejected.username });
  for (const endpoint of ['/api/predictions', '/api/ticket/today', '/api/dashboard/activity']) {
    const res = await get(endpoint, { token });
    assert.equal(res.status, 403, `${endpoint} refuses a rejected account`);
    assert.equal(res.json.error.code, 'ACCOUNT_REJECTED');
    assert.equal(res.json.data, undefined);
  }
  const page = await get('/predictions', { token });
  assert.equal(page.status, 403);
  assert.match(page.text, /not approved/, 'the page explains the rejection');
});

/* ------------------------------------------------------------------ */
/* 9+10. suspend — existing sessions die immediately                   */
/* ------------------------------------------------------------------ */

test('9: an administrator can suspend an approved account', async () => {
  const target = APPROVED_MEMBER.id;
  const res = await post(`/api/admin/users/${target}/suspend`, { reason: 'terms violation' }, { token: adminBearer });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.user.status, 'suspended');
  assert.equal(res.json.data.user.active, false);
  assert.equal(res.json.data.user.statusReason, 'terms violation');

  const audit = auditRows(target);
  assert.ok(audit.some((a) => a.action === 'suspended' && a.previous_status === 'approved' && a.reason === 'terms violation'));
});

test('10: a suspended user’s existing session is blocked from protected features', async () => {
  // memberBearer was issued BEFORE the suspension and is still a valid JWT.
  for (const endpoint of ['/api/predictions', '/api/ticket/today', '/api/tickets/history', '/api/analytics', '/api/dashboard/activity']) {
    const res = await get(endpoint, { token: memberBearer });
    assert.equal(res.status, 403, `${endpoint} refuses the suspended session (got ${res.status})`);
    assert.equal(res.json.error.code, 'ACCOUNT_SUSPENDED');
    assert.equal(res.json.data, undefined, 'no data leaves the server');
  }

  const me = await get('/api/auth/me', { token: memberBearer });
  assert.equal(me.status, 403, 'even the session check refuses the suspended account');

  const page = await get('/predictions', { token: memberBearer });
  assert.equal(page.status, 403, 'the page is refused too');
  assert.match(page.text, /suspended/, 'the page explains the suspension');

  const dash = await get('/dashboard', { token: memberBearer });
  assert.equal(dash.status, 302, 'the dashboard page redirects away');
  assert.equal(dash.headers.get('location'), '/account.html');

  const login = await post('/api/auth/login', { login: APPROVED_MEMBER.username, password: 'member-secret-99' });
  assert.equal(login.status, 403, 'a fresh login is refused as well');
  assert.equal(login.json.error.code, 'ACCOUNT_SUSPENDED');

  // restore the fixture for later tests
  await post(`/api/admin/users/${APPROVED_MEMBER.id}/reactivate`, {}, { token: adminBearer });
  assert.equal(userRow(APPROVED_MEMBER.id).status, 'approved', 'reactivation restores access');
  const audit = auditRows(APPROVED_MEMBER.id);
  assert.ok(audit.some((a) => a.action === 'reactivated' && a.previous_status === 'suspended' && a.new_status === 'approved'));
});

/* ------------------------------------------------------------------ */
/* 11+12. only administrators reach user management                    */
/* ------------------------------------------------------------------ */

test('11: a regular user cannot access admin user-management endpoints', async () => {
  const userToken = auth.signToken({ sub: SEEDED[4].id, type: 'user', role: 'user', username: SEEDED[4].username });
  for (const [method, url, body] of [
    ['GET', '/api/admin/users/summary', null],
    ['GET', '/api/admin/users', null],
    ['GET', `/api/admin/users/${SEEDED[0].id}`, null],
    ['POST', `/api/admin/users/${SEEDED[0].id}/approve`, {}],
    ['POST', `/api/admin/users/${SEEDED[4].id}/suspend`, {}],
    ['POST', `/api/admin/users/${SEEDED[0].id}/reject`, {}],
    ['POST', `/api/admin/users/${SEEDED[0].id}/reactivate`, {}],
  ]) {
    const res = await req(method, url, { token: userToken, body });
    assert.equal(res.status, 403, `${method} ${url} refuses a regular user (got ${res.status})`);
    assert.equal(res.json.data, undefined);
  }
  // the seeded account is untouched by the refused attempts
  assert.equal(userRow(SEEDED[0].id).status, 'pending');
  assert.equal(userRow(SEEDED[4].id).status, 'approved');
});

test('12: an unauthenticated visitor cannot access admin user-management endpoints', async () => {
  for (const [method, url, body] of [
    ['GET', '/api/admin/users/summary', null],
    ['GET', '/api/admin/users', null],
    ['GET', `/api/admin/users/${SEEDED[0].id}`, null],
    ['POST', `/api/admin/users/${SEEDED[0].id}/approve`, {}],
  ]) {
    const res = await req(method, url, { body });
    assert.equal(res.status, 401, `${method} ${url} refuses a guest (got ${res.status})`);
    assert.equal(res.json.data, undefined);
  }
  // and the Users page itself is guarded like the rest of the console
  for (const page of ['/admin/users', '/admin/users.html']) {
    const res = await fetch(`${base}${page}`, { redirect: 'manual' });
    assert.equal(res.status, 302, `${page} redirects guests`);
    assert.equal(res.headers.get('location'), '/admin/login');
  }
  const asUser = await get('/admin/users', { token: memberBearer });
  assert.equal(asUser.status, 403, 'a member gets a bare 403, no admin content');
  const script = await get('/js/admin-users.js');
  assert.equal(script.status, 404, 'the users console script is invisible to guests');
});

/* ------------------------------------------------------------------ */
/* 13. public registration can never create an administrator           */
/* ------------------------------------------------------------------ */

test('13: public registration cannot create an administrator account', async () => {
  const adminsBefore = ctx.store.admins.length;
  const res = await registerUser('wannabeadmin', 'wannabe@test.local', {
    role: 'admin',
    status: 'approved',
    isAdmin: true,
    is_active: 1,
  });
  assert.equal(res.status, 201, 'the registration itself succeeds');
  const row = userRow(res.json.data.id);
  assert.equal(row.role, 'user', 'a smuggled role is dropped — only user/premium exist for public accounts');
  assert.equal(row.status, 'pending', 'a smuggled approval status is dropped — the account stays pending');
  assert.equal(ctx.store.admins.length, adminsBefore, 'the admins table is untouched');

  // the account still cannot log in until approved
  const login = await post('/api/auth/login', { login: 'wannabeadmin', password: 'super-secret-99' });
  assert.equal(login.status, 403);
  assert.equal(login.json.error.code, 'ACCOUNT_PENDING');
});

/* ------------------------------------------------------------------ */
/* 14. search, filtering, pagination and summary statistics            */
/* ------------------------------------------------------------------ */

test('14: summary statistics count every status', async () => {
  const res = await get('/api/admin/users/summary', { token: adminBearer });
  assert.equal(res.status, 200);
  const s = res.json.data;
  const users = ctx.store.users;
  assert.equal(s.total, users.length);
  assert.equal(s.pending, users.filter((u) => u.status === 'pending').length);
  assert.equal(s.approved, users.filter((u) => u.status === 'approved').length);
  assert.equal(s.rejected, users.filter((u) => u.status === 'rejected').length);
  assert.equal(s.suspended, users.filter((u) => u.status === 'suspended').length);
});

test('14: the status filter narrows the list', async () => {
  const res = await get('/api/admin/users?status=pending', { token: adminBearer });
  assert.equal(res.status, 200);
  assert.ok(res.json.data.items.length >= 2);
  assert.ok(res.json.data.items.every((u) => u.status === 'pending'));
  assert.equal(res.json.data.status, 'pending');
  assert.equal(res.json.data.total, ctx.store.users.filter((u) => u.status === 'pending').length);
});

test('14: search matches name, e-mail and user id', async () => {
  const byName = await get(`/api/admin/users?search=${encodeURIComponent('Peter Pending')}`, { token: adminBearer });
  assert.equal(byName.status, 200);
  assert.ok(byName.json.data.items.some((u) => u.username === 'pendingone'));
  assert.ok(byName.json.data.items.every((u) => /peter pending/i.test(u.fullName)));

  const byEmail = await get('/api/admin/users?search=suspended%40test.local', { token: adminBearer });
  assert.equal(byEmail.json.data.items.length, 1);
  assert.equal(byEmail.json.data.items[0].username, 'suspendedsam');

  const byId = await get(`/api/admin/users?search=${SEEDED[3].id}`, { token: adminBearer });
  assert.equal(byId.json.data.items.length, 1);
  assert.equal(byId.json.data.items[0].id, SEEDED[3].id);

  const byUsername = await get('/api/admin/users?search=approvedann', { token: adminBearer });
  assert.equal(byUsername.json.data.items.length, 1);
});

test('14: pagination walks the whole list', async () => {
  const total = ctx.store.users.length;
  const page1 = await get('/api/admin/users?limit=2&page=1', { token: adminBearer });
  assert.equal(page1.status, 200);
  assert.equal(page1.json.data.items.length, 2);
  assert.equal(page1.json.data.total, total);
  assert.equal(page1.json.data.pages, Math.ceil(total / 2));

  const page2 = await get('/api/admin/users?limit=2&page=2', { token: adminBearer });
  assert.equal(page2.json.data.items.length, 2);
  const ids1 = page1.json.data.items.map((u) => u.id);
  const ids2 = page2.json.data.items.map((u) => u.id);
  assert.ok(!ids1.some((id) => ids2.includes(id)), 'pages do not overlap');

  const last = await get(`/api/admin/users?limit=2&page=${Math.ceil(total / 2)}`, { token: adminBearer });
  assert.equal(last.status, 200);
  assert.ok(last.json.data.items.length >= 1);

  const beyond = await get(`/api/admin/users?limit=2&page=${Math.ceil(total / 2) + 5}`, { token: adminBearer });
  assert.equal(beyond.status, 200);
  assert.equal(beyond.json.data.items.length, 0, 'beyond the last page is an empty list, not an error');
});

test('14: the list and detail responses never expose password hashes', async () => {
  const list = await get('/api/admin/users?limit=100', { token: adminBearer });
  assert.equal(list.status, 200);
  assert.ok(!list.text.includes('password_hash'), 'no password_hash key in the list payload');
  for (const u of list.json.data.items) {
    for (const key of ['password_hash', 'passwordHash', 'token', 'csrfToken', 'sessionToken']) {
      assert.ok(!(key in u), `user payload must not contain ${key}`);
    }
  }
  const detail = await get(`/api/admin/users/${SEEDED[4].id}`, { token: adminBearer });
  assert.equal(detail.status, 200);
  assert.ok(!detail.text.includes('password_hash'));
  assert.ok(!detail.text.includes(APPROVED_MEMBER.password_hash), 'the bcrypt hash value never appears');
  assert.equal(detail.json.data.user.username, 'approvedann');
  assert.ok(Array.isArray(detail.json.data.audit), 'the detail carries the action history');
});

/* ------------------------------------------------------------------ */
/* state machine + input validation                                    */
/* ------------------------------------------------------------------ */

test('admin actions: invalid transitions, unknown users and bad input are refused', async () => {
  // approve an already approved account -> 409
  const bad = await post(`/api/admin/users/${SEEDED[4].id}/approve`, {}, { token: adminBearer });
  assert.equal(bad.status, 409);
  assert.equal(bad.json.error.code, 'INVALID_STATUS_TRANSITION');
  assert.equal(userRow(SEEDED[4].id).status, 'approved', 'the row is unchanged');

  // reject an approved account -> 409 (suspend is the correct action)
  const bad2 = await post(`/api/admin/users/${SEEDED[4].id}/reject`, {}, { token: adminBearer });
  assert.equal(bad2.status, 409);

  // unknown user -> 404
  const missing = await post('/api/admin/users/999999/approve', {}, { token: adminBearer });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'USER_NOT_FOUND');

  // the administrator account id is not a user -> 404 (admins can never be
  // modified through user management)
  const adminAsUser = await post(`/api/admin/users/${ADMIN.id}/suspend`, {}, { token: adminBearer });
  assert.equal(adminAsUser.status, 404);
  assert.equal(userRow(ADMIN.id), undefined);
  const adminRow = ctx.store.admins.find((a) => a.id === ADMIN.id);
  assert.equal(adminRow.is_active, 1, 'the administrator account is untouched');

  // invalid id -> 400
  const badId = await get('/api/admin/users/abc', { token: adminBearer });
  assert.equal(badId.status, 400);

  // invalid status filter -> 400
  const badFilter = await get('/api/admin/users?status=bogus', { token: adminBearer });
  assert.equal(badFilter.status, 400);
});

test('admin actions: cookie sessions need the double-submit CSRF token', async () => {
  const reg = await registerUser('csrfuser', 'csrfuser@test.local');
  const id = reg.json.data.id;
  const csrf = 'csrf-token-value-1234567890';
  const cookie = `fp_token=${adminBearer}; fp_csrf=${csrf}`;

  const withoutHeader = await post(`/api/admin/users/${id}/approve`, {}, { cookie });
  assert.equal(withoutHeader.status, 403);
  assert.equal(withoutHeader.json.error.code, 'CSRF_MISSING');
  assert.equal(userRow(id).status, 'pending', 'no state change without the token');

  const mismatched = await post(`/api/admin/users/${id}/approve`, {}, { cookie, csrf: 'wrong-token-value-0000000000' });
  assert.equal(mismatched.status, 403);
  assert.equal(mismatched.json.error.code, 'CSRF_INVALID');

  const withHeader = await post(`/api/admin/users/${id}/approve`, {}, { cookie, csrf });
  assert.equal(withHeader.status, 200);
  assert.equal(userRow(id).status, 'approved');
});

/* ------------------------------------------------------------------ */
/* 15. existing admin login + football features keep working           */
/* ------------------------------------------------------------------ */

test('15: existing administrator login and football features continue to work', async () => {
  const login = await post('/api/auth/admin/login', { login: 'admin', password: 'admin-test-pass-1' });
  assert.equal(login.status, 200, 'the administrator can still sign in');
  assert.equal(login.json.data.admin.username, 'admin');
  const token = login.json.data.token;

  const overview = await get('/api/admin/overview', { token });
  assert.equal(overview.status, 200, 'the console API still answers');
  assert.equal(overview.json.data.settings.market.key, 'over_1_5');

  const consolePage = await get('/admin.html', { token });
  assert.equal(consolePage.status, 200, 'the console shell still loads');
  assert.match(consolePage.text, /Users/, 'the console sidebar links the Users section');

  const predictions = await get('/api/predictions', { token: memberBearer });
  assert.ok([200, 404].includes(predictions.status), 'football features still answer a member');

  const ticket = await get('/api/ticket/today', { token: memberBearer });
  assert.ok([200, 404].includes(ticket.status));

  const health = await get('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.data.database, 'ok');
});

/* ------------------------------------------------------------------ */
/* 16. migrations: discovered, ordered, idempotent, non-destructive     */
/* ------------------------------------------------------------------ */

test('16: the approval migration is discovered, applied once and preserves existing data', async () => {
  const files = migrate.listMigrationFiles();
  const names = files.map((f) => f.filename);
  assert.ok(names.includes('001-widen-odds-precision.sql'), 'the existing migration is still there');
  assert.ok(names.includes('002-user-approval-system.sql'), 'the approval migration follows the naming convention');
  assert.ok(files.find((f) => f.filename === '002-user-approval-system.sql').sequence > files.find((f) => f.filename === '001-widen-odds-precision.sql').sequence);

  // the migration text implements the documented safe policy
  const sql = fs.readFileSync(path.join(__dirname, '..', 'server', 'database', 'migrations', '002-user-approval-system.sql'), 'utf8');
  assert.match(sql, /ADD COLUMN `status`\s+ENUM\('pending','approved','rejected','suspended'\) NOT NULL DEFAULT 'pending'/, 'new registrations default to pending');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS `user_audit_logs`/, 'the audit table is created');
  assert.match(sql, /SET `status` = 'approved'.*WHERE `is_active` = 1/s, 'existing ACTIVE users are grandfathered as approved — nobody is locked out');
  assert.match(sql, /SET `status` = 'suspended'.*WHERE `is_active` = 0/s, 'existing INACTIVE users become suspended');
  assert.ok(!/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(sql), 'the migration never deletes data');

  // the baseline schema stays in sync (fresh installs get the same shape)
  const schema = fs.readFileSync(path.join(__dirname, '..', 'server', 'database', 'schema.sql'), 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS `user_audit_logs`/, 'schema.sql contains the audit table');
  assert.match(schema, /`status`\s+ENUM\('pending','approved','rejected','suspended'\) NOT NULL DEFAULT 'pending'/, 'schema.sql contains the status column');
  assert.match(schema, /`full_name`\s+VARCHAR\(120\)/, 'schema.sql contains the full_name column');

  // the engine applies it exactly once (fake mysql2 connection)
  const executed = [];
  const records = [];
  const fakeConnection = {
    async query(sqlText, params) {
      executed.push(String(sqlText));
      if (/^SELECT filename/i.test(String(sqlText).trim())) return [records.map((r) => ({ ...r }))];
      if (/^INSERT INTO `schema_migrations`/i.test(String(sqlText).trim())) {
        records.push({ filename: params[0], checksum: params[1], applied_at: new Date() });
        return [{}];
      }
      return [{}];
    },
  };
  const first = await migrate.applyMigrations(fakeConnection);
  assert.ok(first.applied.includes('002-user-approval-system.sql'), 'the migration runs on a fresh database');
  const second = await migrate.applyMigrations(fakeConnection);
  assert.equal(second.applied.length, 0, 'a second run is a no-op — existing data is never touched twice');
  assert.equal(records.filter((r) => r.filename === '002-user-approval-system.sql').length, 1, 'recorded exactly once');
});
