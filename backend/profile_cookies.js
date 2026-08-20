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
      "SELECT name, value FROM moz_cookies "
      + "WHERE (host = '.google.com' OR host = 'www.google.com') AND originAttributes = ''"
    ).all();
    const cookies = rows.map((r) => ({ name: r.name, value: r.value }));
    const names = new Set(cookies.map((c) => c.name));
    // Without these two, requests get the token-less shell / bot-check → not logged in.
    if (!names.has('NID') || !names.has('GOOGLE_ABUSE_EXEMPTION')) return null;
    return { cookies, ua: deriveUA(profileDir) };
  } catch (_) {
    return null;
  } finally {
    try { if (db) db.close(); } catch (_) { /* ignore */ }
  }
}

module.exports = { read, deriveUA, DEFAULT_UA };
