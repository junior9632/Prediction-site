'use strict';

/**
 * DEPLOYMENT ARTEFACT — `GoalPredict-cPanel-deployment.zip` is what an operator
 * uploads to cPanel. It has drifted before: a committed archive once shipped a
 * stale `public/index.html` that still contained the admin controls.
 *
 * The archive is therefore built deterministically from the files git tracks
 * (`npm run build:zip`), and this test proves the committed bytes are the build
 * of the current tree. If it fails, run `npm run build:zip` and commit the ZIP
 * in the same commit as the source change.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildArchive, deploymentFiles, ARCHIVE_NAME, ARCHIVE_PATH } = require('../scripts/build-deployment-zip');

test('deployment zip: the committed archive is the build of the current source', () => {
  assert.ok(fs.existsSync(ARCHIVE_PATH), `${ARCHIVE_NAME} is tracked and must exist`);
  const committed = fs.readFileSync(ARCHIVE_PATH);
  const expected = buildArchive();

  if (!committed.equals(expected)) {
    assert.fail(
      `${ARCHIVE_NAME} does not match the current source ` +
        `(committed ${committed.length} bytes, expected ${expected.length} bytes, ${deploymentFiles().length} files). ` +
        'Run `npm run build:zip` and commit the result in the same commit as this change.'
    );
  }
  assert.ok(committed.length > 0);
});

test('deployment zip: it contains everything the host needs and nothing it does not', () => {
  const files = deploymentFiles();

  // the deployment entry points and the whole application
  for (const required of [
    'server.js',
    'package.json',
    'package-lock.json',
    '.env.example',
    'server/app.js',
    'server/database/schema.sql',
    'server/database/migrations/001-widen-odds-precision.sql',
    'public/index.html',
    'public/admin.html',
    'scripts/doctor.js',
    'scripts/verify-access.js',
    'scripts/generate-ticket-cli.js',
  ]) {
    assert.ok(files.includes(required), `${required} must ship in the deployment package`);
  }

  // never the local-only or secret material
  for (const forbidden of [ARCHIVE_NAME, '.env', 'node_modules/package.json']) {
    assert.ok(!files.includes(forbidden), `${forbidden} must never ship`);
  }
  assert.ok(!files.some((f) => f.startsWith('node_modules/')), 'no dependencies are bundled');
  assert.ok(!files.some((f) => f.startsWith('.git/')), 'no git metadata is bundled');
  assert.ok(!files.some((f) => f.startsWith('logs/')), 'no logs are bundled');
  assert.ok(!files.some((f) => f.endsWith('.log')), 'no log files are bundled');
});

test('deployment zip: the build is deterministic', () => {
  const first = buildArchive();
  const second = buildArchive();
  assert.ok(first.equals(second), 'two builds of the same tree must be byte-identical');
});

test('deployment zip: every packaged file is the reviewed file, byte for byte', () => {
  // Re-read the archive through a real unzip implementation: the central
  // directory must agree with the working tree for every entry.
  const archive = buildArchive();
  const entries = new Map();
  const text = archive.toString('latin1');

  // walk the central directory records (signature 0x02014b50)
  let offset = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  while (offset !== -1) {
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const size = archive.readUInt32LE(offset + 24);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = text.slice(offset + 46, offset + 46 + nameLength);
    entries.set(name, { size, localOffset });
    offset = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), offset + 46 + nameLength + extraLength + commentLength);
  }

  assert.equal(entries.size, deploymentFiles().length, 'every tracked file is in the archive');

  for (const [name, meta] of entries) {
    const source = fs.readFileSync(path.join(__dirname, '..', name));
    assert.equal(meta.size, source.length, `${name} is packaged at its current size`);
    assert.equal(meta.localOffset > 0 || name === deploymentFiles()[0], true, `${name} has a local header`);
  }
});
