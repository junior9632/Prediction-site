'use strict';

/**
 * Dependency-free input validation.
 *
 * Every value that reaches the database or the prediction engine passes
 * through here first. Unknown keys are dropped, types are coerced only
 * when unambiguous, and numbers/dates are range checked. NOTE: business
 * critical values (odds, confidence, results, ticket totals) are NEVER
 * accepted from the client — see middleware/validate.js usage in routes.
 */

const { AppError } = require('./errors');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function cleanString(value, maxLength) {
  // strip control characters, collapse nothing else (MySQL stores utf8mb4)
  let s = String(value).replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (typeof maxLength === 'number' && s.length > maxLength) s = s.slice(0, maxLength);
  return s;
}

function coerce(rule, raw, key, errors) {
  const fail = (msg) => {
    errors[key] = msg;
    return undefined;
  };

  if (raw === undefined || raw === null || raw === '') {
    if (rule.required) return fail(`${key} is required`);
    return rule.default !== undefined ? rule.default : undefined;
  }

  switch (rule.type) {
    case 'string': {
      if (typeof raw !== 'string' && typeof raw !== 'number') return fail(`${key} must be a string`);
      const s = cleanString(raw, rule.maxLength || 500);
      if (rule.minLength && s.length < rule.minLength) return fail(`${key} is too short`);
      if (rule.pattern && !rule.pattern.test(s)) return fail(`${key} has an invalid format`);
      if (rule.values && !rule.values.includes(s)) return fail(`${key} must be one of: ${rule.values.join(', ')}`);
      return s;
    }
    case 'int':
    case 'number':
    case 'float': {
      const n = rule.type === 'int' ? parseInt(raw, 10) : Number(raw);
      if (!Number.isFinite(n)) return fail(`${key} must be a number`);
      if (rule.type === 'int' && !Number.isInteger(n)) return fail(`${key} must be an integer`);
      if (rule.min !== undefined && n < rule.min) return fail(`${key} must be >= ${rule.min}`);
      if (rule.max !== undefined && n > rule.max) return fail(`${key} must be <= ${rule.max}`);
      return n;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      const s = String(raw).toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(s)) return true;
      if (['0', 'false', 'no', 'off'].includes(s)) return false;
      return fail(`${key} must be a boolean`);
    }
    case 'date': {
      const s = cleanString(raw, 10);
      if (!DATE_RE.test(s) || Number.isNaN(new Date(`${s}T00:00:00Z`).getTime())) {
        return fail(`${key} must be a date in YYYY-MM-DD format`);
      }
      return s;
    }
    case 'datetime': {
      const s = cleanString(raw, 40);
      if (!DATETIME_RE.test(s)) return fail(`${key} must be an ISO datetime`);
      const d = new Date(s);
      return Number.isNaN(d.getTime()) ? fail(`${key} is not a valid datetime`) : d.toISOString();
    }
    case 'email': {
      const s = cleanString(raw, 190).toLowerCase();
      return EMAIL_RE.test(s) ? s : fail(`${key} must be a valid email address`);
    }
    case 'enum': {
      const s = cleanString(raw, 60);
      return rule.values.includes(s) ? s : fail(`${key} must be one of: ${rule.values.join(', ')}`);
    }
    case 'array': {
      let arr = raw;
      if (typeof arr === 'string') {
        arr = arr.split(rule.separator || ',').map((v) => v.trim()).filter(Boolean);
      }
      if (!Array.isArray(arr)) return fail(`${key} must be an array`);
      if (rule.maxItems && arr.length > rule.maxItems) return fail(`${key} has too many items`);
      if (rule.itemType === 'int') {
        const nums = arr.map((v) => parseInt(v, 10));
        if (nums.some((n) => !Number.isFinite(n))) return fail(`${key} must contain integers`);
        return nums;
      }
      return arr.map((v) => cleanString(v, rule.maxLength || 120));
    }
    case 'json': {
      if (typeof raw === 'object') return raw;
      try {
        return JSON.parse(String(raw));
      } catch (_) {
        return fail(`${key} must be valid JSON`);
      }
    }
    default:
      return fail(`${key}: unsupported rule type ${rule.type}`);
  }
}

/**
 * @param {object} schema  field rules
 * @param {object} input   raw values
 * @param {object} options {strict:false} -> unknown keys rejected
 * @returns {{ok:boolean, value:object, errors:object}}
 */
function validate(schema, input, options = {}) {
  const data = input && typeof input === 'object' ? input : {};
  const value = {};
  const errors = {};

  for (const [key, rule] of Object.entries(schema || {})) {
    const coerced = coerce(rule, data[key], key, errors);
    if (errors[key] === undefined && coerced !== undefined) value[key] = coerced;
  }

  if (options.strict) {
    for (const key of Object.keys(data)) {
      if (!schema || !(key in schema)) errors[key] = `${key} is not an accepted field`;
    }
  }

  return { ok: Object.keys(errors).length === 0, value, errors };
}

/** Validate or throw a 400 AppError (used directly in controllers). */
function assertValid(schema, input, options) {
  const result = validate(schema, input, options);
  if (!result.ok) {
    throw AppError.badRequest('Invalid request parameters', 'VALIDATION_ERROR', result.errors);
  }
  return result.value;
}

module.exports = { validate, assertValid, cleanString };
