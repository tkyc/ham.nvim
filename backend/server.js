'use strict';

// Long-lived backend for the nam Neovim plugin.
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

async function handleQuery(job) {
  await ensureConnected();
  const final = await browserlib.ask(browser, page, job.text, config, (partial) => {
    send({ type: 'chunk', id: job.id, text: partial });
  });
  send({ type: 'done', id: job.id, text: final });
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
