'use strict';

// Long-lived backend for the ham Neovim plugin.
//
// Speaks newline-delimited JSON over stdio:
//   IN : {"type":"config","config":{...}}          (optional, send once first)
//        {"type":"query","id":<n>,"text":"..."}
//        {"type":"reset"}                            (start a fresh conversation)
//        {"type":"cancel","id":<n>}                  (abort an in-flight / queued query)
//        {"type":"await_captcha_clear","id":<n>}     (wait for the user to solve a captcha)
//        {"type":"ping"}
//   OUT: {"type":"ready"}
//        {"type":"chunk","id":<n>,"text":"...partial..."}
//        {"type":"done","id":<n>,"text":"...final..."}
//        {"type":"error","id":<n|null>,"message":"...","code":"..."}
//        {"type":"captcha_cleared","id":<n>}         (user solved it; re-send the query)
//        {"type":"pong"}
//
// In browser mode the browser connection and AI Mode page are created lazily on the
// first query and kept alive for the whole process (== the whole nvim session), so
// follow-up questions keep their conversation context. In http mode no page is created
// for queries at all — Firefox is attached only transiently to harvest cookies.

const readline = require('readline');
const net = require('node:net');
const browserlib = require('./browser');
const httpFetcher = require('./http_fetcher');
const profileCookies = require('./profile_cookies');

let config = {};
let browser = null;
let page = null;
const queue = [];
let working = false;
let currentAbort = null; // AbortController for the job the pump is currently running
let currentJobId = null; // its id, so a 'cancel' can target the running job
let captchaWait = null; // { id, abort } while awaiting a captcha solve (not a pump job)

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function fail(id, err) {
  send({ type: 'error', id: id ?? null, message: err.message || String(err), code: err.code });
}

// Connect to Firefox and make it the session browser. The 'disconnected' guard only clears
// THIS instance, so a late event from a just-killed Firefox can't null a fresher one.
async function attach() {
  const b = await browserlib.connect(config);
  b.on('disconnected', () => { if (browser === b) { browser = null; page = null; } });
  browser = b;
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
  if (!browser) await attach();
  if (!page || page.isClosed()) {
    page = await browserlib.ensurePage(browser);
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

// Is something listening on host:port? The debug port is ham-exclusive (only ham's
// Firefox is launched with --remote-debugging-port), so open ⟺ ham's Firefox is up.
function portOpen(host, port, timeoutMs = 300) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => { if (done) return; done = true; sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host || '127.0.0.1');
  });
}

// Harvest cookies + UA from the managed Firefox over BiDi (one attach). Loads
// google.com first so the SESSION cookies (NID/AEC/__Secure-STRP) are in the jar —
// a fresh headless launch only has the persistent ones, and without NID Google serves
// a token-less shell page that makes the folwr request 400.
async function harvestViaBrowser() {
  // Harvest on a THROWAWAY tab so we never disturb the tab the user is driving (e.g. the
  // captcha solver): navigating the session `page` to google.com would clobber it mid-
  // solve. Reuse an existing BiDi connection if one is live (Firefox allows only one
  // session, so a fresh connect() could collide with the captcha-clear watcher's) and
  // only disconnect a connection we opened ourselves. http mode never drives the page,
  // so newPage() here is safe (no visibility-spoof preload to hang it).
  const owned = !browser;
  const b = browser || await browserlib.connect(config);
  let harvestPage = null;
  try {
    harvestPage = await b.newPage();
    try {
      await harvestPage.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch (_) { /* best-effort; harvest whatever is there */ }
    const cookies = await harvestPage.cookies('https://www.google.com');
    const ua = await harvestPage.evaluate(() => navigator.userAgent);
    return { cookies, ua };
  } finally {
    try { if (harvestPage) await harvestPage.close(); } catch (_) { /* ignore */ }
    if (owned) { try { await b.disconnect(); } catch (_) { /* ignore */ } }
  }
}

// Get the profile's Google cookies + UA. Prefer a live Firefox if one is on the debug
// port (the captcha solver, or a lingering post-captcha instance) — it has the freshest
// cookies and avoids a cookies.sqlite flush race. Otherwise read the cookies straight
// off disk so normal queries need no Firefox at all.
async function bootstrapCookies() {
  if (await portOpen(config.host, config.port)) return harvestViaBrowser();
  const fromDisk = config.profile ? profileCookies.read(config.profile) : null;
  if (fromDisk) return fromDisk;
  const e = new Error('No usable cookies — run :Ham login (or set backend.mode=browser).');
  e.code = 'ENOCOOKIES';
  throw e;
}

// ---- query engines ----------------------------------------------------------
// One per backend.mode, chosen when the config arrives. Each answers a job (replying via
// send), starts a fresh conversation on reset, and notes errors that affect its state;
// handleQuery/pump hold the mode-independent retry, cancel and queueing logic.

// http: answer over plain HTTP via the token-chaining fetcher instead of driving the
// DOM. `conversation` holds the multi-turn token chain; `cookieStale` forces a cookie
// re-harvest after a captcha/Firefox restart.
const httpEngine = {
  conversation: null,
  cookieStale: false,

  // Lazily build the conversation, or refresh just its cookies after a captcha /
  // Firefox restart (keeping the token chain so context survives).
  async ensureConversation() {
    if (this.conversation && !this.cookieStale) return;
    const { cookies, ua } = await bootstrapCookies();
    if (this.conversation) this.conversation.refreshCookies(cookies, ua);
    else this.conversation = new httpFetcher.Conversation({ cookies, ua });
    this.cookieStale = false;
  },

  async ask(job, signal) {
    await this.ensureConversation();
    const { answer } = await this.conversation.ask(job.text, signal);
    // A response can be "answerable" (has the aimc container) yet render to nothing if
    // the answer markup drifted. Browser mode throws in that case; match it here so ham
    // surfaces a clear error instead of a silent, permanently-blank turn.
    if (!answer || !answer.trim()) {
      throw new Error('No answer text found in the AI Mode response — the markup may '
        + 'have changed (see backend/http_fetcher.js extractAnswer).');
    }
    send({ type: 'done', id: job.id, text: answer }); // one-shot; no streaming
  },

  // Next query starts a fresh first turn (new thread), which harvests cookies itself.
  async reset() {
    this.conversation = null;
    this.cookieStale = false;
  },

  // Only a real bot-check (ECAPTCHA) means the cookie jar is stale and worth
  // re-harvesting. A plain dropped socket (a transient network blip against google.com)
  // does NOT imply stale cookies, so don't force a re-harvest.
  onError(err) {
    if (err.code === 'ECAPTCHA') this.cookieStale = true;
  },
};

// browser: drive the AI Mode DOM in the session tab, streaming chunks as they render.
const browserEngine = {
  async ask(job, signal) {
    await ensureConnected();
    const final = await browserlib.ask(browser, page, job.text, config, (partial) => {
      send({ type: 'chunk', id: job.id, text: partial });
    }, signal);
    send({ type: 'done', id: job.id, text: final });
  },

  // Navigate the driven tab to about:blank so the next query is treated as a first turn
  // (new thread) rather than a follow-up.
  async reset() {
    if (page && !page.isClosed()) {
      await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10000 });
    }
  },

  onError() {},
};

let engine = browserEngine; // until a config says otherwise (browser was the original mode)

async function handleQuery(job, signal) {
  const deadline = Date.now() + 30000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await engine.ask(job, signal);
    } catch (err) {
      // Cancelled by the user (:Ham cancel): stop immediately — don't retry, don't
      // re-harvest cookies. The pump swallows it (the Lua side already detached the turn).
      if (signal && signal.aborted) throw err;
      engine.onError(err);
      // A connection drop is usually Firefox restarted under us (the captcha/headless
      // flip). Drop the dead handle and retry against the fresh instance for a while so
      // the post-captcha re-send runs instead of dying on a "Connection closed". (http
      // mode uses it too: harvestViaBrowser reuses the connection awaitCaptchaCleared made.)
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
  // finally guarantees the flag is cleared even if a job's own plumbing throws (e.g. a
  // stdout EPIPE from fail() when nvim's pipe closes) — otherwise `working` would stay
  // true and every future pump() would return early, wedging the backend silently.
  try {
    while (queue.length) {
      const job = queue.shift();
      if (job.kind === 'reset') {
        // Serialized with queries so a reset can't navigate/clear state out from under
        // an in-flight answer (which would destroy it mid-stream).
        try { await engine.reset(); } catch (_) { /* best-effort; the next query still starts fresh */ }
        continue;
      }
      currentAbort = new AbortController();
      currentJobId = job.id;
      try {
        await handleQuery(job, currentAbort.signal);
      } catch (err) {
        // A user cancel aborts the job's own plumbing; the Lua side already detached the
        // turn, so stay silent rather than surfacing the abort as a backend error.
        if (!currentAbort.signal.aborted) fail(job.id, err);
      } finally {
        currentAbort = null;
        currentJobId = null;
      }
    }
  } finally {
    working = false;
  }
}

// Cancel a query by id: drop it from the queue if it hasn't started, and abort it if
// it's the one currently running (so the pump frees up and the next query starts
// promptly instead of waiting out the abandoned one).
function cancelJob(id) {
  if (id == null) return;
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].kind === 'query' && queue[i].id === id) queue.splice(i, 1);
  }
  if (currentJobId === id && currentAbort) currentAbort.abort();
  // A captcha solve-wait isn't a pump job (it runs in awaitCaptchaCleared), so abort it
  // separately — otherwise it would keep polling for the full timeout after a cancel.
  if (captchaWait && captchaWait.id === id) captchaWait.abort.abort();
}

// Wait for a captcha the user is solving (in the now-headful window) to clear, then
// reply so ham can flip back to headless / close Firefox and retry. The solver flip
// restarted Firefox, so drop any stale handle and connect fresh to the solver window;
// awaitCaptchaClear scans its tabs itself, so we don't need (and must not force) a page.
async function awaitCaptchaCleared(id) {
  // Register the wait so a 'cancel' (:Ham cancel while solving) can abort it. Without
  // this it would poll for the full 180s — and killing Firefox doesn't stop it, since
  // awaitCaptchaClear treats a dropped connection as "no captcha tab yet" and keeps going.
  const ac = new AbortController();
  captchaWait = { id, abort: ac };
  try {
    browser = null;
    page = null;
    await attach();
    const cleared = await browserlib.awaitCaptchaClear(browser, 180000, { signal: ac.signal });
    if (ac.signal.aborted) return; // cancelled: the Lua side restores Firefox; stay silent
    if (cleared) send({ type: 'captcha_cleared', id });
    else fail(id, new Error('captcha not cleared within the time limit'));
  } catch (err) {
    if (!ac.signal.aborted) fail(id, err);
  } finally {
    if (captchaWait && captchaWait.id === id) captchaWait = null;
  }
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
      engine = config.mode === 'http' ? httpEngine : browserEngine;
      break;
    case 'ping':
      send({ type: 'pong' });
      break;
    case 'query':
      queue.push({ kind: 'query', id: msg.id, text: String(msg.text || '') });
      pump();
      break;
    case 'reset':
      queue.push({ kind: 'reset' });
      pump();
      break;
    case 'cancel':
      cancelJob(msg.id);
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

// After an uncaughtException Node's state is officially undefined — continuing could
// leave working/queue/browser inconsistent (a wedged backend that still answers pings).
// Report it, then exit cleanly (ending the BiDi session) so nvim restarts us fresh.
process.on('uncaughtException', (err) => {
  try { fail(null, err); } catch (_) { /* stdout may be gone */ }
  shutdown(1);
});
// Like uncaughtException: an unhandled rejection means some async path threw past its
// awaits, leaving working/queue/browser/conversation in an undefined state. Report it,
// then exit cleanly (ending the BiDi session) so nvim restarts us fresh rather than
// letting a half-broken backend keep answering pings.
process.on('unhandledRejection', (err) => {
  try { fail(null, err instanceof Error ? err : new Error(String(err))); } catch (_) { /* stdout may be gone */ }
  shutdown(1);
});

send({ type: 'ready' });
