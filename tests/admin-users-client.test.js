'use strict';

/**
 * ADMIN USERS PAGE — client wiring regression suite.
 *
 * THE INCIDENT
 *   On the live site the Users table rendered, but View / Approve / Reject /
 *   Suspend did nothing when tapped. Two real causes:
 *
 *   1. `loadUsers()` rebuilt the table HTML but never called
 *      `bindActionButtons()`, so every rendered button was dead markup with no
 *      listener (on every device; it was first noticed on an iPhone). Only the
 *      detail modal re-bound its buttons, and the modal is unreachable without
 *      a working View button.
 *   2. On small screens the Actions column sat past the right edge of the
 *      640px-wide table and the buttons were 36px-tall inline pills — below
 *      the ~44px touch-target guideline and easy to miss or mis-hit.
 *
 * HOW THIS TESTS THE REAL CODE
 *   The repo ships no DOM library, so the page is executed in a `vm` context
 *   with a minimal document double (exactly the pattern tests/fakeDb.js uses
 *   for MySQL: the code under test is the real file, only the environment is
 *   faked). `window.AdminUsersPage` is a deliberate test hook exported by
 *   public/js/admin-users.js.
 *
 * Covered:
 *   1. rendering the table binds the buttons (the regression),
 *   2. each action posts to the right endpoint with the right user id,
 *   3. confirm/prompt gate the request and carry the optional reason,
 *   4. a failed request shows the server message, restores the button and
 *      never claims success or refreshes,
 *   5. a double tap cannot send the decision twice,
 *   6. success refreshes the list and the counters,
 *   7. the shipped CSS keeps every action a >=44px, stacked, visible target,
 *   8. the shipped HTML version-busts its assets for mobile Safari.
 *
 * Server-side authorization/CSRF for these endpoints is asserted over real
 * HTTP in tests/user-approval.test.js (matrix items 5, 7, 9, 11, 12 and the
 * CSRF subtest) — the client never decides status by itself.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PAGE_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'admin-users.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
const USERS_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'users.html'), 'utf8');

const MEMBER = {
  id: 55,
  username: 'pendingpete',
  fullName: 'Pete Pending',
  email: 'pete@test.local',
  role: 'user',
  status: 'pending',
  registeredAt: '2026-10-01T09:00:00.000Z',
  lastLoginAt: null,
  approvedAt: null,
  approvedBy: null,
  statusReason: null,
  statusChangedAt: null,
  availableActions: ['view', 'approve', 'reject', 'suspend'],
};

/** Build one isolated page context. Returns the handles the tests drive. */
function makePage({ confirm = true, prompt = 'duplicate account', post, get } = {}) {
  const calls = { get: [], post: [] };
  let confirmCalls = 0;

  const nodeCache = new Map();
  const makeNode = (sel) => ({
    selector: sel,
    innerHTML: '',
    textContent: '',
    style: {},
    disabled: false,
    onclick: null,
    addEventListener() {},
  });
  const liveButtons = [];

  const documentDouble = {
    querySelector(sel) {
      if (!nodeCache.has(sel)) nodeCache.set(sel, makeNode(sel));
      return nodeCache.get(sel);
    },
    querySelectorAll(sel) {
      return sel === '[data-act]' ? liveButtons : [];
    },
    addEventListener() {},
  };

  const getImpl =
    get ||
    ((p) => {
      if (p === '/admin/users/summary') return { total: 1, pending: 1, approved: 0, rejected: 0, suspended: 0 };
      if (p.startsWith('/admin/users?')) return { page: 1, pages: 1, total: 1, status: 'all', search: '', items: [MEMBER] };
      if (/^\/admin\/users\/\d+$/.test(p)) return { user: MEMBER, audit: [] };
      throw new Error(`unexpected GET ${p}`);
    });

  const postImpl = post || (async () => ({ user: { ...MEMBER, status: 'approved' } }));

  const App = {
    API: {
      get: async (p) => {
        calls.get.push(p);
        return getImpl(p);
      },
      post: async (p, body) => {
        calls.post.push({ path: p, body });
        return postImpl(p, body);
      },
    },
    fmt: { dateTimeLabel: (v) => String(v || '—') },
    icons: { check: '', x: '', lock: '', refresh: '', eye: '', alert: '', info: '', clock: '', checkCircle: '' },
    escapeHtml: (v) => String(v === null || v === undefined ? '' : v),
    emptyState: () => '<empty/>',
    skeletonRows: () => '<skeleton/>',
  };

  const sandbox = {
    document: documentDouble,
    App,
    URLSearchParams,
    setTimeout: () => 0,
    console,
    window: {
      confirm: () => {
        confirmCalls += 1;
        return confirm;
      },
      prompt: () => prompt,
      location: { replace() {} },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(PAGE_JS, sandbox, { filename: 'public/js/admin-users.js' });

  /** Create the same four buttons the table would contain for MEMBER. */
  function seedButtons() {
    liveButtons.length = 0;
    for (const act of ['view', 'approve', 'reject', 'suspend']) {
      liveButtons.push({ dataset: { act, id: String(MEMBER.id) }, disabled: false, onclick: null, innerHTML: act });
    }
    return liveButtons;
  }

  return {
    page: sandbox.window.AdminUsersPage,
    calls,
    domNodes: nodeCache,
    seedButtons,
    buttons: liveButtons,
    get confirmCalls() {
      return confirmCalls;
    },
  };
}

test('rendering the table binds the action buttons (the mobile tap regression)', async () => {
  const { page, seedButtons, buttons } = makePage();
  seedButtons();

  // before the fix, loadUsers() rebuilt the table and never wired the buttons
  await page.loadUsers();
  for (const btn of buttons) {
    assert.equal(typeof btn.onclick, 'function', `the ${btn.dataset.act} button has a live listener after render`);
  }
});

test('every action button invokes its intended endpoint with the correct user id', async () => {
  const { page, seedButtons, buttons, calls } = makePage();
  seedButtons();
  await page.loadUsers();

  const click = (act) => buttons.find((b) => b.dataset.act === act).onclick();

  await click('approve');
  await click('reject');
  await click('suspend');

  assert.deepEqual(
    calls.post.map((c) => c.path),
    ['/admin/users/55/approve', '/admin/users/55/reject', '/admin/users/55/suspend'],
    'correct POST endpoint and user id per action'
  );

  calls.post.length = 0;
  await click('view');
  assert.ok(calls.get.includes('/admin/users/55'), 'View loads the detail + audit payload');
  assert.equal(calls.post.length, 0, 'View performs no mutation');
});

test('confirmation gates the request and the optional reason is sent', async () => {
  // declined confirmation -> nothing is sent
  let ctx = makePage({ confirm: false });
  ctx.seedButtons();
  await ctx.page.loadUsers();
  ctx.buttons.find((b) => b.dataset.act === 'approve').onclick();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ctx.calls.post.length, 0, 'declining the confirm dialog sends nothing');

  // approve sends an empty body; reject/suspend carry the typed reason
  ctx = makePage({ confirm: true, prompt: 'duplicate account' });
  ctx.seedButtons();
  await ctx.page.loadUsers();
  // one decision at a time: each click is awaited before the next is tapped
  await ctx.buttons.find((b) => b.dataset.act === 'approve').onclick();
  await ctx.buttons.find((b) => b.dataset.act === 'reject').onclick();
  await ctx.buttons.find((b) => b.dataset.act === 'suspend').onclick();
  // bodies are created inside the vm realm; compare their JSON shape
  const plain = (o) => JSON.parse(JSON.stringify(o));
  assert.deepEqual(ctx.calls.post.map((c) => plain(c.body)), [{}, { reason: 'duplicate account' }, { reason: 'duplicate account' }]);

  // cancelling the reason prompt aborts the whole action
  ctx = makePage({ confirm: true, prompt: null });
  ctx.seedButtons();
  await ctx.page.loadUsers();
  await ctx.buttons.find((b) => b.dataset.act === 'suspend').onclick();
  assert.equal(ctx.calls.post.length, 0, 'cancelling the reason prompt sends nothing');
});

test('a failed request shows the real server message, restores the button, never claims success', async () => {
  const { page, seedButtons, buttons, calls, domNodes } = makePage({
    post: async () => {
      throw Object.assign(new Error('Cannot suspend a user whose status is "pending"'), { code: 'INVALID_STATUS_TRANSITION' });
    },
  });
  seedButtons();
  await page.loadUsers();
  const getsBefore = calls.get.length;

  const btn = buttons.find((b) => b.dataset.act === 'suspend');
  await btn.onclick();

  const notice = domNodes.get('#noticeBox');
  assert.match(notice.innerHTML, /alert error/, 'an error alert is shown');
  assert.match(notice.innerHTML, /Cannot suspend a user whose status is/, 'the safe server message is displayed');
  assert.doesNotMatch(notice.innerHTML, /Suspended .* — status is now/, 'no success copy is shown');
  assert.equal(btn.disabled, false, 'the button is usable again after the failure');
  assert.equal(calls.get.length, getsBefore, 'a failed action does not refresh the data');
});

test('a second tap while a decision is in flight cannot double-submit', async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const { page, seedButtons, buttons, calls } = makePage({
    post: async () => {
      await gate;
      return { user: { ...MEMBER, status: 'approved' } };
    },
  });
  seedButtons();
  await page.loadUsers();

  const btn = buttons.find((b) => b.dataset.act === 'approve');
  const first = btn.onclick(); // in flight
  assert.equal(btn.disabled, true, 'the button is disabled while the request is in flight');
  btn.onclick(); // impatient second tap
  btn.onclick(); // and a third
  release();
  await first;

  assert.equal(calls.post.length, 1, 'exactly one decision reached the server');
});

test('a successful action refreshes the list and the summary counters', async () => {
  const { page, seedButtons, buttons, calls } = makePage();
  seedButtons();
  await page.loadUsers();
  calls.get.length = 0;

  await buttons.find((b) => b.dataset.act === 'approve').onclick();

  assert.ok(calls.get.includes('/admin/users/summary'), 'the counters are re-fetched after success');
  assert.ok(calls.get.some((p) => p.startsWith('/admin/users?')), 'the user list is re-fetched after success');
});

test('the shipped CSS keeps every mobile action visible, stacked and >=44px', () => {
  const mobile = /@media \(max-width: 699\.98px\) \{([\s\S]*?)\n\}/.exec(CSS);
  assert.ok(mobile, 'a small-screen media query for the Users table exists');
  const block = mobile[1];

  assert.match(block, /table\.data td:last-child[\s\S]*position: sticky/, 'the Actions column stays visible while the table scrolls');
  assert.match(block, /table\.data td:last-child \.row[\s\S]*flex-direction: column/, 'actions stack vertically instead of crowding one row');
  assert.match(block, /min-height: 44px/, 'touch targets meet the ~44px guideline');
  assert.match(block, /#detailActions \.btn[\s\S]*min-height: 44px/, 'the modal actions are full-size on mobile too');
});

test('the shipped HTML version-busts its assets so mobile Safari loads the fix', () => {
  assert.match(USERS_HTML, /<script src="\/js\/admin-users\.js\?v=\d+"/, 'admin-users.js is versioned');
  assert.match(USERS_HTML, /<script src="\/js\/api\.js\?v=\d+"/, 'api.js is versioned');
  assert.match(USERS_HTML, /<link rel="stylesheet" href="\/css\/style\.css\?v=\d+"/, 'style.css is versioned');
});
