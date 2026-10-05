'use strict';

/** Forward rejected promises from async route handlers to Express' error pipeline. */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = { asyncHandler };
