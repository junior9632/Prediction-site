# GoalPredict — Unfinished modules (inventory of build code)

**Repository:** `junior9632/Prediction-site`
**Analysed revision:** `main` @ `ef547d4` (checked out as `arena/d1c5e8d0-prediction-site`)
**Date:** 2026-10-08

### How this list was produced

| Check | Tool / command | Result |
| --- | --- | --- |
| Test suite | `npm test` | 105/105 pass, 0 skipped, 0 todo |
| Documented endpoints vs. mounted routes | `docs/API.md` ∩ `server/routes/*.js` | no drift |
| Frontend `API.*` calls vs. server routes | `public/js/*.js` ∩ `server/routes/*.js` | no drift |
| Schema tables vs. SQL actually issued | `schema.sql` ∩ `queries.js` | 17/17 tables used |
| Settings declared vs. settings consumed | `settingsService.js` `DEFINITIONS` ∩ `server/` | **3 were inert — fixed in module 3** |
| Deployment artefact vs. source | `GoalPredict-cPanel-deployment.zip` ∩ working tree | **28 of 115 files stale** |
| Unmerged work | `git ls-tree` `main` vs. `origin/pr#5` | **8 files + 8 npm scripts missing** |

Everything else in the repository is wired: no `TODO`/`FIXME`/`not implemented` markers exist
anywhere in the source, and every page, route, controller, service and script that `main`
ships has a caller.

---

## 1. Unfinished = built but NOT merged into `main` (open PR #5)

These modules exist as working code on the open pull request
`#5 — "Dashboard Activity is only visible to logged-in users (server-protected)"`
(branch `arena/02873d40-prediction-site`). None of them are in `main` today.

> **Progress — module 1 § 1–6 is now COMPLETE on `arena/d1c5e8d0-prediction-site`**
> (rebased onto `main`, written against the post-PR-#6 odds integrity code instead of merging
> PR #5 wholesale). See section 5 below for the delivered implementation.

| # | Module name | Build code (files) | What it does |
| --- | --- | --- | --- |
| 1 | **Member Dashboard Activity API** | `server/routes/dashboard.js` | `GET /api/dashboard/activity`, `requireAuth` + `requireActiveAccount`, 401 for guests |
| 2 | **Member Dashboard controller** | `server/controllers/dashboardController.js` | caller-scoped activity payload |
| 3 | **Member Activity service** | `server/services/activityService.js` | activity feed built from `system_logs`, scoped to the signed-in principal, max 25 items |
| 4 | **Active-account guard middleware** | `server/middleware/account.js` | re-reads the account row per request → `ACCOUNT_MISSING` / `ACCOUNT_DISABLED` / `ACCOUNT_LOCKED` |
| 5 | **Dashboard activity test suite** | `tests/dashboard-activity.test.js` | pins guest 401, forged-token 401, member scoping, disabled account 403, admin perms |
| 6 | **Homepage render test suite** | `tests/homepage-render.test.js` | pins that public pages carry no private/dashboard markup |
| 7 | **Deployment doctor script** | `scripts/doctor.js` (+ npm `doctor`) | env / MySQL / schema / seed / guest-boundary diagnosis, exit 1 on fault |
| 8 | **Access verifier script** | `scripts/verify-access.js` (+ npm `verify:access`) | proves guest / member / admin boundary against a **running** deployment |

Unmerged supporting changes that ship in the same PR:

* **Public homepage redesign** — `public/index.html`, `public/js/app.js`, `public/css/style.css`
  (+198 CSS lines: five-item mobile bar, sports-intelligence landing layout).
* **Admin sign-in door + DB-fault diagnostics** — `server/app.js`,
  `server/controllers/authController.js`, `public/js/api.js`, `public/account.html`,
  `public/js/account.js`.
* **Member sign-in landing / session hardening** — `no-store` session responses, disabled
  accounts refused in `/api/auth/me`, bfcache revalidation.
* **Queries & fakeDb additions** — `server/database/queries.js` (+23 lines, actor-scoped
  `system_logs` reads), `tests/fakeDb.js`, `tools/uipreview.js` demo member.

> **Merge blocker:** PR #5 branched before PR #6 and is **behind `main`**. It is missing
> `server/database/migrations/001-widen-odds-precision.sql` and `tests/review.test.js`, and its
> copies of `server/prediction/over15.js`, `server/prediction/risk.js`,
> `server/prediction/ticketBuilder.js`, `server/utils/decimal.js`, `server/services/oddsService.js`
> and `server/services/ticketService.js` are the **pre-odds-integrity-fix** versions. It needs a
> rebase before it can be merged.

---

## 2. Unfinished = half-built and still inside `main`

### 2a. Member activity feed — advertised in the UI, absent on the server

`public/dashboard.html` and `public/js/dashboard.js` are live and guarded by
`server/app.js` (`/dashboard`, `/dashboard.html`), and the page copy promises
*"Your account, prediction activity and the latest platform updates in one place."*

There is **no** `server/routes/dashboard.js`, no `dashboardController`, no `activityService` and
no `/api/dashboard/*` mount in `main` — the module that fulfils that promise is items 1–4 above.

### 2b. Inert settings — ✅ RESOLVED (module 3)

The first scan flagged five settings. Tracing each one's real engine mapping showed **three were
genuinely inert**; the other two were already live under irregular names
(`odds_reverify_before_generation` → `reverifyOddsBeforeGeneration`,
`confidence_weights` → `confidence`). All three real gaps are now wired and enforced — see
module 3 in § 5.

### 2c. Stale build artefact — `GoalPredict-cPanel-deployment.zip`

The tracked deployment ZIP is **not** the build of the current source:

* **28 of its 115 files differ** from the working tree — including `README.md`,
  `docs/DEPLOYMENT-CPANEL.md`, `public/index.html`, `public/js/app.js`, `public/js/dashboard.js`,
  `server/app.js`, `server/database/schema.sql`, `server/prediction/over15.js`,
  `server/prediction/risk.js`, `server/prediction/ticketBuilder.js`, `server/utils/decimal.js`,
  `server/services/oddsService.js`, `server/services/ticketService.js`, `tests/acceptance.test.js`.
* It **does not contain** `server/database/migrations/001-widen-odds-precision.sql`
  or `tests/review.test.js`.
* It predates the admin-hardening work, so deploying it would ship the old public surface.

---

## 3. Previously-unfinished modules (already completed — reference naming)

The names used in the earlier "Complete unfinished modules" work (merged PR #2), kept here so the
list above can be compared like-for-like. All of these are **done** and present in `main`:

| Module | Build code | State |
| --- | --- | --- |
| Notification service (Telegram + webhook) | `server/services/notifyService.js` | complete |
| Legal / responsible-gambling + SEO | `public/legal.html`, `server/app.js` (`/robots.txt`, `/sitemap.xml`) | complete |
| Versioned DB migrations | `server/database/migrate.js`, `server/database/migrations/` | complete |
| ESLint + CI | `eslint.config.js`, `.github/workflows/checks.yml` | complete |
| Docker Compose local stack | `docker-compose.yml` | complete |
| Member accounts | `public/account.html`, `public/js/account.js`, `server/controllers/authController.js` | complete |
| PWA | `public/manifest.webmanifest`, `public/sw.js`, `public/offline.html` | complete |
| Analytics page | `public/analytics.html`, `public/js/analytics.js`, `server/services/analyticsService.js` | complete |

---

## 5. Progress log

### Module 1 — Member Dashboard Activity — ✅ COMPLETE (`arena/d1c5e8d0-prediction-site`)

Delivered, tested and documented:

| Piece | File |
| --- | --- |
| Active-account guard middleware | `server/middleware/account.js` **new** |
| Member Activity service | `server/services/activityService.js` **new** |
| Member dashboard controller | `server/controllers/dashboardController.js` **new** |
| Member dashboard routes (`/api/dashboard`) | `server/routes/dashboard.js` **new** |
| Actor-scoped audit queries | `server/database/queries.js` (+`listActorSystemLogs`, `countActorSystemLogs`) |
| Route mount + hardened member page guard | `server/app.js` |
| `no-store` on every session response | `server/routes/auth.js` |
| Explicit actors on login events, guarded `/me` | `server/controllers/authController.js` |
| Dashboard Activity card + renderer | `public/dashboard.html`, `public/js/dashboard.js` |
| Member → dashboard link | `public/account.html` |
| Preview harness: demo member + seeded activity | `tools/uipreview.js` (`member` / `preview123`) |
| Test suite (10 tests) | `tests/dashboard-activity.test.js` **new** |
| Docs | `README.md`, `docs/API.md`, `docs/ARCHITECTURE.md` |

Verification: `npm test` 105/105 · `npm run test:sql` 17 tables / 84 statements · `lint:secrets`
26 files clean · `lint:syntax` clean · ESLint clean.

### Remaining modules

| # | Module | State |
| --- | --- | --- |
| 2 | Admin sign-in door `/admin/login` | ✅ done (module 2) |
| 3 | `scripts/doctor.js` deployment diagnosis | ✅ done (module 2) |
| 4 | `scripts/verify-access.js` deployment verifier | ✅ done (module 2) |
| 5 | Inert settings wired up | ✅ done (module 3) |
| 6 | `GoalPredict-cPanel-deployment.zip` regenerated from source | pending |
| 7 | Homepage redesign (`index.html`, `js/app.js`, `css/style.css`) + `tests/homepage-render.test.js` | pending |

### Module 3 — Inert settings — ✅ COMPLETE

| Gap | Fix |
| --- | --- |
| `combination_weights` never reached the builder | forwarded by `prediction/pipeline.js` into `ticketBuilder.buildTicket()` |
| `combination_leg_penalty` never reached the builder | same — forwarded as `legPenalty` |
| `results_settle_mode` was a dead row | `resultService.assertSettleMode()` enforces it on every settlement; an unsupported value stops the run with `SETTLE_MODE_UNSUPPORTED` instead of settling against the wrong scoreline, and `syncResults()` reports `settleMode` |
| `sync_timezone` was a dead row | `utils/time.js` gains `isValidTimeZone` / `dateInZone` / `zoneDateAnchor`; `syncService` anchors every sync run on the operator's calendar day (UTC storage kept, `UTC` default byte-identical, unknown zone logged + UTC fallback) and returns `syncTimezone` / `syncTimezoneValid` |

| Piece | File |
| --- | --- |
| Zone helpers | `server/utils/time.js` |
| Combination weights + leg penalty forwarded | `server/prediction/pipeline.js` |
| Settlement mode enforced | `server/services/resultService.js` |
| Sync anchored on the configured day | `server/services/syncService.js` |
| Test suite (12 tests, incl. an inert-settings guard) | `tests/settings-wiring.test.js` **new** |
| Docs | `README.md`, `docs/ARCHITECTURE.md` |

### Module 2 — Operator & deployment readiness — ✅ COMPLETE

| Piece | File |
| --- | --- |
| Console sign-in door `/admin/login` + `/admin/login.html` | `server/app.js` |
| Console guard + client redirects now target the door | `server/app.js`, `public/js/admin.js` |
| Deployment doctor (`npm run doctor`) | `scripts/doctor.js` **new** |
| Live access verifier (`npm run verify:access`) | `scripts/verify-access.js` **new** |
| npm scripts | `package.json` |
| `AbortSignal` global for the ESLint env | `eslint.config.js` |
| Existing admin-redirect assertions updated to the door | `tests/http.test.js` |
| Script wiring + failure-mode tests | `tests/scripts.test.js` |
| Live-verifier + door assertions | `tests/dashboard-activity.test.js` |
| Docs | `README.md`, `docs/API.md`, `docs/DEPLOYMENT-CPANEL.md` |

Verified against the running app: `verify-access` **35/35 checks pass**; `doctor` exits 1 on a
broken database while naming the cause and the fix and never printing a secret.

---

## 4. Suggested order of work

1. **Rebase PR #5 onto `main`** and merge it — that lands modules 1–8 above (the single largest
   block of finished-but-unshipped code).
2. ~~Wire or delete the inert settings~~ — **done** (module 3).
3. **Regenerate `GoalPredict-cPanel-deployment.zip`** from the current `main` after the merge,
   so the deployment artefact and the source stop diverging.
