'use strict';

// Integration test for the Page Visibility spoof (browser.js) that keeps AI Mode
// streaming while Firefox is backgrounded. Verifies the driven page always reports
// itself visible and that visibilitychange is swallowed.
//
// Self-contained: launches its own throwaway headless Firefox. Requires `firefox`
// on PATH and `backend/node_modules`; skips (exit 0) if Firefox is missing.
//
//   node test/keep_awake_test.js
//
// Env overrides: HAM_TEST_PORT (default 9341), HAM_FIREFOX (default "firefox").

const { spawnSync, spawn } = require('child_process');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');

const browserlib = require('../backend/browser.js');

const PORT = Number(process.env.HAM_TEST_PORT || 9341);
const FIREFOX = process.env.HAM_FIREFOX || 'firefox';

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
    console.log('SKIP: firefox not found on PATH (set HAM_FIREFOX or install Firefox)');
    process.exit(0);
  }

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

    // A page with a visibilitychange listener that records if it fired.
    const html = '<script>window.vcFired=false;'
      + 'document.addEventListener("visibilitychange",function(){window.vcFired=true;});'
      + '</script>ok';
    await page.goto('data:text/html,' + encodeURIComponent(html), { waitUntil: 'domcontentloaded' });

    // Apply the spoof to the current document, then check the overrides.
    await browserlib.installVisibilitySpoof(page);
    const state = await page.evaluate(() => ({
      hidden: document.hidden,
      visibility: document.visibilityState,
      focus: document.hasFocus(),
      webdriver: navigator.webdriver,
    }));
    check("document.hidden is false", state.hidden === false);
    check("document.visibilityState is 'visible'", state.visibility === 'visible');
    check('document.hasFocus() is true', state.focus === true);
    check('navigator.webdriver is false (anti-captcha)', state.webdriver === false);

    // A dispatched visibilitychange must not reach the page's own listener.
    const reached = await page.evaluate(() => {
      window.vcFired = false;
      document.dispatchEvent(new Event('visibilitychange'));
      return window.vcFired;
    });
    check('visibilitychange event is swallowed', reached === false);

    // Keep-alive: an AudioContext is held open (exempts setTimeout throttling) and
    // requestAnimationFrame is shimmed onto timers (survives compositor frame
    // pausing on a backgrounded/occluded window).
    const ka = await page.evaluate(() => new Promise((resolve) => {
      const hasCtx = !!window.__hamAudioCtx;
      const rafSrc = String(window.requestAnimationFrame);
      // The shim must actually fire a callback with a numeric timestamp.
      window.requestAnimationFrame((t) => resolve({ hasCtx, rafSrc, rafFired: typeof t === 'number' }));
    }));
    check('AudioContext held open (un-throttles timers)', ka.hasCtx === true);
    check('requestAnimationFrame is shimmed onto a timer', /setTimeout/.test(ka.rafSrc));
    check('shimmed rAF fires a callback', ka.rafFired === true);

    // Preload path: after registering, a navigation's document must be patched
    // BEFORE its own scripts run — this is what fixes a first-turn query (which
    // starts generating at page load while Firefox is backgrounded).
    await browserlib.registerVisibilitySpoof(page);
    const html2 = '<script>window.preloadRan=document.hasOwnProperty("hidden");</script>ok';
    await page.goto('data:text/html,' + encodeURIComponent(html2), { waitUntil: 'domcontentloaded' });
    const preloadRan = await page.evaluate(() => window.preloadRan);
    check('preload runs before page scripts (first-turn fix)', preloadRan === true);
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
