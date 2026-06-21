'use strict';

const { google } = require('googleapis');

// gmail.readonly enforces Design Principle 7 at the technical level —
// the integration can observe but never send.
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/gmail.readonly',
];

const authClient = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

if (process.env.GOOGLE_REFRESH_TOKEN) {
  authClient.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
}

const REQUIRED_AUTH_VARS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'GOOGLE_REFRESH_TOKEN',
];

// verifyAuth — confirms Google authentication works end-to-end by exchanging the
// refresh token for a live access token. Returns { ok, missing, error }.
// Makes one network call to Google's OAuth endpoint; no spreadsheet needed.
async function verifyAuth() {
  const missing = REQUIRED_AUTH_VARS.filter(v => !process.env[v]);
  if (missing.length) return { ok: false, missing };

  try {
    const res   = await authClient.getAccessToken();
    const token = typeof res === 'string' ? res : res?.token;
    return { ok: !!token, hasToken: !!token };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

module.exports = { authClient, SCOPES, verifyAuth, REQUIRED_AUTH_VARS };
