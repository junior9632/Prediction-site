# Deploying GoalPredict on cPanel

Target: a standard cPanel account with **Setup Node.js App**, **MySQL Databases**, **phpMyAdmin**,
**Terminal** (or SSH) and **Cron Jobs**. No root access, no Docker, no build step.

| Requirement | Value |
| --- | --- |
| Node.js | 18.17 or newer (20 LTS recommended) — select it in "Setup Node.js App" |
| MySQL / MariaDB | MySQL 5.7+ / MariaDB 10.3+ |
| API-Football | **Pro** plan (the `/odds` endpoint is required) |
| Disk | ~120 MB for the app + `node_modules` |
| Startup file | `server.js` |
| Domain | your domain or subdomain, with SSL enabled |

---

## 1. Upload the application

1. In cPanel → **File Manager**, create `/home/USER/goalpredict` (outside `public_html` — the Node
   app serves its own static files, so the code must not sit in the web root).
2. Upload the project (or `git clone` it in **Terminal**). Required items:

   ```
   server.js  package.json  .env.example  public/  server/  scripts/  docs/
   ```

   `tests/` and `tools/` are development helpers; they are harmless to upload but not needed at
   runtime. Never upload `node_modules/` or a `.env` from another machine.

---

## 2. Create the database

1. cPanel → **MySQL Databases**:
   * create a database, e.g. `USER_goalpredict`
   * create a user, e.g. `USER_gp` with a long random password
   * add the user to the database with **ALL PRIVILEGES**
2. Create the schema — either way is fine:

   **Terminal (recommended)**

   ```bash
   cd /home/USER/goalpredict
   cp .env.example .env      # fill in DB_* first (see step 4)
   npm run db:migrate        # idempotent: CREATE TABLE IF NOT EXISTS only
   ```

   **phpMyAdmin**

   Open the database → **Import** → choose `server/database/schema.sql` → Go.
   17 tables are created (`users`, `admins`, `leagues`, `teams`, `fixtures`, `bookmakers`,
   `odds`, `predictions`, `prediction_scores`, `tickets`, `ticket_selections`, `results`,
   `team_form`, `settings`, `api_sync_logs`, `generation_logs`, `system_logs`).

---

## 3. Register the Node.js application

cPanel → **Setup Node.js App** → **Create Application**:

| Field | Value |
| --- | --- |
| Node.js version | 18.x or 20.x |
| Application mode | `Production` |
| Application root | `goalpredict` |
| Application URL | your domain/subdomain |
| Application startup file | `server.js` |

Save, then use the panel's **Run NPM Install** button (or `npm ci --omit=dev` in Terminal).
All ten dependencies are pure JavaScript — there is nothing to compile, so no `node-gyp`,
python or gcc is needed on the host.

---

## 4. Environment variables

Either enter them in the Node.js app's **Environment Variables** section, or create
`/home/USER/goalpredict/.env` (the app loads it with `dotenv`). `.env` is in `.gitignore`;
never commit it and never place any of these values in `public/`.

```ini
NODE_ENV=production
PORT=3000                      # cPanel injects its own PORT; keep this as a fallback
HOST=0.0.0.0
APP_URL=https://yourdomain.com
TRUST_PROXY=1                  # required: the app sits behind the cPanel proxy

DB_HOST=localhost
DB_PORT=3306
DB_USER=USER_gp
DB_PASSWORD=your-strong-password
DB_NAME=USER_goalpredict
DB_CONNECTION_LIMIT=8

API_FOOTBALL_KEY=your-api-football-pro-key
API_FOOTBALL_HOST=v3.football.api-sports.io
API_FOOTBALL_RATE_PER_MINUTE=60
API_FOOTBALL_TIMEOUT_MS=15000
API_FOOTBALL_MAX_RETRIES=2

JWT_SECRET=<64+ random chars>  # node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
JWT_EXPIRES_IN=8h
COOKIE_NAME=fp_token
COOKIE_SECURE=1
COOKIE_SAMESITE=strict
BCRYPT_ROUNDS=12
LOGIN_MAX_ATTEMPTS=5
LOGIN_LOCK_MINUTES=15

ADMIN_USERNAME=admin
ADMIN_EMAIL=admin@yourdomain.com
ADMIN_PASSWORD=ChangeMe-Immediately-123

CORS_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX=600
AUTH_RATE_LIMIT_MAX=10
ADMIN_RATE_LIMIT_MAX=120
GENERATE_RATE_LIMIT_MAX=10

ENABLE_INTERNAL_SCHEDULER=0    # keep 0 on cPanel; use cron (step 6)
ODDS_FRESHNESS_MINUTES=90
MIN_TOTAL_ODDS=2.00
MAX_TOTAL_ODDS=4.00
MIN_CONFIDENCE=72
MAX_RISK=35
MIN_DATA_QUALITY=60
MAX_SELECTIONS=6

LOG_LEVEL=info
LOG_FILE=                      # optional: /home/USER/goalpredict/logs/app.log
REQUEST_LOGGING=1
```

`config.validate()` runs at boot: in production the process refuses to start when `JWT_SECRET`
or the database credentials are missing, so a bad `.env` fails loudly instead of silently.

---

## 5. Seed settings and the first administrator

```bash
cd /home/USER/goalpredict
npm run db:seed
```

This writes all 51 default settings (locked ones included) and creates the administrator from
`ADMIN_USERNAME` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` with `must_change_password = 1`. Log in at
`https://yourdomain.com/login.html`, change the password immediately, and remove
`ADMIN_PASSWORD` from the environment afterwards.

---

## 6. Cron jobs (background sync only)

cPanel → **Cron Jobs**. Find the Node binary for your selected version with
`which node` in Terminal (commonly `/usr/local/bin/node` or `/opt/cpanel/ea-nodejs20/bin/node`).

Create a log directory first: `mkdir -p /home/USER/goalpredict/logs`.

| Schedule | Command |
| --- | --- |
| `0 * * * *` | `cd /home/USER/goalpredict && /usr/local/bin/node scripts/cron-sync-fixtures.js >> logs/cron.log 2>&1` |
| `*/20 * * * *` | `cd /home/USER/goalpredict && /usr/local/bin/node scripts/cron-sync-odds.js >> logs/cron.log 2>&1` |
| `*/30 * * * *` | `cd /home/USER/goalpredict && /usr/local/bin/node scripts/cron-sync-results.js >> logs/cron.log 2>&1` |
| `*/15 * * * *` | `cd /home/USER/goalpredict && /usr/local/bin/node scripts/cron-health-check.js >> logs/cron.log 2>&1` |

Notes:

* Each cron script sets `CRON_CONTEXT=1`, and the ticket service refuses to generate in that
  context. **A cron job cannot create or publish a ticket** — this is enforced in code and
  covered by tests.
* If your host allows only one cron entry, use `scripts/cron-sync-all.js` hourly.
* Keep the total request rate inside your API-Football quota; the scripts log endpoint calls per
  run, and the admin **API Status** view shows quota usage.
* `cron-health-check.js` exits non-zero when the database or the data source is down, so the
  cron email acts as an alert.
* **Never** schedule `scripts/generate-ticket-cli.js`. Tickets are generated by a human being:
  the CLI requires `--admin=<username> --confirm` and refuses to run under cron.

---

## 7. Start and verify

1. In **Setup Node.js App**, click **Restart** (or **Stop**/**Start**).
2. Check the app's stderr/stdout log in the panel for:

   ```
   server listening  {"market":"Over 1.5 Goals ONLY","oddsWindow":"2.00-4.00","ticketGeneration":"MANUAL ONLY"}
   database connection ok
   ```

3. Verify from a browser:

   | URL | Expected |
   | --- | --- |
   | `https://yourdomain.com/api/health` | `{"ok":true,"data":{"status":"ok","database":"ok","dataSource":{"configured":true,…}}}` |
   | `https://yourdomain.com/api/meta` | site name, `market.key = over_1_5`, `oddsWindow {min:2,max:4}`, `autoTicketGeneration:false` |
   | `https://yourdomain.com/` | homepage renders, dark navy theme, no console errors |
   | `https://yourdomain.com/login.html` | admin sign-in works |

4. Warm the data: admin console → **API Status** → *Sync fixtures*, then *Sync odds*
   (or wait for cron). Check **Fixtures** and **Odds** show rows with a green "verified Xm ago"
   chip.
5. Click **GENERATE TODAY'S TICKET**. The progress panel walks through the steps and ends with
   either a published ticket (total odds inside 2.00–4.00) or **NO QUALIFYING TICKET** with its
   diagnostics. Both are correct outcomes; the second one simply means the day's verified data
   did not support a ticket.
6. Confirm the public pages (`/`, `/ticket.html`, `/history.html`, `/analytics.html`,
   `/predictions.html`) show the same server-computed values.

---

## 8. SSL and cookies

* Enable **AutoSSL** (or upload a certificate) for the domain.
* With `COOKIE_SECURE=1` the admin session cookie is only sent over HTTPS. If you must test on
  plain HTTP, set it to `0` temporarily — never in production.
* `COOKIE_SAMESITE=strict` plus the double-submit CSRF token protect every mutation.
* `CORS_ORIGINS` must list your real origins; the API is same-origin for the bundled frontend,
  so a restrictive list is safe.

---

## 9. Updates

```bash
cd /home/USER/goalpredict
git pull                        # or upload the changed files
npm ci --omit=dev               # only when package.json changed
npm run db:migrate              # idempotent — safe after every deploy
npm test                        # optional but cheap: 95 tests, no DB needed
node scripts/check-no-secrets.js
```

Then restart the application in **Setup Node.js App**. Settings live in the database, so
threshold changes made in the admin console survive deploys; locked settings are re-pinned from
code on every read.

---

## 10. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| cPanel shows "Application Error" on start | Look at the app's log. Usually a missing env var (`config.validate()` refuses to boot in production) or a Node version below 18.17 |
| `/api/health` returns `503` with `database: "unavailable"` | `DB_HOST/DB_USER/DB_PASSWORD/DB_NAME` are wrong, or the user was not added to the database with ALL PRIVILEGES |
| `dataSource.configured: false` | `API_FOOTBALL_KEY` is missing or was pasted with surrounding quotes/spaces |
| `dataSource.state: "OPEN"` | the circuit breaker opened after repeated upstream failures; it half-opens automatically after the cooldown. Check quota/plan and `logs/cron.log` |
| Generation ends `DATA_SOURCE_UNAVAILABLE` | by design when the API is unreachable — no ticket is fabricated. Re-run once the API Status panel shows `OK` |
| Every day is `NO QUALIFYING TICKET` | inspect the diagnostics: usually odds are stale (`ODDS_FRESHNESS_MINUTES` too tight for your sync frequency), the league list is too small (`sync_leagues`), or form data has not accumulated yet — the engine needs at least `min_form_matches` real matches per team |
| Times look shifted | the engine works in UTC day boundaries; kickoff display uses the visitor timezone (`display_timezone = auto`) |
| `429` responses | rate limits; raise `RATE_LIMIT_MAX` / `ADMIN_RATE_LIMIT_MAX` only if the traffic is genuinely yours |
| Cron produces no log output | wrong `node` path or a missing `logs/` directory; run the command once by hand in Terminal |
| Static assets 404 after upload | the app serves `public/` itself; make sure `public/` is inside the Application root and that no `.htaccess` in `public_html` rewrites the domain away from the Node app |

---

## 11. Pre-launch checklist

- [ ] Node.js 18.17+ selected, startup file `server.js`, mode `Production`
- [ ] Schema imported (17 tables), `npm run db:seed` completed
- [ ] `.env` filled in, `JWT_SECRET` unique and 64+ characters, `.env` **not** in git
- [ ] `ADMIN_PASSWORD` changed after first login and removed from the environment
- [ ] SSL active, `COOKIE_SECURE=1`, `TRUST_PROXY=1`, `CORS_ORIGINS` set to the real domain(s)
- [ ] Cron entries added for fixtures, odds, results and health — and **no** cron entry for
      ticket generation
- [ ] `ENABLE_INTERNAL_SCHEDULER=0` (cron does the work)
- [ ] `/api/health` reports `status: ok`
- [ ] One manual generation completed and reviewed (ticket **or** NO QUALIFYING TICKET)
- [ ] `node scripts/check-no-secrets.js` reports no secrets in `public/`
