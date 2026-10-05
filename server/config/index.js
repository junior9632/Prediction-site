'use strict';

/**
 * Centralised, validated environment configuration.
 *
 * SECURITY: the API-Football key and every DB credential stay in this
 * process. Nothing in `public/` may ever receive them (see
 * scripts/check-no-secrets.js which enforces that at build/test time).
 */

const path = require('path');
const dotenv = require('dotenv');

const rootDir = path.resolve(__dirname, '..', '..');
dotenv.config({ path: path.join(rootDir, '.env') });

function str(key, fallback = '') {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : String(v);
}

function int(key, fallback) {
  const v = parseInt(str(key, ''), 10);
  return Number.isFinite(v) ? v : fallback;
}

function float(key, fallback) {
  const v = parseFloat(str(key, ''));
  return Number.isFinite(v) ? v : fallback;
}

function bool(key, fallback = false) {
  const v = str(key, '').toLowerCase();
  if (v === '') return fallback;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function list(key, fallback = []) {
  const v = str(key, '');
  if (!v) return fallback;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

const nodeEnv = str('NODE_ENV', 'development');
const appUrl = str('APP_URL', `http://localhost:${int('PORT', 3000)}`).replace(/\/+$/, '');

const apiFootballHost = str('API_FOOTBALL_HOST', 'v3.football.api-sports.io').replace(/\/+$/, '');

const config = {
  env: nodeEnv,
  isProduction: nodeEnv === 'production',
  isTest: nodeEnv === 'test',
  rootDir,
  port: int('PORT', 3000),
  host: str('HOST', '0.0.0.0'),
  appUrl,
  trustProxy: bool('TRUST_PROXY', false) ? 1 : false,

  db: {
    host: str('DB_HOST', 'localhost'),
    port: int('DB_PORT', 3306),
    user: str('DB_USER', 'root'),
    password: str('DB_PASSWORD', ''),
    database: str('DB_NAME', 'football_predictions'),
    connectionLimit: int('DB_CONNECTION_LIMIT', 8),
    // 'Z' = store/read DATETIME values as UTC. All kickoff times are kept in
    // UTC in the database and rendered in the visitor's timezone client side.
    timezone: 'Z',
    charset: 'utf8mb4_unicode_ci',
    multipleStatements: false,
  },

  apiFootball: {
    key: str('API_FOOTBALL_KEY', ''),
    host: apiFootballHost,
    // RapidAPI style hosts embed the version in the host string.
    baseUrl: apiFootballHost.includes('rapidapi.com')
      ? `https://${apiFootballHost}`
      : `https://${apiFootballHost}/v3`,
    ratePerMinute: int('API_FOOTBALL_RATE_PER_MINUTE', 60),
    timeoutMs: int('API_FOOTBALL_TIMEOUT_MS', 15000),
    maxRetries: int('API_FOOTBALL_MAX_RETRIES', 2),
    isRapidApi: apiFootballHost.includes('rapidapi.com'),
  },

  auth: {
    jwtSecret: str('JWT_SECRET', ''),
    jwtExpiresIn: str('JWT_EXPIRES_IN', '8h'),
    cookieName: str('COOKIE_NAME', 'fp_token'),
    cookieSecure: bool('COOKIE_SECURE', nodeEnv === 'production'),
    cookieSameSite: str('COOKIE_SAMESITE', 'strict'),
    bcryptRounds: int('BCRYPT_ROUNDS', 12),
    loginMaxAttempts: int('LOGIN_MAX_ATTEMPTS', 5),
    loginLockMinutes: int('LOGIN_LOCK_MINUTES', 15),
  },

  bootstrapAdmin: {
    username: str('ADMIN_USERNAME', 'admin'),
    email: str('ADMIN_EMAIL', ''),
    password: str('ADMIN_PASSWORD', ''),
  },

  security: {
    corsOrigins: list('CORS_ORIGINS', []),
    rateLimitWindowMs: int('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
    rateLimitMax: int('RATE_LIMIT_MAX', 600),
    authRateLimitMax: int('AUTH_RATE_LIMIT_MAX', 10),
    adminRateLimitMax: int('ADMIN_RATE_LIMIT_MAX', 120),
    generateRateLimitMax: int('GENERATE_RATE_LIMIT_MAX', 10),
    maxBodySize: str('MAX_BODY_SIZE', '256kb'),
  },

  scheduler: {
    enabled: bool('ENABLE_INTERNAL_SCHEDULER', false),
    fixturesMinutes: int('SCHEDULER_FIXTURES_MINUTES', 30),
    oddsMinutes: int('SCHEDULER_ODDS_MINUTES', 20),
    resultsMinutes: int('SCHEDULER_RESULTS_MINUTES', 30),
  },

  odds: {
    freshnessMinutes: int('ODDS_FRESHNESS_MINUTES', 90),
    minTotalOdds: float('MIN_TOTAL_ODDS', 2.0),
    maxTotalOdds: float('MAX_TOTAL_ODDS', 4.0),
    minConfidence: float('MIN_CONFIDENCE', 72),
    maxRisk: float('MAX_RISK', 35),
    minDataQuality: float('MIN_DATA_QUALITY', 60),
    maxSelections: int('MAX_SELECTIONS', 6),
  },

  logging: {
    level: str('LOG_LEVEL', 'info'),
    file: str('LOG_FILE', ''),
    requestLogging: bool('REQUEST_LOGGING', true),
  },

  // Hard product rule: the only market this platform will ever predict.
  market: Object.freeze({
    key: 'over_1_5',
    label: 'Over 1.5 Goals',
    goalLine: 1.5,
  }),
};

/** Fail fast in production when mandatory secrets are missing. */
config.validate = function validate() {
  const problems = [];
  if (config.isProduction) {
    if (!config.apiFootball.key) problems.push('API_FOOTBALL_KEY is not set');
    if (!config.auth.jwtSecret || config.auth.jwtSecret.length < 32) {
      problems.push('JWT_SECRET must be set to a long random string (32+ characters)');
    }
    if (!config.db.database) problems.push('DB_NAME is not set');
  }
  return problems;
};

module.exports = config;
