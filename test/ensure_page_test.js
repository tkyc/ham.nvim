'use strict';

// Integration test for browser.js `ensurePage`: it should REUSE an existing
// Google AI Mode tab if one is open, otherwise open a NEW tab.
//
// Self-contained: launches its own throwaway headless Firefox on a scratch
// profile, so it never touches your real browser. Requires `firefox` on PATH and
// `backend/node_modules` installed (npm install); skips (exit 0) if Firefox is
// missing.
//
//   node test/ensure_page_test.js
//
// Env overrides: HAM_TEST_PORT (default 9337), HAM_FIREFOX (default "firefox").

const { spawnSync, spawn } = require('child_process');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');

const browserlib = require('../backend/browser.js');

const PORT = Number(process.env.HAM_TEST_PORT || 9337);
const FIREFOX = process.env.HAM_FIREFOX || 'firefox';

function haveFirefox() {
  const r = spawnSync(FIREFOX, ['--version'], { stdio: 'ignore' });
  return r.status === 0;
}

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

async function main() {
  if (!haveFirefox()) {
    console.log('SKIP: firefox not found on PATH (set HAM_FIREFOX or install Firefox)');
    process.exit(0);
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ham-ff-test-'));
  const ff = spawn(FIREFOX, ['--headless', '--profile', profile, '--remote-debugging-port', String(PORT), 'about:blank'],
    { detached: true, stdio: 'ignore', env: Object.assign({}, process.env, { MOZ_ENABLE_WAYLAND: '1' }) });

  let browser;
  const failures = [];
  function check(name, ok) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) failures.push(name);
  }

  try {
    if (!(await waitForPort(PORT, 20000))) throw new Error(`Firefox debug port ${PORT} never came up`);
    browser = await browserlib.connect({ port: PORT });

    // Case 1: no AI Mode tab present -> ensurePage opens a NEW tab.
    let before = (await browser.pages()).length;
    let p = await browserlib.ensurePage(browser, { port: PORT });
    let after = (await browser.pages()).length;
    check('no AI Mode tab -> creates a new tab', after === before + 1);

    // Case 2: an AI Mode tab exists -> ensurePage REUSES it (no new tab).
    const aim = await browser.newPage();
    await aim.goto('data:text/html,<div data-subtree="aimc">answer</div>', { waitUntil: 'domcontentloaded' });
    before = (await browser.pages()).length;
    p = await browserlib.ensurePage(browser, { port: PORT });
    after = (await browser.pages()).length;
    const reusedIsAiMode = await p.evaluate(() => !!document.querySelector('[data-subtree="aimc"]'));
    check('existing AI Mode tab -> reuses it (no new tab)', after === before);
    check('reused tab is the AI Mode tab', reusedIsAiMode === true);
  } catch (err) {
    console.log('FAIL  (error) ' + err.message);
    failures.push('error: ' + err.message);
  } finally {
    try { if (browser) await browser.disconnect(); } catch (_) {}
    try { process.kill(-ff.pid); } catch (_) { try { ff.kill('SIGKILL'); } catch (_) {} }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  }

  if (failures.length === 0) {
    console.log('\nALL PASS');
    process.exit(0);
  } else {
    console.log('\nFAILURES: ' + failures.join(', '));
    process.exit(1);
  }
}

main();
