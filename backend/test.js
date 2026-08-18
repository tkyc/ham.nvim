'use strict';

// Standalone canary: attach to Firefox, ask one question, print the answer.
// Use this to validate/tune the automation (selectors, URL) independently of nvim.
//
//   1. Fully quit Firefox.
//   2. firefox --remote-debugging-port 9222 &
//   3. node test.js "your question here"
//
// Env overrides: NAM_PORT, NAM_HOST.

const browserlib = require('./browser');

async function main() {
  const question = process.argv.slice(2).join(' ') || 'What is the tallest mountain on Earth?';
  const config = {
    host: process.env.NAM_HOST || undefined,
    port: process.env.NAM_PORT ? Number(process.env.NAM_PORT) : undefined,
  };

  process.stderr.write(`[nam-test] connecting to Firefox...\n`);
  const browser = await browserlib.connect(config);
  try {
    const page = await browserlib.ensurePage(browser, config);
    process.stderr.write(`[nam-test] asking: ${question}\n`);
    let lastLen = 0;
    const answer = await browserlib.ask(browser, page, question, config, (partial) => {
      if (partial.length > lastLen) {
        process.stderr.write(`[nam-test] streaming... (${partial.length} chars)\n`);
        lastLen = partial.length;
      }
    });
    process.stdout.write('\n===== ANSWER =====\n' + answer + '\n');
  } finally {
    // Detach only — never close the user's browser.
    await browser.disconnect();
  }
}

main().catch((err) => {
  process.stderr.write('[nam-test] ERROR: ' + (err.message || err) + '\n');
  process.exit(1);
});
