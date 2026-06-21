'use strict';

const errorUtils = require('../utils/errorUtils');
const { LAB_COMM_CONTEXTS, LAB_COMM_LINK_MODES } = require('../models/LabCommThread');
const { ORDER_STATUSES, LAB_COMM_SEARCH_MAX_RESULTS } = require('../config/constants');

const OBJECT_ID_RE  = /^[0-9a-fA-F]{24}$/;
const POSITIVE_INT_RE = /^[1-9]\d*$/;

function validateOrderId(idParam) {
  if (!idParam || !OBJECT_ID_RE.test(idParam)) {
    throw errorUtils.validationError('id must be a valid ObjectId');
  }
}

function validateVersion(versionParam) {
  if (!versionParam || !POSITIVE_INT_RE.test(String(versionParam))) {
    throw errorUtils.validationError('version must be a positive integer');
  }
}

function validateLinkThread(body) {
  if (!body.threadId || typeof body.threadId !== 'string' || !body.threadId.trim()) {
    throw errorUtils.validationError('threadId is required');
  }
  if (!LAB_COMM_LINK_MODES.includes(body.linkMode)) {
    throw errorUtils.validationError('linkMode must be "live" or "historical"');
  }
  if (!LAB_COMM_CONTEXTS.includes(body.context)) {
    throw errorUtils.validationError(
      `context must be one of: ${LAB_COMM_CONTEXTS.join(', ')}`
    );
  }
  if (body.sentAt !== undefined) {
    const d = new Date(body.sentAt);
    if (isNaN(d.getTime())) {
      throw errorUtils.validationError('sentAt must be a valid ISO 8601 date string');
    }
    if (d > new Date()) {
      throw errorUtils.validationError('sentAt must not be a future date');
    }
  }
}

function validateOrderSearch(query) {
  const { name, company, phone, email, status } = query;

  const hasSearchParam = [name, company, phone, email].some(
    v => v && String(v).trim().length >= 2
  );
  if (!hasSearchParam) {
    throw errorUtils.validationError(
      'At least one search parameter (name, company, phone, email) with at least 2 characters is required'
    );
  }

  if (status !== undefined && !ORDER_STATUSES.includes(status)) {
    throw errorUtils.validationError(
      `status must be one of: ${ORDER_STATUSES.join(', ')}`
    );
  }
}

function validateGmailSearch(query) {
  if (!query.q || typeof query.q !== 'string' || !query.q.trim()) {
    throw errorUtils.validationError('q (Gmail search query) is required');
  }
  if (query.maxResults !== undefined) {
    const n = parseInt(query.maxResults, 10);
    if (isNaN(n) || n < 1 || n > LAB_COMM_SEARCH_MAX_RESULTS) {
      throw errorUtils.validationError(
        `maxResults must be a positive integer not exceeding ${LAB_COMM_SEARCH_MAX_RESULTS}`
      );
    }
  }
}

module.exports = {
  validateOrderId,
  validateVersion,
  validateLinkThread,
  validateOrderSearch,
  validateGmailSearch,
};
