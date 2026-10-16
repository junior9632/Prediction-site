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
 *     `API_CREDENTIALS_ENCRYPTION_KEY` (64 hex chars / base64 of 32 bytes). When
 *     that variable is NOT set, the vault creates a random key file on the
 *     server's own disk the first time an administrator saves a credential from
 *     the dashboard (`storage/api-credentials.key`, mode 0600, git-ignored) so
 *     no one has to touch the server environment. The environment variable
 *     always wins when present. The key is never written to the database, never
 *     logged and never sent to the browser.
 *   * FAIL SAFE: with no usable master key, `encryptSecret` refuses to store
 *     anything (it throws) — the platform never silently saves a plaintext key
 *     and never downgrades to "no encryption".
 *
 * The module reads `process.env` on every call (with a tiny cache keyed on the
 * raw value), so a key can be rotated by restarting the app with a new value —
 * see `keyId()` and `describeStoredKey()` for how a rotation is reported.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { AppError } = require('./errors');

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ENV_VAR = 'API_CREDENTIALS_ENCRYPTION_KEY';

/** How an operator creates the value, shown verbatim in the dashboard + docs. */
const GENERATE_COMMAND = `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`;

const DEFAULT_KEY_FILE = path.resolve(__dirname, '..', '..', 'storage', 'api-credentials.key');

let cached = { raw: null, key: null, problem: null };

/** Where the auto-managed key file lives (override with API_CREDENTIALS_KEY_FILE). */
function keyFilePath() {
  const custom = String(process.env.API_CREDENTIALS_KEY_FILE || '').trim();
  return custom ? path.resolve(custom) : DEFAULT_KEY_FILE;
}

/** API_CREDENTIALS_AUTO_KEY=0 turns the key file off (environment key only). */
function autoKeyEnabled() {
  return !/^(0|false|no|off)$/i.test(String(process.env.API_CREDENTIALS_AUTO_KEY || '1').trim());
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
      generate: GENERATE_COMMAND,
      hint: `Set ${ENV_VAR} in the cPanel Node.js application environment (or .env) to 64 hex characters and restart the application.${
        auto ? ` Alternatively make ${path.dirname(keyFilePath())} writable so the server can create its own key file.` : ''
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
 * Parse the configured master key.
 * @returns {{key: Buffer|null, raw: string, problem: string|null, source: 'env'|'file'|null}}
 */
function readKey() {
  const envRaw = String(process.env[ENV_VAR] || '').trim();

  if (envRaw) {
    if (cached.raw === envRaw && cached.source === 'env') return cached;
    const parsed = parseKey(envRaw);
    cached = { raw: envRaw, key: parsed.key, problem: parsed.problem, source: 'env' };
    return cached;
  }

  // No environment key: use the server-managed key file when it exists.
  if (autoKeyEnabled()) {
    let fileRaw = '';
    try {
      fileRaw = fs.readFileSync(keyFilePath(), 'utf8').trim();
    } catch (_err) {
      fileRaw = '';
    }
    if (fileRaw) {
      const parsed = parseKey(fileRaw);
      cached = { raw: fileRaw, key: parsed.key, problem: parsed.problem ? 'KEY_FILE_INVALID' : null, source: 'file' };
      return cached;
    }
  }

  cached = { raw: '', key: null, problem: 'NOT_SET', source: null };
  return cached;
}

/**
 * Create the server-managed key file (first save from the dashboard).
 * Exclusive create: an existing key is never overwritten — that would make
 * every stored credential undecryptable.
 */
function createKeyFile() {
  const file = keyFilePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${crypto.randomBytes(KEY_BYTES).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    // another request created the file first — use theirs, never overwrite
    if (err && err.code === 'EEXIST' && fs.existsSync(file) && fs.statSync(file).isFile()) return;
    throw failConfiguration(
      'KEY_FILE_UNWRITABLE',
      `API credentials cannot be saved: ${ENV_VAR} is not set and the server could not create its key file (${err && err.code ? err.code : 'write failed'}).`
    );
  }
}

/**
 * True when credentials can be stored: either a usable master key exists, or
 * the server may create its own key file on the first save.
 */
function isConfigured() {
  const { key, problem } = readKey();
  if (key) return true;
  return problem === 'NOT_SET' && autoKeyEnabled();
}

/**
 * Safe status for the admin dashboard: says whether encryption is ready and
 * how to fix it — and never includes the key itself.
 */
function status() {
  const { key, problem, source } = readKey();
  if (key) {
    return {
      configured: true,
      algorithm: ALGORITHM,
      keyEnvVar: ENV_VAR,
      keyId: keyId(key),
      source,
      message:
        source === 'env'
          ? `${ENV_VAR} is set (${ALGORITHM}).`
          : `Encrypted with a key file managed by the server (${ALGORITHM}).`,
    };
  }
  if (problem === 'NOT_SET' && autoKeyEnabled()) {
    return {
      configured: true,
      pending: true,
      algorithm: ALGORITHM,
      keyEnvVar: ENV_VAR,
      keyId: null,
      source: 'file',
      message: `No ${ENV_VAR} is set — the server will create its own encryption key file the first time you save an API key (${ALGORITHM}).`,
    };
  }
  const messages = {
    NOT_SET: `${ENV_VAR} is not set on the server — saving an API key is disabled until it is configured.`,
    TOO_SHORT: `${ENV_VAR} is too short — it must be 64 hex characters (32 bytes).`,
    MALFORMED: `${ENV_VAR} is not valid — it must be 64 hex characters (32 bytes), or the base64 form of 32 bytes.`,
    WRONG_LENGTH: `${ENV_VAR} does not decode to 32 bytes.`,
    KEY_FILE_INVALID: `The server key file ${keyFilePath()} is not valid — remove it (stored keys must then be re-entered) or set ${ENV_VAR}.`,
  };
  return {
    configured: false,
    algorithm: ALGORITHM,
    keyEnvVar: ENV_VAR,
    keyId: null,
    problem,
    message: messages[problem] || messages.NOT_SET,
    generate: GENERATE_COMMAND,
  };
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
  let { key, problem } = readKey();
  if (key) return key;
  if (problem === 'NOT_SET' && autoKeyEnabled()) {
    createKeyFile();
    ({ key, problem } = readKey());
    if (key) return key;
  }
  const message =
    problem === 'NOT_SET'
      ? `API credentials cannot be saved: ${ENV_VAR} is not configured on the server.`
      : `API credentials cannot be saved: ${ENV_VAR} is set but not usable (${problem}).`;
  throw failConfiguration(problem || 'NOT_SET', message);
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
      `The stored API credential cannot be decrypted: ${ENV_VAR} is missing on the server.`
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
      `The stored API credential cannot be decrypted with the current ${ENV_VAR}. ` +
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
  ENV_VAR,
  GENERATE_COMMAND,
  keyFilePath,
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
