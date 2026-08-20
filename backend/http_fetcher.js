'use strict';

// Browserless Google AI Mode client.
//
// AI Mode answers are delivered by two GET endpoints, not a documented API:
//   - first turn : GET /search?udm=50&q=Q  →  scaffold HTML carrying async tokens,
//                  then GET /async/folwr?…&q=Q  →  answer HTML
//   - follow-ups : GET /async/folif?q=Q&mstk=…&stkp=…&elrc=…  →  answer HTML
//
// Both are plain GETs authenticated by the profile cookie jar (crucially
// GOOGLE_ABUSE_EXEMPTION + NID); there is no BotGuard on the answer path. Context
// is threaded by tokens: each response carries the tokens needed to build the next
// turn's request. This module chains them so a whole conversation runs over HTTP
// with no browser. Tokens/markup are Google-internal and change often — when a turn
// stops returning text, re-capture with the scripts in test/ and update the maps.

const BASE = 'https://www.google.com';
const FF_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0';

const htmlmd = require('./html_markdown');

// ---- token extraction -------------------------------------------------------

// First non-empty `data-<name>="…"` value in an HTML string.
function dataAttr(html, name) {
  const m = html.match(new RegExp('data-' + name.replace(/[-]/g, '\\-') + '="([^"]*)"'));
  return m ? m[1] : null;
}

// Overlay `next` onto `prev`, but only where `next` actually has a value — so a
// response that omits a token (e.g. folwr drops srtst/ei) keeps the prior one.
function mergeTokens(prev, next) {
  const out = { ...prev };
  for (const [k, v] of Object.entries(next || {})) if (v != null && v !== '') out[k] = v;
  return out;
}

// The tokens a turn's response must expose so we can build the NEXT request.
function extractTokens(html) {
  return {
    srtst: dataAttr(html, 'srtst'),
    garc: dataAttr(html, 'garc'),
    ei: dataAttr(html, 'ei'),
    lroToken: dataAttr(html, 'lro-token'),
    lroSig: dataAttr(html, 'lro-signature'),
    stkp: dataAttr(html, 'stkp'),
    ved: dataAttr(html, 'ved'),
    elrc: dataAttr(html, 'elrc'),
    xsrfFolwr: dataAttr(html, 'xsrf-folwr-token'),
    xsrfFolif: dataAttr(html, 'xsrf-folif-token'),
    // conversation "master" token — absent on the /search scaffold, present in the
    // answer responses; threads context into follow-ups.
    mstk: dataAttr(html, 'mstk') || dataAttr(html, 'msei') || (html.match(/(AUtExf[A-Za-z0-9_-]{20,})/) || [])[1] || null,
  };
}

// ---- answer extraction ------------------------------------------------------

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

// The answer's action toolbar (Good response / Bad response / Export to Docs / the
// share sheet) can trail the prose as plain text when the raw response renders those
// labels as <div>s rather than <button>s (which the renderer's SKIP set would drop).
// These distinctive multi-word markers show where the prose ends, so we cut there.
// (Single words like "share"/"export" are omitted as too likely to appear in prose.)
const TOOLBAR_MARKERS = [
  'Good response', 'Bad response', 'Copy Share public link', 'Export to Docs',
];

function cutToolbar(text) {
  const lower = text.toLowerCase();
  let cut = -1;
  for (const m of TOOLBAR_MARKERS) {
    const i = lower.indexOf(m.toLowerCase());
    if (i !== -1 && (cut === -1 || i < cut)) cut = i;
  }
  return cut !== -1 ? text.slice(0, cut).trim() : text;
}

// Fallback flattener: strip tags and collapse whitespace within the aimc container.
// Used only if the Markdown render yields nothing (malformed/unexpected HTML).
function flattenAnswer(html) {
  const idx = html.indexOf('data-subtree="aimc"');
  let region = html;
  if (idx !== -1) {
    const gt = html.indexOf('>', idx);
    region = html.slice(gt + 1, gt + 1 + 400000);
  }
  return decodeEntities(
    region
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=\\]+/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

// Convert a folwr/folif answer response to Markdown, matching browser mode. Walks the
// answer region to Markdown (see html_markdown.js) — headings, lists, bold/italic,
// fenced code, tables, links; citations/boilerplate dropped. Falls back to a flat
// strip if parsing produces nothing, and trims trailing action-toolbar chrome.
//
// We render the REGION after the aimc container's opening tag (bounded, like the flat
// fallback) rather than the parsed container element: Google's real answer HTML is
// deeply/imperfectly nested, so the container node can close early in the parse tree —
// region-slicing sidesteps that and keeps the answer, which sits at the top.
function extractAnswer(html) {
  const idx = html.indexOf('data-subtree="aimc"');
  let region = html;
  if (idx !== -1) {
    const gt = html.indexOf('>', idx); // skip past the container's opening tag
    region = html.slice(gt + 1, gt + 1 + 400000);
  }
  const cleaned = region
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=\\]+/gi, '');
  let out = '';
  try {
    out = htmlmd.render(htmlmd.parse(cleaned));
  } catch (_) { out = ''; }
  if (!out) out = flattenAnswer(html);
  return cutToolbar(out);
}

// ---- HTTP -------------------------------------------------------------------

function cookieHeader(cookies) {
  if (typeof cookies === 'string') return cookies;
  return (cookies || []).map((c) => `${c.name}=${c.value}`).join('; ');
}

// A bot-check / degraded-response error, routed by the backend into the same
// solver → cookie-refresh recovery as a browser-mode captcha.
function captchaError(detail) {
  const e = new Error('Google is not serving AI Mode' + (detail ? ' — ' + detail : '') + ' (bot-check / stale exemption).');
  e.code = 'ECAPTCHA';
  return e;
}

// A real answer response carries the aimc prose container. Its absence (an error
// page or the degraded shell) means we're blocked — surface it for recovery.
function ensureAnswerable(body) {
  if (!body || body.indexOf('data-subtree="aimc"') === -1) throw captchaError('no answer container in response');
}

async function httpGet(url, ctx) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': ctx.ua || FF_UA,
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Cookie': cookieHeader(ctx.cookies),
    },
  });
  const body = await res.text();
  if (/\/sorry\//.test(res.url)) throw captchaError('/sorry redirect');
  return { status: res.status, finalUrl: res.url, body };
}

// ---- URL builders -----------------------------------------------------------

// Build a query string with the EXACT encoding AI Mode uses. Most values are
// encodeURIComponent'd, but the `async` param must keep its `_fmt:adl,_xsrf:`
// prefix literal (only the token is encoded) or the server 400s — so we assemble
// the string by hand instead of via URLSearchParams (which would encode the `,`/`:`).
function qs(pairs) {
  return pairs.filter(([, v]) => v != null && v !== '').map(([k, v, raw]) => k + '=' + (raw ? v : encodeURIComponent(v))).join('&');
}

function asyncParam(xsrf) {
  return '_fmt:adl,_xsrf:' + encodeURIComponent(xsrf || '');
}

function buildFolwr(tok, query) {
  const vet = tok.ved ? '1' + tok.ved : null; // vet is literally "1" + ved
  return BASE + '/async/folwr?' + qs([
    ['srtst', tok.srtst],
    ['garc', tok.garc],
    ['mlro', tok.lroToken],
    ['mlros', tok.lroSig],
    ['ei', tok.ei],
    ['q', query],
    ['yv', '3'],
    ['vet', vet],
    ['ved', tok.ved],
    ['udm', '50'],
    ['stkp', tok.stkp],
    ['cs', '0'],
    ['async', asyncParam(tok.xsrfFolwr), true],
  ]);
}

function buildFolif(tok, query) {
  // folif carries no `vet`; its `ved` is a short UI form (not the scaffold's long
  // ved) and appears optional, so we omit it. Context rides in mstk + stkp + elrc.
  return BASE + '/async/folif?' + qs([
    ['srtst', tok.srtst],
    ['ei', tok.ei],
    ['yv', '3'],
    ['udm', '50'],
    ['stkp', tok.stkp],
    ['cs', '0'],
    ['csuir', '0'],
    ['elrc', tok.elrc],
    ['mstk', tok.mstk],
    ['csui', '3'],
    ['q', query],
    ['async', asyncParam(tok.xsrfFolif || tok.xsrfFolwr), true],
  ]);
}

// ---- public API -------------------------------------------------------------

// A conversation over HTTP. `cookies` is a cookie string or [{name,value}]; `ua` is
// the profile's User-Agent (match the browser that owns the cookies).
class Conversation {
  constructor({ cookies, ua } = {}) {
    this.ctx = { cookies, ua: ua || FF_UA };
    this.tokens = null; // tokens for the NEXT turn (null ⇒ first turn)
  }

  // Swap the cookie jar (and optionally UA) without touching the token chain, so a
  // mid-conversation captcha refresh (new GOOGLE_ABUSE_EXEMPTION) keeps context.
  refreshCookies(cookies, ua) {
    this.ctx.cookies = cookies;
    if (ua) this.ctx.ua = ua;
  }

  async ask(query) {
    if (!this.tokens) return this._firstTurn(query);
    return this._followUp(query);
  }

  async _firstTurn(query) {
    const scaffold = await httpGet(BASE + '/search?udm=50&q=' + encodeURIComponent(query), this.ctx);
    const tok = extractTokens(scaffold.body);
    // A scaffold with no async tokens is Google's degraded "shell" page, served when
    // the GOOGLE_ABUSE_EXEMPTION cookie is stale/expired (a 200, not a /sorry redirect,
    // so httpGet let it through). Surface it as ECAPTCHA so the backend runs the same
    // solver → cookie-refresh recovery as a hard bot-check.
    if (!tok.srtst || !tok.garc) throw captchaError('stale bot-check exemption (token-less page)');
    const ans = await httpGet(buildFolwr(tok, query), this.ctx);
    ensureAnswerable(ans.body);
    // Chain: keep the scaffold's srtst/ei/stkp/elrc/xsrf (the answer response omits
    // them) and overlay whatever fresh tokens the answer DID carry — crucially mstk,
    // the conversation thread token that gives follow-ups their context.
    this.tokens = mergeTokens(tok, extractTokens(ans.body));
    return { answer: extractAnswer(ans.body), raw: ans.body };
  }

  async _followUp(query) {
    const ans = await httpGet(buildFolif(this.tokens, query), this.ctx);
    ensureAnswerable(ans.body);
    this.tokens = mergeTokens(this.tokens, extractTokens(ans.body));
    return { answer: extractAnswer(ans.body), raw: ans.body };
  }
}

module.exports = { Conversation, extractTokens, mergeTokens, buildFolwr, buildFolif, extractAnswer, ensureAnswerable, FF_UA };
