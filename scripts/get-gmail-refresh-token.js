'use strict';

// scripts/get-gmail-refresh-token.js — One-time OAuth2 flow to obtain a Gmail refresh token.
//
// Usage:
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/get-gmail-refresh-token.js
//
// The script prints an authorization URL, waits for you to paste the code from
// the browser redirect, then prints the refresh token. Copy it into backend/.env
// as GOOGLE_REFRESH_TOKEN.

const { google } = require('googleapis');
const readline   = require('readline');

const clientId     = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error('ERROR: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set.');
  process.exit(1);
}

const REDIRECT_URI = 'http://localhost';
const SCOPES       = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/gmail.readonly',
];

const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt:      'consent',
  scope:       SCOPES,
});

console.log('\nOpen this URL in your browser:\n');
console.log(authUrl);
console.log('');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Paste the authorization code from the redirect URL: ', async (code) => {
  rl.close();

  try {
    const { tokens } = await oauth2Client.getToken(code.trim());

    if (!tokens.refresh_token) {
      console.error('\nERROR: No refresh token returned.');
      console.error('Revoke app access at https://myaccount.google.com/permissions and re-run.');
      process.exit(1);
    }

    console.log('\nRefresh token:\n');
    console.log(tokens.refresh_token);
    console.log('');
  } catch (err) {
    console.error('\nERROR: Token exchange failed:', err.message);
    process.exit(1);
  }
});
