'use strict';

// scripts/google-oauth-mint.js — mint a fresh Google OAuth refresh token (interactive).
//
// WHY: GOOGLE_REFRESH_TOKEN was rejected by Google with `invalid_grant` (revoked or
// expired — the latter happens automatically after 7 days when the OAuth consent screen
// is still in "Testing" mode). The app's Gmail (lab mailbox) + Sheets access need a valid
// refresh token. This script runs the OAuth "offline" flow once and prints a new token.
//
// SCOPES match integrations/googleAuth.js exactly (spreadsheets + gmail.readonly).
//
// USAGE (run locally, with a browser available):
//   1. In Google Cloud Console → APIs & Services → Credentials → your OAuth client,
//      add this Authorized redirect URI:  http://localhost:5555/oauth2callback
//      (override the port with OAUTH_PORT=NNNN if 5555 is taken.)
//   2. From backend/:  node -r dotenv/config scripts/google-oauth-mint.js
//   3. Open the printed URL, pick the business Google account, allow access.
//   4. The script prints GOOGLE_REFRESH_TOKEN=…  — hand it back.
//
// DURABLE FIX: if the consent screen is in "Testing", publish it to "In production"
// (Console → OAuth consent screen → Publish app) so refresh tokens stop expiring weekly.

const http = require('http');
const { google } = require('googleapis');

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/gmail.readonly',
];

const PORT = parseInt(process.env.OAUTH_PORT || '5555', 10);
const REDIRECT = `http://localhost:${PORT}/oauth2callback`;

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in env. Run with -r dotenv/config from backend/.');
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT);

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',      // ask for a refresh token
  prompt: 'consent',           // force a NEW refresh token even if previously granted
  scope: SCOPES,
});

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/oauth2callback')) { res.writeHead(404); res.end(); return; }
  const code = new URL(req.url, REDIRECT).searchParams.get('code');
  if (!code) { res.writeHead(400); res.end('No code in callback.'); return; }
  try {
    const { tokens } = await oauth2.getToken(code);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Готово. Refresh token получен — вернитесь в терминал. Можно закрыть вкладку.');
    if (!tokens.refresh_token) {
      console.error('\n⚠ Google did not return a refresh_token. Revoke prior access at\n' +
        '  https://myaccount.google.com/permissions  then re-run this script.');
    } else {
      console.log('\n=== NEW TOKEN — paste this line back ===');
      console.log('GOOGLE_REFRESH_TOKEN=' + tokens.refresh_token);
      console.log('=======================================');
    }
  } catch (err) {
    res.writeHead(500); res.end('Token exchange failed: ' + err.message);
    console.error('\nToken exchange failed:', err.message);
  } finally {
    setTimeout(() => server.close(() => process.exit(0)), 500);
  }
});

server.listen(PORT, () => {
  console.log(`OAuth mint server on ${REDIRECT}`);
  console.log('\n1) Ensure this redirect URI is registered on the OAuth client:\n   ' + REDIRECT);
  console.log('\n2) Open this URL in a browser and authorize:\n');
  console.log(authUrl + '\n');
});
