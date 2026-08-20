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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
