#!/usr/bin/env node
'use strict';

/**
 * Seed default settings + the first administrator.
 *   npm run db:seed
 *
 * The admin password comes from ADMIN_PASSWORD in .env. Change it immediately
 * after the first login (the account is flagged must_change_password).
 */

const bcrypt = require('bcryptjs');
const config = require('../server/config');
const db = require('../server/database/queries');
const pool = require('../server/database/connection');
const settingsService = require('../server/services/settingsService');

async function main() {
  await settingsService.ensureDefaults();
  const settings = await db.getAllSettings();
  process.stdout.write(`Settings present: ${settings.length}\n`);

  const { username, email, password } = config.bootstrapAdmin;
  if (!username || !password) {
    process.stdout.write('ADMIN_USERNAME / ADMIN_PASSWORD not set — skipping admin creation.\n');
  } else {
    const existing = await db.getAdminByLogin(username);
    if (existing) {
      process.stdout.write(`Administrator "${username}" already exists — left untouched.\n`);
    } else {
      const passwordHash = await bcrypt.hash(password, config.auth.bcryptRounds);
      const id = await db.createAdmin({
        username,
        email: email || `${username}@localhost`,
        passwordHash,
        role: 'superadmin',
        mustChangePassword: true,
      });
      process.stdout.write(`Administrator created: id=${id} username=${username}\n`);
      process.stdout.write('IMPORTANT: log in and change this password immediately.\n');
    }
  }

  process.stdout.write(
    [
      '',
      'Reminders:',
      '  * market = OVER 1.5 GOALS only (locked)',
      '  * automatic ticket generation = OFF (locked)',
      '  * tickets are created only from Admin > GENERATE TODAY\'S TICKET',
      '',
    ].join('\n')
  );
}

main()
  .catch((err) => {
    process.stderr.write(`Seeding failed: ${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.closePool());
