# Dashboard audit — final report

Date: 2026-10-21
Scope: every dashboard in GoalPredict (admin console + member area), its scripts,
API calls, forms, buttons, filters, permissions and failure paths.
Method: the shipped browser scripts are executed against the real Express app on a
loopback port through a purpose-built DOM harness (`tests/lib/miniDom.js`), plus HTTP
level acceptance tests. Nothing is mocked at the product layer: the server, the
controllers, the services and the real `public/js/*.js` files are the ones under test;
only the database and the API-Football HTTP client are doubled (as the existing suite
already does).

## 1. What was tested

| Surface | Checks |
| --- | --- |
| Admin console — generation | Generate button initial state, confirmation prompt, live progress panel, button restored on completion, ticket badge refresh |
| Admin console — failure paths | Progress endpoint down (button released, retry notice, final "stopped watching" message), odds / predictions / logs view failures (message shown, no stuck skeleton) |
| Admin console — sync jobs | All four sync buttons (`[data-sync]`), each reporting a result, each released afterwards |
| Admin console — users | Summary cards, table rows, approve action + table refresh, detail modal open/fill/close, empty search state, refresh |
| Admin console — settings | Form renders with every control, save control present, validation wired (client suite) |
| Admin console — API management | Credentials card, Test Connection against the provider client, verdict text |
| Admin console — navigation | Mobile drawer (open, overlay, `aria-expanded`, overlay close, close on navigate), hash routing, unknown-view fallback to dashboard |
| Admin console — session | Sign out returns to `/admin/login` |
| Member — predictions | Date filter (populated → empty → populated), eligible-only filter, API failure error state, transparent breakdown panel (formerly dead) |
| Member — ticket | Day without a ticket, published ticket (picks, accuracy summary, diagnostics, badge, date) |
| Member — history | Rows, settled badges, pager (Prev disabled on page 1, Next loads page 2), result filter resetting to page 1 |
| Member — analytics | Stat cards, ROI cards, streak cards, SVG monthly chart built from settled tickets, monthly table, generated-at stamp |
| Member — account | Guest view, member view, sign-in validation, password change validation, button re-enable, sign out |
| Member — dashboard | Profile paint, ticket status card, phone-width paint, activity-feed failure hides the card instead of showing stale data |
| Sign-in doors | Admin door refuses a bad password and enters the console on success; member door refuses a bad password and navigates on success |
| Mobile | Public nav drawer (open / Escape / tap-a-link) and member dashboards at 390 px |
| Permissions | Covered by the existing HTTP suites: members are refused `/api/admin/*` and admin pages (403), deactivated / pending / locked accounts are refused on both API and page, CSRF required for cookie sessions |
| Data contracts | `/api/admin/overview` `recentSyncs` and `/api/predictions/:id` `scoreBreakdown` are populated when rows exist |

## 2. Defects found and fixed

All three were real, reproducible frontend defects. Each was fixed on its own and the
relevant tests were re-run before moving to the next one.

1. **Predictions → "Transparent breakdown" never loaded** (`public/js/predictions.js`).
   The fixture id lived only on the inner `<div>` while the `toggle` handler read it
   from the `<details>` element, so every panel requested `/api/predictions/NaN` (HTTP
   400) and stayed on "Loading…" for the rest of the session. Fixed by carrying the id
   (`data-fixture-id`) on the element that is actually listened to, validating it,
   moving the body id to `detail-body-<id>`, and clearing the `loaded` guard on failure
   so re-opening the panel retries.

2. **Admin generation poll could lock the console forever** (`public/js/admin.js`).
   A single failed poll performed a bare `clearInterval`, leaving "Starting generation…"
   and a disabled Generate button with no explanation. Fixed with
   `MAX_POLL_FAILURES = 4`: each failure is reported with an attempt count and the
   button is always released; after four failures the panel says the console stopped
   watching, that the run continues on the server, and links to Today's Ticket.

3. **Password change showed "Invalid request parameters"** (`public/js/account.js`).
   The server returns a generic headline plus per-field `details`; only the headline
   was shown, so the member could not tell what to change. Fixed with `fieldError()`
   (surfaces the first field detail), a client-side pre-check mirroring the server rules
   (minimum 8 characters, must differ from the current password), and the same
   treatment for the sign-in and registration alerts.

## 3. Tests performed

- `tests/dashboards.test.js` — new, 21 tests running the real browser scripts against
  the real app (admin generation flow, poll failure, view failures, sync jobs, users
  console, settings, API management, mobile drawer/routing, sign-out, member
  predictions/ticket/history/analytics/account/dashboard, sign-in doors, mobile member
  pages, data contracts).
- `tests/lib/miniDom.js` — extended while auditing: HttpOnly-aware cookie jar exposed
  as `document.cookie`, form-field semantics (`value`, `checked`, `disabled`, `open`),
  and `MiniDocument.dispatchEvent` now keeps the event payload (without it, `Escape`
  in the nav handler could not be exercised).
- Full suite: `npm test` → **442 tests, 442 passing**.
- Lints: `npm run lint:syntax`, `npm run lint:js` (eslint 9), `npm run lint:secrets` — clean.
- Staging verification: every fix was re-run against the real server through the harness
  (not against mocks of the product). No production deploy was performed.

## 4. Not defects (investigated and closed)

- `scoreBreakdown: []` and `recentSyncs: []` in early audit runs were empty *fixtures*,
  not missing code: the queries are populated when rows exist. A permanent test now
  proves both contracts.
- The history pager is empty when a search returns a single page (intended), and the
  analytics chart shows "No settled months yet." until a ticket is settled (intended).
- The admin ticket diagnostics grid is only rendered for runs that carry diagnostics
  (e.g. a data-source refusal), not for a healthy ticket (intended).

## 5. Remaining issues / caveats

- **Staging verification is local**: the harness boots the real app with the real
  database layer doubled. A final manual pass on the staging host (real MySQL,
  real API-Football credentials, real browser + phone) is still required before
  production, per the working agreement.
- The admin generation poll intentionally keeps watching after a transient read error;
  if the progress endpoint stays down for four consecutive polls the console stops
  watching and tells the operator where to look. The run itself is unaffected.
- API-Football's IP allowlist is an account setting, not code — it must be updated on
  the provider dashboard (see the earlier sync-report fix); the product now reports the
  refusal accurately everywhere.
