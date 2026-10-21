# Deploying GoalPredict on cPanel

> **Primary deployment path:** [cPanel without SSH/Terminal](../CPANEL-START-HERE.md).
> Follow that guide for panel-managed dependency installation and deployment.
> The command-line examples retained below are optional developer/hosting-support
> reference, not steps required from a cPanel-only operator. Never run fresh-install
> seed/setup instructions against an existing production database during this repair.

Target: a standard cPanel account with **Setup Node.js App**, **MySQL Databases**, **phpMyAdmin**,
**Run NPM Install** and restart controls. SSH/Terminal is not required. No root access, no Docker, no frontend build step.

| Requirement | Value |
| --- | --- |
| Node.js | 18.17 or newer (20 LTS recommended) — select it in "Setup Node.js App" |
| MySQL / MariaDB | MySQL 5.7+ / MariaDB 10.3+ |
| API-Football | **Pro** plan (the `/odds` endpoint is required) |
| Disk | ~120 MB for the app + `node_modules` |
| Startup file | `server.js` |
| Domain | your domain or subdomain, with SSL enabled |

---

## 0. Get the package

`GoalPredict-cPanel-deployment.zip` (in the repository root) is the upload package. It is built
from the tracked source with `npm run build:zip`, and `tests/deployment-zip.test.js` fails the
suite if the committed archive is not the build of the committed tree — so the ZIP you upload is
always the reviewed code. `node scripts/build-deployment-zip.js --check` verifies it without
running the tests.

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
   npm run db:migrate        # baseline schema + every pending versioned migration (applied once each)
   ```

   **phpMyAdmin**

   Open the database → **Import** → choose `server/database/schema.sql` → Go.
   20 tables are created (`users`, `admins`, `leagues`, `teams`, `fixtures`, `bookmakers`,
   `odds`, `predictions`, `prediction_scores`, `tickets`, `ticket_selections`, `results`,
   `team_form`, `settings`, `api_sync_logs`, `generation_logs`, `system_logs`,
   `api_credentials`, `api_connection_events`).

   `api_credentials` holds the admin-managed API key (AES-256-GCM **ciphertext** only —
   see section 9c) and `api_connection_events` the connection/error history shown on the
   API Management screen. A live database that was created before this feature simply runs
   migration `003-api-credential-management.sql` (section 9c) — nothing existing is touched.

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

# One-time key for the admin API Management screen (section 9c). AES-256-GCM
# encryption of API credentials at rest. 64 hex characters.
# Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
API_CREDENTIALS_ENCRYPTION_KEY=<64 hex characters>
API_CREDENTIALS_TEST_TIMEOUT_MS=15000
API_CREDENTIALS_TEST_MIN_INTERVAL_MS=3000
API_CREDENTIALS_TEST_REUSE_MS=60000

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
CONFIDENCE_MODE=auto
MIN_CONFIDENCE=30
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
`https://yourdomain.com/admin/login`, change the password immediately, and remove
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
   | `https://yourdomain.com/admin/login` | admin sign-in works |

4. Prove the data source in one command before generating anything (it spends **one** request, on
   the free `/status` endpoint, and prints the verdict with the fix):

   ```bash
   npm run api:check
   ```

   `Verdict  CONNECTED` means the key, the host and the daily budget are all fine. Any other verdict
   (`INVALID_KEY`, `QUOTA_EXCEEDED`, `RATE_LIMITED`, `NETWORK_ERROR`, `CONFIG_INCOMPLETE`, …) names
   the cause and the cPanel screen that fixes it. The same information is on the API Status panel
   and in `/api/health` under `dataSource.reason`.
5. Warm the data: admin console → **API Status** → *Sync fixtures*, then *Sync odds*
   (or wait for cron). Check **Fixtures** and **Odds** show rows with a green "verified Xm ago"
   chip. A row may also read `SKIPPED` with `REQUEST BUDGET RESERVED`: that is the reserve keeping
   the last `api_quota_reserve` requests for the manual generation, not a failure.
6. Click **GENERATE TODAY'S TICKET**. The progress panel walks through the steps and ends with
   either a published ticket (total odds inside 2.00–4.00) or **NO QUALIFYING TICKET** with its
   diagnostics. Both are correct outcomes; the second one simply means the day's verified data
   did not support a ticket.
7. Confirm the access boundary. Signed out, every football URL must answer `401` with the
   "login required" page and every football API must answer `401` with an empty body:

   ```bash
   for u in /predictions /ticket /today-ticket /history /analytics \
            /api/predictions /api/ticket/today /api/tickets/history /api/analytics \
            /api/fixtures /api/odds; do
     printf '%-32s %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' https://yourdomain.com$u)"
   done
   ```

   Every line must read `401`. Then sign in and confirm the same URLs answer `200`.
   `node scripts/verify-access.js https://yourdomain.com --member=user:pw` automates the whole
   matrix (guest + member + admin) and exits non-zero on any failure, so it can gate a deploy
   or run from cron.

   `/`, `/about`, `/legal`, `/login`, `/account`, `/api/health` and `/api/meta` stay public.

---

## 8. SSL and cookies

* Enable **AutoSSL** (or upload a certificate) for the domain.
* With `COOKIE_SECURE=1` the admin session cookie is only sent over HTTPS. If you must test on
  plain HTTP, set it to `0` temporarily — never in production.
* `COOKIE_SAMESITE=strict` plus the double-submit CSRF token protect every mutation.
* `CORS_ORIGINS` must list your real origins; the API is same-origin for the bundled frontend,
  so a restrictive list is safe.

---

## 9. Updates (File Manager + phpMyAdmin — no Terminal needed)

1. **File Manager** → open the **Application root** (e.g. `/home/USER/goalpredict`) →
   **Upload** `GoalPredict-cPanel-deployment.zip` → right-click → **Extract** → overwrite.
   The archive stores its files at the top level, so it unpacks straight into the app root.
   `.env` is deliberately **not** in the archive — your live settings survive.
2. **Setup Node.js App** → your app → **Run NPM Install** — only needed when `package.json`
   changed. All ten dependencies are pure JavaScript, so nothing is compiled.
3. **Apply any pending database migration in phpMyAdmin** (section 9b). Without a Terminal,
   `npm run db:migrate` cannot run — the SQL files in `server/database/migrations/` are plain
   text you paste into the phpMyAdmin **SQL** tab.
4. **Setup Node.js App** → **Restart**.

> **The Node application never migrates the database by itself.** `server.js` only pings MySQL
> on boot. The Docker development stack is the one exception — its start command runs
> `npm run db:setup` — so a database that works locally can still be behind on the host.
> **Every deploy that ships a new migration needs step 3.**

---

## 9b. "Internal server error" on /admin/users — fix it from the browser and phpMyAdmin

The admin **Users** page renders (its guard only reads the `admins` table) while every user
request fails, because `users.status`, `users.full_name`, the approval columns and the
`user_audit_logs` table do not exist yet. Nothing below needs a Terminal.

### A. Read the cause in ten seconds (browser, works on the code that is live now)

Sign in at `/admin/login`, then open:

```
https://yourdomain.com/api/admin/users/summary
```

The JSON `code` is **never** hidden, only the `message` is:

| `error.code` you see | Meaning |
| --- | --- |
| `SQL_ER_BAD_FIELD_ERROR` | a **column** is missing → migration `002` was never applied. Go to B |
| `SQL_ER_NO_SUCH_TABLE` | a **table** is missing (`user_audit_logs`) → same fix |
| `DB_UNAVAILABLE` | MySQL credentials/host — section 10 |
| `{"ok":true,...}` with counters | the schema is fine; the fault is elsewhere |

From the code in this release the same request answers `SCHEMA_OUT_OF_DATE` with a message that
says what to run, and the server log names the exact missing column:

```json
{"level":"error","message":"database schema is out of date",
 "meta":{"code":"ER_BAD_FIELD_ERROR","errno":1054,"missing":"column: status",
         "message":"Unknown column 'status' in 'field list'"}}
```

### B. Confirm read-only in phpMyAdmin (SQL tab — nothing here writes)

cPanel → **phpMyAdmin** → your database → **SQL** tab:

```sql
-- has any migration ever been recorded?
SHOW TABLES LIKE 'schema_migrations';
SELECT filename, applied_at FROM schema_migrations ORDER BY filename;
--   table missing, or 002 not listed  => migration 002 NOT applied

-- does the audit table exist?
SHOW TABLES LIKE 'user_audit_logs';

-- the six approval columns (expect 6 rows once 002 is applied)
SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
   AND COLUMN_NAME IN ('full_name','status','approved_at',
                       'approved_by_admin_id','status_reason','status_changed_at')
 ORDER BY COLUMN_NAME;
```

### C. Back the database up (cPanel UI)

* **cPanel → Backups → Download a MySQL Database Backup** — pick the GoalPredict database, or
* **phpMyAdmin → the database → Export → Go** (Format: SQL, "Structure and data").

Save the file to your own computer. Never leave a dump inside `public_html/`.

### D. Apply migration 002 in phpMyAdmin

Open `server/database/migrations/002-user-approval-system.sql` (File Manager → View, or the
copy in the deployment ZIP), select **all** of it, paste it into the **SQL** tab of your
database and press **Go**. It runs five statements:

1. one `ALTER TABLE users` adding the six columns + index + the foreign key to `admins`
   (a single `ALTER` is all-or-nothing, so it cannot leave a half-added column),
2. two `UPDATE`s that grandfather existing accounts — active → `approved`,
   inactive → `suspended` (**no row is ever deleted**),
3. `CREATE TABLE IF NOT EXISTS user_audit_logs`.

If step B showed that *some* columns already exist, paste only the missing ones instead —
e.g. for `status` alone:

```sql
ALTER TABLE `users` ADD COLUMN `status` ENUM('pending','approved','rejected','suspended')
  NOT NULL DEFAULT 'pending' AFTER `is_active`;
```

> Re-importing `schema.sql` does **not** fix this: `users` already exists and
> `CREATE TABLE IF NOT EXISTS` leaves an existing table untouched. Only the migration alters it.

### E. Record it so it is never applied twice

```sql
CREATE TABLE IF NOT EXISTS `schema_migrations` (
  `filename`   VARCHAR(255) NOT NULL,
  `checksum`   CHAR(64)     NOT NULL,
  `applied_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`filename`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `schema_migrations` (`filename`, `checksum`) VALUES
  ('002-user-approval-system.sql', '9af1c29812e9ff537021064753499bf4e41a6556475b486ea9abb8f706a1f4f1');
```

That checksum is the SHA-256 of the migration file as shipped in this release; step B now reads
`002 … applied`, and any future runner sees it as done.

### F. Restart and verify

**Setup Node.js App → Restart**, then:

* `https://yourdomain.com/api/admin/users/summary` → `{"ok":true,"data":{"total":…,"pending":…}}`
* `/admin/users` → the five counters, the user table, and the audit history of any user opened
  with **View**.

```sql
-- optional read-only confirmation
SELECT status, COUNT(*) FROM users GROUP BY status;
SELECT COUNT(*) FROM user_audit_logs;
```

### G. Check migration 001 at the same time (silent odds rounding)

`001-widen-odds-precision.sql` widens three price columns to `DECIMAL(12,6)`. Without it, any
bookmaker price with more than three decimals is **silently rounded on write** and the odds
re-validation can reject a real price:

```sql
SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND ((TABLE_NAME IN ('odds','ticket_selections') AND COLUMN_NAME = 'odd_decimal')
        OR (TABLE_NAME = 'predictions' AND COLUMN_NAME = 'selected_odds'));
-- decimal(12,6) => already correct.  decimal(8,3) => paste 001 into the SQL tab, then record
-- it in schema_migrations the same way as step E.
```

### H. Reading the application log without a Terminal

**File Manager** → home folder → `logs/` (written only when `LOG_FILE` is set in the app
environment), or the stderr file named in **Setup Node.js App**; also **Metrics → Errors** for
the domain error log. Open the file in File Manager and search for `database schema is out of
date` or `SQL error`.

---

## 9c. API Management — admin-managed API key + `API_CREDENTIALS_ENCRYPTION_KEY` (no Terminal needed)

The admin console's **API Management** page (sidebar → *System* / *API Management*, URL
`/admin#api-management`) lets an administrator enter, test, save, activate and disable the
API-Football key **without editing `.env` or any source file**.

### One-time: set the encryption key

Credentials are stored **encrypted at rest** with AES-256-GCM. The encryption key lives only in
the server environment:

1. Generate a value (locally, or in cPanel → **Terminal** if you have it):

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

2. cPanel → **Setup Node.js App** → your application → **Environment Variables** → add
   `API_CREDENTIALS_ENCRYPTION_KEY` = the 64 hex characters you generated (or add the same line
   to `.env` with File Manager → **Edit**).
3. **Restart** the application.

**Optional:** you can skip the steps above. When `API_CREDENTIALS_ENCRYPTION_KEY` is not set, the
server uses a key file with permissions `0600`, created only on the first save from
**Admin → API Management**:

1. an **existing** `storage/api-credentials.key` is always used first. Credentials saved by an
   earlier release therefore keep decrypting after this upgrade — nothing is regenerated;
2. otherwise the server creates a key file **outside** the application folder (normally
   `~/.goalpredict/api-credentials.key`, derived from the application root so Passenger and cron
   agree), so re-uploading the deployment ZIP or cleaning the folder cannot remove it;
3. `API_CREDENTIALS_KEY_FILE` overrides both. A relative value resolves against the application
   root, never the process working directory (Passenger and cron differ).

Keep the key file with your database backups; deleting it makes saved keys unreadable (re-enter
them). Set `API_CREDENTIALS_AUTO_KEY=0` to require the environment variable and forbid automatic
key-file creation. **Never replace a working key** — see
[API credential storage on cPanel](API-CREDENTIAL-STORAGE.md) for the optional, reversible
migration to the outside-folder location.

### Read the storage diagnosis before changing anything

Open **Admin → API Management** and read the **Credential storage — admin-only read-only check**
panel, or open this URL while signed in as an administrator:

```
https://yourdomain.com/api/admin/api-management/storage-diagnostics
```

It separates: database unreachable, missing migration 003, missing database grants, unusable
encryption key, credential-table read failure and a broken diagnostics history. It runs
`SELECT`/`SHOW` only, writes nothing and never returns a key, password, cookie or grant text.
A successful **Test Connection** is about the provider; it is **not** proof that a credential can
be stored.

If neither is possible (for example the folder is read-only) the platform **fails safely**: *Save configuration* answers
`503 ENCRYPTION_KEY_MISSING` with the exact variable name, and **nothing is written** — a key is
never stored unencrypted. `npm run doctor` reports the same state.

> Keep this value: it is the only thing that can decrypt a saved credential. If you change or
> lose it, re-enter the API key on the API Management screen (`500 CREDENTIAL_UNREADABLE` is
> exactly that situation).

### One-time: create the credential tables on an existing database

A fresh install gets the tables from `schema.sql`. A **live database created before this feature**
needs migration `003-api-credential-management.sql`. No Terminal required:

1. **Back up first**: phpMyAdmin → your database → **Export** → Go (format SQL).
2. phpMyAdmin → your database → **SQL** tab → paste the whole content of
   `server/database/migrations/003-api-credential-management.sql` → **Go**. It only creates two
   new tables (`api_credentials`, `api_connection_events`) — no existing table, row or column is
   touched, so the current setup keeps working.
3. Record it so the runner does not try to apply it twice. In the same **SQL** tab, run (replace
   `<SHA256_OF_THE_FILE>` with the checksum printed by
   `node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('server/database/migrations/003-api-credential-management.sql','utf8')).digest('hex'))"`
   — or simply skip this step when you always deploy with the versioned migration runner in Terminal):

   ```sql
   INSERT INTO `schema_migrations` (filename, checksum)
   VALUES ('003-api-credential-management.sql', '<SHA256_OF_THE_FILE>')
   ON DUPLICATE KEY UPDATE checksum = VALUES(checksum);
   ```

   (If `schema_migrations` does not exist yet, create it with the DDL in section 9b step C first.)
4. Alternatively — with Terminal access — the versioned migration runner applies every pending
   migration in one go (see section 2, `db:migrate`).

### Using the screen

1. Open `/admin#api-management`, pick **API-Football (Pro)** and one of the approved hosts
   (`v3.football.api-sports.io` is the official direct host; the RapidAPI host is also approved).
2. Paste the key → **Save configuration**. The response shows only the masked form
   (`********abcd`); the key is encrypted immediately and never returned by any endpoint.
3. **Test connection** — one real request to the provider's `/status` endpoint, reported honestly
   as *Connection successful*, *Invalid API key or unauthorized*, *Daily quota exceeded*,
   *Rate limit exceeded*, *Network failure*, *Request timed out*, *Provider unavailable* or
   *Configuration incomplete*. Testing never creates, publishes or replaces a prediction ticket.
4. **Activate provider** — from then on the server uses the saved credential. Until you activate
   it, the existing `API_FOOTBALL_KEY` environment configuration stays in force.
5. **Disconnect / disable provider** — the server falls back to the environment configuration;
   the stored key stays encrypted for re-activation.
6. **Refresh API status** — re-reads the status and (when a usable credential exists) performs one
   cached `/status` probe for the daily quota. Quota is only ever shown when the provider really
   reported it.

---

## 10. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| cPanel shows "Application Error" on start | Look at the app's log. Usually a missing env var (`config.validate()` refuses to boot in production) or a Node version below 18.17 |
| `/admin/users` answers **Internal server error** / "Could Not Load Users" while the page itself loads | the live database is older than the code — migration `002-user-approval-system.sql` is missing. Read `error.code` at `/api/admin/users/summary`, confirm read-only in phpMyAdmin, back the database up, then paste `002-user-approval-system.sql` into the SQL tab. No Terminal needed — section 9b |
| `/api/health` returns `503` with `database: "unavailable"` | `DB_HOST/DB_USER/DB_PASSWORD/DB_NAME` are wrong, or the user was not added to the database with ALL PRIVILEGES |
| `dataSource.configured: false` | no usable credential is active. Configure an environment key or save/activate one in API Management. The app can boot without an environment API key |
| API Management: *Save configuration* answers `503 ENCRYPTION_KEY_MISSING` | `API_CREDENTIALS_ENCRYPTION_KEY` is not set and no usable key file exists or can be created (see section 9c). Nothing was written — the key is never stored unencrypted. Open the storage diagnostic for the exact state (`PENDING`, `KEY_FILE_INVALID`, `KEY_FILE_UNREADABLE`, `KEY_FILE_UNWRITABLE`) |
| API Management says *Credential storage is unavailable* | open the read-only storage panel / `/api/admin/api-management/storage-diagnostics`. `DATABASE_UNREACHABLE` → fix DB_*; `SCHEMA_OUT_OF_DATE` → apply migration 003; `PERMISSION_DENIED` → grant SELECT/INSERT/UPDATE; `ENCRYPTION_NOT_READY` → section 9c; `HISTORY_DEGRADED` → only event/sync history is unavailable and saving still works |
| Storage diagnostic shows `KEY_FILE_IN_APPLICATION_FOLDER` | optional: migrate the key outside the application folder with the reversible procedure in [API credential storage on cPanel](API-CREDENTIAL-STORAGE.md). Do not move or regenerate it without verifying a saved credential first |
| API Management: `500 CREDENTIAL_UNREADABLE` / *cannot be decrypted* | the encryption key changed (or `.env` was restored from another machine) after the credential was saved. Re-enter and save the API key on the API Management screen |
| API Management shows a raw `SCHEMA_OUT_OF_DATE` | migration `003-api-credential-management.sql` was not applied to the live database — see section 9c. The site keeps working with the environment credential meanwhile |
| `dataSource.state: "OPEN"` | the circuit breaker opened after repeated upstream failures; it half-opens automatically after the cooldown. Check quota/plan and `logs/cron.log` |
| Every job says `DATA SOURCE TEMPORARILY UNAVAILABLE` and API Status shows `QUOTA_EXHAUSTED` | the plan's daily request budget is spent (Free = 100/day). The message and `error_detail` now say so, and the client stops calling the provider until 00:00 UTC instead of retrying. Fix: raise the plan, or lower what a run costs — `sync_history_days`, `sync_days_ahead`, `history_refresh_minutes` (a history day that is still fresh is not requested again), `h2h_sync_max_calls` — and space the cron entries out |
| Sync rows show `SKIPPED` / `REQUEST BUDGET RESERVED` | **not a failure**: background sync paused because only `api_quota_reserve` requests were left today, so an administrator can still generate the ticket from the console. Lower `api_quota_reserve` or raise the plan; it resumes by itself after 00:00 UTC |
| A results sync is `SUCCESS` with `results=0 settled=0 tickets=0` while fixtures/odds `FAILED` | nothing was awaiting a result (`checked=0`), so that job made no upstream call at all — the fixtures and odds jobs are the ones that talk to the provider. Read their `error_detail`/reason, or run `npm run api:check` |
| API Status: `AUTH_REJECTED` / "Missing application key" | `API_FOOTBALL_KEY` and `API_FOOTBALL_HOST` do not match (an api-sports.io key needs `v3.football.api-sports.io`), or the key was revoked. Re-run *Test connection* after saving |
| API Status: `RATE_LIMITED` (HTTP 429) | more requests per minute than the plan allows (Free = 10/min). Lower `API_FOOTBALL_RATE_PER_MINUTE` and space the cron entries. Do **not** retry in a loop — API-Football firewalls keys/IPs that keep hammering |
| API Status: `NETWORK_ERROR` / `TIMEOUT` | read the safe transport code and hint (DNS, connection, TLS or timeout). Automatic IPv6/IPv4 fallback is enabled; use `API_FOOTBALL_IP_FAMILY=4` only on confirmed IPv4-only hosting. Check outbound HTTPS/DNS with the host; never disable TLS. See [repair checklist](API-FOOTBALL-REPAIR.md) and `npm run api:check` |
| Generation ends `DATA_SOURCE_UNAVAILABLE` | by design when the API cannot be used — no ticket is fabricated. The stored report and the console now carry the reason (`NO_API_KEY`, `QUOTA_EXCEEDED`, `AUTH_REJECTED`, …), the fix and the reset time; re-run once API Status shows `OK` |
| Every day is `NO QUALIFYING TICKET` | inspect the diagnostics: usually odds are stale (`ODDS_FRESHNESS_MINUTES` too tight for your sync frequency), the league list is too small (`sync_leagues`), or form data has not accumulated yet — the engine needs at least `min_form_matches` real matches per team |
| Times look shifted | the engine works in UTC day boundaries; kickoff display uses the visitor timezone (`display_timezone = auto`) |
| `429` responses | rate limits; raise `RATE_LIMIT_MAX` / `ADMIN_RATE_LIMIT_MAX` only if the traffic is genuinely yours |
| Cron produces no log output | wrong `node` path or a missing `logs/` directory; run the command once by hand in Terminal |
| Anything else — start here | `npm run doctor` (add `--skip-probe` to skip the one free API-Football `/status` probe) and `npm run api:check`. It prints the cause and the exact cPanel screen that fixes it (masked values only), and exits non-zero so it can gate a deploy. `npm run doctor -- --json` for a machine readable report |
| "Is the member area really private on the live site?" | `npm run verify:access -- --member=USER:PW --admin=USER:PW` against the deployed URL. It checks every guest/member/admin boundary with real HTTP requests and exits non-zero on any leak |
| Static assets 404 after upload | the app serves `public/` itself; make sure `public/` is inside the Application root and that no `.htaccess` in `public_html` rewrites the domain away from the Node app |

**Where the reason is written:** every failed job stores the provider's own words in
`api_sync_logs.error_detail`, the reason/hint in the job message, and the daily budget in
`requests_used` / `requests_limit`; the generation report (`generation_logs.report_json`) carries the
same reason for the ticket screen. The admin dashboard reads all three, so the activity panel shows
*why* instead of one sentence for every cause.

> **Regenerating the ZIP is a repository-side job**, not something to do on the host: build it
> where the source lives (`npm run build:zip`) and upload the result.

---

## 11. Pre-launch checklist

- [ ] Node.js 18.17+ selected, startup file `server.js`, mode `Production`
- [ ] Schema imported (20 tables), settings + first administrator seeded
- [ ] `API_CREDENTIALS_ENCRYPTION_KEY` set (64 hex chars) — required before an administrator can save an API key from the dashboard (section 9c)
- [ ] Migration `003-api-credential-management.sql` recorded in `schema_migrations` (section 9c)
- [ ] `.env` filled in, `JWT_SECRET` unique and 64+ characters, `.env` **not** in git
- [ ] `ADMIN_PASSWORD` changed after first login and removed from the environment
- [ ] SSL active, `COOKIE_SECURE=1`, `TRUST_PROXY=1`, `CORS_ORIGINS` set to the real domain(s)
- [ ] Cron entries added for fixtures, odds, results and health — and **no** cron entry for
      ticket generation
- [ ] `ENABLE_INTERNAL_SCHEDULER=0` (cron does the work)
- [ ] `/api/health` reports `status: ok`
- [ ] One manual generation completed and reviewed (ticket **or** NO QUALIFYING TICKET)
- [ ] `node scripts/check-no-secrets.js` reports no secrets in `public/`
