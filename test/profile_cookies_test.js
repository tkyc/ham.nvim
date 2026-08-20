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
  const ins = db.prepare('INSERT INTO moz_cookies (originAttributes,name,value,host) VALUES (?,?,?,?)');
  for (const c of cookies) ins.run(c.oa || '', c.name, c.value, c.host || '.google.com');
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

// 2. missing essentials -> null
const dir2 = makeProfile([{ name: 'NID', value: 'x', host: '.google.com' }], '153.0');
check('null when GOOGLE_ABUSE_EXEMPTION absent', pc.read(dir2) === null);

// 3. missing DB / no profile -> null
check('null when cookies.sqlite missing', pc.read(fs.mkdtempSync(path.join(os.tmpdir(), 'ham-empty-'))) === null);
check('null when profileDir empty/nil', pc.read('') === null && pc.read(null) === null);

// 4. UA fallback
check('deriveUA falls back to DEFAULT_UA without compatibility.ini',
  pc.deriveUA(fs.mkdtempSync(path.join(os.tmpdir(), 'ham-noini-'))) === pc.DEFAULT_UA);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
