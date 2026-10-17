'use strict';

/**
 * The admin can configure the API from the dashboard without touching the
 * server environment: with no API_CREDENTIALS_ENCRYPTION_KEY the vault creates
 * its own key file on first save.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
const keyFile = path.join(dir, 'nested', 'api-credentials.key');
delete process.env.API_CREDENTIALS_ENCRYPTION_KEY;
process.env.API_CREDENTIALS_KEY_FILE = keyFile;
delete process.env.API_CREDENTIALS_AUTO_KEY;

const vault = require('../server/utils/credentialVault');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('with no env key the vault is ready and creates its key file on first save', () => {
  assert.equal(vault.isConfigured(), true);
  assert.equal(vault.status().pending, true);
  assert.equal(fs.existsSync(keyFile), false, 'nothing is created until a key is saved');

  const enc = vault.encryptSecret('my-live-api-key', { provider: 'api_football' });
  assert.ok(fs.existsSync(keyFile));
  if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o077, 0, 'owner-only permissions');
  assert.match(fs.readFileSync(keyFile, 'utf8').trim(), /^[0-9a-f]{64}$/);

  const plain = vault.decryptSecret(
    { key_ciphertext: enc.ciphertext, key_iv: enc.iv, key_tag: enc.tag },
    { provider: 'api_football' }
  );
  assert.equal(plain, 'my-live-api-key');
  assert.equal(vault.status().source, 'file');
  assert.equal(vault.status().pending, undefined);
});

test('the key file is never overwritten, and the env variable wins when set', () => {
  const before = fs.readFileSync(keyFile, 'utf8');
  vault.encryptSecret('another-key-value', { provider: 'api_football' });
  assert.equal(fs.readFileSync(keyFile, 'utf8'), before);

  process.env.API_CREDENTIALS_ENCRYPTION_KEY = 'c'.repeat(64);
  try {
    assert.equal(vault.status().source, 'env');
  } finally {
    delete process.env.API_CREDENTIALS_ENCRYPTION_KEY;
  }
});

test('AUTO_KEY=0 restores the strict environment-only behaviour', () => {
  process.env.API_CREDENTIALS_AUTO_KEY = '0';
  try {
    fs.rmSync(keyFile);
    assert.equal(vault.isConfigured(), false);
    assert.throws(() => vault.encryptSecret('x-key-value', { provider: 'api_football' }), (e) => e.code === 'ENCRYPTION_KEY_MISSING');
    assert.equal(fs.existsSync(keyFile), false);
  } finally {
    delete process.env.API_CREDENTIALS_AUTO_KEY;
  }
});

test('an unwritable key location fails safely with ENCRYPTION_KEY_MISSING', () => {
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'a file, not a directory');
  process.env.API_CREDENTIALS_KEY_FILE = path.join(blocker, 'key');
  try {
    assert.throws(
      () => vault.encryptSecret('x-key-value', { provider: 'api_football' }),
      (e) => e.code === 'ENCRYPTION_KEY_MISSING' && e.details.reason === 'KEY_FILE_UNWRITABLE'
    );
  } finally {
    process.env.API_CREDENTIALS_KEY_FILE = keyFile;
  }
});
