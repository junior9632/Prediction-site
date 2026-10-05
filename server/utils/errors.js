'use strict';

/** Application error with an HTTP status + machine readable code. */
class AppError extends Error {
  constructor(message, { status = 500, code = 'INTERNAL_ERROR', details = null, expose = true } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = expose; // false => message is hidden from clients
    this.isAppError = true;
  }

  static badRequest(message, code = 'BAD_REQUEST', details) {
    return new AppError(message, { status: 400, code, details });
  }

  static unauthorized(message = 'Authentication required', code = 'UNAUTHORIZED') {
    return new AppError(message, { status: 401, code });
  }

  static forbidden(message = 'Not allowed', code = 'FORBIDDEN') {
    return new AppError(message, { status: 403, code });
  }

  static notFound(message = 'Not found', code = 'NOT_FOUND') {
    return new AppError(message, { status: 404, code });
  }

  static conflict(message, code = 'CONFLICT', details) {
    return new AppError(message, { status: 409, code, details });
  }

  static unprocessable(message, code = 'UNPROCESSABLE', details) {
    return new AppError(message, { status: 422, code, details });
  }

  static tooMany(message = 'Too many requests', code = 'RATE_LIMITED') {
    return new AppError(message, { status: 429, code });
  }

  static upstream(message, code = 'UPSTREAM_UNAVAILABLE', details) {
    return new AppError(message, { status: 503, code, details });
  }

  static internal(message, code = 'INTERNAL_ERROR') {
    return new AppError(message, { status: 500, code, expose: false });
  }
}

module.exports = { AppError };
