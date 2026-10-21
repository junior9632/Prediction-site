'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseCredentialGrants: parse } = require('../server/database/credentialGrants');

test('grant scopes: escaped literals, quoted dots/backticks, global and table grants', () => {
  for (const [scope, database] of [
    ['`account\\_goalpredict`.*', 'account_goalpredict'],
    ['`account\\%goalpredict`.*', 'account%goalpredict'],
    ['`account.db`.*', 'account.db'],
    ['`account``db`.*', 'account`db'],
    ['*.*', 'testdb'],
    ['`account_goalpredict`.`api_credentials`', 'account_goalpredict'],
  ]) {
    const report = parse([`GRANT ALL PRIVILEGES ON ${scope} TO 'app'@'localhost'`], database);
    assert.equal(report.checked, true, scope);
    assert.equal(report.insert, true, scope);
    assert.equal(report.update, true, scope);
  }
});

test('grant scopes: another database/table cannot establish storage privileges', () => {
  for (const scope of ['`otherdb`.*', '`testdb`.`api_connection_events`']) {
    const report = parse([`GRANT ALL PRIVILEGES ON ${scope} TO 'app'@'localhost'`], 'testdb');
    assert.equal(report.insert, false);
  }
});

test('separate grants combine, SELECT alone does not prove writes', () => {
  const select = "GRANT SELECT ON `testdb`.* TO 'app'@'localhost'";
  assert.equal(parse([select], 'testdb').insert, false);
  assert.equal(parse([select, "GRANT INSERT, UPDATE ON `testdb`.`api_credentials` TO 'app'@'localhost'"], 'testdb').update, true);
});

test('ambiguous unescaped wildcard semantics and empty metadata stay unknown', () => {
  assert.equal(parse([], 'testdb').checked, false);
  assert.equal(parse(["GRANT ALL ON `account_goalpredict`.* TO 'app'@'localhost'"], 'account_goalpredict').checked, false);
});
