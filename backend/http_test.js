'use strict';

// Live canary for the browserless token-chaining fetcher (http_fetcher.js).
// Bootstraps cookies from the running Firefox (the debug port must be up and the
// profile logged in / un-flagged), then holds a multi-turn conversation entirely
// over HTTP — no browser drives the queries. Proves first-turn (folwr) + follow-up
// (folif) context threading.
//
//   1. Firefox must be reachable on the debug port (HAM_PORT / HAM_HOST, default 9222).
//   2. node http_test.js "first question" "follow-up 1" "follow-up 2" ...
//      (defaults to an impressionist-painters conversation if no args)

const browserlib = require('./browser');
const { Conversation } = require('./http_fetcher');

async function main() {
  const queries = process.argv.slice(2);
  const turns = queries.length ? queries
    : ['name three famous impressionist painters', 'which of them painted water lilies?', 'where is that series displayed?'];

  process.stderr.write('[http-test] bootstrapping cookies from Firefox...\n');
  const browser = await browserlib.connect({
    host: process.env.HAM_HOST || undefined,
    port: process.env.HAM_PORT ? Number(process.env.HAM_PORT) : undefined,
  });
  let cookies = [];
  let ua;
  try {
    const page = await browserlib.ensurePage(browser);
    cookies = await page.cookies('https://www.google.com');
    ua = await page.evaluate(() => navigator.userAgent);
  } finally {
    await browser.disconnect(); // detach — the queries need no browser
  }
  process.stderr.write(`[http-test] ${cookies.length} cookies; browser detached. Querying over HTTP only.\n`);

  const conv = new Conversation({ cookies, ua });
  for (let i = 0; i < turns.length; i++) {
    process.stderr.write(`\n[http-test] turn ${i + 1}: ${turns[i]}\n`);
    const { answer } = await conv.ask(turns[i]);
    process.stdout.write(`\n===== TURN ${i + 1} =====\nQ: ${turns[i]}\nA: ${answer.slice(0, 700)}\n`);
  }
}

main().catch((err) => {
  process.stderr.write('[http-test] ERROR: ' + (err.message || err) + (err.code ? ` (${err.code})` : '') + '\n');
  process.exit(1);
});
