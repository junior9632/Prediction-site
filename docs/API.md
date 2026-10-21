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
  // reason/label/hint/resetsAt explain WHY an unavailable source is unusable
  // (NO_API_KEY, CREDENTIAL_UNREADABLE, CIRCUIT_OPEN, QUOTA_EXCEEDED,
  //  RATE_LIMITED, AUTH_REJECTED, IP_NOT_ALLOWED, PROVIDER_UNAVAILABLE,
  //  NETWORK_ERROR, TIMEOUT)
  "dataSource": { "configured": true, "available": true, "state": "OK" | "DEGRADED" | "QUOTA_EXHAUSTED" | "IP_BLOCKED" | "OPEN" | "UNCONFIGURED",
                   "reason": null, "label": null, "hint": null, "resetsAt": null,
                   "quota": { "current": 120, "limit_day": 100 } | null },
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
The stored generation report adds `reason` (see the failure table in
`docs/ARCHITECTURE.md` §3.1, e.g. `QUOTA_EXCEEDED`), `label`, `detail`, `hint` and `resetAt`, so the
console can name the cause and the fix instead of only the status.
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

One fixture with its verified prices and, when available, its stored prediction. Both list and
detail revalidate prices against current settings, freshness and kickoff/status. The selected price
is also attached to `fixture.over15`; expired or started fixtures never expose a price as available.

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
| `GET /generation-report?run_id=&date=` | the persisted run: `{…, counters {…18 keys…}, report, error}`. `report.oddsSync` is credential-free sync metrics (`endpointCalls`, `rowsWritten`, `fixturesScanned`, `fixturesWithAnyOffers`, `fixturesWithRejectedOffers`, `fixturesWithVerifiedOver15`, `offerRejectionCounts`, `over15OfferRejectionCounts`, `providerErrors[]`). Fixture-level counts stay separate from offer-level rejection maps. `report.oddsLoad` is the generation query against stored verified Over 1.5 rows. |
| `GET /generations?limit=` | recent runs as a flat array |
| `GET /settings` | `{items[], effective {}}` — `items` carry `key, label, description, group, type, options, min, max, integer, required, maxLength, locked, value, warning, needsRepair, updatedAt` |
| `PUT /settings` | `{key: value, …}` → `{applied[], rejected[{key, reason, message}], settings}` |
| `GET /fixtures?date=` · `GET /odds?date=` · `GET /predictions?date=&eligible=&limit=` | stored rows for inspection, including rejected prices and reject reasons |
| `GET /tickets/history?limit=` | every generated day |
| `GET /analytics` | the admin variant (adds `qualified`, `noTicketDays`, `pending`, `avgConfidence`, per-leg stats) |
| `POST /sync` | `{job: "fixtures"|"odds"|"results"|"all", date?: "YYYY-MM-DD"}` (date is accepted for fixtures only) → `{job, result}`; `503 NO_API_KEY` when the key is missing. **Never creates a ticket** |
| `GET /api-status` | `{configured, keyConfigured, state, available, quota, plan, host, baseUrl, ratePerMinute, keyPreview, recentSyncs}` — masked key only |
| `GET /sync-logs?limit=&job=` | background sync history |
| `GET /system-logs?level=&channel=&event=&page=&limit=` | `{page, limit, total, items}` audit/error trail |
| `GET /admins` | superadmin only: administrator accounts |

### API Management (`/api/admin/api-management*`) — provider credentials

The admin **API Management** screen (Admin Console → API Management). All routes sit behind the
same `adminGuard` chain (`requireAdmin` + `requireActiveAdmin` + `requireCsrf`); the mutations
answer `403 CSRF_MISSING` / `403 CSRF_INVALID` for a cookie session without the double-submit
token. **No response ever contains a full API key** — only the masked form `********abcd` — and
none of these routes can create, publish or replace a prediction ticket.

| Endpoint | Purpose |
| --- | --- |
| `GET /api-management` (alias `GET /api-management/status`) | `{provider, providers[], activeProviderId, credentialSource, credential {provider, host, maskedKey, keyLength, isActive, algorithm, savedAt, updatedAt, location}, environment {keyConfigured, host, maskedKey, isActive}, connection {state, label, message, testedAt, latencyMs, lastSuccessAt, lastErrorAt, lastErrorCode, lastErrorMessage, host}, lastRequestAt, lastSuccessfulSyncs {fixtures, odds, results {lastSuccessAt, runs}}, quota {current, limitDay, checkedAt, source}\|null, rateLimits, plan, encryption {configured, algorithm, keyEnvVar, message}, storage {state, ready, canRead, canSave, database, schema, permissions, credentials, history, encryption, issues[]}, client, recentEvents[], recentErrors[], predictionRules, serverTime}`. `credentialSource` is `database`, `environment` or `none`. On a live database that has not received migration 003 the endpoint still answers `200` with `databaseManaged: false` and `degradedReason: SCHEMA_OUT_OF_DATE` instead of a `500`, and the environment credential keeps driving the syncs |
| `GET /api-management/providers` | the allowlisted provider registry: `{providers[], defaultProviderId}`. Only `implemented: true` providers can be configured; the others are declared for extension and carry **no** host |
| `GET /api-management/diagnostics?probe=1` | safe quota/connection diagnostics. `probe=1` performs one real `/status` call (skipped — `liveProbe.skipped: true` — when no usable credential exists, and repeated inside the reuse window with `liveProbe.reused: true` instead of a second upstream call; a changed credential is always probed for real) and returns refreshed `{quota, rateLimits, connection, liveProbe, recentErrors, encryption, status}` |
| `GET /api-management/storage-diagnostics` | **admin-only, read-only** credential-storage diagnosis. Separates `DATABASE_UNREACHABLE`, `SCHEMA_OUT_OF_DATE` (migration `003-api-credential-management.sql`), `PERMISSION_DENIED` (SELECT/INSERT/UPDATE booleans), `ENCRYPTION_NOT_READY`, `CREDENTIAL_READ_FAILED` and `HISTORY_DEGRADED`, and returns `{readOnly: true, state, ready, canRead, canSave, database, schema, permissions, credentials, history, encryption, issues[], checkedAt}`. Runs `SELECT`/`SHOW` only; never returns a key, ciphertext, password, cookie or grant text. A provider connection test is not evidence for this report |
| `PUT /api-management/credentials` | `{provider, key, host?}` → stores the key **AES-256-GCM encrypted** (`api_credentials`). Refuses `400 HOST_NOT_ALLOWED` (SSRF guard), `400 UNKNOWN_PROVIDER`, `400 PROVIDER_NOT_IMPLEMENTED`, `503 ENCRYPTION_KEY_MISSING` (nothing is written). Saving an inactive credential does not activate it. Replacing an active credential takes effect immediately and clears its old diagnostics. Saving is not a connection test |
| `POST /api-management/test` | `{provider, key?, host?}` → **one real request** to the provider's official `/status` endpoint. Returns `{ok, state, label, message, reason, hint, networkCode, resetAt, httpStatus, latencyMs, quota, plan, rateLimitPerMinute, keyOrigin, reused, testedAt}` with `state` ∈ `CONNECTED`, `INVALID_KEY`, `QUOTA_EXCEEDED`, `RATE_LIMITED`, `NETWORK_ERROR`, `TIMEOUT`, `PROVIDER_UNAVAILABLE`, `CONFIG_INCOMPLETE`, `REQUEST_REJECTED`, `SUBSCRIPTION_INACTIVE`. `429 TEST_THROTTLED` when called again inside the floor window |
| `POST /api-management/activate` | `{provider}` → the server starts using the stored (encrypted) credential; `400 NOTHING_TO_ACTIVATE` when nothing was saved, `500 CREDENTIAL_UNREADABLE` when the stored key cannot be decrypted |
| `POST /api-management/disable` | `{provider}` → stops using the stored credential (it stays encrypted for re-activation) and falls back to the environment configuration |

Test and Refresh share a throttled, single-flight probe and explicit reuse window. A typed key is
never saved by Test. If `host` is omitted, the key's stored/environment host is used. Only the exact
saved key fingerprint and host can receive persisted test diagnostics, including during concurrent
key rotation. Success clears old error fields; Refresh persists failed checks as well as successes.
`connection` includes `inUse`, `reason`, `hint` and `networkCode`; `effectiveCredential` names the
active source/host/masked key separately from a saved-but-inactive credential. Environment-only
observations live in the current process; database-backed observations persist across restarts.

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

54 settings, grouped as `market` (locked), `odds_window`, `filters`, `model`, `scoring`,
`correlation`, `sync`, `site`. Four code-enforced rules are locked; 50 settings are editable.

Send a nonempty object of changed keys. JSON settings accept a JSON object or a JSON-encoded
object. Counts must be integers; blank numeric values are not zero; booleans must explicitly name
on/off; timezone names and comma-separated positive league IDs are validated. Scoring objects
accept known, bounded numeric components only. Cross-field rules are checked against the current
locked database rows. The accepted subset is committed atomically, including inserts for settings
not yet seeded. **HTTP 200 can contain rejections**: check `applied` and `rejected`, never assume all
submitted fields were saved. Database failures roll back the accepted subset.

`GET /settings` uses code-enforced values for locked fields. Invalid legacy settings show a safe
default with `warning` and `needsRepair: true`, matching what the engine actually uses.

Rejection codes include `UNKNOWN_SETTING`, `LOCKED_SETTING`, `NOT_A_NUMBER`, `NOT_AN_INTEGER`,
`BELOW_MINIMUM_<min>`, `ABOVE_MAXIMUM_<max>`, `INVALID_BOOLEAN`, `INVALID_OPTION`, `INVALID_JSON`,
`INVALID_WEIGHTS`, `UNKNOWN_WEIGHT`, `INVALID_WEIGHT`, `ZERO_WEIGHT_TOTAL`, `NOT_A_STRING`,
`REQUIRED`, `TOO_LONG`, `INVALID_TEXT`, `INVALID_TIMEZONE`, `INVALID_LEAGUE_IDS`,
`ODDS_WINDOW_INVALID`, `SELECTION_RANGE_INVALID`, `SINGLE_ODDS_RANGE_INVALID`,
`CANDIDATE_POOL_TOO_SMALL`, `FORM_WINDOW_TOO_SMALL`, `VENUE_WINDOW_TOO_SMALL`, `ZERO_MODEL_WEIGHTS`.
Every rejection includes a human-readable `message`.

`POST /sync` with `{job: "fixtures", date: "2026-10-16"}` refreshes that **one UTC date**,
without the history/upcoming backfill. It respects league filters, enrichment and quota settings.
An invalid date is a 400; a date attached to another job is `400 SYNC_DATE_UNSUPPORTED`.
`GET /fixtures?date=` includes `statusLabel`, `live`, current `playable`, `finished`, 90-minute
`score` and `fetchedAt` for each stored fixture. No sync operation generates a ticket.

### Generation run states

`RUNNING` → `QUALIFIED` | `NO_QUALIFYING_TICKET` | `DATA_SOURCE_UNAVAILABLE` | `ERROR`.
A run that hits the daily request quota ends `DATA_SOURCE_UNAVAILABLE` with
`reason: QUOTA_EXCEEDED` and `resetAt` (00:00 UTC) rather than an unlabelled outage.

Background sync jobs (`fixtures`, `odds`, `results`) log `SUCCESS | FAILED | PARTIAL | SKIPPED`
in `api_sync_logs`; `SKIPPED` means the job paused itself because the plan had only
`api_quota_reserve` (or fewer) requests left for the day — nothing is broken, the requests are kept
for a manual generation. This check runs between requests as well as at job start; a partially
completed job retains its rows and reports actual call counts with `SKIPPED`. The same table records the daily budget the provider reported
(`requests_used` / `requests_limit`).
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
