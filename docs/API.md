# API reference

Base path: `/api`. Every response uses the same envelope:

```jsonc
// success
{ "ok": true, "data": { } }

// failure
{ "ok": false, "error": { "code": "STRING_CODE", "message": "Human readable" } }
```

`error.stack` is added only outside production. Status codes: `200` read, `201` created,
`202` generation accepted, `400` validation, `401` unauthenticated, `403` forbidden/CSRF,
`404` not found, `409` conflict, `422` business rule, `429` rate limited, `503` upstream/data
source unavailable, `500` unexpected.

Authentication for `/api/admin/*`: either `Authorization: Bearer <jwt>` (CLI) or the `fp_token`
cookie **plus** an `X-CSRF-Token` header equal to the `fp_csrf` cookie (browser). Cookie
mutations without a matching CSRF token are rejected with `CSRF_MISSING` / `CSRF_INVALID`.

## Access model

Football data is **login only**. Three tiers, enforced by middleware before any controller runs:

| Tier | Routes |
| --- | --- |
| Public | `/`, `/about`, `/legal`, `/login`, `/account`, `GET /api/health`, `GET /api/meta` |
| Member (**approved** only) | `/predictions`, `/ticket`, `/today-ticket`, `/history`, `/analytics`, `/dashboard` and every `/api/predictions`, `/api/ticket`, `/api/tickets`, `/api/analytics`, `/api/fixtures`, `/api/odds`, `/api/dashboard` route |
| Admin | `/admin`, `/admin/users` and every `/api/admin` route |

A member route is refused at the server boundary — never by CSS or by hiding a link:

| Principal | Prediction / ticket / analytics **API** | Prediction / ticket / history / analytics **page** |
| --- | --- | --- |
| Guest | `401 UNAUTHORIZED`, `{"ok":false,…}`, no `data` key, `Cache-Control: no-store` | `401` + the "login required" page (`no-store`, `X-Robots-Tag: noindex`) |
| Expired / forged token | `401 TOKEN_EXPIRED` / `401 TOKEN_INVALID` | `401` + the "login required" page |
| Deleted account | `401 ACCOUNT_MISSING` | `401` + the "login required" page |
| **Pending approval** | `403 ACCOUNT_PENDING` | `403` + the "login required" page with the approval notice |
| **Rejected application** | `403 ACCOUNT_REJECTED` | `403` + the "login required" page with the reason |
| **Suspended account** | `403 ACCOUNT_SUSPENDED` | `403` + the "login required" page with the reason |
| Disabled / locked account | `403 ACCOUNT_DISABLED` / `403 ACCOUNT_LOCKED` | `403` + the "login required" page with the reason |
| Approved member / admin | `200`, scoped to the session | page served `no-store`, `noindex` |

**Registration approval.** Every public registration is created with `status = 'pending'`
(`users.status` ENUM `pending | approved | rejected | suspended`). A pending account cannot sign
in — `POST /api/auth/login` answers `403 ACCOUNT_PENDING` with the approval message and issues no
session — and even a token that was issued before the status changed is refused, because the
status is re-read from the database on every request (`middleware/account.js`). Approval,
rejection, suspension and reactivation are admin-only operations on `/api/admin/users/*` and are
recorded in `user_audit_logs` plus `system_logs`.

The authenticated principal is always resolved from the session token (`requireAuth`) and then
**re-read from the database** (`requireActiveAccount`). No `userId`, `user_id`, account header or
query parameter can widen or change the scope.

The landing page is marketing only: it fetches nothing but the shared session check
(`GET /api/auth/me`), shows a locked preview, and names no prediction endpoint.

Nothing below ever accepts odds, picks, confidence values, totals or results from a client:
those fields are dropped and reported back in `ignoredClientFields`.

---

## Pages

| Page | Route | Access | Notes |
| --- | --- | --- | --- |
| Landing page | `/` (`/index.html`) | Public | Pure marketing: hero, locked preview, how the AI works, trust strip, process, CTA. It reads **no** prediction, ticket or analytics endpoint — only the shared session check — and renders no football data |
| About | `/about` (`/about.html`) | Public | Product story, the single market, the rules, the no-guarantee position |
| Legal | `/legal` | Public | Legal and responsible play, terms (`#terms`), privacy (`#privacy`) |
| Member sign-in | `/login`, `/account` | Public | Sign in, register, profile, change password |
| Predictions | `/predictions`, `/predictions.html` | **Member** | Every analysed fixture with its evidence |
| Today's ticket | `/ticket`, `/today-ticket`, `/ticket.html` | **Member** | The published ticket for a date (`?date=YYYY-MM-DD`) |
| Results | `/history`, `/history.html` | **Member** | Settled record with filters and pagination |
| Analytics | `/analytics`, `/analytics.html` | **Member** | Win rate, streaks, flat-stake ROI |
| Member dashboard | `/dashboard`, `/dashboard.html` | **Member** (approved only) | Profile, status, Dashboard Activity |
| Console | `/admin`, `/admin/login` | Admin | Unlisted and guarded |
| Console → Users | `/admin/users`, `/admin/users.html` | Admin | Registration approvals and account management; served `no-store` + `noindex`, guarded exactly like the console |

## Public

Only these two. Everything else under `/api` needs a session.

### `GET /api/health`

```jsonc
{ "ok": true, "data": {
  "status": "ok" | "degraded",
  "database": "ok" | "unavailable",
  "dataSource": { "configured": true, "available": true, "state": "OK" | "DEGRADED" | "OPEN" | "UNCONFIGURED" },
  "market": { "key": "over_1_5", "label": "Over 1.5 Goals", "goalLine": 1.5 },
  "autoTicketGeneration": false,
  "generationRunning": false,
  "serverTime": "2026-10-05T00:07:16.000Z",
  "version": "1.0.0"
}}
```

`200` while the database is up (even when the data source is down → `status: "degraded"`),
`503` when the database is unavailable. The key itself is never returned.

### `GET /api/meta`

Branding + the published product rules: `siteName`, `tagline`, `displayTimezone`, `market`,
`oddsWindow {min: 2, max: 4}`, `thresholds {minConfidence, maxRisk, minDataQuality,
minSelections, maxSelections}`, `autoTicketGeneration: false`, `correlationProtection`,
`oddsFreshnessMinutes`, `serverTime`.

## Member only

Every endpoint in this section runs behind `requireAuth` → `requireActiveAccount`
(`memberGuard`). A guest is answered with `401 Unauthorized` and an empty body; see
[Access model](#access-model).

### `GET /api/ticket/today` · `GET /api/ticket/:date` · `GET /api/tickets/:date`

The ticket router is mounted twice — `/api/ticket` **and** `/api/tickets` — so every route below
also answers on the alias prefix (`GET /api/tickets/today`, `GET /api/ticket/history`, …). Both
prefixes hit the same handler.

The published outcome for one date (`:date` = `YYYY-MM-DD`, defaults to today, UTC).

```jsonc
{ "ok": true, "data": {
  "id": 1176, "date": "2026-10-05",
  "market": { "key": "over_1_5", "label": "Over 1.5 Goals", "goalLine": 1.5 },
  "status": "QUALIFIED",              // QUALIFIED | NO_QUALIFYING_TICKET | DATA_SOURCE_UNAVAILABLE | PENDING
  "result": "PENDING",                // PENDING | WON | LOST | VOID | PARTIAL_VOID | POSTPONED | N/A
  "selectionCount": 3,
  "totalOdds": "2.20",                // display value, exactly 2 decimals
  "totalOddsExact": "2.196500",       // the exact product of the verified prices
  "settledOdds": null,
  "avgConfidence": 83.8, "minConfidence": 83.07, "avgQuality": 89.65, "maxRisk": 14.37,
  "estimatedProbability": 0.5916,
  "oddsWindow": { "min": 2, "max": 4 },
  "generatedAt": "2026-10-05T00:07:16.000Z", "settledAt": null, "resultNote": null,
  "headline": "TODAY'S TICKET", "statusLabel": "QUALIFIED",
  "selections": [ /* see below */ ],
  "noTicket": null                    // present instead of selections when nothing qualified
}}
```

Each selection (an immutable snapshot of one leg):

```jsonc
{ "id": 1177, "position": 1, "fixtureId": 1001,
  "league": { "id": 39, "name": "…", "country": "…", "logo": null },
  "homeTeam": { "id": 11, "name": "…", "logo": null },
  "awayTeam": { "id": 12, "name": "…", "logo": null },
  "kickoffAt": "2026-10-05T01:00:00.000Z",
  "market": { "key": "over_1_5", "label": "Over 1.5 Goals", "goalLine": 1.5 },
  "odds": {
    "value": "1.28",                  // the untouched published string
    "display": "1.28",                // rounded for display only
    "bookmakerId": 8, "bookmaker": "Bet365",
    "oddsUpdatedAt": "…", "verifiedAt": "…", "ageMinutes": 5, "bookmakersOffering": 3,
    "impliedProbability": 0.7813
  },
  "confidence": 84.4, "quality": 89.65, "risk": 12.26, "riskLevel": "LOW",
  "modelProbability": 0.8824, "marketProbability": 0.7813,
  "snapshot": { "expectedTotalGoals": 3.942, "expectedGoals": { "home": 2.262, "away": 1.68 },
                "impliedProbability": 0.7813, "bookmakersOffering": 3 },
  "score": { "home": 2, "away": 1, "total": 3 },   // null until the match is finished
  "result": "WON"                                  // PENDING | WON | LOST | VOID | POSTPONED
}
```

When nothing qualified, `selections` is empty and `noTicket` explains why:

```jsonc
"noTicket": {
  "reason": "ALL_COMBINATIONS_BELOW_MINIMUM",
  "message": "Every possible combination stays below the 2.00 minimum total odds. No weak match was added to force it.",
  "diagnostics": {
    "fixturesAnalyzed": 3, "over15Candidates": 3, "verifiedOdds": 9, "rejectedMatches": 0,
    "lowConfidence": 0, "highRisk": 0, "insufficientData": 0, "correlationRejected": 0,
    "combinationsTested": 0, "qualifiedCombinations": 0
  }
}
```

When the data source is down: `status: "DATA_SOURCE_UNAVAILABLE"`,
`headline: "DATA SOURCE TEMPORARILY UNAVAILABLE"`, `selections: []`, `totalOdds: null`.
Before any run: `status: "PENDING"`, `statusLabel: "NOT GENERATED YET"`.

`GET /api/ticket/today` additionally returns `oddsWindow`, `autoTicketGeneration: false` and
`serverTime`.

### `GET /api/tickets/history?page=&limit=&from=&to=&status=&result=` (alias: `/api/ticket/history`)

`{ page, limit, total, pages, items: [ticket] }` — tickets newest first, each with its selections.
`status` ∈ `QUALIFIED | NO_QUALIFYING_TICKET | DATA_SOURCE_UNAVAILABLE | PENDING | ERROR`,
`result` ∈ `PENDING | WON | LOST | VOID | PARTIAL_VOID | POSTPONED | N/A`.

### `GET /api/fixtures?date=&page=&limit=&playable=`

`{ date, page, limit, total, pages, market, items }`; each item carries `kickoffAt`,
`status {short, long, label, playable, finished}`, `league`, `homeTeam`, `awayTeam`, `score`
(null before the match ends) and its verified Over 1.5 price when one exists.

### `GET /api/fixtures/:id`

One fixture with its verified prices and, when available, its stored prediction.

### `GET /api/odds?date=`

```jsonc
{ "date": "2026-10-05", "market": { "key": "over_1_5", "label": "Over 1.5 Goals", "goalLine": 1.5 },
  "fixturesScanned": 3, "fixturesWithVerifiedOdds": 3, "freshnessMinutes": 90,
  "items": [ { "fixtureId": 1001, "kickoffAt": "…", "league": "…", "homeTeam": "…", "awayTeam": "…",
               "market": { }, "selected": { "value": "1.28", "display": "1.28", "bookmaker": "Bet365",
                                            "verifiedAt": "…", "ageMinutes": 5 },
               "prices": [ /* every verified bookmaker price, exactly as published */ ] } ],
  "generatedAt": "…" }
```

### `GET /api/odds/bookmakers` · `GET /api/odds/fixture/:id`

The real bookmakers stored from the API, and every verified price for one fixture (with the
rejected Over 1.5 attempts and their reasons, for transparency).

### `GET /api/predictions?date=&page=&limit=&eligible=`

`{ date, page, limit, total, pages, market, rejectionBreakdown, items }`. Each item:
`fixtureId`, `kickoffAt`, `market`, `league`, teams, `eligible`, `rejectReason`,
`confidence`, `quality`, `risk`, `riskLevel`, `modelProbability`, `marketProbability`,
`expectedGoals {home, away, total}`, `over15Rates {home, away, league}`, `odds`, `analysis`
(the evidence behind the scores). `eligible=1` returns only candidates that passed every filter.

`rejectionBreakdown` maps a reason (`NONE`, `NO_OVER15_ODDS`, `INSUFFICIENT_DATA`,
`FIXTURE_STARTED`, `FIXTURE_NOT_PLAYABLE`, `LOW_CONFIDENCE`, `HIGH_RISK`, `LOW_QUALITY`) to a
count for the day.

### `GET /api/predictions/:fixtureId`

One prediction with its component breakdown (`prediction_scores`) so every number can be traced.

### `GET /api/analytics`

```jsonc
{ "tickets":   { "total": 15, "won": 6, "lost": 3, "winRate": 66.67, "avgOdds": 2.2,
                 "highestOdds": 2.2, "lowestOdds": 2.2 },
  "selections":{ "total": 33, "winRate": 85.71 },
  "over15":    { "settled": 28, "won": 24, "lost": 4, "voided": 2, "winRate": 85.71 },
  "streaks":   { "currentWinningStreak": 1, "currentLosingStreak": 0,
                 "longestWinningStreak": 2, "longestLosingStreak": 1, "settledTickets": 9 },
  "monthly":   [ { "month": "2026-10", "tickets": 15, "qualified": 11, "won": 6, "lost": 3,
                   "voided": 1, "selections": 33, "avgOdds": 2.2 } ],
  "flatStake": { "staked": 9, "returned": 17.6, "profit": 8.6, "roi": 95.56 },
  "market":    { "key": "over_1_5", "label": "Over 1.5 Goals", "oddsWindow": { "min": 2, "max": 4 } },
  "generatedAt": "…" }
```

`flatStake` is illustrative accounting for 1 unit staked on every qualified ticket: won tickets
return their void-adjusted real odds, lost tickets return 0, fully void tickets return the stake.

---

## Sessions & accounts

### Auth

| Endpoint | Body | Notes |
| --- | --- | --- |
| `POST /api/auth/admin/login` | `{login, password}` | `200 {admin, token, csrfToken}` + `fp_token` (httpOnly) and `fp_csrf` cookies; rate limited; failures lock the account |
| `POST /api/auth/admin/logout` | — | clears the cookies |
| `POST /api/auth/admin/change-password` | `{currentPassword, newPassword}` | authenticated; minimum length enforced |
| `GET /api/auth/me` | — | `{type: "admin"|"user"|"anonymous", account}` |
| `POST /api/auth/register` | `{email, username, fullName, password}` | `201 {id, username, email, status: "pending", pendingApproval: true, message}`; the account is created **pending** and issues **no session** — it needs an administrator approval before it can sign in. Optional reader account (never required to read the site); rate limited. A client-supplied `role`/`status` is dropped: public registration can never create an administrator |
| `POST /api/auth/login` | `{login, password}` | `200 {user, token, csrfToken}` + the same cookie pair as the admin login; lockout after repeated failures. A pending / rejected / suspended account answers `403 ACCOUNT_PENDING` / `403 ACCOUNT_REJECTED` / `403 ACCOUNT_SUSPENDED` with **no** session cookie |
| `POST /api/auth/logout` | — | clears the session cookies for any session type (admin or user) |
| `POST /api/auth/change-password` | `{currentPassword, newPassword}` | authenticated user session; CSRF required for cookie sessions |

Every `/api/auth/*` response is sent `Cache-Control: no-store`.

### Sign-in door

`GET /admin/login` (and `/admin/login.html`, plus the legacy `/login.html`) serves the console
sign-in form to anyone who is not already an administrator — no admin data, no console shell, no
endpoint list — and redirects a live administrator session to `/admin.html`. Guests hitting
`/admin` or `/admin.html` are redirected here. Any other `/admin/<anything>` answers `404`.

`GET /login` is the **member** sign-in: it serves `account.html` (sign in, register, profile), so
a visitor who types the obvious public address lands on something useful. The marketing pages link
it as `Login` and link `/account.html#register` as `Get Started`.

### Member dashboard (`/api/dashboard/*`)

Session-scoped data that belongs to the signed-in account only. Nothing here is ever rendered on
a public page: the landing page is pure marketing (a locked preview, no football data), the
account area shows the session's own data. `requireAuth` +
`requireActiveAccount` run on **every** route: a guest receives `401 UNAUTHORIZED` with no payload,
and an account that is deleted, deactivated or locked is refused with `401 ACCOUNT_MISSING`,
`403 ACCOUNT_DISABLED` or `403 ACCOUNT_LOCKED` even while its token is still valid. Responses are
always `Cache-Control: no-store`.

| Endpoint | Purpose |
| --- | --- |
| `GET /activity` | The caller's own feed: `{audience: "authenticated", scope: "self", account {type, id, username, email, plan, memberSince, lastLoginAt}, summary {recordedEvents, shownEvents, lastActivityAt, accountAgeDays}, items[]}`. Items are `{id, event, title, detail, tone, level, channel, at}`, newest first, at most 25. |

The actor type/id are read from the account row the middleware re-read from the database — **query
parameters can never widen the scope**, and one account can never read another's events. The page
that renders it (`/dashboard`, `/dashboard.html`) redirects guests to `/account.html`, redirects
administrators to `/admin.html`, and is served `no-store` + `X-Robots-Tag: noindex`.

---

## Admin (`/api/admin/*`)

All routes require an active administrator; the account is re-read from the database on every
request. Rate limited separately from the public API.

| Endpoint | Purpose |
| --- | --- |
| `GET /overview` | `{today, generationRunning, lastGeneration, dataToday {fixtures, playableFixtures, fixturesWithVerifiedOdds, verifiedOddsRows}, settings, dataSource, analytics, recentSyncs, serverTime}` |
| `POST /generate-ticket` | `{date?}` only. Returns `202 {runId, status: "RUNNING", ticketDate, ignoredClientFields[], note, progressUrl}` |
| `GET /generation-progress?run_id=` | `{runId, status, currentStep, currentMessage, progress[], finishedAt, report, ticket, error}` |
| `GET /generation-report?run_id=&date=` | the persisted run: `{…, counters {…18 keys…}, report, error}` |
| `GET /generations?limit=` | recent runs as a flat array |
| `GET /settings` | `{items[], effective {}}` — `items` carry `key, label, description, group, type, options, min, max, locked, value, updatedAt` |
| `PUT /settings` | `{key: value, …}` → `{applied[], rejected[{key, reason}], settings}` |
| `GET /fixtures?date=` · `GET /odds?date=` · `GET /predictions?date=&eligible=&limit=` | stored rows for inspection, including rejected prices and reject reasons |
| `GET /tickets/history?limit=` | every generated day |
| `GET /analytics` | the admin variant (adds `qualified`, `noTicketDays`, `pending`, `avgConfidence`, per-leg stats) |
| `POST /sync` | `{job: "fixtures"|"odds"|"results"|"all"}` → `{job, result}`; `503 NO_API_KEY` when the key is missing. **Never creates a ticket** |
| `GET /api-status` | `{configured, keyConfigured, state, available, quota, plan, host, baseUrl, ratePerMinute, keyPreview, recentSyncs}` — masked key only |
| `GET /sync-logs?limit=&job=` | background sync history |
| `GET /system-logs?level=&channel=&event=&page=&limit=` | `{page, limit, total, items}` audit/error trail |
| `GET /admins` | superadmin only: administrator accounts |

### User management (`/api/admin/users*`) — registration approval

All routes sit behind the same `adminGuard` chain (`requireAdmin` + `requireActiveAdmin` +
`requireCsrf`): a guest answers `401`, a member `403`, and every mutation from a cookie session
needs the double-submit `X-CSRF-Token`. No response ever contains a password hash, session token
or other secret.

| Endpoint | Purpose |
| --- | --- |
| `GET /users/summary` | `{total, pending, approved, rejected, suspended}` — the dashboard cards |
| `GET /users?status=&search=&page=&limit=` | `{page, limit, total, pages, status, search, items[]}`. `status` filters by `pending`/`approved`/`rejected`/`suspended`; `search` matches username, full name, e-mail or exact user id. Items carry `{id, username, fullName, email, role, status, active, registeredAt, lastLoginAt, approvedAt, approvedByAdminId, approvedBy, statusReason, statusChangedAt, availableActions[]}` |
| `GET /users/:id` | `{user, audit[]}` — the account plus its administrative action history |
| `POST /users/:id/approve` | `pending`/`rejected` → `approved` (activates the account, records the approving admin + timestamp) |
| `POST /users/:id/reject` | `{reason?}` — `pending` → `rejected` (deactivates the account) |
| `POST /users/:id/suspend` | `{reason?}` — `pending`/`approved` → `suspended` (blocks access immediately, including existing sessions) |
| `POST /users/:id/reactivate` | `suspended` → `approved` (re-opens access) |

Each decision returns `{user, auditId, notification, note}`. `notification` reports honestly
whether the configured channel (Telegram / webhook) was reached; `note` says so when nothing is
configured — the decision is still fully applied and audited either way.

Rules: only member accounts (`role` `user`/`premium`) can be managed, so an administrator account
can never be locked out here; an illegal transition answers `409 INVALID_STATUS_TRANSITION` and
changes nothing; an unknown id answers `404 USER_NOT_FOUND`. Every decision is written in one
database transaction together with its `user_audit_logs` row (administrator, affected user,
action, previous/new status, optional reason, IP, timestamp) and mirrored into `system_logs` as
`USER_APPROVED` / `USER_REJECTED` / `USER_SUSPENDED` / `USER_REACTIVATED`.

### Generation counters

`generation_logs` (and the report) expose every decision counter, so a run can be audited:

```
fixturesScanned, playableFixtures, over15Candidates, verifiedOdds, rejectedMatches,
rejectedNoOdds, rejectedInsufficientData, rejectedStaleOdds, rejectedLowConfidence,
rejectedHighRisk, rejectedLowQuality, rejectedFixtureState, correlationRejected,
confidenceQualified, riskQualified, finalCandidates, combinationsTested,
qualifiedCombinations, selectedPicks
```

### Settings keys

Grouped as `market` (locked), `odds_window`, `filters`, `model`, `scoring`, `correlation`,
`sync`, `site`. Rejection reasons returned by `PUT /settings`:
`UNKNOWN_SETTING`, `LOCKED_SETTING`, `NOT_A_NUMBER`, `BELOW_MINIMUM_<min>`,
`ABOVE_MAXIMUM_<max>`, `INVALID_OPTION`, `INVALID_JSON`, `ODDS_WINDOW_INVALID`,
`SELECTION_RANGE_INVALID`, `SINGLE_ODDS_RANGE_INVALID`.

### Generation run states

`RUNNING` → `QUALIFIED` | `NO_QUALIFYING_TICKET` | `DATA_SOURCE_UNAVAILABLE` | `ERROR`.
Trigger sources accepted: `admin_ui`, `admin_api`, `cli_manual`. Anything else (including
`cron`/`scheduler`) is refused with `403 AUTOMATIC_GENERATION_DISABLED`, and any process with
`CRON_CONTEXT=1` is refused with `403 CRON_GENERATION_FORBIDDEN`.

---

## Rate limits

| Scope | Default | Env |
| --- | --- | --- |
| `/api/*` | 600 per 15 min | `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS` |
| `/api/auth/*` | 10 per window | `AUTH_RATE_LIMIT_MAX` |
| `/api/admin/*` | 120 per window | `ADMIN_RATE_LIMIT_MAX` |
| `POST /api/admin/generate-ticket` | 10 per window | `GENERATE_RATE_LIMIT_MAX` |

Exceeding a limit returns `429` with `error.code = "RATE_LIMITED"`.
