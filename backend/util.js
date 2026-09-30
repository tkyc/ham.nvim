'use strict';

// Small helpers shared by the browser (browser.js) and browserless (http_fetcher.js)
// query paths. Kept separate so http mode never loads puppeteer via browser.js.

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Thrown when a user cancel (:Ham cancel) aborts a query mid-wait. The backend swallows
// it (the Lua side already detached the turn).
function abortError() {
  const e = new Error('cancelled');
  e.name = 'AbortError';
  return e;
}

module.exports = { sleep, abortError };
