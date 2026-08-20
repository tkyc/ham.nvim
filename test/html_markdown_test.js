'use strict';

// Offline unit test for the browserless HTML→Markdown converter (backend/html_markdown.js),
// which ports browser.js readAnswer's rules for HTTP mode. Asserts each construct and
// that parsing is crash-proof on messy input.

const md = require('../backend/html_markdown.js');

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}
const render = (html) => md.render(md.parse(html));

// headings (h-tags and role="heading")
check('h2 -> ###', render('<h2>Title</h2>').includes('### Title'));
check('role=heading -> ###', render('<div role="heading">Title</div>').includes('### Title'));

// lists
check('li -> "- "', /(^|\n)- Item one/.test(render('<ul><li>Item one</li><li>Item two</li></ul>')));

// emphasis: italic survives; bold markers are dropped (parity with browser mode's
// readAnswer, whose emphasis-cleanup regex removes ** — the TEXT still shows).
check('em -> *italic*', render('<p>a <em>two</em> b</p>').includes('*two*'));
check('strong text kept (markers dropped, like browser mode)', (() => {
  const r = render('<p>a <strong>bold</strong> b</p>');
  return r.includes('bold') && !r.includes('**');
})());

// code
check('pre -> fenced block', render('<pre>line1\nline2</pre>').includes('```\nline1\nline2\n```'));
check('pre preserves whitespace + decodes entities', render('<pre>if (a &lt; b) {\n  x;\n}</pre>').includes('if (a < b) {\n  x;\n}'));
check('code -> inline `', render('<p>use <code>malloc</code></p>').includes('`malloc`'));
check('language label folds into fence', (() => {
  const r = render('<p>python</p><pre>x = 1</pre>');
  return r.includes('```python') && r.includes('x = 1');
})());

// table -> GFM
check('table -> GFM', (() => {
  const r = render('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>');
  return r.includes('| A | B |') && r.includes('| --- | --- |') && r.includes('| 1 | 2 |');
})());

// links: external kept as md link; google/citation links reduced to text
check('external link -> [text](href)', render('<a href="https://ex.com/x">Docs</a>').includes('[Docs](https://ex.com/x)'));
check('google link -> text only', (() => {
  const r = render('<a href="https://www.google.com/search?q=1">Example</a>');
  return r.includes('Example') && !r.includes('(http');
})());

// citations / hidden dropped
check('SOURCE chip (Wikipedia) dropped', render('<p>Fact.<span>Wikipedia</span></p>').trim() === 'Fact.');
check('"+3" chip dropped', !render('<p>x <span>+3</span></p>').includes('+3'));
check('aria-hidden dropped', !render('<div aria-hidden="true">content_copy</div>').includes('content_copy'));
check('inline display:none dropped', !render('<div style="display:none">hidden</div>').includes('hidden'));
check('data-src-id block card dropped', !render('<div data-src-id="1">Card blurb</div>').includes('Card blurb'));

// script/style/base64 never leak
check('script body skipped', !render('<p>hi</p><script>var a="<b>x</b>";</script>').includes('var a'));
check('style body skipped', !render('<style>.a{color:red}</style><p>hi</p>').includes('color:red'));

// entities in text
check('entity decode in text', render('<p>a &amp; b &lt; c</p>').includes('a & b < c'));

// robustness: malformed / unclosed tags must not crash
check('unclosed tags do not crash', (() => {
  try { return render('<div><p>hi <strong>there').includes('hi'); } catch (_) { return false; }
})());

// find() locates the aimc container
check('find locates aimc container', (() => {
  const root = md.parse('<div><div data-subtree="aimc"><p>ANS</p></div></div>');
  const c = md.find(root, (n) => n.attrs && n.attrs['data-subtree'] === 'aimc');
  return c && md.render(c).includes('ANS');
})());

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
