'use strict';

// Offline unit test for the browserless token-chaining fetcher (backend/http_fetcher.js).
// Exercises token extraction, URL construction, the null-safe merge, and answer
// scraping against a synthetic fixture — no network. The live end-to-end check is
// scripts/validate against a logged-in profile (needs cookies + a cleared bot-flag).

const assert = require('assert');
const hf = require('../backend/http_fetcher.js');

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

// --- fixture: a minimal /search scaffold carrying the async tokens -------------
const SCAFFOLD = `
<div data-ved="2ahUKEwjVED" data-stkp="AeYwpWkSTKP" data-srtst="AF5tSO_SRTST:1787200000000"
     data-garc="ChswGARC" data-ei="EIVALUE123" data-lro-token="0a4LROTOKEN"
     data-lro-signature="LROSIG9" data-elrc="CmowELRC"
     data-xsrf-folwr-token="AF5tSO_FOLWR:1787200000000"
     data-xsrf-folif-token="AF5tSO_FOLIF:1787200000000"></div>`;

// --- extractTokens -------------------------------------------------------------
const tok = hf.extractTokens(SCAFFOLD);
check('extract srtst', tok.srtst === 'AF5tSO_SRTST:1787200000000');
check('extract garc', tok.garc === 'ChswGARC');
check('extract ei', tok.ei === 'EIVALUE123');
check('extract lro-token -> lroToken', tok.lroToken === '0a4LROTOKEN');
check('extract lro-signature -> lroSig', tok.lroSig === 'LROSIG9');
check('extract stkp', tok.stkp === 'AeYwpWkSTKP');
check('extract ved', tok.ved === '2ahUKEwjVED');
check('extract xsrf folwr/folif', tok.xsrfFolwr === 'AF5tSO_FOLWR:1787200000000' && tok.xsrfFolif === 'AF5tSO_FOLIF:1787200000000');
check('scaffold has no mstk', tok.mstk === null);

// --- buildFolwr ----------------------------------------------------------------
const folwr = hf.buildFolwr(tok, 'hello world');
check('folwr hits /async/folwr', folwr.startsWith('https://www.google.com/async/folwr?'));
check('folwr encodes query', folwr.includes('q=hello%20world'));
check('folwr maps mlro/mlros', folwr.includes('mlro=0a4LROTOKEN') && folwr.includes('mlros=LROSIG9'));
check('folwr vet = "1" + ved', folwr.includes('vet=12ahUKEwjVED') && folwr.includes('ved=2ahUKEwjVED'));
check('folwr srtst colon encoded', folwr.includes('srtst=AF5tSO_SRTST%3A1787200000000'));
check('folwr async keeps literal prefix', folwr.includes('async=_fmt:adl,_xsrf:AF5tSO_FOLWR%3A1787200000000'));

// --- buildFolif ----------------------------------------------------------------
const withMstk = hf.mergeTokens(tok, { mstk: 'AUtExfMSTK' });
const folif = hf.buildFolif(withMstk, 'follow up?');
check('folif hits /async/folif', folif.startsWith('https://www.google.com/async/folif?'));
check('folif carries mstk (context)', folif.includes('mstk=AUtExfMSTK'));
check('folif carries elrc + stkp', folif.includes('elrc=CmowELRC') && folif.includes('stkp=AeYwpWkSTKP'));
check('folif has no vet', !/[?&]vet=/.test(folif));
check('folif encodes query', folif.includes('q=follow%20up%3F'));

// --- mergeTokens ---------------------------------------------------------------
const merged = hf.mergeTokens({ srtst: 'keep', mstk: null }, { srtst: null, mstk: 'AUtExfNEW' });
check('merge keeps prior when next is null', merged.srtst === 'keep');
check('merge overlays new non-null (mstk)', merged.mstk === 'AUtExfNEW');

// --- extractAnswer -------------------------------------------------------------
const RESP = `<div data-subtree="aimc" data-x="noise">Answer prose here.
  <script>sn._setImageSrc('img','data:image/jpeg;base64,AAAABBBBCCCC')</script>
  <img src="data:image/png;base64,ZZZZ"> More prose.</div>`;
const ans = hf.extractAnswer(RESP);
check('answer keeps prose', ans.includes('Answer prose here.') && ans.includes('More prose.'));
check('answer drops container attrs (no data-x)', !ans.includes('noise'));
check('answer strips base64/script', !/base64|AAAABBBB|setImageSrc/.test(ans));

// Markdown structure + toolbar/citation trimming (parity with browser mode)
const RESP2 = '<div data-subtree="aimc">'
  + '<div role="heading">Answer</div>'
  + '<ul><li>first</li><li>second</li></ul>'
  + '<p>Monet painted Water Lilies.<a href="https://www.google.com/url?q=w">Wikipedia</a><span>+2</span></p>'
  + '<div>Good response</div><div>Bad response</div><div>Export to Docs</div></div>';
const ans2 = hf.extractAnswer(RESP2);
check('answer renders heading as ###', /(^|\n)### Answer/.test(ans2));
check('answer renders list as bullets', /(^|\n)- first/.test(ans2) && /(^|\n)- second/.test(ans2));
check('answer keeps the prose', ans2.includes('Monet painted Water Lilies.'));
check('answer cuts the action toolbar', !/Good response|Bad response|Export to Docs/.test(ans2));
check('answer drops the Wikipedia/+2 citation chips', !/Wikipedia/.test(ans2) && !/\+2/.test(ans2));

// --- ensureAnswerable (shell / bot-check detection) ----------------------------
check('answerable when aimc present', (() => { try { hf.ensureAnswerable('<div data-subtree="aimc">x</div>'); return true; } catch (_) { return false; } })());
let ecaptcha = null;
try { hf.ensureAnswerable('<html>Error 400</html>'); } catch (e) { ecaptcha = e; }
check('token-less shell throws ECAPTCHA', ecaptcha && ecaptcha.code === 'ECAPTCHA');

// --- refreshCookies ------------------------------------------------------------
const conv = new hf.Conversation({ cookies: 'A=1', ua: 'UA-old' });
conv.tokens = { mstk: 'AUtExfKEEP', srtst: 'keep' }; // simulate an in-flight conversation
conv.refreshCookies([{ name: 'GOOGLE_ABUSE_EXEMPTION', value: 'fresh' }], 'UA-new');
check('refreshCookies swaps the cookie jar', Array.isArray(conv.ctx.cookies) && conv.ctx.cookies[0].value === 'fresh');
check('refreshCookies updates the UA', conv.ctx.ua === 'UA-new');
check('refreshCookies preserves the token chain (context)', conv.tokens.mstk === 'AUtExfKEEP');

// --- isAnswerable + hex entity decoding ---------------------------------------
check('isAnswerable true when aimc present', hf.isAnswerable('<div data-subtree="aimc">x</div>') === true);
check('isAnswerable false for an error page', hf.isAnswerable('<html>Error 400</html>') === false);
check('decodeEntities handles hex + decimal', hf.decodeEntities('a &#x27;b&#39; &lt;c&gt;') === "a 'b' <c>");

// --- httpGet request timeout (async): a server that never responds must not hang ---
(async () => {
  const net = require('node:net');
  // Accept the connection but never write a response → fetch would hang without a timeout.
  const server = net.createServer(() => { /* hold the socket open, send nothing */ });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const t0 = Date.now();
  let msg = '';
  try {
    await hf.httpGet(`http://127.0.0.1:${port}/x`, { cookies: '', ua: 'x', timeoutMs: 150 });
  } catch (e) { msg = e.message || String(e); }
  const elapsed = Date.now() - t0;
  server.close();
  check('httpGet times out (does not hang)', /timed out/i.test(msg) && elapsed < 3000);

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
