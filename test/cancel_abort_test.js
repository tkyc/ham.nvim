'use strict';

// Offline unit test for the http-mode cancel wiring in backend/http_fetcher.js.
// :Ham cancel aborts the in-flight query by passing an AbortSignal down to httpGet's
// fetch(). This verifies that plumbing against local servers (no network, no Google):
//   - an external cancel aborts the request PROMPTLY and reports it as an AbortError,
//     distinct from a timeout;
//   - a signal that never fires still lets the request time out (AbortSignal.any
//     composition keeps the timeout live);
//   - a pre-aborted signal rejects immediately;
//   - the happy path is unaffected, with or without a signal.
//
//   node test/cancel_abort_test.js   (exits 0 on success, 1 on failure)

const http = require('http');
const net = require('net');
const hf = require('../backend/http_fetcher.js');

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

// A server that accepts the connection but never responds → the request hangs until it
// is aborted (by cancel) or times out. Same shape as http_fetcher_test's hang server.
function hangServer() {
  const server = net.createServer(() => { /* hold the socket open, send nothing */ });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// A server that answers immediately with a fixed body (for the happy-path checks).
function okServer(body) {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(body); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const url = (server, p) => `http://127.0.0.1:${server.address().port}${p || '/'}`;
const ctx = { cookies: '', ua: 'ham-test' };

(async () => {
  // 1. External cancel mid-flight → prompt AbortError, NOT a timeout. The generous
  //    60s timeout would mask a broken signal, so <2s proves the cancel did the work.
  {
    const hang = await hangServer();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200); // user hits :Ham cancel
    const t0 = Date.now();
    let err = null;
    try { await hf.httpGet(url(hang), { ...ctx, timeoutMs: 60000 }, ac.signal); }
    catch (e) { err = e; }
    const dt = Date.now() - t0;
    hang.close();
    check('external cancel rejects with AbortError', err && err.name === 'AbortError');
    check('external cancel aborts promptly (< 2s, not the 60s timeout)', dt < 2000);
    check('external cancel is not misreported as a timeout', !!err && !/timed out/i.test(err.message || ''));
  }

  // 2. A signal that never fires must NOT disable the timeout (AbortSignal.any keeps
  //    both live) — the request still times out and is reported as such.
  {
    const hang = await hangServer();
    const ac = new AbortController(); // never aborted
    let err = null;
    try { await hf.httpGet(url(hang), { ...ctx, timeoutMs: 150 }, ac.signal); }
    catch (e) { err = e; }
    hang.close();
    check('timeout still fires when a non-aborting signal is present', !!err && /timed out/i.test(err.message || ''));
  }

  // 3. A signal already aborted before the call rejects immediately with AbortError.
  {
    const hang = await hangServer();
    const err = await hf.httpGet(url(hang), { ...ctx, timeoutMs: 60000 }, AbortSignal.abort())
      .then(() => null, (e) => e);
    hang.close();
    check('pre-aborted signal rejects with AbortError', err && err.name === 'AbortError');
  }

  // 4. Happy path with a (non-aborting) signal present → resolves with the body.
  {
    const ok = await okServer('<div data-subtree="aimc">hi</div>');
    const ac = new AbortController();
    const res = await hf.httpGet(url(ok), ctx, ac.signal).catch((e) => ({ err: e }));
    ok.close();
    check('happy path with a signal resolves', res && res.status === 200 && res.body.includes('aimc'));
  }

  // 5. Happy path without a signal → the no-signal branch is unaffected.
  {
    const ok = await okServer('plain');
    const res = await hf.httpGet(url(ok), ctx).catch((e) => ({ err: e }));
    ok.close();
    check('happy path without a signal resolves', res && res.status === 200 && res.body === 'plain');
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
