'use strict';

// Interpret only grant forms whose scope we can establish safely. Database-level
// escaped underscores/percent signs are literals in MySQL/MariaDB SHOW GRANTS.
// Wildcards, roles, partial revokes and column grants need server-side evidence;
// they must never become a fabricated denial (or an optimistic success).
function parseCredentialGrants(lines, databaseName) {
  const unknown = {
    checked: false, code: 'GRANT_FORMAT_UNVERIFIED',
    message: 'Effective privileges could not be established from grant metadata. No write was attempted.',
    select: null, insert: null, update: null, delete: null, all: null,
  };
  if (!lines.length) return unknown;
  const privileges = new Set();
  let all = false;
  const identifier = '(?:`(?:``|[^`])+`|[A-Za-z0-9_$]+|\\*)';
  const pattern = new RegExp(`^GRANT\\s+(.+?)\\s+ON\\s+(${identifier})\\.(${identifier})\\s+TO\\s+`, 'i');
  const unquote = (s) => s.startsWith('`') ? s.slice(1, -1).replace(/``/g, '`') : s;
  for (const line of lines) {
    const match = pattern.exec(line.trim());
    if (!match || /[()]/.test(match[1])) return unknown;
    let database = unquote(match[2]);
    const table = unquote(match[3]);
    const global = match[2] === '*' && match[3] === '*';
    if (!global && match[3] === '*') {
      // Unescaped patterns have server-version-dependent semantics (including
      // partial_revokes). Don't guess. Escaped patterns are literal names.
      if (/(^|[^\\])(?:\\\\)*[%_]/.test(database)) return unknown;
      database = database.replace(/\\([_%\\])/g, '$1');
      if (database.includes('\\')) return unknown;
    }
    const applicable = global || (database === databaseName && (match[3] === '*' || table === 'api_credentials'));
    if (!applicable) continue;
    const names = match[1].split(',').map((name) => name.trim().toUpperCase());
    if (names.includes('ALL') || names.includes('ALL PRIVILEGES')) all = true;
    for (const name of names) privileges.add(name);
  }
  const has = (name) => all || privileges.has(name);
  return { checked: true, select: has('SELECT'), insert: has('INSERT'), update: has('UPDATE'), delete: has('DELETE'), all };
}

module.exports = { parseCredentialGrants };
