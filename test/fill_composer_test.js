'use strict';

// Integration test for browser.js `fillComposer`: putting a MULTI-LINE query into
// the composer must not trigger an early submit (typing key-by-key would send the
// embedded newline as Enter). This is what makes `/explain` on yanked code work.
//
// Self-contained: launches its own throwaway headless Firefox and drives a fake
// composer that submits on Enter (like AI Mode's). Requires `firefox` on PATH and
// `backend/node_modules`; skips (exit 0) if Firefox is missing.
//
//   node test/fill_composer_test.js
//
// Env overrides: NAM_TEST_PORT (default 9339), NAM_FIREFOX (default "firefox").

const { spawnSync, spawn } = require('child_process');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');

const browserlib = require('../backend/browser.js');

const PORT = Number(process.env.NAM_TEST_PORT || 9339);
const FIREFOX = process.env.NAM_FIREFOX || 'firefox';

function haveFirefox() {
  return spawnSync(FIREFOX, ['--version'], { stdio: 'ignore' }).status === 0;
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
    console.log('SKIP: firefox not found on PATH (set NAM_FIREFOX or install Firefox)');
    process.exit(0);
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nam-ff-test-'));
  const ff = spawn(FIREFOX, ['--headless', '--profile', profile, '--remote-debugging-port', String(PORT), 'about:blank'],
    { detached: true, stdio: 'ignore', env: Object.assign({}, process.env, { MOZ_ENABLE_WAYLAND: '1' }) });

  let browser;
  const failures = [];
  const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures.push(name); };

  try {
    if (!(await waitForPort(PORT, 20000))) throw new Error(`Firefox debug port ${PORT} never came up`);
    browser = await browserlib.connect({ port: PORT });
    const page = await browserlib.ensurePage(browser, { port: PORT });

    // Fake composer that submits on Enter (no Shift) — like AI Mode's.
    const html = '<textarea id="c"></textarea><script>'
      + 'window.submitted=null;'
      + 'document.getElementById("c").addEventListener("keydown",function(e){'
      + ' if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();window.submitted=e.target.value;}});'
      + '</script>';
    await page.goto('data:text/html,' + encodeURIComponent(html), { waitUntil: 'domcontentloaded' });
    const el = await page.$('#c');

    const multiline = 'local function add(a, b)\n  return a + b\nend';
    await el.focus();
    await browserlib.fillComposer(page, el, multiline);

    const valAfterFill = await page.$eval('#c', (e) => e.value);
    const submittedDuringFill = await page.evaluate(() => window.submitted);
    await page.keyboard.press('Enter');
    const submittedValue = await page.evaluate(() => window.submitted);

    check('multi-line value set intact', valAfterFill === multiline);
    check('no early submit during fill', submittedDuringFill === null);
    check('Enter submits the full multi-line text', submittedValue === multiline);
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
