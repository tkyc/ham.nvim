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

const htmlmd = require('./html_markdown');
// The generic Firefox UA lives in profile_cookies (the module that owns UA derivation);
// reuse it here as the fallback so the string is defined in exactly one place.
const FF_UA = require('./profile_cookies').DEFAULT_UA;

// ---- token extraction -------------------------------------------------------

// First NON-EMPTY `data-<name>="…"` value in an HTML string. Skipping empties matters:
// an empty placeholder (e.g. data-ei="") earlier in the page than the real token would
// otherwise mask it, dropping the token from the next request's URL.
function dataAttr(html, name) {
  const re = new RegExp('data-' + name + '="([^"]+)"');
  const m = html.match(re);
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

// Single shared implementation (see html_markdown.js): decodes named + numeric
// entities with out-of-range code points clamped, so a malformed entity can't throw.
const decodeEntities = htmlmd.decodeEntities;

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
    const ml = m.toLowerCase();
    // Only treat a marker as toolbar chrome when it starts its own line (real answers
    // don't put "Good response"/"Export to Docs" mid-sentence). This avoids truncating
    // prose that happens to contain "a good response to…". Scan lines, not substrings.
    let from = 0;
    while (true) {
      const i = lower.indexOf(ml, from);
      if (i === -1) break;
      const atLineStart = i === 0 || lower[i - 1] === '\n';
      if (atLineStart && (cut === -1 || i < cut)) { cut = i; break; }
      from = i + ml.length;
    }
  }
  return cut !== -1 ? text.slice(0, cut).trim() : text;
}

// The bounded slice after the aimc container's opening tag (the answer prose sits at
// the top). Bounded rather than the parsed container element because Google's answer
// HTML is deeply/imperfectly nested and the container node can close early in a parse.
function aimcRegion(html) {
  const idx = html.indexOf('data-subtree="aimc"');
  if (idx === -1) return html;
  const gt = html.indexOf('>', idx); // skip past the container's opening tag
  return html.slice(gt + 1, gt + 1 + 400000);
}

// Drop script/style bodies and inlined base64 images from a region.
function stripNoise(region) {
  return region
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=\\]+/gi, ' ');
}

// Fallback flattener: strip tags and collapse whitespace within the aimc container.
// Used only if the Markdown render yields nothing (malformed/unexpected HTML).
function flattenAnswer(html) {
  return decodeEntities(stripNoise(aimcRegion(html)).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim();
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
  const cleaned = stripNoise(aimcRegion(html));
  let out = '';
  try {
    out = htmlmd.render(htmlmd.parse(cleaned));
  } catch (_) { out = ''; }
  if (!out) out = flattenAnswer(html);
  return cutToolbar(out);
}

// ---- HTTP -------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

// A real answer response carries the aimc prose container.
function isAnswerable(body) {
  return !!body && body.indexOf('data-subtree="aimc"') !== -1;
}

// Its absence (an error page or the degraded shell) means we're blocked — surface it
// for recovery (the backend routes ECAPTCHA into the solver → cookie-refresh flow).
function ensureAnswerable(body) {
  if (!isAnswerable(body)) throw captchaError('no answer container in response');
}

const DEFAULT_TIMEOUT_MS = 30000;

async function httpGet(url, ctx) {
  const timeoutMs = (ctx && ctx.timeoutMs) || DEFAULT_TIMEOUT_MS;
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs), // bound the whole request+body read
      headers: {
        'User-Agent': ctx.ua || FF_UA,
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Cookie': cookieHeader(ctx.cookies),
      },
    });
    const body = await res.text();
    if (/\/sorry\//.test(res.url)) throw captchaError('/sorry redirect');
    // A throttle (429) or transient server error is NOT a bot-check — surface it as a
    // plain (uncoded) error so the backend reports it instead of burning a captcha
    // solve / cookie re-harvest on the token-less body these responses carry.
    if (res.status === 429 || res.status >= 500) {
      throw new Error(`AI Mode returned HTTP ${res.status} (rate-limited or temporary server error) — try again shortly.`);
    }
    return { status: res.status, finalUrl: res.url, body };
  } catch (err) {
    if (err && err.code === 'ECAPTCHA') throw err; // our own /sorry throw — pass through
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`AI Mode request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  }
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
    // Without mstk (the thread token) folif can't carry context anyway — start a fresh
    // first turn deliberately rather than silently sending a context-free follow-up.
    if (!this.tokens.mstk) {
      this.tokens = null;
      return this._firstTurn(query);
    }
    // Try folif up to twice: a transient shell (the answer just wasn't ready) shouldn't
    // cost the whole conversation. Keep the tokens across attempts and give the second a
    // brief beat to let the answer materialize.
    let ans = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      ans = await httpGet(buildFolif(this.tokens, query), this.ctx);
      if (isAnswerable(ans.body)) break;
      if (attempt < 2) await sleep(400);
    }
    if (!isAnswerable(ans.body)) {
      // Still nothing — the follow-up token chain (srtst/mstk…) likely expired. Drop it
      // and retry as a fresh first turn: recovers the answer (losing conversation
      // context) when the cookies are still good. If this is actually a bot-check,
      // _firstTurn's scaffold has no tokens → it throws ECAPTCHA and the backend opens
      // the solver — so token-expiry and captcha stay distinct.
      this.tokens = null;
      return this._firstTurn(query);
    }
    this.tokens = mergeTokens(this.tokens, extractTokens(ans.body));
    return { answer: extractAnswer(ans.body), raw: ans.body };
  }
}

module.exports = { Conversation, extractTokens, mergeTokens, buildFolwr, buildFolif, extractAnswer, ensureAnswerable, isAnswerable, httpGet, cookieHeader, decodeEntities, FF_UA };
