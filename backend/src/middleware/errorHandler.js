'use strict';

const STATUS_MAP = {
  VALIDATION_ERROR:       422,
  NOT_FOUND:              404,
  CONFLICT:               409,
  FORBIDDEN:              403,
  GMAIL_AUTH_ERROR:       503,
  GMAIL_RATE_LIMITED:     503,
  GMAIL_THREAD_NOT_FOUND: 404,
  THREAD_ALREADY_LINKED:  409,
};

// Four-argument signature required by Express to treat this as an error handler
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = STATUS_MAP[err.code] || 500;

  const body = {
    code:    err.code    || 'INTERNAL_ERROR',
    message: err.message || 'An unexpected error occurred',
  };

  // conflictingOrderId is non-sensitive; always include when present
  if (err.conflictingOrderId !== undefined) {
    body.conflictingOrderId = err.conflictingOrderId;
  }

  if (process.env.NODE_ENV === 'development' && err.stack) {
    body.stack = err.stack;
  }

  res.status(status).json(body);
}

module.exports = errorHandler;
