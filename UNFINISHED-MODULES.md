# GoalPredict — Unfinished modules (inventory of build code)

**Repository:** `junior9632/Prediction-site`
**Analysed revision:** `main` @ `ef547d4` (checked out as `arena/d1c5e8d0-prediction-site`)
**Date:** 2026-10-08

### How this list was produced

| Check | Tool / command | Result |
| --- | --- | --- |
| Test suite | `npm test` | 124/124 pass, 0 skipped, 0 todo |
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

### 2a. Member activity feed — advertised in the UI, absent on the server — ✅ RESOLVED (module 1)

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

**Resolved in module 4** — see § 5. The tracked deployment ZIP was not the build of the current
source:

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

Verification: `npm test` 124/124 · `npm run test:sql` 17 tables / 84 statements · `lint:secrets`
26 files clean · `lint:syntax` clean · ESLint clean.

### Module 5 — Public homepage redesign — ✅ COMPLETE

The public homepage is now a sports-intelligence landing page built from **public data only**, in
the direction PR #5 sketched, but written against the post-odds-integrity code rather than merging
the stale branch.

| Piece | File |
| --- | --- |
| Landing layout: hero + eyebrow + dual CTA + trust strip | `public/index.html` |
| Live "today's ticket" panel (status pill, odds, picks, confidence, generated-at / honest reason) | `public/index.html` + `public/js/app.js` |
| Today's Accumulator card kept and repainted from real data | `public/js/app.js` |
| Rules cards, latest settled tickets, 18+ / responsible-play footer | `public/index.html` |
| Design system additions (`hp-hero`, `hp-eyebrow`, `hp-h1`, `hp-cta`, `hp-trust`, `hp-live`, `hp-pill` + small-screen rules) | `public/css/style.css` |
| Render contract suite (6 tests) | `tests/homepage-render.test.js` **new** |

The page reads `/api/ticket/today` and `/api/tickets/history?limit=5` — the same two public
endpoints every visitor may read. It never references `/api/dashboard`, `activityFeed`,
`/js/dashboard.js`, `/api/admin` or the admin surface, which is asserted both statically
(`tests/homepage-render.test.js`) and against the running app (`verify-access` guest checks).

Honesty rules the page obeys: a dead feed renders "Data offline" (red pill) rather than a stale
ticket, a no-ticket day renders the reason plus the full diagnostics grid, a browser-side failure
says "Status unavailable" instead of blaming the feed, and no copy promises a win.

### Module 6 — Re-audit after modules 1–5 — ✅ COMPLETE

Re-ran every check from the original inventory against the delivered tree (see § 6).

### Remaining modules

| # | Module | State |
| --- | --- | --- |
| 2 | Admin sign-in door `/admin/login` | ✅ done (module 2) |
| 3 | `scripts/doctor.js` deployment diagnosis | ✅ done (module 2) |
| 4 | `scripts/verify-access.js` deployment verifier | ✅ done (module 2) |
| 5 | Inert settings wired up | ✅ done (module 3) |
| 6 | Deployment ZIP regenerated + drift-proofed | ✅ done (module 4) |
| 7 | Homepage redesign (`index.html`, `js/app.js`, `css/style.css`) + `tests/homepage-render.test.js` | ✅ done (module 5) |
| — | Re-audit after modules 1–5 | ✅ done (module 6) |

### Module 4 — Deployment artefact — ✅ COMPLETE

| Piece | File |
| --- | --- |
| Deterministic ZIP builder (pure Node, `zlib` + a small ZIP writer) | `scripts/build-deployment-zip.js` **new** |
| `npm run build:zip` and `--check` | `package.json` |
| Drift guard — fails when the committed ZIP is not the build of the committed tree | `tests/deployment-zip.test.js` **new** |
| Regenerated archive (128 files) | `GoalPredict-cPanel-deployment.zip` |
| Docs | `README.md`, `docs/DEPLOYMENT-CPANEL.md` |

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

1. ~~Rebase and merge PR #5~~ — **superseded.** Every module PR #5 carried has been rebuilt on
   top of `main` (modules 1–5 above) against the post-odds-integrity engine. PR #5 should be
   **closed**, not merged: its copies of `over15.js`, `risk.js`, `ticketBuilder.js`,
   `decimal.js`, `oddsService.js` and `ticketService.js` predate the odds-integrity fix, and
   merging it now would revert that work.
2. ~~Wire or delete the inert settings~~ — **done** (module 3).
3. ~~Regenerate `GoalPredict-cPanel-deployment.zip`~~ — **done** (module 4), and the archive can
   no longer silently drift: `npm test` fails when it is not the build of the committed tree.
4. Deploy from the regenerated archive and prove the host with `npm run doctor` and
   `npm run verify:access -- --member=… --admin=…`.

---

## 6. Re-audit results (module 6)

Run after modules 1–5 landed, against the delivered tree (`npm test` **130/130**).

| Check | How | Result |
| --- | --- | --- |
| Mounted routes vs `docs/API.md` | `server/routes/*.js` ∩ `app.use` prefixes vs the documented endpoint rows | **42 route pairs; all documented.** The two alias combinations (`GET /api/tickets/today`, `GET /api/ticket/history`) were implicit — the double mount is now spelled out in the API doc |
| Documented endpoints with no route | `docs/API.md` → mounted routes | **none** |
| Frontend calls vs routes | 31 `API.*` calls in `public/js/*.js` | **no drift** — every call resolves to a mounted route |
| Settings declared vs consumed | `tests/settings-wiring.test.js` (`CONSUMED_AS`) | **PASS** — 51 declared settings, no inert row |
| Schema vs SQL issued | `npm run test:sql` | **PASS** — 17 tables / 84 statements |
| Deployment artefact vs source | `npm run build:zip -- --check` | **PASS** — 129 files, byte-identical to the committed tree (`--check` reports it up to date) |
| Public surface leaks | every `public/*.html` except `admin.html` | **none** — no `/api/admin`, no `/api/dashboard`, no `data-auth-admin`, no admin script |
| Orphaned pages / scripts / assets | links in every page + `app.js` + `sw.js` | **none** — every page is linked, every referenced asset exists, every script is loaded |
| `TODO` / `FIXME` / "not implemented" markers | `server/`, `public/`, `scripts/`, `tests/` | **none** |
| Docs consistency fixes found by the audit | — | `README.md` test count (124 → 130), CI job order (missing `lint:js`), homepage description; `docs/API.md` ticket alias mount |

**New work introduced by the audit:** none. Both findings were documentation drift, not missing
functionality, and both are fixed in the same commit as module 5.
