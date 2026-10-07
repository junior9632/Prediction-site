'use strict';

/**
 * MySQL / MariaDB connection pool (mysql2).
 *
 *  - every statement uses placeholders (parameterised SQL) => no injection
 *  - DECIMAL columns are returned as STRINGS on purpose so odds keep their
 *    exact published value and can be fed into utils/decimal.js
 *  - DATETIME values are read/written in UTC (timezone: 'Z')
 */

const mysql = require('mysql2/promise');
const config = require('../config');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');

let pool = null;

function getPool() {
  if (pool) return pool;
  pool = mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    waitForConnections: true,
    connectionLimit: config.db.connectionLimit,
    queueLimit: 0,
    timezone: config.db.timezone,
    charset: config.db.charset,
    decimalNumbers: false,
    dateStrings: false,
    multipleStatements: false,
    namedPlaceholders: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
  });
  return pool;
}

async function query(sql, params = []) {
  try {
    const [rows] = await getPool().execute(sql, params);
    return rows;
  } catch (err) {
    if (isConnectionError(err)) {
      // A misconfigured deployment (wrong host/credentials, no privileges on
      // the database) is an availability problem, not a query bug: report it
      // as 503 DB_UNAVAILABLE. The raw MySQL message names the database user
      // and host, so it is only attached outside production.
      throw AppError.upstream('Database is unavailable', 'DB_UNAVAILABLE', config.isProduction ? undefined : {
        code: err.code,
        message: err.message,
      });
    }
    logger.error('SQL error', { code: err.code, errno: err.errno, sql: sql.slice(0, 400), message: err.message });
    throw new AppError('Database query failed', {
      status: 500,
      code: `SQL_${err.code || 'ERROR'}`,
      details: config.isProduction ? undefined : { sqlError: err.sqlMessage || err.message },
      expose: !config.isProduction,
    });
  }
}

function isConnectionError(err) {
  const codes = [
    'ECONNREFUSED',
    'EHOSTUNREACH',
    'ENOTFOUND',
    'ETIMEDOUT',
    'ECONNRESET',
    'EPIPE',
    'PROTOCOL_CONNECTION_LOST',
    'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
    'ER_ACCESS_DENIED_ERROR',
    // the user exists but was never granted privileges on this database —
    // a deployment/configuration fault, seen as SQL_ER_DBACCESS_DENIED_ERROR
    'ER_DBACCESS_DENIED_ERROR',
    'ER_BAD_DB_ERROR',
    'POOL_CLOSED',
  ];
  return codes.includes(err && err.code);
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows && rows.length ? rows[0] : null;
}

/** @returns {{insertId:number, affectedRows:number}} */
async function execute(sql, params = []) {
  const rows = await query(sql, params);
  return { insertId: rows.insertId || 0, affectedRows: rows.affectedRows || 0 };
}

/**
 * Run `work` inside a transaction. The callback receives the raw connection
 * so every statement shares the same transaction.
 */
async function transaction(work) {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const result = await work({
      query: async (sql, params = []) => {
        const [rows] = await connection.execute(sql, params);
        return rows;
      },
      queryOne: async (sql, params = []) => {
        const [rows] = await connection.execute(sql, params);
        return rows && rows.length ? rows[0] : null;
      },
      execute: async (sql, params = []) => {
        const [rows] = await connection.execute(sql, params);
        return { insertId: rows.insertId || 0, affectedRows: rows.affectedRows || 0 };
      },
    });
    await connection.commit();
    return result;
  } catch (err) {
    try {
      await connection.rollback();
    } catch (_) {
      /* ignore */
    }
    throw err;
  } finally {
    connection.release();
  }
}

async function ping() {
  const connection = await getPool().getConnection();
  try {
    await connection.ping();
    return true;
  } finally {
    connection.release();
  }
}

/**
 * LIMIT/OFFSET cannot be safely bound on every MySQL/MariaDB version when
 * using prepared statements, so they are inlined AFTER integer validation.
 */
function limitClause(limit, offset = 0) {
  const l = Number.isInteger(limit) && limit >= 0 ? Math.min(limit, 100000) : 50;
  const o = Number.isInteger(offset) && offset >= 0 ? Math.min(offset, 10000000) : 0;
  return ` LIMIT ${l} OFFSET ${o}`;
}

async function closePool() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end().catch(() => {});
  }
}

module.exports = { getPool, query, queryOne, execute, transaction, ping, limitClause, closePool };
