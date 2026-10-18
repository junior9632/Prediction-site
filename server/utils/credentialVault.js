'use strict';

/**
 * CREDENTIAL VAULT — authenticated encryption for API credentials at rest.
 *
 * WHAT IT GUARANTEES
 *   * AES-256-GCM: the ciphertext is authenticated, so a tampered row in the
 *     database is DETECTED instead of decrypted into garbage.
 *   * a fresh random 12-byte nonce per encryption, plus an additional
 *     authenticated data (AAD) binding of `provider:field`, so a ciphertext
 *     copied to another provider/row/column fails authentication.
 *   * the master key comes from the server environment variable
 *     `API_CREDENTIALS_ENCRYPTION_KEY` (64 hex chars / base64 of 32 bytes).
 *     When that variable is NOT set, the vault uses a key file on the server:
 *       - an existing `<application root>/storage/api-credentials.key` (the
 *         original location) is ALWAYS used first, so credentials saved by an
 *         earlier release keep decrypting after an upgrade;
 *       - otherwise a key file outside the application folder is used
 *         (normally `~/.goalpredict/api-credentials.key`, derived from the
 *         application root so Passenger and cron agree), so re-uploading the
 *         deployment ZIP or cleaning the application folder cannot destroy it.
 *     `API_CREDENTIALS_KEY_FILE` overrides both locations (a relative value is
 *     resolved against the application root, never the process working
 *     directory, so Passenger and cron resolve the same file).
 *   * the environment variable always wins when present. The key is never
 *     written to the database, never logged and never sent to the browser.
 *   * FAIL SAFE: with no usable master key, `encryptSecret` refuses to store
 *     anything (it throws) — the platform never silently saves a plaintext key
 *     and never downgrades to "no encryption".
 *   * a key is created ONLY when none exists and a credential is being saved.
 *     An existing key file is never regenerated, replaced or deleted: doing so
 *     would make every stored credential permanently undecryptable.
 *
 * The module reads `process.env` and the key file on every call, so a key can
 * be rotated deliberately by restarting the app with a new value — see
 * `keyId()` and `inspect()` for how that is reported.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AppError } = require('./errors');

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ENV_VAR = 'API_CREDENTIALS_ENCRYPTION_KEY';

/** How an operator creates the value, shown verbatim in the dashboard + docs. */
const GENERATE_COMMAND = `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`;

/** The application root (the folder that contains server/, public/ and storage/). */
const APP_ROOT = path.resolve(__dirname, '..', '..');

/** Original location, kept for backward compatibility with existing installs. */
const LEGACY_KEY_FILE = path.join(APP_ROOT, 'storage', 'api-credentials.key');

/**
 * New default: a persistent folder OUTSIDE the application root and outside a
 * web root. It is derived from the application folder, not from `$HOME`, so
 * Passenger, cron and CLI resolve the same file even when their HOME differs.
 * Normally `/home/USER/.goalpredict/api-credentials.key` on cPanel.
 */
function defaultPersistentKeyFile(appRoot = APP_ROOT) {
  const parent = path.dirname(appRoot);
  const isWebRoot = (dir) => /(^|\/)(public_html|public|www|htdocs|httpdocs)$/i.test(dir);
  let base = parent;
  if (isWebRoot(base)) {
    // Never put a key inside a served folder. Prefer the account's home folder;
    // if that IS the web root, step one level above it instead.
    const home = os.homedir();
    base = home && home !== base && !home.startsWith(`${base}${path.sep}`)
      ? home
      : path.dirname(base);
  }
  return path.join(base, '.goalpredict', 'api-credentials.key');
}

const PERSISTENT_KEY_FILE = defaultPersistentKeyFile();

/**
 * Where the auto-managed key file lives.
 *
 * `API_CREDENTIALS_KEY_FILE` is explicit: it is the only candidate. Without it
 * an existing legacy file wins (compatibility), then the persistent file.
 */
function keyFilePath() {
  const custom = String(process.env.API_CREDENTIALS_KEY_FILE || '').trim();
  if (custom) return resolvePath(custom);
  if (fileExists(LEGACY_KEY_FILE)) return LEGACY_KEY_FILE;
  return PERSISTENT_KEY_FILE;
}

/** Resolve an operator-supplied path against the application root when relative. */
function resolvePath(value) {
  const raw = String(value || '').trim();
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(APP_ROOT, raw);
}

/** API_CREDENTIALS_AUTO_KEY=0 turns the key file off (environment key only). */
function autoKeyEnabled() {
  return !/^(0|false|no|off)$/i.test(String(process.env.API_CREDENTIALS_AUTO_KEY || '1').trim());
}

function fileExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch (_err) {
    return false;
  }
}

function failConfiguration(reason, message) {
  const auto = autoKeyEnabled();
  return new AppError(message, {
    status: 503,
    code: 'ENCRYPTION_KEY_MISSING',
    details: {
      envVar: ENV_VAR,
      reason,
      keyFile: auto ? keyFilePath() : null,
      legacyKeyFile: auto ? LEGACY_KEY_FILE : null,
      persistentKeyFile: auto ? PERSISTENT_KEY_FILE : null,
      generate: GENERATE_COMMAND,
      hint: `Set ${ENV_VAR} in the cPanel Node.js application environment (or .env) to 64 hex characters and restart the application.${
        auto
          ? ` Alternatively make ${path.dirname(keyFilePath())} writable so the server can create its own key file.`
          : ''
      }`,
    },
  });
}

/** Parse a raw 64-hex / base64(32 bytes) master key string. */
function parseKey(raw) {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return { key: Buffer.from(raw, 'hex'), problem: null };
  // 16 bytes in hex is refused: AES-256 requires 32 bytes.
  if (/^[0-9a-fA-F]{32}$/.test(raw)) return { key: null, problem: 'TOO_SHORT' };
  const b64 = Buffer.from(raw, 'base64');
  if (b64.length === KEY_BYTES && /^[A-Za-z0-9+/=_-]+$/.test(raw)) return { key: b64, problem: null };
  return { key: null, problem: 'MALFORMED' };
}

/**
 * Describe one key file WITHOUT reading its value into any output.
 * `valid` is computed from the content; the content itself is never returned.
 */
function inspectKeyFile(file, { legacy = false, explicit = false } = {}) {
  const meta = { path: file, exists: false, readable: false, valid: false, legacy, explicit, mode: null, bytes: null };
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    meta.exists = false;
    meta.reason = err && err.code === 'ENOENT' ? 'MISSING' : err && err.code;
    return meta;
  }
  if (!stat.isFile()) {
    meta.exists = true;
    meta.reason = 'NOT_A_FILE';
    return meta;
  }
  meta.exists = true;
  meta.mode = `0${(stat.mode & 0o777).toString(8)}`;
  meta.bytes = stat.size;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    meta.reason = err && err.code === 'EACCES' ? 'UNREADABLE' : err && err.code;
    return meta;
  }
  meta.readable = true;
  const parsed = parseKey(raw);
  meta.valid = Boolean(parsed.key);
  meta.problem = parsed.problem;
  // Never return the key material in a serialisable field: the raw text and the
  // parsed buffer are non-enumerable, so JSON.stringify(status()) cannot leak them.
  Object.defineProperty(meta, 'raw', { value: raw, enumerable: false });
  Object.defineProperty(meta, 'key', { value: parsed.key, enumerable: false });
  return meta;
}

/**
 * Can the server create a file below `dir`? Finds the nearest existing ancestor
 * and checks it is a directory the process may write to. Read-only: nothing is
 * created, so a diagnostic cannot change the deployment.
 */
function directoryWritable(dir) {
  let current = path.resolve(dir);
  for (let depth = 0; depth < 40; depth += 1) {
    let stat;
    try {
      stat = fs.statSync(current);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        const parent = path.dirname(current);
        if (parent === current) return { writable: false, checked: current, reason: 'NO_ANCESTOR' };
        current = parent;
        continue;
      }
      return { writable: false, checked: current, reason: err && err.code };
    }
    if (!stat.isDirectory()) return { writable: false, checked: current, reason: 'NOT_A_DIRECTORY' };
    try {
      fs.accessSync(current, fs.constants.W_OK | fs.constants.X_OK);
      return { writable: true, checked: current, reason: null };
    } catch (err) {
      return { writable: false, checked: current, reason: err && err.code === 'EACCES' ? 'NOT_WRITABLE' : err && err.code };
    }
  }
  return { writable: false, checked: current, reason: 'TOO_DEEP' };
}

/**
 * Resolve the master key and the storage readiness in one read-only pass.
 *
 * State vocabulary:
 *   ENV_READY        a valid environment key is loaded
 *   FILE_READY       a valid server key file is loaded
 *   PENDING          no key yet, but the server can create one on first save
 *   PENDING_FALLBACK no key yet; the persistent location is unusable but the
 *                    legacy application folder is writable
 *   ENV_INVALID      the environment variable is set but unusable
 *   KEY_FILE_INVALID a key file exists but its content is not a 32-byte key
 *   KEY_FILE_UNREADABLE an existing key file cannot be read (permissions)
 *   KEY_FILE_UNWRITABLE no key exists and no candidate directory is writable
 *   MISSING          no key and automatic key creation is disabled
 *
 * A key file that EXISTS is never skipped in favour of another location: the
 * first existing candidate decides. Falling through would silently switch
 * encryption keys and make every saved credential unreadable.
 */
function inspect() {
  const envRaw = String(process.env[ENV_VAR] || '').trim();
  const customRaw = String(process.env.API_CREDENTIALS_KEY_FILE || '').trim();
  const auto = autoKeyEnabled();
  const custom = customRaw ? resolvePath(customRaw) : null;
  const base = {
    algorithm: ALGORITHM,
    keyEnvVar: ENV_VAR,
    source: null,
    keyPath: null,
    keyFile: null,
    legacyKeyFile: LEGACY_KEY_FILE,
    persistentKeyFile: PERSISTENT_KEY_FILE,
    explicitKeyFile: custom,
    writable: null,
    canEncrypt: false,
    canDecrypt: false,
    pending: false,
    keyId: null,
    problem: null,
    message: '',
  };

  if (envRaw) {
    const parsed = parseKey(envRaw);
    if (parsed.key) {
      return {
        ...base,
        state: 'ENV_READY',
        configured: true,
        source: 'env',
        key: parsed.key,
        canEncrypt: true,
        canDecrypt: true,
        keyId: keyId(parsed.key),
        message: `${ENV_VAR} is set (${ALGORITHM}).`,
      };
    }
    const messages = {
      TOO_SHORT: `${ENV_VAR} is too short — it must be 64 hex characters (32 bytes).`,
      MALFORMED: `${ENV_VAR} is not valid — it must be 64 hex characters (32 bytes), or the base64 form of 32 bytes.`,
    };
    return {
      ...base,
      state: 'ENV_INVALID',
      configured: false,
      source: 'env',
      problem: parsed.problem,
      message: messages[parsed.problem] || messages.MALFORMED,
      generate: GENERATE_COMMAND,
    };
  }

  const candidates = custom ? [{ path: custom, explicit: true }] : [
    { path: LEGACY_KEY_FILE, legacy: true },
    { path: PERSISTENT_KEY_FILE, legacy: false },
  ];

  for (const candidate of candidates) {
    const file = inspectKeyFile(candidate.path, { legacy: Boolean(candidate.legacy), explicit: Boolean(candidate.explicit) });
    if (!file.exists) continue;
    const common = {
      ...base,
      source: 'file',
      keyPath: file.path,
      keyFile: file,
      writable: directoryWritable(path.dirname(file.path)),
      legacy: Boolean(file.legacy),
    };
    if (file.exists && file.reason === 'NOT_A_FILE') {
      return {
        ...common,
        state: 'KEY_FILE_INVALID',
        configured: false,
        problem: 'KEY_FILE_INVALID',
        message: `The key path ${file.path} exists but is not a regular file. Restore the key file from a backup; do not create a different key while stored credentials must remain readable.`,
      };
    }
    if (!file.readable) {
      return {
        ...common,
        state: 'KEY_FILE_UNREADABLE',
        configured: false,
        problem: 'KEY_FILE_UNREADABLE',
        message: `The server key file ${file.path} exists but is not readable by the application (${file.reason || 'permission denied'}). Fix its permissions; do not delete or replace it.`,
      };
    }
    if (!file.valid) {
      return {
        ...common,
        state: 'KEY_FILE_INVALID',
        configured: false,
        problem: 'KEY_FILE_INVALID',
        message: `The server key file ${file.path} is not a valid 32-byte key (${file.problem || 'malformed'}). Restore it from a backup or set ${ENV_VAR}; do not generate a replacement while stored credentials must remain readable.`,
      };
    }
    return {
      ...common,
      state: 'FILE_READY',
      configured: true,
      key: file.key,
      canEncrypt: true,
      canDecrypt: true,
      keyId: keyId(file.key),
      message: file.legacy
        ? `Encrypted with the key file managed by the server in the application folder (${ALGORITHM}).`
        : `Encrypted with the key file managed by the server outside the application folder (${ALGORITHM}).`,
    };
  }

  if (!auto) {
    return {
      ...base,
      state: 'MISSING',
      configured: false,
      problem: 'NOT_SET',
      message: `${ENV_VAR} is not set on the server — saving an API key is disabled until it is configured.`,
      generate: GENERATE_COMMAND,
    };
  }

  const primary = custom || PERSISTENT_KEY_FILE;
  const primaryDir = directoryWritable(path.dirname(primary));
  if (primaryDir.writable) {
    return {
      ...base,
      state: 'PENDING',
      configured: true,
      pending: true,
      source: 'file',
      keyPath: primary,
      writable: primaryDir,
      canEncrypt: true,
      canDecrypt: false,
      message: `No ${ENV_VAR} is set — the server will create its own encryption key file at ${primary} the first time you save an API key (${ALGORITHM}).`,
      generate: GENERATE_COMMAND,
    };
  }

  if (!custom) {
    const legacyDir = directoryWritable(path.dirname(LEGACY_KEY_FILE));
    if (legacyDir.writable) {
      return {
        ...base,
        state: 'PENDING_FALLBACK',
        configured: true,
        pending: true,
        source: 'file',
        keyPath: LEGACY_KEY_FILE,
        writable: legacyDir,
        canEncrypt: true,
        canDecrypt: false,
        message: `No ${ENV_VAR} is set. ${primary} is not writable, so the server will create its key file in the application folder instead (${ALGORITHM}).`,
        generate: GENERATE_COMMAND,
      };
    }
  }

  return {
    ...base,
    state: 'KEY_FILE_UNWRITABLE',
    configured: false,
    problem: 'KEY_FILE_UNWRITABLE',
    keyPath: primary,
    writable: primaryDir,
    message: `No ${ENV_VAR} is set and the server cannot create a key file at ${primary} (${primaryDir.reason || 'not writable'}). Set the variable in the cPanel Node.js application environment and restart.`,
    generate: GENERATE_COMMAND,
  };
}

/**
 * Parse the configured master key.
 * @returns {{key: Buffer|null, raw: string, problem: string|null, source: 'env'|'file'|null, keyPath: string|null}}
 */
function readKey() {
  const state = inspect();
  const raw = state.keyFile && state.keyFile.raw ? state.keyFile.raw : '';
  return {
    raw,
    key: state.key || null,
    problem: state.key ? null : state.problem,
    source: state.source,
    keyPath: state.keyPath,
    state: state.state,
  };
}

/**
 * Create the server-managed key file (first save from the dashboard).
 *
 * Exclusive create: an existing key is never overwritten — that would make
 * every stored credential undecryptable. New installs prefer the persistent
 * location outside the application root; if that is not writable the legacy
 * application folder is used, exactly like earlier releases.
 */
function createKeyFile(target = null) {
  const custom = String(process.env.API_CREDENTIALS_KEY_FILE || '').trim();
  const candidates = target ? [target] : custom ? [resolvePath(custom)] : [PERSISTENT_KEY_FILE, LEGACY_KEY_FILE];
  const failures = [];

  for (const file of candidates) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, `${crypto.randomBytes(KEY_BYTES).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
      return { path: file, created: true };
    } catch (err) {
      // another request created the file first — use theirs, never overwrite
      if (err && err.code === 'EEXIST' && fileExists(file)) return { path: file, created: false };
      failures.push(`${file}: ${err && err.code ? err.code : 'write failed'}`);
    }
  }

  throw failConfiguration(
    'KEY_FILE_UNWRITABLE',
    `API credentials cannot be saved: ${ENV_VAR} is not set and the server could not create its key file (${failures.join('; ')}).`
  );
}

/**
 * True when credentials can be stored: a usable key exists, or the server can
 * create one on the first save in a writable location.
 */
function isConfigured() {
  return inspect().canEncrypt;
}

/**
 * Safe status for the admin dashboard: says whether encryption is ready and
 * how to fix it — and never includes the key itself.
 */
function status() {
  const state = inspect();
  const configured = Boolean(state.canEncrypt);
  const result = {
    configured,
    ready: configured,
    state: state.state,
    algorithm: ALGORITHM,
    keyEnvVar: ENV_VAR,
    source: state.source,
    keyId: state.keyId,
    keyPath: state.keyPath,
    keyFile: state.keyFile
      ? {
          path: state.keyFile.path,
          exists: state.keyFile.exists,
          readable: state.keyFile.readable,
          valid: state.keyFile.valid,
          mode: state.keyFile.mode,
          legacy: state.keyFile.legacy,
          explicit: state.keyFile.explicit,
        }
      : null,
    legacyKeyFile: state.legacyKeyFile,
    persistentKeyFile: state.persistentKeyFile,
    explicitKeyFile: state.explicitKeyFile,
    writable: state.writable,
    canEncrypt: configured,
    canDecrypt: Boolean(state.canDecrypt),
    message: state.message,
  };

  if (state.pending) {
    result.pending = true;
  } else if (!configured) {
    result.problem = state.problem || state.state;
    result.generate = GENERATE_COMMAND;
  }

  // A legacy key still works, but it sits inside the application folder and a
  // ZIP re-upload/cleanup can remove it. Report the optional migration; never
  // perform it automatically.
  if (state.source === 'file' && state.keyFile && state.keyFile.legacy) {
    result.legacyLocation = true;
    result.migrationRecommended = true;
    result.migration = {
      required: false,
      from: state.keyFile.path,
      to: state.persistentKeyFile,
      steps: [
        'Back up the application and database, and keep the current key file untouched.',
        'Copy the existing key file to the new location (never move or regenerate it).',
        `Set API_CREDENTIALS_KEY_FILE=${state.persistentKeyFile} in the cPanel Node.js environment and restart.`,
        'Verify a saved credential can still be tested/activated, then keep the old file as a backup.',
      ],
    };
  }

  return result;
}

/** Non-secret identifier of the loaded master key (detects a rotated key). */
function keyId(keyBuffer) {
  const key = keyBuffer || readKey().key;
  if (!key) return null;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * Return the master key for ENCRYPTING, creating the server key file on first
 * use when no environment key is set. Throws when encryption is unusable.
 */
function assertConfigured() {
  let state = inspect();
  if (state.key) return state.key;
  if (state.canEncrypt && (state.state === 'PENDING' || state.state === 'PENDING_FALLBACK')) {
    createKeyFile(state.keyPath);
    state = inspect();
    if (state.key) return state.key;
  }
  const message =
    state.problem === 'NOT_SET' || state.state === 'MISSING'
      ? `API credentials cannot be saved: ${ENV_VAR} is not configured on the server.`
      : `API credentials cannot be saved: ${state.message || `${ENV_VAR} is not usable (${state.problem || state.state})`}`;
  throw failConfiguration(state.problem || state.state || 'NOT_SET', message);
}

/** AAD binds the ciphertext to the provider + the field it belongs to. */
function buildAad({ provider, field = 'api_key' }) {
  return Buffer.from(`goalpredict:api-credential:${String(provider)}:${String(field)}`, 'utf8');
}

/**
 * Encrypt a secret for storage.
 * @returns {{ciphertext: Buffer, iv: Buffer, tag: Buffer, algorithm: string, keyId: string}}
 */
function encryptSecret(plaintext, { provider, field = 'api_key' } = {}) {
  const secret = String(plaintext === null || plaintext === undefined ? '' : plaintext);
  if (!secret) throw AppError.badRequest('No value to encrypt', 'EMPTY_SECRET');
  const key = assertConfigured();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(buildAad({ provider, field }));
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return {
    ciphertext,
    iv,
    tag: cipher.getAuthTag(),
    algorithm: ALGORITHM,
    keyId: keyId(key),
  };
}

/**
 * Decrypt a stored secret.
 *
 * Fails with a stable, actionable code:
 *   ENCRYPTION_KEY_MISSING  — no usable master key on the server
 *   CREDENTIAL_UNREADABLE   — the master key changed, or the row was tampered
 *                             with (GCM authentication failed)
 */
function decryptSecret(record, { provider, field = 'api_key' } = {}) {
  if (!record || !record.key_ciphertext) {
    throw new AppError('No stored credential to decrypt', { status: 500, code: 'CREDENTIAL_MISSING' });
  }
  const { key, problem } = readKey();
  if (!key) {
    throw failConfiguration(
      problem || 'NOT_SET',
      `The stored API credential cannot be decrypted: ${ENV_VAR} / the server key file is missing or unusable.`
    );
  }
  const ciphertext = Buffer.from(record.key_ciphertext);
  const iv = Buffer.from(record.key_iv);
  const tag = Buffer.from(record.key_tag);

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new AppError('The stored API credential is malformed', {
      status: 500,
      code: 'CREDENTIAL_UNREADABLE',
      details: { reason: 'MALFORMED_RECORD' },
    });
  }

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(buildAad({ provider, field }));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    if (!plaintext) throw new Error('empty plaintext');
    return plaintext;
  } catch (_err) {
    throw new AppError(
      `The stored API credential cannot be decrypted with the current ${ENV_VAR} / key file. ` +
        'The encryption key was changed after the credential was saved — re-enter and save the API key.',
      { status: 500, code: 'CREDENTIAL_UNREADABLE', details: { reason: 'AUTH_TAG_MISMATCH' } }
    );
  }
}

/**
 * Masked display form — the ONLY form of a stored key that ever reaches the
 * browser: `********abcd`. Very short values are fully hidden.
 */
function maskSecret(secret) {
  const value = String(secret === null || secret === undefined ? '' : secret);
  if (!value) return null;
  if (value.length <= 8) return '*'.repeat(8);
  return `${'*'.repeat(8)}${value.slice(-4)}`;
}

/**
 * Mask a key from its stored parts (no plaintext needed):
 * `********abcd`. Falls back to a generic mask when the last4 is unknown.
 */
function maskFromStoredParts({ last4, length } = {}) {
  const tail = last4 ? String(last4) : '';
  const size = Number(length) || 0;
  if (tail && size > 8) return `${'*'.repeat(8)}${tail}`;
  return '*'.repeat(8);
}

/** Non-reversible identifier of a key value: change detection only. */
function fingerprint(secret) {
  return crypto.createHash('sha256').update(String(secret), 'utf8').digest('hex');
}

/** Last four characters of a key (masked display) — never the whole value. */
function lastFour(secret) {
  const value = String(secret === null || secret === undefined ? '' : secret);
  return value.length >= 4 ? value.slice(-4) : '';
}

module.exports = {
  ALGORITHM,
  defaultPersistentKeyFile,
  ENV_VAR,
  GENERATE_COMMAND,
  LEGACY_KEY_FILE,
  PERSISTENT_KEY_FILE,
  keyFilePath,
  inspect,
  inspectKeyFile,
  directoryWritable,
  isConfigured,
  status,
  keyId,
  assertConfigured,
  encryptSecret,
  decryptSecret,
  maskSecret,
  maskFromStoredParts,
  fingerprint,
  lastFour,
};
