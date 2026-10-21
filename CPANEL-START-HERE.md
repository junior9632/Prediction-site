# GoalPredict: cPanel deployment without SSH or Terminal

This is the primary production deployment guide. You do **not** need to open a
shell, clone Git on the host, build the ZIP, or type npm commands. Use the supplied
`GoalPredict-cPanel-deployment.zip` and the cPanel controls below.

Node.js/Passenger and npm packages are still required. **No Terminal access** does
not mean **no dependencies**. Dependencies are installed by the panel, not bundled
from another computer. This release has no frontend build step.

## Hosting prerequisites

Your hosting account must provide:

- **Setup Node.js App** (or an equivalent Node.js/Passenger application manager)
  with a supported Node.js version satisfying `package.json` (>=18.17; prefer a
  currently supported LTS version offered by the host).
- **Run NPM Install**, or a host-managed dependency installation service.
- **File Manager**, **MySQL Databases**, **phpMyAdmin**, and app **Restart** controls.
- Outbound access for package installation and HTTPS access to the API provider.

If a control is absent, ask support to enable it for your account. File Manager
alone cannot install Node.js or make a PHP-only hosting plan run this application.
Do not upload a `node_modules` folder from a different operating system and do not
create a public web endpoint that installs packages or runs migrations.

## A. Update your existing production application (your current case)

### 1. Back up and identify the right application

1. Open **Setup Node.js App** and note the application's root, URL, Node version
   and startup file. Use the existing application, not a second app on the same URL.
2. In **File Manager → Settings → Show Hidden Files**, back up the application
   files, including `.env`, runtime storage and any encryption key file.
3. In **phpMyAdmin**, select the existing production database and use **Export**.
4. Store backups privately outside the web-accessible directory. Never share them
   or paste secrets, cookies or full environment dumps into chat/support tickets.

### 2. Upload the ready-built release

1. Download `GoalPredict-cPanel-deployment.zip` from this repository/session.
2. In File Manager, upload and extract it to a private staging folder.
3. Copy the release files into the existing **application root**, preserving their
   folder layout. Startup file remains `server.js`.
4. Preserve the existing `.env`, `storage/`, key files, uploads and runtime data.
   Do not delete the application directory or an existing panel-managed
   `node_modules` link. Do not replace the database.
5. The archive contains `.env.example`, not a production `.env`. The example
   never supplies working credentials. Do not overwrite existing settings with it.

For the API permission repair alone, uploading
`server/services/credentialStorageService.js` and
`server/database/credentialGrants.js` is sufficient; dependencies did not change.

### 3. Install dependencies using the panel

1. Open **Setup Node.js App → your application**.
2. Confirm **Application mode: Production** and **Application startup file:
   server.js**, then save if needed.
3. Click **Run NPM Install**. Wait for the panel's completion result before restart.
   It reads `package.json` / `package-lock.json` in the application root.
4. On later updates, repeat when the dependency manifests change. The current
   permission-parser-only repair needs no reinstall if dependencies already work.
5. If installation fails, do not repeatedly restart or delete runtime data. Ask
   support to check the selected Node version, app-root ownership, the panel-managed
   dependency directory and npm registry access. Share only redacted error output.

Do not select `db:setup`, `db:seed`, `ticket:generate` or any sync script during an
existing-site update. There is no automatic install/start migration or ticket job.

### 4. Preserve the production environment

Use **Setup Node.js App → Environment Variables**, or privately edit the existing
app-root `.env` using File Manager. The filename is `.env`, not `.evn`.

- Check `NODE_ENV=production`, the real `APP_URL`, matching `CORS_ORIGINS`,
  `TRUST_PROXY=1` and HTTPS cookie configuration.
- Confirm DB_HOST, DB_PORT, DB_NAME and DB_USER privately, including cPanel prefixes.
  Preserve the correct DB_PASSWORD; cPanel's displayed account need not be the
  account used by a running Passenger worker.
- Keep the existing JWT secret and API credential encryption key/file unchanged.
  Your AES-256-GCM diagnostic was already ready. Do not rotate its key for deployment.
- Keep the existing API provider key/host or activated encrypted database credential.
  An empty provider configuration may correctly report CONFIG_INCOMPLETE.
- Keep `ENABLE_INTERNAL_SCHEDULER=0` during this repair. No cron job is required to
  deploy or verify the site. Existing production scheduling should only be changed
  deliberately, not by copying an example file.

Process environment values set by cPanel override `.env`. Avoid conflicting copies.
Never put `.env` or key files in `public/`, and never publish a configuration dump.

### 5. Apply SQL only if a migration is actually required

**The permission-parser repair requires no SQL changes.**

For a separately confirmed pending migration, back up first, select the **actual
runtime database** in phpMyAdmin, and use its **SQL** tab to apply the reviewed
migration file. Verify required tables/columns afterward. Never import baseline
schema, seed data, DROP tables, or replace credential rows as an update workaround.
Migration 003 creates missing tables but cannot repair missing columns in an
existing table. Stop for a reviewed additive migration in that case.

See [the permission repair runbook](docs/API-PERMISSION-REPAIR.md) for runtime
identity, schema, migration-ledger and restricted-host verification details.

### 6. Restart and verify in the browser

1. **Save** any panel changes, then click **Restart** for the application. Ask the
   host to restart all Passenger workers if the button is unavailable. Configuration
   and connection pools are cached; refreshing the browser is not a restart.
2. Open the public site and `/api/health`. A successful HTTP response alone is not
   proof of API credentials or database write privileges; inspect the reported state.
3. Sign in at `/admin/login` with your existing account.
4. Open **API Management** and the authenticated read-only endpoint
   `/api/admin/api-management/storage-diagnostics`.
5. Confirm database reachability, schema readiness, credential readability and
   permission/encryption results. Unknown permission remains unknown, not healthy.
6. Do not click ticket generation, publication, credential replacement or sync
   controls just to verify deployment. This process creates no prediction ticket.

If the app fails to start, view its configured application/Passenger log using
File Manager, or cPanel's error viewer. Send hosting support only redacted error
codes and the app root/release time. Do not expose `.env`, grants or credentials.

Rollback: restore the prior app files, preserve runtime secrets/data, restore the
prior dependency manifests and use **Run NPM Install** if dependencies changed,
then **Restart**. This code-only repair needs no database rollback.

## B. Brand-new installation only — not for your existing production database

1. Create a private application folder in File Manager, extract the supplied ZIP,
   then use **Setup Node.js App → Create Application** with Production mode, your
   domain/application URL, that root, and startup file `server.js`.
2. Create a database and database user in **MySQL Databases**, associate the user
   with that database, and configure the real DB values privately. Installation
   DDL privileges may be needed; do not grant global privileges.
3. Create `.env` privately from `.env.example`, or use the panel environment fields.
   Replace every placeholder. A fresh installation needs unique secure secrets;
   do not use example passwords or online secret-generation websites.
4. Click **Run NPM Install**.
5. In phpMyAdmin select the new, empty database and import
   `server/database/schema.sql`. Do not use this fresh-install step on an existing DB.
6. If your panel exposes **Run JS script** / package scripts, run the existing
   `db:migrate` script to reconcile the baseline/versioned migration ledger, then
   `db:seed` once to create default settings and the first admin from private
   ADMIN_USERNAME, ADMIN_EMAIL and ADMIN_PASSWORD environment values. These are
   panel actions, not shell commands. Never select `ticket:generate`.
7. If the script runner is absent, ask the host to perform the existing migration
   and first-admin bootstrap scripts under the app environment. Do not create an
   unauthenticated web installer or insert a plaintext admin password through SQL.
8. Restart, log in, change the initial admin password and remove ADMIN_PASSWORD
   from the environment. Save and restart again. Verify as in section A.

A fresh bootstrap requires either the panel's script runner or hosting support;
it cannot be safely completed through static file upload alone. No SSH/Terminal
access is required from you in either case.

## Hosting support request (safe to copy)

> Please enable Node.js/Passenger application management, Run NPM Install and
> restart controls for my GoalPredict application. I deploy using cPanel only,
> without SSH/Terminal. Please confirm dependency installation can run from the
> application's package.json and lockfile, and that all Passenger workers restart
> after environment changes. If this is a new installation and the panel has no
> script runner, please run the existing migration and first-admin bootstrap
> scripts under the app's configured environment. Do not run ticket generation,
> publication or data sync scripts, and do not send secret values in the reply.
