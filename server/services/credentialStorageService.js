'use strict';

/**
 * CREDENTIAL STORAGE DIAGNOSTICS — one read-only answer to
 * "why does Admin → API Management say credential storage is unavailable?".
 *
 * The screen used to collapse every failure into the same sentence: a MySQL
 * connection problem, a missing migration, a missing grant, an unreadable
 * encryption key, an empty event history and a failing sync-history query all
 * looked identical. That is worse than useless on cPanel shared hosting, where
 * each cause has a different fix.
 *
 * This module separates them:
 *
 *   database      can a connection execute `SELECT 1`?
 *   schema        do the two migration-003 tables and their required columns
 *                 exist? (read from INFORMATION_SCHEMA, never by writing)
 *   permissions   what does `SHOW GRANTS FOR CURRENT_USER()` allow? Only
 *                 booleans are returned — never the grant text or the user.
 *   credentials   can `api_credentials` be read? how many rows exist?
 *   history       can `api_connection_events` and the existing `api_sync_logs`
 *                 be read? A broken history degrades the screen; it does NOT
 *                 make saving/activating a credential impossible.
 *   encryption    is the AES-256-GCM master key usable, is it going to be
 *                 created on first save, and where does it live?
 *
 * GUARANTEES
 *   * read-only: SELECT / SHOW only. No INSERT, UPDATE, DELETE, DDL, key
 *     creation or file write happens here;
 *   * no secret leaves this module: no API key, ciphertext, key file content,
 *     database password, session/cookie or grant string is included;
 *   * a provider connection test says nothing about this report. The two are
 *     deliberately independent: a valid provider key does not prove that the
 *     database or the encryption key can store anything.
 */

const connection = require('../database/connection');
const db = require('../database/queries');
const vault = require('../utils/credentialVault');
const { AppError } = require('../utils/errors');

const MIGRATION_FILE = '003-api-credential-management.sql';

/** Columns the repository's queries actually use. */
const REQUIRED_SCHEMA = Object.freeze({
  api_credentials: Object.freeze([
    'id', 'provider', 'host', 'key_ciphertext', 'key_iv', 'key_tag', 'key_algorithm',
    'key_id', 'key_last4', 'key_length', 'key_fingerprint', 'is_active',
    'connection_state', 'connection_message', 'last_test_at', 'last_test_latency_ms',
    'last_success_at', 'last_request_at', 'last_error_at', 'last_error_code',
    'last_error_message', 'quota_used_today', 'quota_limit_day', 'quota_checked_at',
    'rate_limit_per_minute', 'plan_name', 'activated_at', 'disabled_at',
    'created_by_admin_id', 'updated_by_admin_id', 'created_at', 'updated_at',
  ]),
  api_connection_events: Object.freeze([
    'id', 'provider', 'event', 'outcome', 'http_status', 'endpoint', 'latency_ms',
    'message', 'context_json', 'admin_id', 'ip_address', 'created_at',
  ]),
});

const CONNECTION_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'PROTOCOL_CONNECTION_LOST',
  'ER_ACCESS_DENIED_ERROR', 'POOL_CLOSED', 'DB_UNAVAILABLE',
]);
const SCHEMA_CODES = new Set([
  'SCHEMA_OUT_OF_DATE', 'ER_NO_SUCH_TABLE', 'ER_BAD_TABLE_ERROR', 'ER_BAD_FIELD_ERROR',
]);
const PERMISSION_CODES = new Set([
  'ER_TABLEACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR', 'ER_SPECIFIC_ACCESS_DENIED_ERROR',
  'ER_ACCESS_DENIED_ERROR',
]);

/** Safe classification — never includes SQL, a value or a credential. */
function classifyError(err) {
  const reported = String((err && (err.driverCode || err.code)) || 'UNKNOWN');
  // connection.toAppError prefixes generic driver codes with SQL_. Strip it so
  // a permission error is still classified as a permission error.
  const code = reported.startsWith('SQL_') ? reported.slice(4) : reported;
  if (CONNECTION_CODES.has(code)) {
    return {
      state: 'DATABASE_UNREACHABLE',
      code: code === 'DB_UNAVAILABLE' ? 'DB_UNAVAILABLE' : 'DATABASE_UNREACHABLE',
      driverCode: reported,
      message: 'The application cannot connect to the database. Check DB_HOST, DB_USER, DB_PASSWORD, DB_NAME and the database service.',
    };
  }
  if (SCHEMA_CODES.has(code)) {
    return {
      state: 'SCHEMA_OUT_OF_DATE',
      code: 'SCHEMA_OUT_OF_DATE',
      driverCode: reported,
      message: `The database schema is behind the code — apply ${MIGRATION_FILE} (npm run db:migrate, or phpMyAdmin on cPanel).`,
    };
  }
  if (PERMISSION_CODES.has(code)) {
    return {
      state: 'PERMISSION_DENIED',
      code: 'DATABASE_PERMISSION_DENIED',
      driverCode: reported,
      message: 'The database user is missing a privilege required for credential storage. Ask the host to grant SELECT, INSERT and UPDATE on the application database.',
    };
  }
  return {
    state: 'QUERY_FAILED',
    code: reported.startsWith('SQL_') ? reported : `SQL_${reported}`,
    driverCode: reported,
    message: 'A credential-storage query failed. Read the server log for the safe driver code; no data was changed.',
  };
}

/** Execute a read-only statement, capturing a classified failure instead of throwing. */
async function attempt(work) {
  try {
    return { ok: true, value: await work(), error: null };
  } catch (err) {
    const classified = classifyError(err);
    return {
      ok: false,
      value: null,
      error: {
        ...classified,
        // AppError messages are already operator-safe; anything else is replaced.
        message: err instanceof AppError ? err.message : classified.message,
      },
    };
  }
}

/**
 * Compare INFORMATION_SCHEMA with the expected tables/columns.
 * Read-only. Falls back to a `SELECT ... LIMIT 0` probe if INFORMATION_SCHEMA
 * itself is not readable, so a restricted host still gets a useful answer.
 */
async function inspectSchema() {
  const expectedTables = Object.keys(REQUIRED_SCHEMA);
  const result = {
    ready: false,
    checked: false,
    source: null,
    missingTables: [],
    missingColumns: [],
    tables: {},
    migration: { required: false, file: MIGRATION_FILE, applied: null },
  };

  const info = await attempt(() =>
    connection.query(
      `SELECT TABLE_NAME, COLUMN_NAME
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME IN (${expectedTables.map(() => '?').join(', ')})`,
      expectedTables
    )
  );

  if (info.ok) {
    const found = new Map(expectedTables.map((name) => [name, new Set()]));
    for (const row of info.value || []) {
      const table = String(row.TABLE_NAME || row.table_name || '');
      const column = String(row.COLUMN_NAME || row.column_name || '');
      if (found.has(table)) found.get(table).add(column);
    }
    for (const [table, columns] of found) {
      const missing = REQUIRED_SCHEMA[table].filter((column) => !columns.has(column));
      result.tables[table] = { exists: columns.size > 0, missingColumns: missing };
      if (columns.size === 0) result.missingTables.push(table);
      result.missingColumns.push(...missing.map((column) => `${table}.${column}`));
    }
    result.checked = true;
    result.source = 'information_schema';
  } else {
    // INFORMATION_SCHEMA is unavailable (permissions or an old server). Probe
    // each table with a statement that returns no rows and writes nothing.
    for (const table of expectedTables) {
      const probe = await attempt(() => connection.query(`SELECT ${REQUIRED_SCHEMA[table].join(', ')} FROM ${table} LIMIT 0`));
      result.tables[table] = { exists: probe.ok, error: probe.ok ? null : probe.error };
      if (!probe.ok) {
        if (probe.error.state === 'SCHEMA_OUT_OF_DATE') result.missingTables.push(table);
        else result.schemaError = probe.error;
      }
    }
    result.checked = true;
    result.source = 'probe';
  }

  result.ready = result.missingTables.length === 0 && result.missingColumns.length === 0 && !result.schemaError;
  result.migration.required = !result.ready;
  result.migration.applied = result.ready ? true : false;
  return result;
}

/**
 * Parse `SHOW GRANTS FOR CURRENT_USER()` into booleans.
 * The grant text and the account name never leave this function.
 */
async function inspectPermissions() {
  const grants = await attempt(() => connection.query('SHOW GRANTS FOR CURRENT_USER()'));
  if (!grants.ok) {
    return {
      checked: false,
      code: grants.error.code,
      message: 'Database privileges could not be read (the account may lack SHOW GRANTS). No write was attempted.',
      select: null, insert: null, update: null, delete: null, all: null,
    };
  }
  const text = (grants.value || [])
    .map((row) => String(row[(Object.keys(row) || [])[0]] || ''))
    .join('\n');
  if (!text) {
    return { checked: false, code: 'NO_GRANTS_RETURNED', message: 'The database returned no grant information.', select: null, insert: null, update: null, delete: null, all: null };
  }
  const all = /ALL PRIVILEGES|GRANT ALL\b/i.test(text);
  const has = (privilege) => all || new RegExp(`\\b${privilege}\\b`, 'i').test(text);
  return {
    checked: true,
    select: has('SELECT'),
    insert: has('INSERT'),
    update: has('UPDATE'),
    delete: has('DELETE'),
    all,
  };
}

/**
 * Collect every piece of evidence without throwing.
 * `data` is for internal callers (the status DTO); `report` is safe to send.
 */
async function collectStorage() {
  const databaseProbe = await attempt(() => connection.queryOne('SELECT 1 AS ok'));
  const database = {
    reachable: databaseProbe.ok,
    checkedAt: new Date().toISOString(),
    code: databaseProbe.ok ? null : databaseProbe.error.code,
    driverCode: databaseProbe.ok ? null : databaseProbe.error.driverCode,
    message: databaseProbe.ok ? 'Database connection is available.' : databaseProbe.error.message,
  };

  const evidence = {
    database,
    schema: { checked: false, ready: false, missingTables: [], missingColumns: [], migration: { required: false, file: MIGRATION_FILE, applied: null } },
    permissions: { checked: false, select: null, insert: null, update: null, delete: null, all: null },
    credentials: { readable: false, count: null, error: null },
    events: { readable: false, error: null },
    syncs: { readable: false, error: null },
  };
  const data = { rows: [], events: [], recentErrors: [], lastSyncs: null };

  if (database.reachable) {
    evidence.schema = await inspectSchema();
    evidence.permissions = await inspectPermissions();

    const credentials = await attempt(() => db.listApiCredentials());
    evidence.credentials = credentials.ok
      ? { readable: true, count: (credentials.value || []).length, error: null }
      : { readable: false, count: null, error: credentials.error };
    if (credentials.ok) data.rows = credentials.value || [];

    const events = await attempt(() => db.listApiConnectionEvents({ limit: 12 }));
    evidence.events = events.ok ? { readable: true, error: null } : { readable: false, error: events.error };
    if (events.ok) data.events = events.value || [];

    const recentErrors = await attempt(() => db.listApiConnectionEvents({ limit: 12, errorsOnly: true }));
    if (recentErrors.ok) data.recentErrors = recentErrors.value || [];

    const syncs = await attempt(() => db.getLastSuccessfulSyncs(['fixtures', 'odds', 'results']));
    evidence.syncs = syncs.ok ? { readable: true, error: null } : { readable: false, error: syncs.error };
    if (syncs.ok) data.lastSyncs = syncs.value || {};
  }

  return { report: buildReport(evidence), data, evidence };
}

/** Compute one honest readiness state from the collected evidence. */
function buildReport(evidence) {
  const encryption = vault.status();
  const issues = [];
  const addIssue = (area, code, message, fix) => issues.push({ area, code, message, fix: fix || null });

  if (!evidence.database.reachable) {
    addIssue('database', evidence.database.code || 'DATABASE_UNREACHABLE', evidence.database.message,
      'Correct DB_HOST / DB_USER / DB_PASSWORD / DB_NAME in the cPanel Node.js environment, then restart the application.');
  }

  if (evidence.database.reachable && !evidence.schema.ready) {
    addIssue('schema', 'SCHEMA_OUT_OF_DATE',
      evidence.schema.missingTables.length || evidence.schema.missingColumns.length
        ? `Missing credential-storage objects: ${[...evidence.schema.missingTables, ...evidence.schema.missingColumns].join(', ')}.`
        : 'The credential-storage tables could not be verified.',
      `Apply ${MIGRATION_FILE} with npm run db:migrate, or paste it into phpMyAdmin's SQL tab on cPanel. It only creates two new tables.`);
  }

  if (evidence.credentials.error) {
    addIssue('credentials', evidence.credentials.error.code, evidence.credentials.error.message,
      'Read the server log and run the storage diagnostic again. Nothing was written by this check.');
  }

  const permissions = evidence.permissions;
  const readAllowed = permissions.checked ? permissions.select !== false : null;
  const writeAllowed = permissions.checked ? permissions.insert !== false && permissions.update !== false : null;
  if (permissions.checked && (!readAllowed || !writeAllowed)) {
    addIssue('permissions', 'DATABASE_PERMISSION_DENIED',
      `The database user ${!readAllowed ? 'cannot SELECT' : ''}${!readAllowed && !writeAllowed ? ' and ' : ''}${!writeAllowed ? 'cannot INSERT/UPDATE' : ''} credential rows.`,
      'Ask the host to grant SELECT, INSERT and UPDATE on the application database to the configured database user.');
  }

  if (!encryption.canEncrypt) {
    addIssue('encryption', encryption.state || 'ENCRYPTION_KEY_MISSING', encryption.message,
      encryption.keyEnvVar ? `Set ${encryption.keyEnvVar} (64 hex characters) in the cPanel Node.js environment and restart, or make the key folder writable.` : null);
  }
  if (encryption.legacyLocation) {
    addIssue('encryption', 'KEY_FILE_IN_APPLICATION_FOLDER',
      'The encryption key is readable but lives inside the application folder, where a deployment ZIP re-upload or cleanup can remove it.',
      'Follow the optional key migration procedure: copy (never move) the key outside the application folder, set API_CREDENTIALS_KEY_FILE, restart and verify.');
  }

  const historyErrors = [evidence.events.error, evidence.syncs.error].filter(Boolean);
  if (historyErrors.length) {
    addIssue('history', historyErrors[0].code,
      'Credential storage itself is readable, but the diagnostics/history queries fail, so recent events and sync times cannot be shown.',
      `Usually a missing baseline table (api_sync_logs/api_connection_events). Apply the pending migration ${MIGRATION_FILE} or restore the baseline schema. Saving a credential is not blocked by this.`);
  }

  // A credential read can itself reveal that the table is missing or that the
  // database user lacks SELECT even when INFORMATION_SCHEMA looked healthy.
  // Treat that as a schema/permission failure, not as an anonymous read error.
  const credentialFailure = evidence.credentials.error;
  const schemaReady = evidence.schema.ready && !(credentialFailure && credentialFailure.state === 'SCHEMA_OUT_OF_DATE');
  const permissionFailure = permissions.checked
    ? permissions.select === false || permissions.insert === false || permissions.update === false
    : false;

  const canRead = evidence.database.reachable && schemaReady && evidence.credentials.readable &&
    readAllowed !== false && (encryption.canDecrypt || evidence.credentials.count === 0);
  const canSave = evidence.database.reachable && schemaReady && encryption.canEncrypt && writeAllowed !== false;

  let state = 'READY';
  if (!evidence.database.reachable) state = 'DATABASE_UNREACHABLE';
  else if (!schemaReady) state = 'SCHEMA_OUT_OF_DATE';
  else if (permissionFailure) state = 'PERMISSION_DENIED';
  else if (!encryption.canEncrypt) state = 'ENCRYPTION_NOT_READY';
  else if (credentialFailure && credentialFailure.state === 'PERMISSION_DENIED') state = 'PERMISSION_DENIED';
  else if (!evidence.credentials.readable) state = 'CREDENTIAL_READ_FAILED';
  else if (historyErrors.length) state = 'HISTORY_DEGRADED';
  else if (!canRead || !canSave) state = 'DEGRADED';

  const ready = state === 'READY';
  const summary = {
    READY: 'Credential storage is ready: the database tables are present and the encryption key is usable.',
    DATABASE_UNREACHABLE: 'Credential storage is unavailable: the database cannot be reached.',
    SCHEMA_OUT_OF_DATE: `Credential storage is unavailable: the database is missing migration ${MIGRATION_FILE}.`,
    PERMISSION_DENIED: 'Credential storage is unavailable: the database user lacks the required privileges.',
    ENCRYPTION_NOT_READY: 'Credential storage is unavailable: no usable encryption key is configured.',
    CREDENTIAL_READ_FAILED: 'Credential storage is unavailable: the credential table cannot be read.',
    HISTORY_DEGRADED: 'Credential storage is ready; only the diagnostics history is unavailable.',
    DEGRADED: 'Credential storage is only partly ready. Read the issues below.',
  }[state];

  return {
    readOnly: true,
    state,
    ready,
    degraded: !ready,
    canRead,
    canSave,
    summary,
    checkedAt: new Date().toISOString(),
    database: {
      reachable: evidence.database.reachable,
      code: evidence.database.code,
      driverCode: evidence.database.driverCode,
      message: evidence.database.message,
    },
    schema: {
      checked: evidence.schema.checked,
      ready: evidence.schema.ready,
      source: evidence.schema.source || null,
      missingTables: evidence.schema.missingTables,
      missingColumns: evidence.schema.missingColumns,
      migration: evidence.schema.migration,
    },
    permissions: {
      checked: permissions.checked,
      select: permissions.select,
      insert: permissions.insert,
      update: permissions.update,
      delete: permissions.delete,
      all: permissions.all,
      message: permissions.message || null,
    },
    credentials: {
      readable: evidence.credentials.readable,
      count: evidence.credentials.count,
      error: evidence.credentials.error ? evidence.credentials.error.code : null,
    },
    history: {
      ready: !historyErrors.length,
      eventsReadable: evidence.events.readable,
      syncsReadable: evidence.syncs.readable,
      error: historyErrors.length ? historyErrors[0].code : null,
    },
    encryption: {
      state: encryption.state,
      configured: encryption.configured,
      pending: Boolean(encryption.pending),
      canEncrypt: encryption.canEncrypt,
      canDecrypt: encryption.canDecrypt,
      source: encryption.source,
      keyEnvVar: encryption.keyEnvVar,
      keyPath: encryption.keyPath,
      keyFile: encryption.keyFile,
      legacyKeyFile: encryption.legacyKeyFile,
      persistentKeyFile: encryption.persistentKeyFile,
      explicitKeyFile: encryption.explicitKeyFile,
      legacyLocation: Boolean(encryption.legacyLocation),
      writable: encryption.writable,
      message: encryption.message,
    },
    issues,
  };
}

/** Public entry point for the admin-only endpoint and the status DTO. */
async function inspectStorage() {
  const { report, data } = await collectStorage();
  return { report, data };
}

module.exports = {
  MIGRATION_FILE,
  REQUIRED_SCHEMA,
  classifyError,
  inspectSchema,
  inspectPermissions,
  collectStorage,
  buildReport,
  inspectStorage,
};
