# Architecture

How GoalPredict turns API-Football data into one honest Over 1.5 Goals ticket per day — and
how it refuses to publish one when the data does not support it.

---

## 1. Layers

```
Browser (HTML/CSS/vanilla JS)
   │  fetch('/api/...')  — relative URLs only, CSRF header on mutations
   ▼
Express app (server/app.js)
   │  helmet CSP · compression · cors · body limit · request logger
   │  rate limits: global /api, /api/auth, /api/admin, generate-ticket
   │  optionalAuth → requireAdmin → requireActiveAdmin → requireCsrf
   ▼
Controllers (server/controllers/*)      validate input, shape output, no business rules
   ▼
Services (server/services/*)            apiFootball · fixtures · odds · stats · context
   │                                    sync · results · settings · logs · analytics · tickets
   │                                    notify (Telegram/webhook, fire-and-forget, zero deps)
   ▼
Prediction engine (server/prediction/*) pure functions: over15 · confidence · risk · quality
   │                                    correlation · ticketBuilder · pipeline
   ▼
Repository (server/database/queries.js) the only place SQL is written, bound placeholders only
   ▼
MySQL / MariaDB                          18 tables (schema.sql)
```

Rules that keep the layers honest:

* **Controllers never compute odds, confidence or results.** They validate, call a service and
  serialise. Any odds/picks/totals a client posts are dropped and reported back as
  `ignoredClientFields`.
* **The prediction engine performs no I/O.** `pipeline.runPipeline({fixtures, oddsByFixture,
  loadContext, settings, now})` receives everything it needs, which is why the whole decision
  process is unit-testable without a database or a network.
* **`server/database/queries.js` is the only SQL.** It references the connection through the
  module object so tests can substitute an in-memory double without touching production code.
* **Exact decimal maths** (`server/utils/decimal.js`) for every odds value: prices are parsed
  from the API's strings into BigInt scaled integers (4 decimals), multiplied exactly, compared
  exactly against the 2.00–4.00 window, and rounded **only** for display.

---

## 2. Data model (18 tables)

| Table | Purpose |
| --- | --- |
| `users`, `admins` | optional reader accounts; administrators (bcrypt hash, role, lockout, `must_change_password`) |
| `leagues` | league metadata + the computed goal environment (`avg_total_goals`, `over15_rate`, `sample_matches`) |
| `teams` | team metadata |
| `fixtures` | one row per match: kickoff, status, playability flags, final score, `api_timestamp`, `fetched_at` |
| `bookmakers` | real bookmakers as returned by the API (never invented) |
| `odds` | **every validated price**: market key, bet/value name, goal line, direction, `odd_raw` (untouched string), `odd_decimal`, `is_verified`, `validation_state`, `reject_reason`, `odds_updated_at`, `fetched_at` |
| `predictions` | one row per fixture per day: eligibility, reject reason, confidence, quality, risk, probabilities, expected goals, selected price + bookmaker, `analysis_json` |
| `prediction_scores` | component-level breakdown of confidence/risk/quality (auditability) |
| `tickets` | one published outcome per date: status, selection count, exact + display total odds, odds window, thresholds, generation id, result, settled odds |
| `ticket_selections` | immutable legs: fixture, league/teams, kickoff, market, bookmaker, `odd_raw`, scores, result, final goals, `snapshot_json` |
| `results` | settled full-time scores with the Over 1.5 outcome |
| `team_form` | per team × scope (`all`/`home`/`away`) × window (5/10): goals for/against, Over 1.5 hits and rate, clean sheets, failed to score, stddev, last match |
| `settings` | every tunable rule with type, group, min/max, `is_locked` |
| `api_sync_logs` | each background sync: job, trigger, endpoint calls, rows written, status, message |
| `generation_logs` | each generation run: trigger source, admin, status, progress JSON, settings snapshot, all counters, report JSON, duration, error detail |
| `system_logs` | audit + error trail (level, channel, event, actor, context) |

Two design decisions worth calling out:

* **Rejected prices are stored too.** A wrong goal line or a stale price is written with
  `is_verified = 0` and a `reject_reason`, so an auditor can see exactly why a match had no
  usable price. Only `market_key = 'over_1_5'` rows are ever stored — other goal lines are
  discarded so they cannot leak into the engine.
* **The ticket snapshot is immutable.** `ticket_selections.snapshot_json` freezes the market,
  the price, the bookmaker, the verification time, the scoring components and the thresholds in
  force at generation time. Later odds movements or settings changes never rewrite history.

---

## 3. Ingestion

`syncService` orchestrates three independent jobs, each callable from cron or the admin
"API Status" panel:

| Job | Endpoints | Writes |
| --- | --- | --- |
| `fixtures` | `/fixtures?date=`, `/fixtures?last=` (form), `/fixtures/headtohead` | `fixtures`, `teams`, `leagues`, `team_form`, league environment |
| `odds` | `/odds?date=&page=` | `bookmakers`, `odds` (validated) |
| `results` | `/fixtures?id=` | `fixtures` (final score), `results`, settled legs + recomputed ticket result |

Guards around ingestion:

* **Form is always computed strictly before the ticket day** (`before: startOfUtcDay(ticketDate)`),
  so a team's form can never include the match being predicted.
* The API client has a **circuit breaker** (`_maxFailures`, cooldown), per-minute rate budget,
  timeouts, bounded retries and a small TTL cache. When it opens, services raise
  `ApiFootballUnavailable` and callers convert that into `DATA_SOURCE_UNAVAILABLE` — never into
  estimated data.
* Every job writes an `api_sync_logs` row with endpoint calls and rows written, so quota use is
  visible in the admin console.

---

## 4. The 14-point odds gate

`oddsService.validateOdd(entry, fixture, options)` accepts a price only when **all** of these
hold. Any failure stores the price as rejected with a reason.

| # | Check | Rejection reason |
| --- | --- | --- |
| 1 | the fixture exists | `FIXTURE_MISSING` |
| 2 | the fixture is structurally valid (teams + kickoff) | `FIXTURE_INVALID` |
| 3 | the fixture has **not started** (`kickoff > now`) | `FIXTURE_STARTED` |
| 4 | the fixture is not cancelled | `FIXTURE_CANCELLED` |
| 5 | the fixture is not postponed and is playable | `FIXTURE_POSTPONED` / `FIXTURE_NOT_PLAYABLE` |
| 6 | the market is **exactly** full-time Over 1.5 (goal line `1.50`, direction `over`, no half-time/team-total/period scope) | `MARKET_NOT_OVER_1_5`, `MARKET_GOAL_LINE_MISMATCH`, `MARKET_NOT_FULL_TIME`, `MARKET_AMBIGUOUS` |
| 7 | a real bookmaker id + name is present | `BOOKMAKER_MISSING` |
| 8 | an odds value is present | `ODDS_MISSING` |
| 9 | the odds parse as an exact decimal | `ODDS_NOT_NUMERIC` |
| 10 | the odds are greater than 1.00 | `ODDS_BELOW_MINIMUM` |
| 11 | the price is fresh (`odds_updated_at` within `odds_freshness_minutes`) | `ODDS_STALE` |
| 12 | the odds timestamp is valid and not in the future | `ODDS_TIMESTAMP_INVALID` |
| 13 | the source is API-Football, never a client request | `ODDS_SOURCE_INVALID` |
| 14 | the value has not been manually modified (`odd_raw` identical to the stored string, numeric value identical to the exact decimal, no manual-edit flag) | `ODDS_MANUALLY_MODIFIED` |

A configurable single-leg band (`min_single_odds` 1.01 – `max_single_odds` 2.50) is applied on
top of point 10 (`ODDS_OUT_OF_RANGE`): an Over 1.5 price above 2.50 means the market expects few
goals, which contradicts the product.

`selectPrice()` then chooses **one of the real verified prices** (highest price, or a preferred
bookmaker first) — it never averages, adjusts or computes a synthetic number.

---

## 5. Prediction engine

### 5.1 Model inputs (`contextService.buildContexts`)

For every fixture: team form (overall + venue split + last 5) from `team_form`, the league goal
environment, head-to-head (only when a real sample of ≥ `h2h_min_meetings` exists) and injuries
(only when the API actually returns them). Anything missing stays missing and lowers data
quality — it is never replaced by a baseline guess.

### 5.2 `prediction/over15.js` — P(total goals ≥ 2)

1. Reject immediately when the fixture has started, is not playable, has no verified Over 1.5
   price, or when the form sample is smaller than `min_form_matches` / stale beyond
   `max_days_since_last_match` → `INSUFFICIENT_DATA` ("DATA UNAVAILABLE" in the UI).
2. Blend venue-specific rates with overall rates, weighting by the real sample behind each
   (`blendedRate`), and apply a recency factor from last-5 vs window form (clamped 0.7–1.4).
3. Attack/defence strengths relative to the league baseline (clamped 0.35–2.6); with no
   sufficient league environment the baseline is derived from the two teams' own numbers and
   flagged as `derived_from_teams`.
4. Expected goals `λ_home`, `λ Away` (clamped 0.05–6), optionally scaled by real h2h evidence
   (`h2h_weight`) and real injury counts (`injury_impact_per_player`, capped).
5. `poissonProbability` = P(total ≥ 2) from the two Poissons (optional Dixon-Coles ρ), blended
   with the teams' **historical Over 1.5 frequency** (`poisson_weight` 0.6 / `history_weight` 0.4).
6. `marketProbability` = 1 / verified decimal odds — an independent estimate from the bookmaker.

### 5.3 Confidence (0–100), `prediction/confidence.js`

```
base            = 0.62 · pModel + 0.38 · pMarket
− disagreement  = up to 22 points when |pModel − pMarket| > 0.12
− sample        = up to 10 points for a thin overall sample
− venue         = up to 6 points for a thin venue sample
caps            = min(55 + 0.45 · dataQuality, 100 · max(pModel, pMarket) + 5, 97)
```

Confidence can therefore never exceed what the evidence supports: thin data is capped, and a
model that disagrees with the market is penalised instead of being averaged away.

### 5.4 Risk (0–100), `prediction/risk.js`

Weighted sum of ten real components: goal volatility (0.16), sample size (0.12), defensive
solidity — clean sheets and failed-to-score rates (0.16), league environment (0.14), market
implied probability (0.14), model/market disagreement (0.10), historical Over 1.5 rate (0.08),
injuries (0.04), head-to-head (0.03), kickoff proximity (0.03). Unavailable evidence contributes
a fixed, deliberately conservative amount rather than zero. Levels: LOW < 20, MEDIUM < 35,
ELEVATED < 50, HIGH ≥ 50. Candidates above `max_risk` (default 35) are rejected.

### 5.5 Data quality (0–100), `prediction/quality.js`

Weighted completeness/freshness score: form sample (0.24), venue sample (0.14), league
environment (0.16), odds availability — how many real bookmakers quoted the market (0.18), odds
freshness (0.14), h2h (0.07), injuries (0.04), fixture freshness (0.03). Below
`min_data_quality` (default 60) the candidate is rejected.

### 5.6 Correlation protection, `prediction/correlation.js`

Always blocked: the same fixture twice, the same team twice (in any home/away combination).
When enabled, additionally capped: picks per league (`max_selections_per_league`), per country
(`max_selections_per_country`) and per kickoff window (`max_same_kickoff_window` within
`kickoff_window_minutes`). Caps are enforced both while building the candidate pool and again on
every finished combination.

### 5.7 Combination engine, `prediction/ticketBuilder.js`

* Candidates are ranked by strength (`0.45·confidence + 0.20·quality + 0.20·(100−risk) +
  0.15·probability·100`), then reduced to a correlation-safe pool of at most
  `candidate_pool_size`.
* The pool is ordered by odds ascending and searched with a depth-first pass over **every**
  reachable combination of `min_selections…max_selections` legs, using exact BigInt products.
  Pruning only discards branches that provably cannot reach the window:
  * running product already above the maximum (all prices > 1, so no later leg can reduce it);
  * not enough candidates left to reach the minimum number of legs;
  * even the most expensive reachable combination stays below the minimum.
* The winner is the **strongest** ticket, not the highest-odds ticket:
  `0.30·avgConfidence + 0.15·minConfidence + 0.10·avgQuality + 0.15·(100−maxRisk) +
  0.20·estimatedProbability·100 + 0.05·diversity − legPenalty·(legs − minSelections)`.
  Ties break on estimated probability, then fewer legs, then the lower total.
* If nothing lands inside the window the result is `NO_QUALIFYING_TICKET` with an explicit
  reason: `NO_CANDIDATES` / `INSUFFICIENT_CANDIDATES`, `CORRELATION_LIMITS`,
  `ALL_COMBINATIONS_BELOW_MINIMUM`, `ALL_COMBINATIONS_ABOVE_MAXIMUM` or `NO_COMBO_IN_RANGE`,
  plus the highest/lowest reachable totals for the report.

### 5.8 Final validation before writing

`pipeline.validateFinalSelections()` re-checks every chosen leg one last time: market key, goal
line 1.5, numeric odds > 1.00, kickoff still in the future, odds still fresh, no duplicate
fixture, the exact total still inside the window, and correlation caps still satisfied. Only then
is a ticket persisted.

---

## 6. Generation run (manual only)

```
POST /api/admin/generate-ticket   (administrator, CSRF, rate limited)
  └─ ticketService.startGeneration()
       ├─ assertManualTrigger({source, adminId})
       │     · CRON_CONTEXT=1 or FP_CRON=1  → 403 CRON_GENERATION_FORBIDDEN
       │     · source ∉ {admin_ui, admin_api, cli_manual} → 403 AUTOMATIC_GENERATION_DISABLED
       │     · no administrator (except the hand-run CLI) → 403 ADMIN_REQUIRED
       ├─ assertLockedRules(settings)   market = over_1_5, auto generation = OFF, window sane
       ├─ insert generation_logs (RUNNING, settings snapshot) → 202 {runId, ignoredClientFields}
       └─ runGeneration() in the background
            1 api.configured / api.isAvailable() → else DATA_SOURCE_UNAVAILABLE
            2 fixtures for the UTC day (sync from the API only when the day is empty)
            3 bulk odds sync + reload of verified prices from the database
            4 pass 1: full scan → predictions persisted for every fixture
            5 shortlist by strength → live re-verification of those prices
                 (re-verification unavailable ⇒ DATA_SOURCE_UNAVAILABLE, no ticket)
            6 pass 2: final decision on the shortlist
            7 QUALIFIED → immutable ticket + legs + snapshot
              otherwise → a NO_QUALIFYING_TICKET row with reason + diagnostics
            8 generation_logs updated with every counter, the report JSON and the duration
```

The dashboard polls `GET /api/admin/generation-progress?run_id=` (in-memory first, database
fallback) and renders the step list live. `GET /api/ticket/:date` and the homepage read only what
was persisted, so a visitor can never see a ticket that the pipeline did not produce.

---

## 7. Settlement

`resultService` records what API-Football reports and nothing else:

| Full-time score | Outcome |
| --- | --- |
| total goals ≥ 2 | **WON** |
| total goals 0 or 1 | **LOST** |
| status `PST` | **POSTPONED** |
| status `CANC` / `ABD` / `WO` / `AWD` | **VOID** |
| not finished, or finished with a missing scoreline | **PENDING** (never guessed) |

Ticket result: any lost leg ⇒ `LOST` immediately; all legs won ⇒ `WON`; every leg void ⇒ `VOID`;
a mix of won and void legs ⇒ `PARTIAL_VOID`. Settled odds are the exact product of the remaining
(non-void) legs, so a void leg reduces the accumulator instead of being counted as a win.

---

## 8. Settings and locked rules

`settingsService` is the single source of truth. 51 settings in 8 groups (`market`,
`odds_window`, `filters`, `model`, `scoring`, `correlation`, `sync`, `site`), each typed with
min/max or enum options, cached for 30 seconds and invalidated on write.

* **Locked in code**: `market_key = over_1_5`, `market_label = Over 1.5 Goals`,
  `auto_ticket_generation = 0`, `results_settle_mode = fulltime`. Locked values are never read
  from the table, are refused by `PUT /api/admin/settings`, are re-pinned by `ensureDefaults()`
  and are re-asserted by `assertLockedRules()` on every run.
* **Bounded by the product rule**: `min_total_odds` ∈ [2.00, 3.99], `max_total_odds` ∈ [2.01, 4.00].
* **Two-phase updates**: each key is validated individually, then cross-field rules
  (odds window, selection range, single-leg range) are checked against the merged values *before*
  anything is written, so a contradictory patch cannot half-apply.
* Administrators may tighten thresholds (raise `min_confidence`, lower `max_risk`, shorten odds
  freshness, reduce `max_selections`, tighten correlation caps). Nothing in the code weakens a
  threshold automatically.

---

## 9. Frontend

Static files only, mobile-first, no build step and no framework:

* `public/js/api.js` exposes one helper (`window.App`) with the fetch wrapper (relative `/api`
  URLs, JSON envelope handling, automatic `X-CSRF-Token` from the `fp_csrf` cookie on mutations),
  formatters (odds to 2 dp, percentages, relative times), icons, and shared renderers for pick
  rows, status badges, "verified X ago" chips, evidence lists, empty states and skeletons.
* Each page has exactly one controller script; the CSP allows only `script-src 'self'`, so there
  is no inline JavaScript anywhere.
* The UI never computes odds, confidence, totals or results: it renders the server payload and
  links to the date-specific views. Diagnostics grids are populated from the server's counters
  (10 keys publicly, 18 in the admin report).
* States that must be visible: `QUALIFIED`, `NO_QUALIFYING_TICKET` (with the reason and the
  diagnostic grid), `DATA_SOURCE_UNAVAILABLE` ("DATA SOURCE TEMPORARILY UNAVAILABLE"),
  `PENDING` (not generated yet), and per-leg `WON` / `LOST` / `VOID` / `POSTPONED` / `PENDING`.
* The admin console is a single page with hash routing over ten views; generation is a
  confirm dialog → `202 Accepted` → 900 ms polling of the progress endpoint → refresh.

---

## 10. Failure behaviour (anti-fabrication contract)

| Situation | Behaviour |
| --- | --- |
| API key missing | run ends `DATA_SOURCE_UNAVAILABLE`; UI shows "DATA SOURCE TEMPORARILY UNAVAILABLE"; no ticket row with picks |
| API unreachable / breaker open | same as above, with `reason: CIRCUIT_OPEN` in the report |
| Odds re-verification fails mid-run | same as above (`REVERIFY_UNAVAILABLE`) — the stale prices are not reused |
| No fixtures for the day | `NO_QUALIFYING_TICKET`, zero selections, diagnostics explain the empty day |
| A fixture has no Over 1.5 price | candidate rejected `NO_OVER15_ODDS`; other markets are never substituted |
| Form/league sample too small | candidate rejected `INSUFFICIENT_DATA` ("DATA UNAVAILABLE"); no baseline is invented |
| Nothing reaches 2.00 combined | `NO_QUALIFYING_TICKET` with `ALL_COMBINATIONS_BELOW_MINIMUM`; no weak leg is added |
| Everything exceeds 4.00 | `NO_QUALIFYING_TICKET` with `ALL_COMBINATIONS_ABOVE_MAXIMUM` |
| Client posts odds/picks/results | fields ignored, listed in `ignoredClientFields`, server recomputes |
| Cron tries to generate | refused with `CRON_GENERATION_FORBIDDEN` before any work happens |
| Match postponed after publication | leg becomes `POSTPONED`, ticket `VOID`/`PARTIAL_VOID`, settled odds recomputed from remaining legs |

Every one of these paths is covered by the test suite (`npm test`).
