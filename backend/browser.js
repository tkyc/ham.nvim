'use strict';

// Core automation for driving Google AI Mode inside the user's Firefox.
//
// We do NOT launch a browser. The user starts their own Firefox with
//   firefox --remote-debugging-port 9222
// which exposes a WebDriver BiDi websocket at ws://127.0.0.1:9222 . We attach
// to it with puppeteer-core (protocol: 'webDriverBiDi') and reuse their logged-in
// Google session.
//
// Everything Google-specific (URL, selectors, timings) lives in DEFAULTS so it
// can be overridden from the Neovim side without touching this logic. Google
// changes AI Mode's markup often; when a query stops returning text, re-tune the
// selectors here (or via config) using test.js as the canary.

const puppeteer = require('puppeteer-core');

const DEFAULTS = {
  host: '127.0.0.1',
  port: 9222,
  // AI Mode is served by Search with udm=50. The first query is submitted by
  // navigating straight to this URL with the query appended; follow-ups are typed
  // into the on-page follow-up box so the conversation keeps its context.
  ai_mode_url: 'https://www.google.com/search?udm=50&q=',
  // Candidate selectors for the follow-up input box (first match wins).
  // Tuned against live AI Mode (Aug 2026): the follow-up box lives inside the
  // #aim-mars-input-plate and has placeholder "Ask anything".
  followup_selectors: [
    '#aim-mars-input-plate textarea',
    'textarea[placeholder="Ask anything"]',
    'textarea[placeholder*="Ask" i]',
    'textarea[aria-label*="Ask" i]',
    'div[contenteditable="true"]',
    'textarea',
  ],
  // Candidate selectors for the container(s) holding AI Mode answers. We read the
  // LAST match's innerText as the current answer (== the newest turn, so follow-ups
  // work). Tuned against live AI Mode (Aug 2026): the answer prose is marked with
  // data-subtree="aimc" and sits inside a [data-streaming-container]; each
  // conversation turn is wrapped in [data-xid="aim-mars-turn-root"].
  response_selectors: [
    'div[data-subtree="aimc"]',
    'div[data-streaming-container]',
    '[data-xid="aim-mars-turn-root"]',
  ],
  // The composer submits on Enter, but as a fallback we click this button.
  submit_button_selector: 'button[aria-label="Send"]',
  nav_timeout_ms: 30000,
  new_turn_timeout_ms: 6000, // wait for a follow-up's answer container to appear
  connect_timeout_ms: 15000,
  response_timeout_ms: 120000,
  poll_interval_ms: 400,
  // Each finished answer gains an action toolbar; these are the exact aria-labels
  // of its buttons (anchored, so "Copy <prompt>" / "Copy code…" / "Share with X"
  // do NOT match). We detect completion by the COUNT of these increasing, which
  // works for follow-ups too (turns share a container, so scoping to one turn is
  // unreliable — but each completed answer still adds its own toolbar).
  complete_label_pattern: '^(share|copy text|read aloud|good response|bad response|export|regenerate)$',
  // Poll cadence + how long text must sit unchanged before we check completeness.
  settle_polls: 3,
  // Fallback: if text stays unchanged this many polls without the complete
  // signal, finish anyway (guards against the signal changing/breaking).
  stall_polls: 38,
};

function mergeConfig(overrides) {
  const merged = Object.assign({}, DEFAULTS);
  for (const [k, v] of Object.entries(overrides || {})) {
    if (v !== undefined && v !== null) merged[k] = v; // never let absent keys clobber defaults
  }
  return merged;
}

// Attach to the already-running Firefox. Throws a friendly error if the remote
// agent isn't reachable (i.e. Firefox wasn't launched with the flag).
async function connect(config) {
  const cfg = mergeConfig(config);
  // Firefox's remote agent serves the WebDriver BiDi socket at /session
  // (the root path answers with plain HTTP, which fails the ws upgrade).
  const endpoint = `ws://${cfg.host}:${cfg.port}/session`;
  try {
    const browser = await puppeteer.connect({
      browserWSEndpoint: endpoint,
      protocol: 'webDriverBiDi',
      // Firefox may report a viewport we don't want to override.
      defaultViewport: null,
    });
    return browser;
  } catch (err) {
    // Distinguish an ORPHANED session (port is up but Firefox is holding a stale
    // BiDi session and refuses new ones) from the port being down. Firefox only
    // allows one session and won't reap it on a dropped socket, so recovery needs
    // a Firefox restart — the Lua side keys off this code to do that automatically.
    const orphaned = /Maximum number of active sessions|session not created/i.test(err.message || '');
    const e = new Error(
      orphaned
        ? `Firefox is holding an orphaned automation session and refuses new ones. `
          + `It must be restarted to recover.\n(underlying: ${err.message})`
        : `Could not attach to Firefox at ${endpoint}. Fully quit Firefox, then `
          + `relaunch it with:  firefox --remote-debugging-port ${cfg.port}\n(underlying: ${err.message})`
    );
    e.code = orphaned ? 'ESESSIONBUSY' : 'ENOATTACH';
    throw e;
  }
}

// Return a fresh tab for nam to drive. The backend caches this page for the whole
// session, so this runs once. We deliberately create our OWN tab rather than
// reusing an existing AI Mode tab, so nam never hijacks a conversation the user
// already has open (and a fresh tab avoids the known puppeteer<->firefox goto hang
// on the initially-attached page).
async function ensurePage(browser, config) {
  return await browser.newPage();
}

async function firstMatch(page, selectors, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) return { el, selector: sel };
    }
    await sleep(200);
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Read one answer container as Markdown. `index` selects WHICH turn's container
// (0-based) using the first selector that has more than `index` matches — so a
// follow-up reads only its own new answer, never falling back to a container that
// still holds the previous turn. We walk the DOM instead of taking innerText so we
// can keep structure (headings, bold/italic, lists, links, fenced code, tables)
// and drop AI Mode's citation chips/cards.
async function readAnswer(page, selectors, index) {
  return page.evaluate((args) => {
    const sels = args[0];
    const idx = args[1];
    const SKIP = new Set(['BUTTON', 'SVG', 'PATH', 'IMG', 'STYLE', 'SCRIPT', 'NOSCRIPT', 'INPUT', 'TEXTAREA']);
    // A "source chip" whose ENTIRE text is one of these is a citation to drop.
    // Kept multi-char to avoid nuking real words (no bare single letters).
    const SOURCE = /^(\+\d+|sources?|wikipedia|encyclopedia britannica|britannica|youtube|reddit|linkedin|facebook|instagram|twitter)$/i;

    function isCitation(el) {
      if (el.getAttribute('aria-hidden') === 'true') return true;
      // A chip whose ENTIRE text is a source name / "+3" is a citation.
      const t = (el.textContent || '').trim();
      if (SOURCE.test(t)) return true;
      // Citation source CARDS are block-level chips carrying data-src-id (a title +
      // snippet + source + date). Skip those, but KEEP inline entity chips (e.g. a
      // linked team name), which are inline, not block.
      if (el.hasAttribute('data-src-id')) {
        const d = window.getComputedStyle(el).display;
        if (d === 'block' || d === 'list-item' || d === 'flex' || d === 'table' || d === 'grid') return true;
      }
      return false;
    }

    function norm(s) {
      return (s || '').replace(/\s+/g, ' ');
    }

    function cellText(el) {
      return norm(el.innerText || el.textContent).trim().replace(/\|/g, '\\|');
    }

    // Convert a <table> into a GitHub-flavored Markdown table.
    function tableToMd(tbl) {
      const rows = Array.prototype.slice.call(tbl.querySelectorAll('tr'));
      const md = [];
      rows.forEach((tr, ri) => {
        const cells = Array.prototype.slice.call(tr.querySelectorAll('th, td')).map(cellText);
        if (!cells.length) return;
        md.push('| ' + cells.join(' | ') + ' |');
        if (ri === 0) md.push('| ' + cells.map(function () { return '---'; }).join(' | ') + ' |');
      });
      return md.length ? '\n' + md.join('\n') + '\n' : '';
    }

    function walk(node, buf) {
      if (node.nodeType === 3) { buf.push(norm(node.nodeValue)); return; }
      if (node.nodeType !== 1) return;
      const tag = node.tagName;
      if (SKIP.has(tag) || isCitation(node)) return;
      // Skip hidden UI (share dialogs, feedback templates) that innerText ignores.
      const cs = window.getComputedStyle(node);
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return;

      // Fenced code block: preserve whitespace and newlines verbatim.
      if (tag === 'PRE') {
        const code = (node.innerText || node.textContent || '').replace(/\n+$/, '');
        if (code) buf.push('\n```\n' + code + '\n```\n');
        return;
      }
      // Inline code (only reached outside <pre>, which returns above).
      if (tag === 'CODE') {
        const t = norm(node.innerText || node.textContent).trim();
        if (t) buf.push('`' + t + '`');
        return;
      }
      if (tag === 'TABLE') {
        const t = tableToMd(node);
        if (t) buf.push(t);
        return;
      }

      if (tag === 'A') {
        // Keep the visible text always — links are often real content (e.g. team
        // names), so we must NOT drop them just because they carry data-ved. Only
        // bare source chips ("Wikipedia", "+3") are citations to discard.
        const txt = norm(node.innerText || node.textContent).trim();
        if (!txt || SOURCE.test(txt)) return;
        const href = node.getAttribute('href') || '';
        if (/^https?:\/\//.test(href) && !/(^|\.)google\.com/.test(href)) {
          buf.push('[' + txt + '](' + href + ')'); // real external link
        } else {
          buf.push(txt); // citation/redirect link → keep just the text
        }
        return;
      }

      const heading = /^H[1-6]$/.test(tag) || node.getAttribute('role') === 'heading';
      const li = tag === 'LI';
      const bold = tag === 'STRONG' || tag === 'B';
      const italic = tag === 'EM' || tag === 'I';
      const block = li || heading || /^(DIV|P|SECTION|ARTICLE|UL|OL|TR|BLOCKQUOTE)$/.test(tag);

      if (tag === 'BR') { buf.push('\n'); return; }
      if (heading) buf.push('\n### ');
      else if (li) buf.push('\n- ');
      if (bold) buf.push('**');
      if (italic) buf.push('*');
      const mark = buf.length;
      for (const child of node.childNodes) walk(child, buf);
      if (italic) buf.push('*');
      if (bold) buf.push('**');
      // Only break after a block that actually contributed text — avoids blank
      // gaps from empty wrappers (e.g. formulas rendered as images).
      const added = buf.slice(mark).join('').trim();
      if ((heading || block) && added !== '') buf.push('\n');
    }

    const LANGS = new Set(['python', 'py', 'javascript', 'js', 'typescript', 'ts', 'java', 'c',
      'cpp', 'c++', 'csharp', 'cs', 'go', 'golang', 'rust', 'rs', 'ruby', 'rb', 'php', 'bash',
      'shell', 'sh', 'zsh', 'sql', 'html', 'css', 'scss', 'json', 'yaml', 'yml', 'xml', 'kotlin',
      'swift', 'r', 'perl', 'lua', 'dart', 'scala', 'haskell', 'toml', 'dockerfile', 'makefile', 'text']);
    const BOILERPLATE = /^(use code with caution\.?|expand_more|content_copy|thumb_up|thumb_down|show all|show more|show less|feedback|sources|opens in new tab)$/i;

    function toMarkdown(root) {
      const buf = [];
      walk(root, buf);
      const rawLines = buf.join('').split('\n');
      const out = [];
      let inCode = false;
      let prevBlank = false;
      for (let line of rawLines) {
        if (line.trim() === '```') {
          if (!inCode) {
            // Opening fence: if the previous line was a bare language label, turn
            // it into the fence's language and drop the stray label line.
            let li = out.length - 1;
            while (li >= 0 && out[li] === '') li--;
            if (li >= 0 && LANGS.has(out[li].toLowerCase())) {
              const lang = out.splice(li, out.length - li)[0];
              out.push('```' + lang.toLowerCase());
            } else {
              out.push('```');
            }
          } else {
            out.push('```');
          }
          inCode = !inCode;
          prevBlank = false;
          continue;
        }
        if (inCode) { out.push(line); prevBlank = false; continue; } // verbatim code
        let l;
        if (line.charAt(0) === '|') {
          l = line.replace(/[ \t]+$/, ''); // markdown table row: keep pipes/spacing
        } else {
          l = line.replace(/[ \t]+/g, ' ').trim();
        }
        // Drop empty emphasis left behind when a wrapped element had no text
        // (e.g. a bold team name whose only child was a stripped link, or a
        // formula rendered as an image): **** / ** ** / * *.
        l = l.replace(/\*\*([^*]*)\*\*/g, function (m, inner) { return inner.trim() ? m : ''; });
        l = l.replace(/\*([^*]*)\*/g, function (m, inner) { return inner.trim() ? m : ''; });
        l = l.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/, '');
        if (SOURCE.test(l) || BOILERPLATE.test(l)) continue;  // drop source/UI boilerplate
        if (l.trim() === '-' || l.trim() === '###') continue; // drop empty bullets/headings
        if (l === '' && prevBlank) continue;                  // collapse blank runs
        out.push(l);
        prevBlank = (l === '');
      }
      return out.join('\n').replace(/\n{4,}/g, '\n\n\n').trim();
    }

    // Read the container at `idx` from the first selector that reaches it. If it
    // isn't there yet, return '' (keep waiting) rather than an earlier turn.
    for (const sel of sels) {
      const nodes = document.querySelectorAll(sel);
      if (nodes.length > idx) return toMarkdown(nodes[idx]);
    }
    return '';
  }, [selectors, index || 0]);
}

// How many answer containers exist (using the first selector that matches any).
// Each AI Mode turn adds one, so this lets us detect a follow-up's new answer.
async function countAnswers(page, selectors) {
  return page.evaluate((sels) => {
    for (const sel of sels) {
      const n = document.querySelectorAll(sel).length;
      if (n) return n;
    }
    return 0;
  }, selectors);
}

// Wait until the answer-container count exceeds `baseline` (a new turn appeared).
async function waitForNewAnswer(page, selectors, baseline, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await countAnswers(page, selectors)) > baseline) return true;
    await sleep(200);
  }
  return false;
}

// Count finished-answer toolbars on the page (buttons whose aria-label exactly
// matches the completion pattern). Each completed answer contributes a fixed set,
// so this count strictly increases per turn — the signal we use to know a NEW
// answer has finished (robust even though turns share a container).
async function countToolbars(page, cfg) {
  try {
    return await page.evaluate((pattern) => {
      const re = new RegExp(pattern, 'i');
      let c = 0;
      document.querySelectorAll('button, [role="button"]').forEach((b) => {
        if (re.test((b.getAttribute('aria-label') || '').trim())) c += 1;
      });
      return c;
    }, cfg.complete_label_pattern);
  } catch (_) {
    return 0;
  }
}

// Wait for a specific answer (the container at `index`) to finish, calling
// onChunk(partialText) as it grows. Finishes only when its text is stable AND the
// number of completion toolbars has grown past `toolbarBaseline` — i.e. THIS
// answer gained its own toolbar. That survives mid-stream pauses and, unlike a
// per-turn toolbar check, works for follow-ups (turns share a container). Falls
// back to a long text-idle if the toolbar signal ever fails.
async function waitForAnswer(page, cfg, onChunk, index, toolbarBaseline) {
  const deadline = Date.now() + cfg.response_timeout_ms;
  let last = '';
  let sawText = false;
  let stable = 0; // consecutive polls with unchanged text

  while (Date.now() < deadline) {
    const text = await readAnswer(page, cfg.response_selectors, index);
    const changed = text && text !== last;
    if (changed) {
      last = text;
      sawText = true;
      stable = 0;
      if (onChunk) onChunk(text);
    } else if (sawText) {
      stable += 1;
    }

    if (sawText && stable >= cfg.settle_polls) {
      const toolbars = await countToolbars(page, cfg);
      if (toolbars > toolbarBaseline) break;   // this answer gained its toolbar → done
      if (stable >= cfg.stall_polls) break;    // fallback: stable too long
    }
    await sleep(cfg.poll_interval_ms);
  }

  if (!sawText) {
    throw new Error(
      'No answer text found. AI Mode markup may have changed — update ' +
      'response_selectors (see backend/browser.js).'
    );
  }
  return last;
}

// Submit one turn. First turn navigates to the AI Mode URL with the query; later
// turns type into the on-page follow-up box to preserve conversation context.
async function ask(browser, page, text, config, onChunk) {
  const cfg = mergeConfig(config);
  const onAiMode = (page.url() || '').includes('udm=50');

  if (!onAiMode) {
    // First turn: navigate straight to the AI Mode URL with the query. The page
    // reload means exactly one answer container (index 0) and no prior toolbars.
    const url = cfg.ai_mode_url + encodeURIComponent(text);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.nav_timeout_ms });
    return waitForAnswer(page, cfg, onChunk, 0, 0);
  }

  // Follow-up turn: type into the on-page composer so the conversation keeps
  // context. Record the current answer count AND toolbar count first: the new
  // answer will be the container at index `before`, and it is done once the
  // toolbar count grows past `toolbarBaseline`.
  const before = await countAnswers(page, cfg.response_selectors);
  const toolbarBaseline = await countToolbars(page, cfg);
  const found = await firstMatch(page, cfg.followup_selectors, 8000);
  if (!found) {
    throw new Error(
      'Could not find the AI Mode follow-up input — update followup_selectors ' +
      '(see backend/browser.js).'
    );
  }
  await found.el.click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');

  // Enter usually submits; if no new answer container appears, click Send.
  let appeared = await waitForNewAnswer(page, cfg.response_selectors, before, cfg.new_turn_timeout_ms);
  if (!appeared) {
    try {
      await page.evaluate((sel) => {
        const b = document.querySelector(sel);
        if (b) b.click();
      }, cfg.submit_button_selector);
    } catch (_) { /* ignore */ }
    appeared = await waitForNewAnswer(page, cfg.response_selectors, before, cfg.new_turn_timeout_ms);
  }
  if (!appeared) {
    throw new Error('Follow-up did not submit — the composer or submit control may have changed.');
  }

  return waitForAnswer(page, cfg, onChunk, before, toolbarBaseline);
}

module.exports = { DEFAULTS, mergeConfig, connect, ensurePage, ask, readAnswer };
