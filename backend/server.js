'use strict';

// Long-lived backend for the ham Neovim plugin.
//
// Speaks newline-delimited JSON over stdio:
//   IN : {"type":"config","config":{...}}          (optional, send once first)
//        {"type":"query","id":<n>,"text":"..."}
//        {"type":"reset"}                            (start a fresh conversation)
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

// HTTP mode (config.mode === 'http'): answer over plain HTTP via the token-chaining
// fetcher instead of driving the DOM. `conversation` holds the multi-turn token
// chain; `cookieStale` forces a cookie re-harvest after a captcha/Firefox restart.
let conversation = null;
let cookieStale = false;

function isHttpMode() {
  return config.mode === 'http';
}

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
    const b = await browserlib.connect(config);
    // Guard: only clear if THIS instance is still current, so a late 'disconnected'
    // from a just-killed Firefox can't null a freshly-reconnected browser.
    b.on('disconnected', () => { if (browser === b) { browser = null; page = null; } });
    browser = b;
  }
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

// Lazily build the HTTP conversation, or refresh just its cookies after a captcha /
// Firefox restart (keeping the token chain so context survives).
async function ensureConversation() {
  if (!conversation) {
    const { cookies, ua } = await bootstrapCookies();
    conversation = new httpFetcher.Conversation({ cookies, ua });
  } else if (cookieStale) {
    const { cookies, ua } = await bootstrapCookies();
    conversation.refreshCookies(cookies, ua);
    cookieStale = false;
  }
}

async function handleQuery(job) {
  const deadline = Date.now() + 30000;
  for (let attempt = 1; ; attempt++) {
    try {
      if (isHttpMode()) {
        await ensureConversation();
        const { answer } = await conversation.ask(job.text);
        // A response can be "answerable" (has the aimc container) yet render to nothing
        // if the answer markup drifted. Browser mode throws in that case; match it here
        // so ham surfaces a clear error instead of a silent, permanently-blank turn.
        if (!answer || !answer.trim()) {
          throw new Error('No answer text found in the AI Mode response — the markup may '
            + 'have changed (see backend/http_fetcher.js extractAnswer).');
        }
        send({ type: 'done', id: job.id, text: answer }); // one-shot; no streaming
      } else {
        await ensureConnected();
        const final = await browserlib.ask(browser, page, job.text, config, (partial) => {
          send({ type: 'chunk', id: job.id, text: partial });
        });
        send({ type: 'done', id: job.id, text: final });
      }
      return;
    } catch (err) {
      // Only a real bot-check (ECAPTCHA) means the HTTP conversation's cookie jar is
      // stale and worth re-harvesting. A plain dropped socket (a transient network blip
      // against google.com) does NOT imply stale cookies, so don't force a re-harvest.
      if (isHttpMode() && err.code === 'ECAPTCHA') cookieStale = true;
      // A connection drop is usually Firefox restarted under us (browser mode's
      // captcha/headless flip). Retry connecting to the fresh instance for a while so
      // the post-captcha re-send runs instead of dying on a "Connection closed". Only
      // browser mode holds a session browser/page to drop; in http mode they're unused.
      if (isConnDropped(err) && attempt <= 8 && Date.now() < deadline) {
        if (!isHttpMode()) {
          browser = null;
          page = null;
        }
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
        try { await resetConversation(); } catch (_) { /* best-effort */ }
        continue;
      }
      try {
        await handleQuery(job);
      } catch (err) {
        fail(job.id, err);
      }
    }
  } finally {
    working = false;
  }
}

// Wait for a captcha the user is solving (in the now-headful window) to clear, then
// reply so ham can flip back to headless / close Firefox and retry. The solver flip
// restarted Firefox, so drop any stale handle and connect fresh to the solver window;
// awaitCaptchaClear scans its tabs itself, so we don't need (and must not force) a page.
async function awaitCaptchaCleared(id) {
  try {
    browser = null;
    page = null;
    const b = await browserlib.connect(config);
    b.on('disconnected', () => { if (browser === b) { browser = null; page = null; } });
    browser = b;
    const cleared = await browserlib.awaitCaptchaClear(browser, 180000);
    if (cleared) send({ type: 'captcha_cleared', id });
    else fail(id, new Error('captcha not cleared within the time limit'));
  } catch (err) {
    fail(id, err);
  }
}

// Start a fresh AI Mode conversation: navigate the driven tab to about:blank so
// the next query is treated as a first turn (new thread) rather than a follow-up.
async function resetConversation() {
  if (isHttpMode()) {
    conversation = null; // next query starts a fresh first turn (new thread)
    cookieStale = false; // the fresh Conversation harvests cookies itself; don't double-harvest
    return;
  }
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
      queue.push({ kind: 'query', id: msg.id, text: String(msg.text || '') });
      pump();
      break;
    case 'reset':
      queue.push({ kind: 'reset' });
      pump();
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
