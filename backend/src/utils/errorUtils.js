'use strict';

function makeError(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

function validationError(message) {
  return makeError('VALIDATION_ERROR', message);
}

function notFoundError(message) {
  return makeError('NOT_FOUND', message);
}

function conflictError(message) {
  return makeError('CONFLICT', message);
}

function forbiddenError(message) {
  return makeError('FORBIDDEN', message);
}

// ─── Phase L1: Gmail / lab-comm error factories ───────────────────────────────

function gmailAuthError(message) {
  return makeError('GMAIL_AUTH_ERROR', message);
}

function gmailRateLimitError(message) {
  return makeError('GMAIL_RATE_LIMITED', message);
}

function gmailThreadNotFoundError(message) {
  return makeError('GMAIL_THREAD_NOT_FOUND', message);
}

// conflictingOrderId is always included in the response body — not sensitive
function threadAlreadyLinkedError(message, conflictingOrderId) {
  return makeError('THREAD_ALREADY_LINKED', message, { conflictingOrderId });
}

module.exports = {
  validationError,
  notFoundError,
  conflictError,
  forbiddenError,
  gmailAuthError,
  gmailRateLimitError,
  gmailThreadNotFoundError,
  threadAlreadyLinkedError,
};
