'use strict';

// Regression test for browser.js `ask` first-turn completion (the toolbar baseline).
//
// A finished AI Mode answer gains an action toolbar; `waitForAnswer` treats "text has
// settled AND the toolbar count grew past a baseline" as done. Follow-ups MEASURE that
// baseline before submitting, but the first turn used to hardcode 0 — so any button
// already on the freshly-loaded page whose aria-label matches the completion pattern
// (a "Share" control is the realistic one) made `count > 0` true at the first mid-stream
// pause and truncated the answer. This drives a fake streaming AI Mode page that carries
// such a pre-existing button and asserts the first turn waits for the REAL completion
// toolbar (count 1 -> 2) instead of finishing early.
//
// Self-contained: launches its own throwaway headless Firefox. Requires `firefox` on PATH
// and `backend/node_modules`; skips (exit 0) if Firefox is missing.
//
//   node test/first_turn_baseline_test.js

const { spawnSync, spawn } = require('child_process');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');

const browserlib = require('../backend/browser.js');

const PORT = Number(process.env.HAM_TEST_PORT || 9344);
const FIREFOX = process.env.HAM_FIREFOX || 'firefox';

function haveFirefox() { return spawnSync(FIREFOX, ['--version'], { stdio: 'ignore' }).status === 0; }
function portOpen(port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}
async function waitForPort(port, totalMs) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (await portOpen(port, 500)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// A fake AI Mode page: a pre-existing "Share" button (matches the completion pattern) is
// present from load, the answer streams a partial, PAUSES mid-stream long enough to trip
// the settle check, then finalizes AND adds a second matching button ("Regenerate") — the
// real completion toolbar. A first turn baselined at 0 would finish during the pause with
// only the partial; a correctly-measured baseline (1, the Share button) waits for the 2nd.
const PAGE = '<!doctype html><html><head><title>fake ai mode</title></head><body>'
  + '<button aria-label="Share">Share</button>'
  + '<div data-subtree="aimc"></div>'
  + '<script>'
  + 'var a=document.querySelector(\'[data-subtree="aimc"]\');'
  + 'setTimeout(function(){a.textContent="Partial answer so far";},200);'      // first chunk
  // (text stays "Partial answer so far" from 200ms..1600ms — the mid-stream pause)
  + 'setTimeout(function(){'
  + 'a.textContent="Partial answer so far and now the FINAL COMPLETE answer.";' // real end
  + 'var b=document.createElement("button");b.setAttribute("aria-label","Regenerate");'
  + 'document.body.appendChild(b);'                                             // toolbar 1->2
  + '},1600);'
  + '</script></body></html>';

async function main() {
  if (!haveFirefox()) { console.log('SKIP: firefox not found on PATH'); process.exit(0); }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ham-ff-test-'));
  const ff = spawn(FIREFOX, ['--headless', '--profile', profile, '--remote-debugging-port', String(PORT), 'about:blank'],
    { detached: true, stdio: 'ignore', env: Object.assign({}, process.env, { MOZ_ENABLE_WAYLAND: '1' }) });

  let browser;
  const failures = [];
  const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures.push(name); };

  try {
    if (!(await waitForPort(PORT, 20000))) throw new Error(`Firefox debug port ${PORT} never came up`);
    browser = await browserlib.connect({ port: PORT });
    const page = await browserlib.ensurePage(browser); // a fresh about:blank tab (not AI Mode)

    // ai_mode_url is the fake page; `ask` appends the (encoded) query, which lands as
    // harmless trailing body text outside the answer container.
    const cfg = {
      port: PORT,
      ai_mode_url: 'data:text/html,' + encodeURIComponent(PAGE),
      keep_awake: false,       // foreground test tab; skip the visibility preload
      poll_interval_ms: 100,
      settle_polls: 2,         // ~200ms of stable text counts as settled
      stall_polls: 1000,       // keep the stall fallback far away so it can't mask the fix
      new_turn_timeout_ms: 3000,
      nav_timeout_ms: 15000,
      response_timeout_ms: 15000,
    };

    let lastChunk = '';
    const answer = await browserlib.ask(browser, page, 'a test question', cfg, (p) => { lastChunk = p; });

    check('first turn returns the FINAL answer (not truncated at the mid-stream pause)',
      answer.includes('FINAL COMPLETE'));
    check('the mid-stream partial was streamed as a chunk', lastChunk.length > 0);
  } catch (err) {
    console.log('FAIL  (error) ' + err.message);
    failures.push('error: ' + err.message);
  } finally {
    try { if (browser) await browser.disconnect(); } catch (_) {}
    try { process.kill(-ff.pid); } catch (_) { try { ff.kill('SIGKILL'); } catch (_) {} }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  }

  if (failures.length === 0) { console.log('\nALL PASS'); process.exit(0); }
  console.log('\nFAILURES: ' + failures.join(', ')); process.exit(1);
}

main();
