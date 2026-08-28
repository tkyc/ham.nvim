'use strict';

// Offline unit test for awaitCaptchaClear — the "captcha solved?" detector used by both
// modes. Regression guard for the hang where the user solves the captcha before the
// backend observes it. Uses fake pages (controllable url(); evaluate()→false so
// detectCaptcha keys off the URL) — no browser, no network.

const b = require('../backend/browser.js');

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

const AI = 'https://www.google.com/search?udm=50&q=hello';
const SORRY = 'https://www.google.com/sorry/index?continue=https://www.google.com/search%3Fudm%3D50%26q%3Dhello';
const fakeBrowser = (page) => ({ pages: async () => [page] });
const staticPage = (url) => ({ url: () => url, evaluate: async () => false });
// url is SORRY until `sorryMs` have elapsed, then flips to `after`.
const timedPage = (sorryMs, after) => { const t0 = Date.now(); return { url: () => (Date.now() - t0 < sorryMs ? SORRY : after), evaluate: async () => false }; };

const OPT = { pollMs: 5 };

(async () => {
  // isAiModeSearch classification
  check('isAiModeSearch: AI Mode /search?udm=50', b.isAiModeSearch(AI) === true);
  check('isAiModeSearch: plain /search (no udm) is not', b.isAiModeSearch('https://www.google.com/search?q=x') === false);
  check('isAiModeSearch: about:blank is not', b.isAiModeSearch('about:blank') === false);

  // 1. solve-BEFORE-observe (the reported regression): already on the AI Mode page.
  check('cleared when AI Mode already showing (no captcha ever observed)',
    (await b.awaitCaptchaClear(fakeBrowser(staticPage(AI)), 3000, OPT)) === true);

  // 2. solve-AFTER-observe: /sorry for a bit, then AI Mode.
  check('cleared after /sorry flips to AI Mode',
    (await b.awaitCaptchaClear(fakeBrowser(timedPage(40, AI)), 3000, OPT)) === true);

  // 3. /sorry that never clears → times out (not cleared). Its continue=…/search proves
  //    captcha takes precedence over the "solved" URL match.
  check('NOT cleared while /sorry persists (captcha wins over continue=/search)',
    (await b.awaitCaptchaClear(fakeBrowser(staticPage(SORRY)), 120, OPT)) === false);

  // 4. only a blank/loading tab → keep waiting → times out (no false clear).
  check('NOT cleared on about:blank only',
    (await b.awaitCaptchaClear(fakeBrowser(staticPage('about:blank')), 120, OPT)) === false);

  // 5. :Ham cancel while solving — an already-aborted signal stops the wait at once
  //    (returns false fast) even though the /sorry page would otherwise run to timeout.
  {
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    const res = await b.awaitCaptchaClear(fakeBrowser(staticPage(SORRY)), 5000, { pollMs: 5, signal: ac.signal });
    check('aborted signal stops the wait fast (returns false)', res === false && (Date.now() - t0) < 1000);
  }

  // 6. a signal that fires partway through also breaks out well before the timeout.
  {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const t0 = Date.now();
    const res = await b.awaitCaptchaClear(fakeBrowser(staticPage(SORRY)), 5000, { pollMs: 5, signal: ac.signal });
    check('mid-wait abort breaks out before timeout', res === false && (Date.now() - t0) < 2000);
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
