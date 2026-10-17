#!/usr/bin/env node
'use strict';

/**
 * Secret leakage guard.
 *
 * Scans every browser-served file (public/**) for API keys, DB credentials or
 * JWT secrets. Exits non-zero when anything sensitive is found, so this can be
 * wired into CI or run before every deploy:
 *
 *   npm run lint:secrets
 */

const fs = require('fs');
const path = require('path');
const config = require('../server/config');

const ROOT = path.join(__dirname, '..', 'public');
const FORBIDDEN_PATTERNS = [
  { name: 'API-Football header', re: /x-apisports-key|x-rapidapi-key/i },
  { name: 'API key env var', re: /API_FOOTBALL_KEY/ },
  { name: 'DB password env var', re: /DB_PASSWORD/ },
  { name: 'JWT secret env var', re: /JWT_SECRET/ },
  { name: 'API-Football endpoint', re: /api-sports\.io|rapidapi\.com/i },
  { name: 'mysql connection string', re: /mysql:\/\/|mariadb:\/\//i },
];

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (/\.(html?|js|css|json|svg|txt|map)$/i.test(entry.name)) files.push(full);
  }
  return files;
}

function main() {
  const files = walk(ROOT);
  const problems = [];

  if (config.apiFootball.key) {
    FORBIDDEN_PATTERNS.push({ name: 'the configured API key itself', re: new RegExp(config.apiFootball.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
  }

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.re.test(content)) {
        problems.push({ file: path.relative(process.cwd(), file), pattern: pattern.name });
      }
    }
  }

  if (problems.length) {
    process.stderr.write('SECRET LEAK DETECTED in browser-served files:\n');
    for (const p of problems) process.stderr.write(`  - ${p.file}: ${p.pattern}\n`);
    process.stderr.write('\nThe API key must stay on the Node.js server (environment variables).\n');
    process.exit(1);
  }

  process.stdout.write(`OK — ${files.length} public file(s) scanned, no secrets found.\n`);
}

main();
