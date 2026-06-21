'use strict';

const { google }    = require('googleapis');
const { authClient } = require('./googleAuth');
const errorUtils    = require('../utils/errorUtils');
const {
  LAB_COMM_SEARCH_MAX_RESULTS,
  LAB_COMM_ATTACHMENT_MIMETYPES,
} = require('../config/constants');

const gmail = google.gmail({ version: 'v1', auth: authClient });

// Cached after first successful call; reset to null if auth is revoked
let _operatorEmail = null;

// ─── Error normalization ──────────────────────────────────────────────────────

function handleGmailError(err) {
  const status = err?.response?.status ?? err?.code;
  if (status === 401 || status === 403) {
    throw errorUtils.gmailAuthError(
      'Gmail authentication failed. Re-authorize Google account.'
    );
  }
  if (status === 404) {
    throw errorUtils.gmailThreadNotFoundError('Gmail resource not found.');
  }
  if (status === 429) {
    throw errorUtils.gmailRateLimitError('Gmail API rate limit exceeded.');
  }
  throw err;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractHeader(headers, name) {
  if (!Array.isArray(headers)) return null;
  const match = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
  return match ? match.value : null;
}

function messageHasAttachment(message) {
  const parts = message?.payload?.parts;
  if (!Array.isArray(parts)) return false;
  return parts.some(
    p => p.filename && p.mimeType && LAB_COMM_ATTACHMENT_MIMETYPES.includes(p.mimeType)
  );
}

// ─── Body / attachment extraction (read-only) ──────────────────────────────────
// Used by workflow event detection. Requires a message fetched with format
// 'full' (the poller already uses 'full'); 'metadata' format has no body data.

function _decodeB64Url(data) {
  if (!data) return '';
  return Buffer.from(data, 'base64url').toString('utf8');
}

function _stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// Depth-first search for the first part whose mimeType matches and carries data.
function _findPartData(part, mimeType) {
  if (!part) return null;
  if (part.mimeType === mimeType && part.body?.data) return _decodeB64Url(part.body.data);
  if (Array.isArray(part.parts)) {
    for (const child of part.parts) {
      const found = _findPartData(child, mimeType);
      if (found) return found;
    }
  }
  return null;
}

// Returns the decoded message body as plain text. Prefers text/plain; falls back
// to a tag-stripped text/html. Returns '' when no body is available.
function getMessageBody(message) {
  const payload = message?.payload;
  if (!payload) return '';

  const plain = _findPartData(payload, 'text/plain');
  if (plain) return plain;

  const html = _findPartData(payload, 'text/html');
  if (html) return _stripHtml(html);

  // Single-part messages put the body directly on payload.body
  if (payload.body?.data) {
    const raw = _decodeB64Url(payload.body.data);
    return payload.mimeType === 'text/html' ? _stripHtml(raw) : raw;
  }
  return '';
}

// Returns the list of attachment filenames on a message (deduplicated, original case).
function getAttachmentFilenames(message) {
  const names = [];
  (function walk(part) {
    if (!part) return;
    if (part.filename && part.filename.trim()) names.push(part.filename.trim());
    if (Array.isArray(part.parts)) part.parts.forEach(walk);
  })(message?.payload);
  return [...new Set(names)];
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function getOperatorEmail() {
  if (_operatorEmail) return _operatorEmail;
  try {
    const res = await gmail.users.getProfile({ userId: 'me' });
    _operatorEmail = res.data.emailAddress;
    return _operatorEmail;
  } catch (err) {
    handleGmailError(err);
  }
}

async function getThread(threadId, format = 'metadata') {
  try {
    const res = await gmail.users.threads.get({ userId: 'me', id: threadId, format });
    return res.data;
  } catch (err) {
    if (err?.response?.status === 404 || err?.code === 404) {
      throw errorUtils.gmailThreadNotFoundError('Thread not found: ' + threadId);
    }
    handleGmailError(err);
  }
}

async function searchThreads(query, maxResults = 20) {
  const cap = Math.min(maxResults, LAB_COMM_SEARCH_MAX_RESULTS);
  try {
    const listRes = await gmail.users.threads.list({
      userId: 'me',
      q:      query,
      maxResults: cap,
    });
    const items = listRes.data.threads || [];
    if (items.length === 0) return [];

    const results = [];
    for (const item of items) {
      try {
        const thread   = await getThread(item.id, 'metadata');
        const firstMsg = thread.messages?.[0];
        const headers  = firstMsg?.payload?.headers || [];
        results.push({
          threadId:     thread.id,
          subject:      extractHeader(headers, 'Subject') || '(no subject)',
          from:         extractHeader(headers, 'From')    || '',
          to:           extractHeader(headers, 'To')      || '',
          date:         firstMsg?.internalDate
            ? new Date(parseInt(firstMsg.internalDate, 10))
            : null,
          messageCount:  thread.messages?.length || 0,
          hasAttachment: thread.messages?.some(messageHasAttachment) || false,
        });
      } catch (_err) {
        // Skip threads that fail individually — don't abort the whole search
      }
    }
    return results;
  } catch (err) {
    handleGmailError(err);
  }
}

async function getMessage(messageId, format = 'metadata') {
  try {
    const res = await gmail.users.messages.get({ userId: 'me', id: messageId, format });
    return res.data;
  } catch (err) {
    handleGmailError(err);
  }
}

module.exports = {
  getOperatorEmail,
  getThread,
  searchThreads,
  getMessage,
  extractHeader,
  messageHasAttachment,
  getMessageBody,
  getAttachmentFilenames,
};
