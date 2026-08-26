'use strict';

// Offline unit test for backend/profile_cookies.js — reading Google cookies + UA from a
// Firefox profile's cookies.sqlite / compatibility.ini. Builds temp fixtures with
// node:sqlite (no network, no Firefox).

const fs = require('fs');
const os = require('os');
const path = require('path');
const pc = require('../backend/profile_cookies.js');

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch (e) {
  console.log('SKIP profile_cookies_test — node:sqlite unavailable:', e.message);
  process.exit(0);
}

function makeProfile(cookies, version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ham-prof-'));
  const db = new DatabaseSync(path.join(dir, 'cookies.sqlite'));
  db.exec("CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '', name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER)");
  const ins = db.prepare('INSERT INTO moz_cookies (originAttributes,name,value,host,expiry) VALUES (?,?,?,?,?)');
  for (const c of cookies) ins.run(c.oa || '', c.name, c.value, c.host || '.google.com', c.expiry == null ? null : c.expiry);
  db.close();
  if (version) fs.writeFileSync(path.join(dir, 'compatibility.ini'), `[Compatibility]\nLastVersion=${version}\n`);
  return dir;
}

// 1. valid profile — unpartitioned google cookies + derived UA
const dir1 = makeProfile([
  { name: 'NID', value: 'nidval', host: '.google.com' },
  { name: 'GOOGLE_ABUSE_EXEMPTION', value: 'exval', host: '.google.com' },
  { name: 'DV', value: 'dvval', host: 'www.google.com' },
  { name: 'NID', value: 'PARTITIONED', host: '.google.com', oa: '^partitionKey=x' }, // excluded
  { name: 'OTHER', value: 'x', host: 'accounts.google.com' },                        // wrong host
], '153.0.4_20260811');
const r1 = pc.read(dir1);
check('read returns an object with cookies + ua', !!(r1 && Array.isArray(r1.cookies) && r1.ua));
check('includes NID, exemption, DV', !!r1 && ['NID', 'GOOGLE_ABUSE_EXEMPTION', 'DV'].every((n) => r1.cookies.some((c) => c.name === n)));
check('NID is the unpartitioned value', !!r1 && r1.cookies.find((c) => c.name === 'NID').value === 'nidval');
check('excludes partitioned + wrong-host rows (exactly 3)', !!r1 && r1.cookies.length === 3);
check('derives Firefox UA from compatibility.ini', !!r1 && r1.ua === 'Mozilla/5.0 (X11; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0');

// 2. NID alone is enough: a logged-in profile with no exemption cookie yet is still
//    usable — a missing/stale bot-check exemption flows to the ECAPTCHA→solver recovery
//    instead of being mis-reported as "not logged in".
const dir2 = makeProfile([{ name: 'NID', value: 'x', host: '.google.com' }], '153.0');
const r2 = pc.read(dir2);
check('NID alone is usable (exemption not required)', !!(r2 && r2.cookies.some((c) => c.name === 'NID')));

// 2b. genuinely not logged in (no NID) -> null
const dir2b = makeProfile([{ name: 'DV', value: 'x', host: 'www.google.com' }], '153.0');
check('null when NID absent (not logged in)', pc.read(dir2b) === null);

// 3. missing DB / no profile -> null
check('null when cookies.sqlite missing', pc.read(fs.mkdtempSync(path.join(os.tmpdir(), 'ham-empty-'))) === null);
check('null when profileDir empty/nil', pc.read('') === null && pc.read(null) === null);

// 4. UA fallback
check('deriveUA falls back to DEFAULT_UA without compatibility.ini',
  pc.deriveUA(fs.mkdtempSync(path.join(os.tmpdir(), 'ham-noini-'))) === pc.DEFAULT_UA);

// 5. expired GOOGLE_ABUSE_EXEMPTION -> filtered out, but a live NID keeps the profile
//    usable; the dead exemption simply isn't sent (recovery refreshes it).
const past = Math.floor(Date.now() / 1000) - 3600;
const future = Math.floor(Date.now() / 1000) + 3600;
const dir5 = makeProfile([
  { name: 'NID', value: 'x', host: '.google.com', expiry: future },
  { name: 'GOOGLE_ABUSE_EXEMPTION', value: 'stale', host: '.google.com', expiry: past },
], '153.0');
const r5 = pc.read(dir5);
check('expired exemption dropped but NID keeps profile usable', !!(r5 && r5.cookies.some((c) => c.name === 'NID')));
check('expired exemption is not returned', !!(r5 && !r5.cookies.some((c) => c.name === 'GOOGLE_ABUSE_EXEMPTION')));

// 5b. an expired NID (the sign-in cookie itself) -> not usable -> null
const dir5b = makeProfile([{ name: 'NID', value: 'x', host: '.google.com', expiry: past }], '153.0');
check('null when NID itself is expired', pc.read(dir5b) === null);

// 6. session cookies (expiry 0 / null) are kept, not dropped as "expired"
const dir6 = makeProfile([
  { name: 'NID', value: 'sess', host: '.google.com', expiry: 0 },
  { name: 'GOOGLE_ABUSE_EXEMPTION', value: 'sess', host: '.google.com', expiry: future },
], '153.0');
check('keeps session cookies (expiry 0)', !!(pc.read(dir6) && pc.read(dir6).cookies.some((c) => c.name === 'NID')));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
