# GoalPredict — Daily Over 1.5 Goals predictions

**Smarter Football Picks.** A production-ready football prediction platform built for
cPanel Node.js hosting. One market only — **Over 1.5 Goals** — one honestly built
ticket per day, with combined odds between **2.00 and 4.00**, generated **manually by an
administrator** and settled from real full-time scores.

> ### The rules this codebase is built around
> 1. **Over 1.5 Goals only.** No other market is predicted, stored, displayed or settled.
> 2. **Combined daily odds must land inside 2.00–4.00.** There is no fixed number of picks.
> 3. **Nothing is ever forced.** If no combination of verified candidates reaches 2.00, the
>    day is published as **NO QUALIFYING TICKET**. Weak matches are never added to pad the odds.
> 4. **Nothing is ever invented.** Fixtures, bookmakers, prices, statistics, confidence values
>    and results all come from API-Football or the local database. Missing data means
>    **DATA UNAVAILABLE** and the candidate is rejected.
> 5. **If the data source is down, the site says so.** `DATA SOURCE TEMPORARILY UNAVAILABLE`
>    is shown and no ticket is created — no cached guesses, no placeholder numbers.
> 6. **Ticket generation is manual.** Only an authenticated administrator clicking
>    **GENERATE TODAY'S TICKET** (or an operator running the CLI by hand) can create a ticket.
>    Background sync of fixtures/odds/results may run automatically but can never publish one.
> 7. **Displayed odds are the verified bookmaker odds.** Internal maths uses the exact values;
>    only the display is rounded to 2 decimals.
> 8. **The browser is never trusted.** Odds, confidence, totals and results sent by a client are
>    ignored; every critical calculation happens on the server.
> 9. **The API key never reaches the frontend.** It lives in the server environment only.

---

## Stack

| Layer | Technology |
| --- | --- |
| Frontend | HTML5, CSS3, vanilla ES2019 JavaScript (no framework, no build step) |
| Backend | Node.js ≥ 18.17, Express 4 |
| Database | MySQL 5.7+/MariaDB 10.3+ (`mysql2` prepared statements only) |
| Data & odds | API-Football **Pro** (`v3.football.api-sports.io`) |
| Hosting | cPanel "Setup Node.js App" + MySQL + cron |
| Tests | `node:test` (built in) — 54 tests, no test dependencies |

No Next.js, React, Vercel, Firebase, Supabase, MongoDB, Tailwind, PHP or Python anywhere.
`package.json` contains only what the application actually imports.

---

## Quick start (local)

```bash
npm install                 # 100% pure-JS dependencies, no native builds
cp .env.example .env        # then edit DB_*, API_FOOTBALL_KEY, JWT_SECRET, ADMIN_*
npm run db:setup            # creates the schema, seeds settings + the first administrator
npm start                   # http://localhost:3000
```

Useful commands:

```bash
npm run dev                 # node --watch server.js
npm run db:migrate -- --status   # applied vs pending migrations (read-only)
npm test                    # 62 unit + service + HTTP acceptance tests (no DB needed)
npm run test:sql            # static check: schema.sql vs every query in queries.js
npm run ticket:generate -- --admin=admin --confirm
npm run sync:all            # fixtures + odds + results (never creates a ticket)
npm run health              # non-zero exit when the DB or the data source is down
npm run lint:secrets        # verifies no key/secret is shipped in public/
npm run lint:js             # ESLint (correctness rules only, fetched via npx)
npm run lint:syntax         # node --check over every JavaScript file in the repo
```

### Full local stack with Docker (optional)

```bash
docker compose up           # MySQL 8 + app on http://localhost:3000 (admin / local-dev-password)
docker compose up db        # just MySQL; then run `npm run dev` on the host
docker compose down -v      # stop and wipe the database volume
```

First boot applies the schema + migrations and seeds the admin automatically.
Docker is for local development only — production stays on cPanel.

### Look at the UI without MySQL or an API key

```bash
npm run preview:ui          # http://localhost:3000  — admin / preview123
# or: node tools/uipreview.js
```

The preview harness boots the **real** Express app, controllers and prediction pipeline, but
swaps MySQL for an in-memory double (`tests/fakeDb.js`) and API-Football for a fictional
sample client (`tests/synthetic.js`). Every page is stamped with an orange
**PREVIEW MODE — sample data only** banner. Teams such as *Northbridge FC* and leagues such as
*Test Premier League* do not exist; no odds, results or statistics in the preview are real.
It exists so the interface can be reviewed before deployment — production always runs
`node server.js` against a real database and a real API-Football key.

---

## Project layout

```
server.js                     startup entry point (cPanel "Application startup file")
package.json                  scripts + the 9 runtime dependencies
.env.example                  every environment variable, documented
public/                       the entire frontend (static, no build step)
  index.html                  homepage: today's ticket, stats, recent results
  ticket.html                 full ticket page (also accepts ?date=YYYY-MM-DD)
  history.html                ticket history with result filters + pagination
  analytics.html              performance analytics (win rate, streaks, monthly)
  predictions.html            every analysed fixture with its evidence
  login.html                  sign-in door (unlisted, never linked from the public UI)
  admin.html                  admin console (10 views, sidebar layout, unlisted + guarded)
  css/style.css               design system: dark navy panels, cyan accents
  js/api.js                   fetch wrapper + CSRF + shared render helpers
  js/{app,ticket,history,analytics,predictions,account,login,admin}.js
  img/{logo,favicon}.svg
server/
  config/index.js             typed environment configuration
  app.js  server.js           Express app factory + HTTP bootstrap
  routes/                     health, fixtures, odds, predictions, tickets,
                              analytics, auth, admin
  controllers/                request validation + response shaping only
  services/                   apiFootball, fixtureService, oddsService, statsService,
                              contextService, syncService, resultService, settingsService,
                              logService, analyticsService, ticketService, notifyService
  prediction/                 over15, confidence, risk, quality, correlation,
                              ticketBuilder, pipeline
  database/                   schema.sql (baseline), migrations/ (versioned, applied
                              once + checksummed), migrate.js, connection.js (pool),
                              queries.js (all SQL)
  middleware/                 auth, adminAuth (+CSRF), rateLimit, requestLogger, errorHandler
  utils/                      decimal (exact odds maths), numbers, time, logger,
                              errors, asyncHandler, validate, fixtureStatus
  jobs/scheduler.js           optional internal sync scheduler (never generates tickets)
scripts/                      db-migrate, db-seed, cron-sync-*, cron-health-check,
                              generate-ticket-cli, validate-sql, check-no-secrets
tests/                        fakeDb.js, synthetic.js, engine/acceptance/http tests
tools/uipreview.js            preview harness (development only)
docs/                         ARCHITECTURE.md, API.md, DEPLOYMENT-CPANEL.md
```

---

## How a ticket is produced

```
fixtures (API-Football) ─┐
verified Over 1.5 odds ──┼─► 14-point odds gate ─► model inputs (form, venue split,
team + league statistics ┘                          recency, league environment, h2h)
                                                        │
                                    P(Over 1.5) ─► confidence 0–100
                                                ─► risk 0–100
                                                ─► data quality 0–100
                                                        │
                              filters: confidence ≥ 72 · risk ≤ 35 · quality ≥ 60
                                                        │
                              correlation protection (league / country / team / kickoff window)
                                                        │
                     exhaustive combination search with exact BigInt odds products
                                                        │
                     ┌──────────────────────────────────┴─────────────────────────────┐
       2.00 ≤ total ≤ 4.00                                            no combination in range
                     │                                                              │
             QUALIFIED ticket                                     NO QUALIFYING TICKET
       (immutable odds snapshot per leg)                            (reason + diagnostics)
```

Full details, including the 14 validation points and the scoring maths, are in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

Settlement is equally strict: a finished match with **2 or more total goals is WON**, **0–1 goals
is LOST**, and **postponed / cancelled / abandoned legs are VOID or POSTPONED** (void legs are
removed from the accumulator instead of being counted as wins).

---

## Admin console

The console is **hidden from the public site**: no navigation, footer, sitemap or robots
entry references it. Guests opening `/admin` or `/admin.html` are redirected to the sign-in
page, authenticated members receive a bare `403`, and the console shell + its script are
served `no-store` / `noindex` to administrators only. Administrators reach it by going
straight to `/admin` (sign-in lives at the equally unlisted `/login`).

`/admin.html` (superadmin sees everything, `admin` role sees the operational views):

| View | What it does |
| --- | --- |
| Dashboard | today's ticket, live generation panel, latest report, data counters |
| Today's Ticket | the published ticket plus the full diagnostic grid |
| Fixtures / Odds / Predictions | date-filtered inspection of everything stored |
| Ticket History | every generated day with its result |
| Analytics | win rate, streaks, monthly table, flat-stake accounting |
| Settings | thresholds, odds window, correlation caps, sync options, branding |
| API Status | key presence, circuit-breaker state, quota, manual sync buttons, sync log |
| System Logs | level/channel filtered audit + error trail |

Locked settings (`market_key`, `market_label`, `auto_ticket_generation`,
`results_settle_mode`) are refused by the API and re-pinned from code on every read, so the
product rules cannot be weakened from the dashboard. The odds window itself is bounded to
2.00–4.00 by the setting definitions.

---

## Configuration

Every variable is documented in [`.env.example`](.env.example). The important ones:

| Variable | Purpose |
| --- | --- |
| `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME` | MySQL connection (cPanel "MySQL Databases") |
| `API_FOOTBALL_KEY` | API-Football Pro key — **server side only** |
| `API_FOOTBALL_HOST` | `v3.football.api-sports.io` (or the RapidAPI host) |
| `JWT_SECRET` | 64+ random characters; signs admin sessions |
| `APP_URL`, `CORS_ORIGINS` | public origin, used for CORS and secure cookies |
| `TRUST_PROXY` | `1` on cPanel (the app sits behind a proxy) |
| `ADMIN_USERNAME/ADMIN_EMAIL/ADMIN_PASSWORD` | first administrator, created by `npm run db:seed` |
| `ENABLE_INTERNAL_SCHEDULER` | keep `0` on cPanel and use cron instead |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | optional: announce published tickets / NO QUALIFYING TICKET days and operational alerts via a Telegram bot (server side only) |
| `NOTIFY_WEBHOOK_URL` | optional: POST the same events as JSON to any webhook |
| `ODDS_FRESHNESS_MINUTES`, `MIN_TOTAL_ODDS`, `MAX_TOTAL_ODDS`, `MIN_CONFIDENCE`, `MAX_RISK`, `MIN_DATA_QUALITY`, `MAX_SELECTIONS` | fallback defaults; the `settings` table overrides them at runtime |

Documentation:

* [`docs/DEPLOYMENT-CPANEL.md`](docs/DEPLOYMENT-CPANEL.md) — cPanel walkthrough: Node.js app,
  database import, environment, cron entries, SSL, verification and troubleshooting.
* [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — layers, data model, the 14-point odds gate,
  the prediction engine, generation, settlement and the failure contract.
* [`docs/API.md`](docs/API.md) — every endpoint with request/response shapes and error codes.

---

## Security

* Helmet with a strict CSP — **no inline JavaScript anywhere**; `script-src 'self'`.
* `bcryptjs` password hashing, JWT sessions in `httpOnly` + `SameSite=strict` cookies.
* Double-submit CSRF token on every cookie-authenticated mutation (bearer/CLI clients exempt).
* The admin console is unlisted (no public links, robots.txt/sitemap stay silent) **and**
  server-side protected: guest → redirect to sign-in, non-admin session → `403`, admin
  account re-read from the database on every privileged request, so a disabled or locked
  account loses access immediately; repeated failures lock the login.
* Layered rate limiting: global API, auth, admin and generation endpoints.
* All SQL is written in `server/database/queries.js` with bound placeholders; `LIMIT/OFFSET`
  are inlined only after integer validation.
* `scripts/check-no-secrets.js` scans `public/` for keys, hosts and secrets (it also runs as
  part of the test suite).
* Audit trail: admin logins, generation runs, settings changes and sync jobs are written to
  `system_logs` / `generation_logs` / `api_sync_logs`.

---

## Tests

```bash
npm test          # 62 tests, ~1.5s, no database or network required
```

| File | Covers |
| --- | --- |
| `tests/engine.test.js` | exact decimal odds maths, the 14-point odds gate, exact Over 1.5 goal-line matching, combination engine, correlation protection, settlement rules, locked settings |
| `tests/acceptance.test.js` | manual-trigger guards, data-source-unavailable runs, a full qualified generation, regeneration, settlement end to end |
| `tests/http.test.js` | the booted Express app: forged client odds are ignored, public/admin contracts, a field-by-field frontend contract check, CSRF, auth, CSP, and a scan proving no secret ships to the browser |
| `tests/fakeDb.js` | in-memory double for `server/database/connection.js`; the SQL still comes from `queries.js` |
| `tests/synthetic.js` | fictional fixtures, odds payloads, form rows and an API-Football double |
| `tests/scripts.test.js` | runs `scripts/validate-sql.js` and `scripts/check-no-secrets.js` and fails when they do; also guards the `test` script itself (see below) |

### Acceptance criteria → test map

| # | Criterion | Test |
| --- | --- | --- |
| 1 | Qualified ticket with combined odds 2.00–4.00 | `acceptance 1: qualified ticket keeps combined odds inside 2.00 - 4.00` |
| 2 | All candidates below the minimum → no ticket | `acceptance 2: every combination below the minimum -> NO QUALIFYING TICKET` (+ pipeline and service level variants) |
| 3 | All candidates above the maximum → no ticket | `acceptance 3: every combination above the maximum -> NO QUALIFYING TICKET` (+ pipeline variant) |
| 4 | Over 2.5 never substitutes for Over 1.5 | `acceptance 4: a fixture offering only Over 2.5 is rejected, never substituted` |
| 5 | Published odds equal the verified bookmaker odds | `acceptance 5: Over 1.5 = 1.25 is used exactly, never inflated` |
| 6 | Client-supplied odds/picks/results are ignored | `acceptance 6: forged odds, picks and totals in the request body are ignored` |
| 7 | API unavailable → no ticket, honest message | `acceptance 7: no API key -> DATA SOURCE TEMPORARILY UNAVAILABLE and no ticket` (+ circuit breaker, HTTP) |
| 8 | Generation is manual only | `acceptance 8: cron, scheduler and anonymous triggers are refused` (+ cron context, locked rules) |
| 9 | An administrator generates the ticket | `acceptance 9: an administrator generates a qualified ticket from verified data` (+ HTTP variants) |
| 10 | A started/finished match cannot be selected | `acceptance 10: a match that already started cannot be selected` |
| 11 | 2+ total goals settles WON | `acceptance 11: total goals of 2 or more settles WON` (+ service level) |
| 12 | 0–1 total goals settles LOST | `acceptance 12: total goals of 0 or 1 settles LOST` (+ service level, void/postponed) |
| 13 | A later price move never rewrites a stored ticket | `acceptance 13: a later bookmaker price move never rewrites a stored ticket` |
| 14 | The admin console stays usable on a phone | `responsive: the admin console stays navigable on small screens` |
| 15 | The exact spec products behave (1.95 / 2.10 / 3.375) | `review 4`, `review 5`, `review 6`, `review 6b` in `tests/engine.test.js` |

### Continuous integration

`.github/workflows/checks.yml` runs on every push and pull request to `main`, on Node 18, 20 and
22 (`>=18.17` is the documented floor for native `fetch`; 22 is what cPanel currently ships). Each
job runs, in order: `npm ci`, `lint:syntax`, `test:sql`, `lint:secrets`, `npm test`.

The workflow needs **no services and no secrets** — the suite is hermetic, so a green run is proof
of the engine and HTTP contracts, not of a live MySQL or API-Football connection. Those still have
to be verified on the host with `npm run db:setup` and `npm run sync:all` (see
`docs/DEPLOYMENT-CPANEL.md`).

> **Why `"test": "node --test"` has no file pattern.** Glob positionals were only added to
> `node --test` in **Node 21**. On Node 18 and 20 a pattern such as `"tests/**/*.test.js"` is
> treated as a *literal path*, so the runner prints `Could not find ...` and exits 1 without
> running a single test — while looking perfectly fine on a developer's Node 22 machine. With no
> path argument the runner applies its own default discovery, which has behaved the same since
> Node 18 and does not depend on shell expansion (so it also works on Windows). Do not use the
> directory form `node --test tests/` either: that executes every `.js` file in the directory,
> including the `fakeDb.js` and `synthetic.js` fixtures. `tests/scripts.test.js` fails the build
> if either mistake is reintroduced.

---

## Background jobs (cron)

| Schedule | Command | Purpose |
| --- | --- | --- |
| `0 * * * *` | `scripts/cron-sync-fixtures.js` | fixtures + team/league statistics |
| `*/20 * * * *` | `scripts/cron-sync-odds.js` | verified Over 1.5 prices |
| `*/30 * * * *` | `scripts/cron-sync-results.js` | final scores + settlement of pending legs |
| `*/15 * * * *` | `scripts/cron-health-check.js` | alerts (non-zero exit) when DB or data source is down |

Every cron script sets `CRON_CONTEXT=1`, and `ticketService.assertManualTrigger()` refuses to run
in that context — a cron job physically cannot create or publish a ticket. `scripts/cron-sync-all.js`
exists for hosts that allow only one entry. **Never** put `scripts/generate-ticket-cli.js` in cron.

---

## Licence

Private project. Football data and odds are provided by API-Football Pro under its own terms;
nothing here may be repurposed to publish invented odds, fixtures or results.
