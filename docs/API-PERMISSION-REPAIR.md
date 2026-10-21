# API Management permission diagnostic repair

## Findings and verification boundary

**A code defect is reproduced and repaired locally; production is not yet verified.**
No production database or hosting session was available for this investigation.
No provider requests, ticket generation, publication, credential saves, migrations,
or production data changes were performed.

The old `inspectPermissions()` split grant scopes on `.` and removed backticks,
but did not decode escaped database-level grant literals. Given:

```sql
GRANT ALL PRIVILEGES ON `account\_goalpredict`.* TO 'app'@'localhost'
```

and `DATABASE() = account_goalpredict`, it discarded the matching grant and
returned `checked: true`, `select/insert/update: false`. This produces the exact
“cannot SELECT and cannot INSERT/UPDATE” message even while the credential SELECT
succeeds. cPanel database prefixes containing underscores are a relevant case.
The six new endpoint regressions all fail against the original implementation.
This is a proven code cause of that symptom, **not proof of the live grant format**.

The parser now handles escaped literal underscores/percent signs, quoted dots,
quoted backticks, global grants and exact credential-table grants. Roles, column
grants, partial revokes, unrecognized grant rows and ambiguous wildcard scopes
produce `PERMISSIONS_UNVERIFIED`, never a fabricated denial or success. In that
state `canSave` is null, not true. A valid SELECT-only grant still denies writes.
Raw grants, account names and database names are not added to the browser response.
No write probes or privilege grants are introduced.

## Actual configuration and connection path

* `server/config/index.js` loads the application-root `.env` using dotenv without
  override. Existing Passenger/cPanel process environment values take precedence.
  It snapshots DB_HOST (default localhost), DB_PORT (3306), DB_USER (root),
  DB_PASSWORD (empty), and DB_NAME (football_predictions) when first required.
  Do not infer the running account from cPanel's database-user listing.
* `server/database/connection.js` lazily creates one mysql2 pool from that snapshot.
  `query` uses prepared `execute`; `queryOne`, repository operations and transactions
  all use that pool. A pool error is mapped to an application error.
* `server/database/queries.js` imports that same connection module. Credential
  listing uses `SELECT * FROM api_credentials`; saving uses INSERT ... ON DUPLICATE
  KEY UPDATE with encrypted values. The diagnostic imports the same module and
  calls the same repository listing. There is no separate diagnostic DB setting.
* The pool and configuration remain cached for the lifetime of each Passenger
  process. Editing `.env`, cPanel environment values or uploading code does not
  reconfigure a running process. Restart all app workers through cPanel. Merely
  closing a pool would not reload the cached configuration.
* `scripts/db-migrate.js` loads the same config module but opens a **separate**
  connection in its own process. Different inherited environment can target a
  different DB. It reapplies the baseline, then `server/database/migrate.js`
  applies pending SQL files and records filename/checksum in `schema_migrations`.
* Migration 003 creates `api_credentials` and `api_connection_events` with
  `IF NOT EXISTS`, referencing baseline `admins`. It does not modify existing rows
  or fix missing columns in an already-existing table. Do not edit migration 003
  or drop/recreate a credential table to fix column drift.

## What the read-only diagnostic proves (and does not)

Schema inspection filters INFORMATION_SCHEMA.COLUMNS by `TABLE_SCHEMA = DATABASE()`
and checks the required columns for both migration-003 tables. If that metadata
query errors, it tries `SELECT <required columns> ... LIMIT 0`. Credential and
history reads use unqualified tables on the pool's default database. There is no
hard-coded alternate diagnostic database.

Missing-table/column driver errors map to SCHEMA_OUT_OF_DATE; table/database access
errors map to PERMISSION_DENIED; SQL syntax and other errors remain query failures.
Unavailable SHOW GRANTS already produced unknown; the repair also makes unsupported
**successful** grant responses unknown. Connection authentication errors wrapped
by the connection module are DB_UNAVAILABLE, not evidence of missing table grants.

`schema.migration.applied` currently means the expected schema is present, **not**
a verified `schema_migrations` ledger record. A phpMyAdmin import may create the
schema without recording the migration. Conversely, a ledger record alone does
not prove the tables/columns still exist. Metadata visibility can also be restricted:
if the panel reports missing objects but phpMyAdmin shows them, ask the host to
verify table/column access using the application's actual MySQL account, not the
phpMyAdmin account. Do not repeatedly import DDL based only on that discrepancy.

A grant-derived `canSave: true` establishes the checked prerequisites, not a
successful write or end-to-end provider test. CONFIG_INCOMPLETE describes provider
host/key configuration, independently of DB privileges. AES-256-GCM ready proves
key availability, not DB write permission. Neither is changed by this repair.

## cPanel-only deployment and verification — no Terminal or SSH

1. In **Setup Node.js App**, identify the existing application's root and startup
   file (`server.js`). Record the current settings privately. In **File Manager**,
   enable hidden files and back up the app, including `.env` and any storage key.
   In **phpMyAdmin**, export the selected production database. Keep backups private,
   outside the web root. Never paste secrets into a support ticket or chat.
2. The minimal runtime patch consists of:
   * `server/services/credentialStorageService.js` (replace)
   * `server/database/credentialGrants.js` (new)
   Upload these into that exact application root with File Manager. Alternatively
   use the rebuilt `GoalPredict-cPanel-deployment.zip`, extracting to a staging
   directory first and copying the release files without deleting existing data.
   Preserve `.env`, `storage/`, encryption key files, uploads and other runtime data.
   This patch adds no dependencies and requires no npm install or migration.
3. Privately compare **Setup Node.js App → Environment Variables** DB_HOST, DB_PORT,
   DB_NAME and DB_USER against the intended cPanel database/user association,
   including cPanel prefixes. Compare the app-root `.env` too; process environment
   wins. Do not change DB_PASSWORD or encryption settings speculatively. The MySQL
   Databases ALL PRIVILEGES checkbox is not evidence of the running app identity.
4. Click **Save** if settings changed, then **Restart** for the Node.js application.
   If no restart control is provided, ask hosting support to restart all Passenger
   workers for that app root. A browser refresh alone is insufficient.
5. Sign in as administrator and refresh **API Management**, then open the read-only
   `/api/admin/api-management/storage-diagnostics` endpoint on the same site.
   Record only state, timestamps, booleans, safe error codes, and missing-object
   names. Do not share cookies, request headers, credential fields or full grants.
6. For the reproduced escaped-grant case, expect schema ready, readable credentials,
   SELECT/INSERT/UPDATE true and (with the reported healthy encryption/history)
   READY. If unknown, do not treat it as denial or bypass the check. If still denied,
   follow the hosting evidence checklist below. No ticket/sync/generate button is
   part of verification. A READY report verifies diagnostic prerequisites only;
   it does not verify an actual credential write. Do not rotate/save credentials
   solely as a diagnostic probe during this repair.
7. Only if missing schema is independently confirmed in the runtime database:
   select that exact database in **phpMyAdmin** and check **Structure** for both
   tables and their columns against migration 003 / REQUIRED_SCHEMA. If a table is
   absent, after backup paste the unmodified migration 003 into **SQL → Go**.
   Do not import the baseline or seed data for this repair. If an existing table
   lacks columns, stop and have a reviewed additive migration prepared instead.
   Do not invent a migration checksum or overwrite an existing ledger record.
   Re-run the read-only diagnostic afterward.
8. Leave encryption keys unchanged. Resolve any remaining provider CONFIG_INCOMPLETE
   separately in the normal private admin/provider configuration workflow; this
   patch neither creates credentials nor fabricates a provider response.

Rollback: restore the previous runtime files (or previous app backup), then restart
through cPanel. No database rollback is required by this code-only patch.

## Evidence to request from hosting support if the issue persists

Provide the app root/domain, release time, Passenger restart time, diagnostic state,
safe driver code and schema/read/permission booleans. Ask the provider to check:

* The effective DB_HOST/DB_PORT/DB_NAME/DB_USER of **every running Passenger worker**,
  environment precedence and worker start times. No password/key values in replies.
* Via the **application pool/account**, privately compare `DATABASE()`, `USER()`
  (login identity), `CURRENT_USER()` (matched privilege account), `@@hostname` and
  `VERSION()` with the intended database server/account. A phpMyAdmin session uses
  its own account and cannot establish the app's matched identity.
* Inspect SHOW GRANTS privately for escaped database scope, account host matching,
  roles/active roles, partial revokes and any column-level grants. Return only a
  confirmation of effective SELECT/INSERT/UPDATE on api_credentials, not grant
  statements or authentication hashes. No global ALL PRIVILEGES grants are needed.
* Confirm required columns in both migration-003 tables on that same server/schema;
  inspect the `003-api-credential-management.sql` ledger entry if the ledger exists.
  Report schema presence and ledger presence separately. Check SELECT on history
  tables separately from credential writes.
* If SQL fails, return only driver code/errno/SQLSTATE and the operation category,
  not SQL containing values, environment dumps, headers or credentials.

Support can perform these internal checks without asking you to use a shell or
installing a public diagnostic script. Until runtime identity, schema and effective
privileges are confirmed, the production root cause remains unverified.

## Local validation and changed files

* Original code with new endpoint regressions: **6 failed / 6**, reproducing the bug.
* Repaired full suite: **407 passed / 407** (including authentication, encrypted
  credentials, API management, schema drift, migrations, UI and prediction rules).
* `npm run test:sql`: **20 tables, 104 statements, zero warnings**.
* `npm run lint:secrets`: **33 public files scanned, no secrets found**.
* The deployment archive is rebuilt and tested against the tracked source.
  These are fixtures/unit/integration tests, not a live MySQL or production test.

Changed files: `server/services/credentialStorageService.js` (delegates grant
interpretation); new `server/database/credentialGrants.js` (conservative parser);
`tests/fakeDb.js` (configurable database and multi-row grants);
`tests/credential-storage.test.js` (endpoint regressions);
new `tests/credential-grants.test.js` (scope tests); this runbook; and
`GoalPredict-cPanel-deployment.zip` (updated upload artifact).
