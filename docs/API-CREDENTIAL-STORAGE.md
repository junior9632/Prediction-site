# API credential storage on cPanel — diagnosis, repair and safe key migration

This document covers the **storage** half of Admin → API Management: the database tables, the
encryption key and the read-only diagnostic. Provider connectivity, odds integrity and ticket
rules are covered in [API-FOOTBALL-REPAIR.md](API-FOOTBALL-REPAIR.md).

> **No production deployment is performed by this repository change.** The steps below are for an
> operator on the cPanel account. Nothing here runs a migration, moves a key or changes a live
> database automatically.

---

## 1. Why “Credential storage is unavailable” was not enough

The old screen showed that one sentence for six different failures. Each has a different fix, so
the screen now splits them:

| State | Meaning | Fix |
| --- | --- | --- |
| `READY` | database reachable, both tables and their columns present, encryption usable, credential row readable, history readable | nothing |
| `DATABASE_UNREACHABLE` | `SELECT 1` failed (bad `DB_*`, MySQL down, access denied at connect) | correct `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` in **Setup Node.js App → Environment Variables**, then restart |
| `SCHEMA_OUT_OF_DATE` | `api_credentials` / `api_connection_events` or one of their columns is missing | apply `server/database/migrations/003-api-credential-management.sql` (section 4) |
| `PERMISSION_DENIED` | the database user lacks `SELECT`, `INSERT` or `UPDATE` | cPanel → **MySQL® Databases** → add the user to the database with the required privileges |
| `ENCRYPTION_NOT_READY` | no usable `API_CREDENTIALS_ENCRYPTION_KEY` and no usable key file | section 3; the diagnostic names `PENDING`, `KEY_FILE_INVALID`, `KEY_FILE_UNREADABLE`, `KEY_FILE_UNWRITABLE` or `MISSING` |
| `CREDENTIAL_READ_FAILED` | the tables look present but reading the credential row fails for another reason | read the server log for the safe `SQL_*` driver code; nothing was written |
| `HISTORY_DEGRADED` | credential storage itself works; the **diagnostics history** queries (`api_connection_events`, `api_sync_logs`) fail | saving and activating still work. Apply the pending migration or restore the baseline schema when convenient |

A **successful Test Connection is not evidence about any of these.** It proves the provider
accepted a key. It does not prove that the database can store one, that the encryption key is
available, or that the key file is writable.

---

## 2. Read-only diagnostic

### Admin console

Admin → API Management shows **Credential storage — admin-only read-only check**, with database,
table, privilege, encryption and history rows plus the exact fixes.

### Direct URL (signed-in administrator)

```
https://yourdomain.com/api/admin/api-management/storage-diagnostics
```

The request is protected by the same administrator guard as the rest of `/api/admin`. It runs
`SELECT` and `SHOW` statements only. It never creates a key, writes a row, runs DDL, or returns
an API key, ciphertext, encryption key, database password, session cookie or raw `GRANT` text.
Privileges are reduced to booleans; grant account names are discarded.

A minimal healthy response looks like:

```json
{
  "ok": true,
  "data": {
    "readOnly": true,
    "state": "READY",
    "ready": true,
    "canRead": true,
    "canSave": true,
    "database": { "reachable": true },
    "schema": { "ready": true, "migration": { "required": false, "file": "003-api-credential-management.sql" } },
    "permissions": { "checked": true, "select": true, "insert": true, "update": true },
    "encryption": { "state": "ENV_READY", "canEncrypt": true, "canDecrypt": true },
    "history": { "ready": true }
  }
}
```

`npm run doctor` prints the same state in a terminal and never prints the key.

---

## 3. Encryption-key locations and compatibility

The master key is **never** stored in the database.

Resolution order, highest priority first:

1. `API_CREDENTIALS_ENCRYPTION_KEY` (64 hex characters, or base64 of 32 bytes);
2. `API_CREDENTIALS_KEY_FILE`, when set. A relative value resolves against the **application
   root**, not the process working directory — Passenger and cron therefore read the same file;
3. an **existing** `<application root>/storage/api-credentials.key` (the original location);
4. a persistent key file outside the application folder (normally
   `/home/USER/.goalpredict/api-credentials.key`; new default for new installs), created only
   when an administrator saves a key and no key exists. The folder is derived from the
   application root, not `$HOME`, so Passenger and cron resolve the same path. If the
   application root itself sits in a served folder (`public_html`, `public`, `www`, `htdocs`,
   `httpdocs`), the key is placed in the account home folder — or one level above the served
   folder — and **never** inside the web root.

Guarantees:

* an **existing** key is never regenerated, moved, overwritten or deleted automatically;
* a key file that exists but is invalid, unreadable or in an unwritable folder makes the vault
  report **not ready** — it never silently falls back to plaintext or to another key;
* switching to a different key makes the old ciphertext unreadable (`CREDENTIAL_UNREADABLE`).
  That is detected, not hidden. Re-enter the API key only after a deliberate rotation.

The outside-folder location survives a ZIP re-upload and application-folder cleanup because it is outside
the application root. Existing installations that still use `storage/api-credentials.key` keep
working unchanged; the diagnostic reports `KEY_FILE_IN_APPLICATION_FOLDER` and offers the optional
migration below.

---

## 4. cPanel-only: apply migration 003 (only if it is missing)

Use this when the diagnostic says `SCHEMA_OUT_OF_DATE` and lists `api_credentials` or
`api_connection_events`.

1. **Back up first:** cPanel → **phpMyAdmin** → select the database → **Export** → Go (SQL).
2. **phpMyAdmin → SQL** → paste the entire contents of
   `server/database/migrations/003-api-credential-management.sql` → **Go**.
   It only creates the two credential tables. It does not alter existing tables, rows or columns.
3. Record it for the migration runner (optional if you always deploy with `npm run db:migrate`):

   ```sql
   INSERT INTO `schema_migrations` (filename, checksum)
   VALUES ('003-api-credential-management.sql', '<SHA256_OF_THE_FILE>')
   ON DUPLICATE KEY UPDATE checksum = VALUES(checksum);
   ```

4. Reload the storage diagnostic. It must move to `READY` (or to the next real issue).

A fresh install receives the same tables from `server/database/schema.sql`; do not paste the
migration twice.

---

## 5. cPanel-only: reversible key-file migration (optional)

Use this **only** when the diagnostic reports `KEY_FILE_IN_APPLICATION_FOLDER`. It is not needed
for a healthy environment-variable key. Do not delete or regenerate anything.

1. **Back up** the application folder and database. Keep the existing
   `<app root>/storage/api-credentials.key` in place.
2. cPanel → **File Manager** → show hidden files → create `/home/USER/.goalpredict`.
3. **Copy** (do not move) `storage/api-credentials.key` to
   `/home/USER/.goalpredict/api-credentials.key`. Set permissions `0600` and the folder `0700`.
4. cPanel → **Setup Node.js App** → your application → **Environment Variables**:
   `API_CREDENTIALS_KEY_FILE=/home/USER/.goalpredict/api-credentials.key` → **Save** →
   **Restart**.
5. Open the storage diagnostic. `encryption.state` must be `FILE_READY`, `keyPath` must be the new
   path, and `encryption.legacyLocation` must be false.
6. Verify a saved credential: **Test connection**, then **Activate provider** if the saved
   credential is not active. A successful decrypt proves the copied key is the same key.
7. Keep the old `storage/api-credentials.key` as a backup. Remove it only after a separate backup
   exists and the new location has worked across a restart.

**Rollback (reversible):** delete the `API_CREDENTIALS_KEY_FILE` variable in **Setup Node.js
App**, save and restart. The still-present legacy file becomes the key again. Never delete both
files.

---

## 6. Verify save, encrypted read-back, activation, rollback and fallback

Do this on the deployed site only after the diagnostic is `READY`:

1. **Save:** paste the key in Admin → API Management → **Save configuration**. The response shows
   only `********abcd`. Nothing plaintext is returned.
2. **Encrypted read-back:** reload the page; the masked key and metadata are still shown. The
   diagnostic `credentials.readable` is true and `encryption.canDecrypt` is true.
3. **Test:** **Test connection** makes one real `/status` request. A saved key alone is never
   presented as connected.
4. **Activate:** **Activate provider**. The server uses the database credential after a restart
   (startup resolves it), not just in the current process.
5. **Disable / rollback:** **Disable saved credential** keeps the ciphertext, stops using it and
   falls back to `API_FOOTBALL_KEY` when that environment key exists. Re-activation must still
   decrypt the stored row.
6. **Environment fallback:** with no active database row, syncs and testing use
   `API_FOOTBALL_KEY` exactly as before this feature existed.
7. **Storage failure is honest:** if the database or key becomes unavailable, saving fails with
   `503 ENCRYPTION_KEY_MISSING` (nothing written) or a schema/permission error; it never stores
   plaintext.

Automated tests cover steps 1–6 in `tests/api-management.test.js` and the storage states in
`tests/credential-storage.test.js`. They do **not** prove a particular production host, database
or provider account works — that requires the operator checks above.

---

## 7. Deployment ZIP safety

`GoalPredict-cPanel-deployment.zip` is built only from tracked files and explicitly excludes:

* `storage/`, backups, dumps and `cpanel_nodejs/`;
* `.env`, `.env.local`, `.env.production`, `.env.development` and every other `.env*`
  (`.env.example` is documentation and is included);
* `*.key`, `*.pem`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.kdbx`;
* database dumps (`dump*.sql`, `backup*.sql`, `*.dump`, `*.sql.gz`, `*.sql.zip`);
* archives, `.bak`, logs and `node_modules`.

`npm run build:zip` refuses to build if a sensitive-looking file is tracked at all, and
`tests/deployment-zip.test.js` asserts both the exclusions and that no such file is tracked.
An encryption key outside the application root is not in any archive.

---

## 8. Safe cPanel deployment (no Terminal required)

1. Back up the application and database. Copy `.env` and the key file separately; never overwrite
   production secrets with example values.
2. Upload the rebuilt ZIP to the **application root** (not `public_html`) and extract it over the
   files. The archive does not contain `.env`, `storage/` or any key.
3. **Run NPM Install** only if `package.json`/`package-lock.json` changed.
4. Apply migration 003 only when the diagnostic says it is missing (section 4). This repair adds
   **no new migration** and does not touch existing tables.
5. **Restart** the Node.js application.
6. Open the storage diagnostic: database/tables/privileges/encryption must be `READY` (or the
   remaining row must be a real, separate issue).
7. Test, save and activate the credential as in section 6.
8. Generate a ticket **manually** from the console only when the real provider data qualifies.

The market remains **Over 1.5 Goals only**, combined ticket odds remain **2.00–4.00**, prices come
only from verified provider responses, no selection is fabricated, and ticket generation remains
manual. Admin approval, authentication and the rest of API Management are unchanged.
