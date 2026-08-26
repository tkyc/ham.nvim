'use strict';

// Read the ham Firefox profile's Google cookies + User-Agent straight off disk, so
// HTTP mode can authenticate its requests without a running Firefox.
//
// Firefox persists cookies (with an expiry) to <profile>/cookies.sqlite (moz_cookies
// table), including NID and the GOOGLE_ABUSE_EXEMPTION bot-check exemption. The UA is
// derived from <profile>/compatibility.ini's LastVersion. Everything here is best-
// effort: any problem (no node:sqlite, missing DB, missing cookies) returns null so
// the caller can fall back to a live-browser harvest.

const fs = require('fs');
const path = require('path');

// Generic Firefox UA used when compatibility.ini can't be read. Shared with the HTTP
// fetcher (which imports it as FF_UA) so the two can't drift.
const DEFAULT_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0';

// Build the profile's Firefox UA from compatibility.ini (LastVersion=153.0.4… → 153),
// matching the browser that owns the cookies. Falls back to a generic Firefox UA.
function deriveUA(profileDir) {
  try {
    const ini = fs.readFileSync(path.join(profileDir, 'compatibility.ini'), 'utf8');
    const m = ini.match(/LastVersion=(\d+)/);
    if (m) return `Mozilla/5.0 (X11; Linux x86_64; rv:${m[1]}.0) Gecko/20100101 Firefox/${m[1]}.0`;
  } catch (_) { /* fall through */ }
  return DEFAULT_UA;
}

// Return { cookies:[{name,value}], ua } for the profile's google.com cookies, or null
// if unavailable/unusable (so the caller harvests from a live Firefox instead).
function read(profileDir) {
  if (!profileDir) return null;

  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch (_) { return null; } // older Node

  const dbPath = path.join(profileDir, 'cookies.sqlite');
  if (!fs.existsSync(dbPath)) return null;

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    // Unpartitioned (originAttributes='') top-level google cookies — what a request to
    // www.google.com carries. '.google.com' = domain cookies, 'www.google.com' = host.
    const rows = db.prepare(
      "SELECT name, value, expiry FROM moz_cookies "
      + "WHERE (host = '.google.com' OR host = 'www.google.com') AND originAttributes = ''"
    ).all();
    // Drop clearly-expired persistent cookies. Firefox stores expiry in unix seconds;
    // null / 0 marks a session cookie (no expiry) which we keep. Without this an expired
    // GOOGLE_ABUSE_EXEMPTION still passes the presence check below, so we'd think we're
    // logged in and send a dead exemption (→ token-less shell).
    const now = Math.floor(Date.now() / 1000);
    const live = rows.filter((r) => r.expiry == null || r.expiry === 0 || r.expiry > now);
    const cookies = live.map((r) => ({ name: r.name, value: r.value }));
    const names = new Set(cookies.map((c) => c.name));
    // NID is the sign-in cookie; without it we're genuinely not logged in → null so the
    // caller falls back to a live harvest / reports "run :Ham login". We deliberately do
    // NOT also require GOOGLE_ABUSE_EXEMPTION here: a freshly-logged-in profile that never
    // hit a bot-check has no exemption yet, and an expired one is filtered out above. In
    // both cases the right recovery is to send what we have and let the first turn get a
    // token-less shell → ECAPTCHA → the backend opens the solver and refreshes the
    // exemption. Rejecting here would instead mis-report a logged-in user as "no cookies".
    if (!names.has('NID')) return null;
    return { cookies, ua: deriveUA(profileDir) };
  } catch (_) {
    return null;
  } finally {
    try { if (db) db.close(); } catch (_) { /* ignore */ }
  }
}

module.exports = { read, deriveUA, DEFAULT_UA };
