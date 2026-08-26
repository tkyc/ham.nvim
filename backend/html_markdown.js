'use strict';

// Browserless HTML → Markdown for the HTTP-mode fetcher.
//
// AI Mode answers arrive as a raw HTML string (no DOM), but we want the same Markdown
// browser mode produces via browser.js `readAnswer` (which walks the live DOM inside
// page.evaluate and can't be reused here). So this module hand-rolls a small, forgiving
// HTML parser and PORTS readAnswer's walk + toMarkdown rules to run over the parsed
// tree — keeping puppeteer-core as the backend's only dependency.
//
// Fidelity note: off-DOM there is no CSS, so unlike readAnswer's getComputedStyle we
// can only detect hidden nodes via aria-hidden / inline style / the `hidden` attribute;
// the SOURCE/BOILERPLATE post-filters catch most of what slips through.

// ---- parser -----------------------------------------------------------------

const VOID = new Set(['AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT',
  'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR']);

function decodeEntities(s) {
  // Clamp out-of-range code points instead of passing them to String.fromCodePoint,
  // which throws RangeError for anything > 0x10FFFF (e.g. a degenerate &#9999999999;)
  // and would otherwise crash the whole render.
  const cp = (n) => (Number.isFinite(n) && n >= 0 && n <= 0x10FFFF ? String.fromCodePoint(n) : '�');
  return (s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => cp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => cp(parseInt(n, 10)))
    // &amp; LAST, so an already-escaped entity like &amp;lt; decodes to the literal
    // text "&lt;" rather than doubly to "<".
    .replace(/&amp;/g, '&');
}

// Index of the '>' that ends the tag starting at `lt`, skipping quoted attr values.
function findTagEnd(html, lt) {
  let q = null;
  for (let i = lt + 1; i < html.length; i++) {
    const c = html[i];
    if (q) { if (c === q) q = null; }
    else if (c === '"' || c === "'") q = c;
    else if (c === '>') return i;
  }
  return -1;
}

// Parse `<tag a="x" b='y' c=z d>` (with optional trailing /) into { tag, attrs }.
function parseTag(raw) {
  raw = raw.trim();
  if (raw.endsWith('/')) raw = raw.slice(0, -1);
  const m = raw.match(/^([a-zA-Z][a-zA-Z0-9:-]*)/);
  if (!m) return { tag: null, attrs: {} };
  const tag = m[1].toUpperCase();
  const attrs = {};
  const rest = raw.slice(m[1].length);
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let a;
  while ((a = re.exec(rest))) {
    if (!a[1]) { if (re.lastIndex === a.index) re.lastIndex++; continue; }
    const val = a[3] !== undefined ? a[3] : a[4] !== undefined ? a[4] : a[5] !== undefined ? a[5] : '';
    attrs[a[1].toLowerCase()] = decodeEntities(val);
  }
  return { tag, attrs };
}

// Build a forgiving node tree. Nodes: {type:'element',tag,attrs,children} | {type:'text',value}.
function parse(html) {
  const root = { type: 'root', tag: 'ROOT', attrs: {}, children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const pushText = (raw) => { if (raw) top().children.push({ type: 'text', value: raw }); };

  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { pushText(html.slice(i)); break; }
    if (lt > i) pushText(html.slice(i, lt));

    if (html.startsWith('<!--', lt)) { const e = html.indexOf('-->', lt + 4); i = e === -1 ? n : e + 3; continue; }
    if (html.startsWith('<!', lt)) { const e = html.indexOf('>', lt + 2); i = e === -1 ? n : e + 1; continue; }

    if (html.startsWith('</', lt)) { // closing tag
      const e = html.indexOf('>', lt + 2);
      if (e === -1) break;
      const tag = html.slice(lt + 2, e).trim().split(/\s/)[0].toUpperCase();
      i = e + 1;
      for (let s = stack.length - 1; s >= 1; s--) { if (stack[s].tag === tag) { stack.length = s; break; } }
      continue;
    }

    const e = findTagEnd(html, lt);
    if (e === -1) { pushText(html.slice(lt)); break; }
    const inner = html.slice(lt + 1, e);
    const selfClose = inner.endsWith('/');
    const { tag, attrs } = parseTag(inner);
    i = e + 1;
    if (!tag) continue;

    const el = { type: 'element', tag, attrs, children: [] };
    top().children.push(el);

    // Raw-text elements: skip their body wholesale (never parse `<`/`>` inside JS/CSS).
    if (tag === 'SCRIPT' || tag === 'STYLE') {
      const re = new RegExp('</' + tag + '\\s*>', 'i');
      const rest = html.slice(i);
      const m = rest.search(re);
      i = m === -1 ? n : i + m + rest.slice(m).indexOf('>') + 1;
      continue;
    }
    if (!selfClose && !VOID.has(tag)) stack.push(el);
  }
  return root;
}

function find(node, pred) {
  if (node.type === 'element' && pred(node)) return node;
  if (node.children) {
    for (const c of node.children) { const r = find(c, pred); if (r) return r; }
  }
  return null;
}

// ---- renderer (ported from browser.js readAnswer) ---------------------------

const SKIP = new Set(['BUTTON', 'SVG', 'PATH', 'IMG', 'STYLE', 'SCRIPT', 'NOSCRIPT', 'INPUT', 'TEXTAREA']);
const SOURCE = /^(\+\d+|sources?|wikipedia|encyclopedia britannica|britannica|youtube|reddit|linkedin|facebook|instagram|twitter)$/i;
const LANGS = new Set(['python', 'py', 'javascript', 'js', 'typescript', 'ts', 'java', 'c',
  'cpp', 'c++', 'csharp', 'cs', 'go', 'golang', 'rust', 'rs', 'ruby', 'rb', 'php', 'bash',
  'shell', 'sh', 'zsh', 'sql', 'html', 'css', 'scss', 'json', 'yaml', 'yml', 'xml', 'kotlin',
  'swift', 'r', 'perl', 'lua', 'dart', 'scala', 'haskell', 'toml', 'dockerfile', 'makefile', 'text']);
const BOILERPLATE = /^(use code with caution\.?|expand_more|content_copy|thumb_up|thumb_down|show all|show more|show less|feedback|sources|opens in new tab)$/i;

function norm(s) { return (s || '').replace(/\s+/g, ' '); }

// Concatenated descendant text (entity-decoded). raw=true preserves whitespace/newlines
// (for <pre>); otherwise whitespace is collapsed (matching readAnswer's norm(innerText)).
function textOf(node, raw) {
  let out = '';
  (function rec(nd) {
    if (nd.type === 'text') { out += nd.value; return; }
    if (nd.type === 'element' && SKIP.has(nd.tag)) return;
    if (nd.children) for (const c of nd.children) rec(c);
  })(node);
  out = decodeEntities(out);
  return raw ? out : norm(out);
}

function isHidden(node) {
  const a = node.attrs || {};
  if (a['aria-hidden'] === 'true') return true;
  if ('hidden' in a) return true;
  const st = (a.style || '').replace(/\s+/g, '').toLowerCase();
  return st.includes('display:none') || st.includes('visibility:hidden');
}

function isCitation(node) {
  const a = node.attrs || {};
  // (aria-hidden is handled by isHidden, which walk() checks alongside isCitation.)
  if (SOURCE.test(textOf(node).trim())) return true;
  // Citation source CARDS are block-level chips with data-src-id; drop those but keep
  // inline entity chips. Off-DOM we approximate "block" by tag.
  if ('data-src-id' in a && /^(DIV|SECTION|LI|ARTICLE|UL|OL|TABLE)$/.test(node.tag)) return true;
  return false;
}

function collect(node, tags) {
  const res = [];
  (function rec(nd) {
    if (nd.type !== 'element' && nd.type !== 'root') return;
    if (nd.type === 'element' && nd !== node && tags.has(nd.tag)) res.push(nd);
    for (const c of nd.children) rec(c);
  })(node);
  return res;
}

function cellText(el) { return textOf(el).trim().replace(/\|/g, '\\|'); }

function tableToMd(tbl) {
  const rows = collect(tbl, new Set(['TR']));
  const md = [];
  rows.forEach((tr, ri) => {
    const cells = collect(tr, new Set(['TH', 'TD'])).map(cellText);
    if (!cells.length) return;
    md.push('| ' + cells.join(' | ') + ' |');
    if (ri === 0) md.push('| ' + cells.map(() => '---').join(' | ') + ' |');
  });
  return md.length ? '\n' + md.join('\n') + '\n' : '';
}

function walk(node, buf) {
  if (node.type === 'text') { buf.push(norm(decodeEntities(node.value))); return; }
  if (node.type === 'root') { for (const c of node.children) walk(c, buf); return; }
  if (node.type !== 'element') return;

  const tag = node.tag;
  if (SKIP.has(tag) || isCitation(node) || isHidden(node)) return;

  if (tag === 'PRE') {
    const code = textOf(node, true).replace(/\n+$/, '');
    if (code) buf.push('\n```\n' + code + '\n```\n');
    return;
  }
  if (tag === 'CODE') {
    const t = textOf(node).trim();
    if (t) buf.push('`' + t + '`');
    return;
  }
  if (tag === 'TABLE') {
    const t = tableToMd(node);
    if (t) buf.push(t);
    return;
  }
  if (tag === 'A') {
    const txt = textOf(node).trim();
    if (!txt || SOURCE.test(txt)) return;
    const href = node.attrs.href || '';
    if (/^https?:\/\//.test(href) && !/(^|\.)google\.com/.test(href)) buf.push('[' + txt + '](' + href + ')');
    else buf.push(txt);
    return;
  }

  const heading = /^H[1-6]$/.test(tag) || node.attrs.role === 'heading';
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
  for (const child of node.children) walk(child, buf);
  if (italic) buf.push('*');
  if (bold) buf.push('**');
  const added = buf.slice(mark).join('').trim();
  if ((heading || block) && added !== '') buf.push('\n');
}

// Post-process a raw walk buffer — the concatenated push()es joined and split on '\n' —
// into finished Markdown: fold a bare language label into the following fence, keep code
// verbatim, drop empty emphasis / source / boilerplate lines, and collapse blank runs.
// This is the single source of truth for that pass: browser.js's in-page DOM walk returns
// its raw buffer and calls this too, so both query modes render identically.
function finishMarkdown(rawText) {
  const rawLines = String(rawText || '').split('\n');
  const out = [];
  let inCode = false;
  let prevBlank = false;
  for (let line of rawLines) {
    if (line.trim() === '```') {
      if (!inCode) {
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
    if (inCode) { out.push(line); prevBlank = false; continue; }
    let l;
    if (line.charAt(0) === '|') {
      l = line.replace(/[ \t]+$/, '');
    } else {
      l = line.replace(/[ \t]+/g, ' ').trim();
    }
    l = l.replace(/\*\*([^*]*)\*\*/g, (m, inner) => (inner.trim() ? m : ''));
    l = l.replace(/\*([^*]*)\*/g, (m, inner) => (inner.trim() ? m : ''));
    l = l.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/, '');
    if (SOURCE.test(l) || BOILERPLATE.test(l)) continue;
    if (l.trim() === '-' || l.trim() === '###') continue;
    if (l === '' && prevBlank) continue;
    out.push(l);
    prevBlank = (l === '');
  }
  return out.join('\n').replace(/\n{4,}/g, '\n\n\n').trim();
}

function toMarkdown(root) {
  const buf = [];
  walk(root, buf);
  return finishMarkdown(buf.join(''));
}

function render(node) {
  return toMarkdown(node);
}

module.exports = { parse, render, find, decodeEntities, finishMarkdown };
