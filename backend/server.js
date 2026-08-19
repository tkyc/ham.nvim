'use strict';

// Long-lived backend for the ham Neovim plugin.
//
// Speaks newline-delimited JSON over stdio:
//   IN : {"type":"config","config":{...}}        (optional, send once first)
//        {"type":"query","id":<n>,"text":"..."}
//        {"type":"ping"}
//   OUT: {"type":"ready"}
//        {"type":"chunk","id":<n>,"text":"...partial..."}
//        {"type":"done","id":<n>,"text":"...final..."}
//        {"type":"error","id":<n|null>,"message":"...","code":"..."}
//        {"type":"pong"}
//
// The browser connection and AI Mode page are created lazily on the first query
// and kept alive for the whole process (== the whole nvim session), so follow-up
// questions keep their conversation context.

const readline = require('readline');
const browserlib = require('./browser');

let config = {};
let browser = null;
let page = null;
const queue = [];
let working = false;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function fail(id, err) {
  send({ type: 'error', id: id == null ? null : id, message: err.message || String(err), code: err.code });
}

async function ensureConnected() {
  if (browser) {
    try {
      // Cheap liveness probe; if it throws, reconnect.
      await browser.version();
    } catch (_) {
      browser = null;
      page = null;
    }
  }
  if (!browser) {
    browser = await browserlib.connect(config);
    browser.on('disconnected', () => { browser = null; page = null; });
  }
  if (!page || page.isClosed()) {
    page = await browserlib.ensurePage(browser, config);
  }
}

// A connection-level failure (as opposed to a coded ECAPTCHA/ESESSIONBUSY that the
// Lua side must see): the browser socket dropped, typically because Firefox was
// just restarted under us — e.g. the captcha flip (headful solver → back to
// headless) that immediately re-sends this query. Coded errors carry err.code and
// must propagate; these don't.
function isConnDropped(err) {
  if (err && err.code) return false;
  const m = (err && (err.message || String(err))) || '';
  return /Connection closed|Target closed|Session.*closed|socket hang up|Protocol error|WebSocket|ECONNRESET|ECONNREFUSED/i.test(m);
}

async function handleQuery(job) {
  const deadline = Date.now() + 30000;
  for (let attempt = 1; ; attempt++) {
    try {
      await ensureConnected();
      const final = await browserlib.ask(browser, page, job.text, config, (partial) => {
        send({ type: 'chunk', id: job.id, text: partial });
      });
      send({ type: 'done', id: job.id, text: final });
      return;
    } catch (err) {
      // Firefox was likely restarted under us (captcha/headless flip). Drop the
      // stale handles and retry connecting to the fresh instance for a while
      // before giving up, so the post-captcha re-send actually runs instead of
      // dying on a "Connection closed".
      if (isConnDropped(err) && attempt <= 8 && Date.now() < deadline) {
        browser = null;
        page = null;
        await new Promise((r) => setTimeout(r, Math.min(500 * attempt, 2500)));
        continue;
      }
      throw err;
    }
  }
}

async function pump() {
  if (working) return;
  working = true;
  while (queue.length) {
    const job = queue.shift();
    try {
      await handleQuery(job);
    } catch (err) {
      fail(job.id, err);
    }
  }
  working = false;
}

// Wait for a captcha the user is solving (in the now-headful window) to clear,
// then reply so ham can flip back to headless and retry. Reconnects to whatever
// instance is currently on the debug port (the headful solver window).
async function awaitCaptchaCleared(id) {
  try {
    await ensureConnected();
    const cleared = await browserlib.awaitCaptchaClear(browser, 180000);
    if (cleared) send({ type: 'captcha_cleared', id });
    else fail(id, new Error('captcha still present after waiting'));
  } catch (err) {
    fail(id, err);
  }
}

// Start a fresh AI Mode conversation: navigate the driven tab to about:blank so
// the next query is treated as a first turn (new thread) rather than a follow-up.
async function resetConversation() {
  try {
    if (page && !page.isClosed()) {
      await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10000 });
    }
  } catch (_) { /* best-effort; the next query will still navigate fresh */ }
}

function handleLine(line) {
  line = line.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (_) {
    fail(null, new Error('Backend received malformed JSON: ' + line.slice(0, 120)));
    return;
  }

  switch (msg.type) {
    case 'config':
      config = msg.config || {};
      break;
    case 'ping':
      send({ type: 'pong' });
      break;
    case 'query':
      queue.push({ id: msg.id, text: String(msg.text || '') });
      pump();
      break;
    case 'reset':
      resetConversation();
      break;
    case 'await_captcha_clear':
      awaitCaptchaCleared(msg.id);
      break;
    default:
      fail(msg.id, new Error('Unknown message type: ' + msg.type));
  }
}

// Cleanly END the WebDriver BiDi session before exiting. This is critical:
// Firefox allows only ONE BiDi session and does NOT reap it on a dropped socket,
// so if we die without calling disconnect() the session is orphaned and Firefox
// refuses all new connections until it is restarted. nvim's jobstop sends SIGTERM
// on exit, so we must handle signals too — not just stdin close.
let shuttingDown = false;
async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { if (browser) await browser.disconnect(); } catch (_) {}
  process.exit(code || 0);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', handleLine);
rl.on('close', () => shutdown(0)); // stdin closed (nvim exited)
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('SIGHUP', () => shutdown(0));

process.on('uncaughtException', (err) => fail(null, err));
process.on('unhandledRejection', (err) => fail(null, err instanceof Error ? err : new Error(String(err))));

send({ type: 'ready' });
