#!/usr/bin/env node
'use strict';

/**
 * BUILD THE DEPLOYMENT ZIP — the exact upload package for cPanel.
 *
 *   npm run build:zip            # rebuild GoalPredict-cPanel-deployment.zip
 *   node scripts/build-deployment-zip.js --check   # verify it is up to date
 *
 * Why this exists: the tracked artefact drifts. It already shipped once with a
 * stale `public/index.html` that still contained the admin controls. A ZIP that
 * does not match the reviewed source is a deployment of unreviewed code, so:
 *
 *   * the archive is built from the files **git tracks** (never node_modules,
 *     .git, logs, .env or a stray file on disk), and
 *   * it is byte-for-byte reproducible — entries are sorted, and every entry
 *     carries a fixed timestamp — so `--check` can prove the committed ZIP is
 *     the build of the committed tree. `tests/deployment-zip.test.js` runs the
 *     same check inside `npm test`.
 *
 * No dependency is needed: `zlib` is part of Node, so this works on cPanel too.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ARCHIVE_NAME = 'GoalPredict-cPanel-deployment.zip';
const ARCHIVE_PATH = path.join(ROOT, ARCHIVE_NAME);

/** Never include these, even if a future commit tracks them. */
const EXCLUDED_PREFIXES = ['node_modules/', '.git/', 'logs/', 'coverage/'];
const EXCLUDED_FILES = [ARCHIVE_NAME, '.env', '.env.local', '.DS_Store'];
const EXCLUDED_EXTENSIONS = ['.log'];

/* --------------------------- ZIP primitives ------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

// 1980-01-01 00:00:00, the earliest representable DOS timestamp: a fixed value
// so the archive is reproducible.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

function localHeader(name, crc, compressedSize, uncompressedSize) {
  const nameBuffer = Buffer.from(name, 'utf8');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4); // version needed
  header.writeUInt16LE(0, 6); // flags
  header.writeUInt16LE(8, 8); // deflate
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressedSize, 18);
  header.writeUInt32LE(uncompressedSize, 22);
  header.writeUInt16LE(nameBuffer.length, 26);
  header.writeUInt16LE(0, 28); // extra field length
  return Buffer.concat([header, nameBuffer]);
}

function centralHeader(name, crc, compressedSize, uncompressedSize, offset) {
  const nameBuffer = Buffer.from(name, 'utf8');
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4); // version made by
  header.writeUInt16LE(20, 6); // version needed
  header.writeUInt16LE(0, 8); // flags
  header.writeUInt16LE(8, 10); // deflate
  header.writeUInt16LE(DOS_TIME, 12);
  header.writeUInt16LE(DOS_DATE, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(compressedSize, 20);
  header.writeUInt32LE(uncompressedSize, 24);
  header.writeUInt16LE(nameBuffer.length, 28);
  header.writeUInt16LE(0, 30); // extra
  header.writeUInt16LE(0, 32); // comment
  header.writeUInt16LE(0, 34); // disk number
  header.writeUInt16LE(0, 36); // internal attributes
  header.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attributes: rw-r--r--
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, nameBuffer]);
}

function endOfCentralDirectory(entryCount, size, offset) {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(0x06054b50, 0);
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(entryCount, 8);
  record.writeUInt16LE(entryCount, 10);
  record.writeUInt32LE(size, 12);
  record.writeUInt32LE(offset, 16);
  record.writeUInt16LE(0, 20);
  return record;
}

/* ------------------------------- build ------------------------------ */

/** Every file git tracks, minus the deployment-only exclusions. */
function deploymentFiles() {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);

  return tracked
    .filter((file) => !EXCLUDED_FILES.includes(file))
    .filter((file) => !EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix)))
    .filter((file) => !EXCLUDED_EXTENSIONS.some((ext) => file.endsWith(ext)))
    .filter((file) => fs.existsSync(path.join(ROOT, file)))
    .sort();
}

/** Build the archive in memory. Deterministic: same tree -> same bytes. */
function buildArchive() {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const file of deploymentFiles()) {
    const content = fs.readFileSync(path.join(ROOT, file));
    const deflated = zlib.deflateRawSync(content, { level: 9 });
    const crc = crc32(content);

    const local = localHeader(file, crc, deflated.length, content.length);
    parts.push(local, deflated);
    central.push(centralHeader(file, crc, deflated.length, content.length, offset));
    offset += local.length + deflated.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = endOfCentralDirectory(central.length, centralBuffer.length, offset);
  return Buffer.concat([...parts, centralBuffer, end]);
}

/* -------------------------------- run ------------------------------- */

function main() {
  const check = process.argv.includes('--check');
  const archive = buildArchive();

  if (check) {
    if (!fs.existsSync(ARCHIVE_PATH)) {
      process.stderr.write(`${ARCHIVE_NAME} is missing — run \`npm run build:zip\`\n`);
      process.exitCode = 1;
      return;
    }
    const current = fs.readFileSync(ARCHIVE_PATH);
    if (!current.equals(archive)) {
      process.stderr.write(
        `${ARCHIVE_NAME} does NOT match the current source.\n` +
          'It is a deployment package: uploading it would deploy code that was never reviewed.\n' +
          'Run `npm run build:zip` and commit the result.\n'
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${ARCHIVE_NAME} is up to date (${archive.length} bytes)\n`);
    return;
  }

  fs.writeFileSync(ARCHIVE_PATH, archive);
  const files = deploymentFiles();
  process.stdout.write(`Wrote ${ARCHIVE_NAME}\n  ${files.length} files, ${archive.length} bytes\n`);
}

if (require.main === module) main();

module.exports = { buildArchive, deploymentFiles, ARCHIVE_NAME, ARCHIVE_PATH };
