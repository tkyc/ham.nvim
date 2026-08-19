'use strict';

// Integration test for browser.js `detectCaptcha`: recognise Google's bot-check
// (reCAPTCHA widget / "unusual traffic" copy) and NOT flag a normal answer page.
//
// Self-contained: launches its own throwaway headless Firefox. Requires `firefox`
// on PATH and `backend/node_modules`; skips (exit 0) if Firefox is missing.
//
//   node test/captcha_detect_test.js

const { spawnSync, spawn } = require('child_process');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');

const browserlib = require('../backend/browser.js');

const PORT = Number(process.env.HAM_TEST_PORT || 9343);
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
    const page = await browserlib.ensurePage(browser, { port: PORT });

    const load = (html) => page.goto('data:text/html,' + encodeURIComponent(html), { waitUntil: 'domcontentloaded' });

    await load('<div class="g-recaptcha"></div><iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe>');
    check('reCAPTCHA widget → captcha detected', (await browserlib.detectCaptcha(page)) === true);

    await load('<p>Our systems have detected unusual traffic from your computer network.</p>');
    check('"unusual traffic" text → captcha detected', (await browserlib.detectCaptcha(page)) === true);

    await load('<div data-subtree="aimc">The capital of France is Paris.</div>');
    check('normal answer page → not a captcha', (await browserlib.detectCaptcha(page)) === false);
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
