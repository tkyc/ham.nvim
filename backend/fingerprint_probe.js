'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// fingerprint_probe.js — "why won't HTTP mode answer?" diagnostic
// ─────────────────────────────────────────────────────────────────────────────
//
// WHAT IT DOES
//   Reads the profile's Google cookies from cookies.sqlite and fetches AI Mode's
//   /search scaffold TWICE with the same cookies — once with Node's built-in fetch
//   (what HTTP mode uses) and once with a curl-impersonate (Firefox-fingerprinted)
//   build — then classifies each response and prints a verdict.
//
//   Each response is one of:
//     ANSWER scaffold ✓  — token-bearing page: this transport is working
//     SHELL              — token-less page: flagged, or the exemption cookie is stale
//     CAPTCHA (/sorry)   — bot-check interstitial
//
// WHEN TO USE IT
//   Run it whenever HTTP mode stops answering or starts throwing ECAPTCHA, to tell
//   apart the two causes:
//     • both transports fail  → the GOOGLE_ABUSE_EXEMPTION cookie is stale
//                               → solve a captcha (run a query, or :Ham login).
//     • fetch fails, curl ok  → Node's TLS fingerprint is being flagged
//                               → the curl-impersonate transport would help.
//     • both succeed          → everything's fine; nothing to do.
//   (Even without curl-impersonate installed, the fetch line alone is a quick
//    "is my saved session still valid?" check.)
//
// PREREQUISITES
//   1. CLOSE ham's Firefox first — a running instance locks cookies.sqlite and the
//      probe will report "no usable cookies". (:Ham close, or kill the headless
//      Firefox on the debug port.)
//   2. A logged-in profile with a GOOGLE_ABUSE_EXEMPTION cookie (solve a captcha /
//      :Ham login) — otherwise every transport just sees the shell.
//   3. curl-impersonate is OPTIONAL — only needed for the fingerprint A/B. Without
//      it the probe still runs the fetch half and notes curl is absent.
//
// HOW TO RUN  (from backend/)
//   node fingerprint_probe.js                         # default test query
//   node fingerprint_probe.js "your test question"    # custom query
//   HAM_PROFILE=/path/to/profile node fingerprint_probe.js   # different profile dir
//   HAM_CURL=curl_ff117 node fingerprint_probe.js            # name/path of the binary
//
// EXIT CODES: 0 = ran and printed a verdict · 1 = no cookies / error ·
//             2 = ran the fetch half but curl-impersonate isn't installed.
// ─────────────────────────────────────────────────────────────────────────────

const { execFile, execFileSync } = require('node:child_process');
const hf = require('./http_fetcher');
const pc = require('./profile_cookies');

const PROFILE = process.env.HAM_PROFILE || (process.env.HOME + '/.local/share/nvim/ham/firefox');
const Q = process.argv.slice(2).join(' ') || 'what is the tallest building in the world?';
const URL = 'https://www.google.com/search?udm=50&q=' + encodeURIComponent(Q);
const CURL_CANDIDATES = process.env.HAM_CURL
  ? [process.env.HAM_CURL]
  : ['curl-impersonate-ff', 'curl_ff117', 'curl_ff109', 'curl-impersonate'];

function classify(finalUrl, body) {
  if (/\/sorry\//.test(finalUrl || '')) return 'CAPTCHA (/sorry redirect)';
  const tok = hf.extractTokens(body || '');
  if (tok.srtst && tok.garc) return 'ANSWER scaffold — tokens present ✓';
  return 'SHELL — token-less (flagged or stale exemption)';
}
const isOk = (c) => c.startsWith('ANSWER');

const cookieHeader = hf.cookieHeader; // shared with the http-mode fetcher

async function viaFetch(cookies, ua) {
  const res = await fetch(URL, {
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
    headers: {
      'User-Agent': ua,
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Cookie': cookieHeader(cookies),
    },
  });
  return { finalUrl: res.url, body: await res.text() };
}

function findCurl() {
  for (const c of CURL_CANDIDATES) {
    try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return c; } catch (_) { /* not this one */ }
  }
  return null;
}

function viaCurl(bin, cookies) {
  return new Promise((resolve, reject) => {
    const sentinel = '__HAMMETA_' + Math.random().toString(36).slice(2) + '__';
    execFile(
      bin,
      ['-sSL', '--compressed', '--max-time', '30', '-b', cookieHeader(cookies),
        '-w', '\\n' + sentinel + '%{http_code} %{url_effective}', URL],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return reject(err);
        const i = (stdout || '').lastIndexOf(sentinel);
        if (i === -1) return resolve({ finalUrl: '(unknown)', body: stdout || '' });
        const meta = stdout.slice(i + sentinel.length).trim().split(' ');
        resolve({ status: meta[0], finalUrl: meta[1] || '(unknown)', body: stdout.slice(0, i).replace(/\n$/, '') });
      },
    );
  });
}

(async () => {
  const prof = pc.read(PROFILE);
  if (!prof) {
    console.log('No usable cookies in ' + PROFILE + ' — solve a captcha / run :Ham login first.');
    process.exit(1);
  }
  console.log('query   :', Q);
  console.log('profile :', PROFILE);
  console.log('cookies :', prof.cookies.map((c) => c.name).join(','), '\n');

  const a = await viaFetch(prof.cookies, prof.ua);
  const ac = classify(a.finalUrl, a.body);
  console.log('undici fetch     → ' + ac);

  const bin = findCurl();
  if (!bin) {
    console.log('curl-impersonate → NOT INSTALLED (tried: ' + CURL_CANDIDATES.join(', ') + ')');
    console.log('\nInstall a curl-impersonate build (https://github.com/lwthiker/curl-impersonate),');
    console.log('then re-run. Without it the fingerprint comparison can\'t be made.');
    process.exit(2);
  }
  const b = await viaCurl(bin, prof.cookies);
  const bc = classify(b.finalUrl, b.body);
  console.log('curl-impersonate → ' + bc + '  (' + bin + ')');

  console.log('\n=== verdict ===');
  if (!isOk(ac) && isOk(bc)) console.log('FINGERPRINT IS THE CULPRIT → build the curl-impersonate transport (plan steps 1–4).');
  else if (isOk(ac) && isOk(bc)) console.log('Both succeed → fingerprint is fine; curl-impersonate not needed.');
  else if (!isOk(ac) && !isOk(bc)) console.log('Both failed → likely a STALE EXEMPTION (solve a captcha), not the fingerprint. Inconclusive.');
  else console.log('undici succeeds but curl fails → a curl-impersonate setup/version issue, not a Google flag.');
})().catch((e) => { console.log('ERR: ' + (e.message || e)); process.exit(1); });
