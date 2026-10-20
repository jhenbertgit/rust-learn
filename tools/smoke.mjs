// End-to-end DOM smoke test: loads the real page in jsdom against the running
// server, then exercises routing, quiz, editor, the compile button and the shelf.
//
//   node server.mjs                       (in another terminal)
//   node tools/smoke.mjs

import { JSDOM, VirtualConsole } from 'jsdom';

const BASE = process.env.BASE || 'http://127.0.0.1:7878/';
const results = [];
const errors = [];

// The same test runs against the local server build and against the static build that
// GitHub Pages serves. In the static build there is no /api/run and no /docs proxy.
const pageConfig = await fetch(new URL('app-config.json', BASE))
  .then((r) => (r.ok ? r.json() : { runner: 'local' }))
  .catch(() => ({ runner: 'local' }));
const hosted = pageConfig.runner !== 'local';
console.log(`target: ${BASE}  mode: ${hosted ? `hosted (${pageConfig.runner})` : 'local server'}\n`);

function check(name, condition, detail) {
  results.push({ name, ok: !!condition, detail });
  if (!condition) errors.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 15000, label = 'condition' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      /* keep waiting */
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (err) => {
  if (!/Could not parse CSS|Not implemented/i.test(String(err.message))) {
    errors.push(`jsdom error: ${err.message}`);
  }
});

const html = await (await fetch(BASE)).text();

const dom = new JSDOM(html, {
  url: BASE,
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  virtualConsole,
  beforeParse(window) {
    // jsdom has no fetch: hand it Node's, resolved against the page origin.
    window.fetch = (input, init) => fetch(new URL(input, BASE), init);
    window.open = () => null;
    window.scrollTo = () => {};
  },
});

const { window } = dom;
const { document } = window;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const text = (el) => (el ? el.textContent.trim() : '');

await waitFor(() => $('.toc-link'), { label: 'chapter list' });

// ---------------------------------------------------------------- structure --
const tocLinks = $$('.toc-link');
check('chapter list renders every lesson', tocLinks.length === 14, `found ${tocLinks.length}`);
check('module headings render', $$('.toc-module').length === 8, `found ${$$('.toc-module').length}`);
check('progress rail has one segment per chapter', $$('.rail-progress .seg').length === 14);
check('first chapter is selected', text($('.chapter-title')).length > 0, text($('.chapter-title')));
check('lesson body renders prose', $$('.prose').length >= 2);
check('lesson body renders runnable snippets', $$('.snippet').length >= 2);
check('every snippet has a Run button', $$('.snippet-btn.is-run').length === $$('.snippet').length);
check('lesson renders a quiz', $$('.quiz-item').length >= 2);
check('lesson renders an exercise', !!$('.exercise'));
check('lesson renders docs links', $$('.docs-list a').length >= 1);
check('editor is seeded with the starter', $('#editor').value.trim().length > 0);
check('editor shows line numbers', $('#gutter').textContent.trim().split('\n').length > 1);
check('code is syntax highlighted', $$('#editor-hl .tok-kw').length > 0);
check(
  'runner badge resolved',
  hosted ? /playground/.test(text($('#rail-toolchain'))) : /rustc/.test(text($('#rail-toolchain'))),
  text($('#rail-toolchain')),
);

// ------------------------------------------------------------------- compile --
const runBtn = $('.snippet-btn.is-run');
runBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const receipt = await waitFor(() => {
  const r = $('.snippet-out .receipt:not(.is-running)');
  return r && $('.snippet-out .receipt-body') ? r : null;
}, { label: 'snippet receipt' });
const snippetBody = text($('.snippet-out .receipt-body'));
check('snippet compiles and runs in the page', receipt.dataset.kind === 'ok', snippetBody.slice(0, 120));
check('snippet output matches the lesson claim', /Hello, Rust/.test(snippetBody), snippetBody.slice(0, 120));

// ---------------------------------------------------------------------- quiz --
const firstQuiz = $('.quiz-item');
const correctIndex = 0; // lesson 01: "fn main()" is the first option
const quizButtons = Array.from(firstQuiz.querySelectorAll('.quiz-opt'));
quizButtons[correctIndex].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('quiz marks the right answer', quizButtons[correctIndex].classList.contains('is-right'));
check('quiz reveals the explanation', !$('.quiz-why', firstQuiz).hidden, text($('.quiz-why', firstQuiz)).slice(0, 80));
check('quiz locks the options after answering', quizButtons.every((b) => b.disabled));
check(
  'quiz answer persists to localStorage',
  JSON.parse(window.localStorage.getItem('rust-handson-v2') || '{}').quiz?.['01-hello']?.[0] === correctIndex,
);

// ------------------------------------------------------------------ workbench --
// Write the exercise solution into the editor and press "Check exercise".
const lessonId = window.location.hash || '01-hello';
$('#editor').value = 'fn main() {\n    let answer = 42;\n    println!("Hello, Rust");\n    println!("{answer}");\n}\n';
$('#editor').dispatchEvent(new window.Event('input', { bubbles: true }));
$('#btn-check').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

const passedState = await waitFor(() => {
  const state = $('.exercise-state');
  return state && state.classList.contains('is-pass') ? state : null;
}, { label: 'exercise to pass' });
check('exercise checks pass with the solution', text(passedState) === 'passed', text(passedState));
check('checklist is rendered', $$('.exercise-checks li').length >= 2, `${$$('.exercise-checks li').length} items`);
check('all checklist items pass', $$('.exercise-checks li.pass').length === $$('.exercise-checks li').length);
check('rail segment marks the chapter done', $$('.rail-progress .seg.is-done').length === 1);
check('toc marks the chapter done', $$('.toc-link.is-done').length === 1);
check('editor code is persisted', /println!\("\{answer\}"\)/.test(JSON.parse(window.localStorage.getItem('rust-handson-v2') || '{}').code?.['01-hello'] || ''));

// A deliberately broken program must come back as a compile error, colored.
$('#editor').value = 'fn main() {\n    let s = String::from("hi");\n    let t = s;\n    println!("{s}");\n}\n';
$('#editor').dispatchEvent(new window.Event('input', { bubbles: true }));
$('#btn-run').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const errReceipt = await waitFor(() => {
  const r = $('#bench-out .receipt:not(.is-running)');
  return r && r.dataset.kind === 'err' ? r : null;
}, { label: 'compile error receipt' });
check('compile error is reported as an error', errReceipt.dataset.kind === 'err');
check('error lines are colored', $$('#bench-out .receipt-body .d-err').length >= 1);
check('help lines are colored', $$('#bench-out .receipt-body .d-help').length >= 1, `${$$('#bench-out .receipt-body .d-help').length} help lines`);
check('diagnostics use a clean filename', /main\.rs:\d+:\d+/.test(text($('#bench-out .receipt-body'))));

// ----------------------------------------------------------------- navigation --
window.location.hash = '#/c/06-moves';
window.dispatchEvent(new window.HashChangeEvent('hashchange'));
await waitFor(() => /Ownership/.test(text($('.chapter-title'))), { label: 'ownership chapter' });
check('hash routing loads another chapter', /Ownership/.test(text($('.chapter-title'))), text($('.chapter-title')));
check('chapter number is right', /Chapter 06/.test(text($('.chapter-eyebrow'))), text($('.chapter-eyebrow')));
check('previous/next navigation renders', $$('.chapter-nav a').length === 2);

// --------------------------------------------------------------------- shelf --
window.location.hash = '#/shelf';
window.dispatchEvent(new window.HashChangeEvent('hashchange'));
await waitFor(() => $('.shelf-item'), { label: 'bookshelf' });
check('bookshelf lists the offline books', $$('.shelf-item').length >= 15, `found ${$$('.shelf-item').length}`);
check(
  'bookshelf links resolve to the right docs host',
  $$('.shelf-item').every((a) => {
    const href = a.getAttribute('href') || '';
    return hosted ? href.startsWith(pageConfig.docsBase) : href.startsWith('/docs/') || href.startsWith('docs/');
  }),
  $$('.shelf-item')[0]?.getAttribute('href') || '',
);

// ------------------------------------------------------- docs delivery check --
if (!hosted) {
  const docsUrl = new URL($$('.shelf-item')[0].getAttribute('href'), BASE);
  const docsRes = await fetch(docsUrl);
  check('docs proxy serves a real page', docsRes.ok && /<html/i.test(await docsRes.text()), String(docsRes.status));
} else {
  check('hosted build explains its constraints', !!$('.hosted-note'), 'no hosted notice rendered');
}

// -------------------------------------------------------------------- search --
$('#search-input').value = 'ownership';
$('#search-input').dispatchEvent(new window.Event('input', { bubbles: true }));
const searchHits = $$('#search-results a');
check('search finds chapters', searchHits.length >= 1, `${searchHits.length} hits`);
check('search result points at a chapter', (searchHits[0]?.getAttribute('href') || '').startsWith('#/c/'));

// -------------------------------------------------------------------- report --
dom.window.close();

const width = Math.max(...results.map((r) => r.name.length));
results.forEach((r) => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)} ${r.ok ? '' : `  <- ${r.detail || ''}`}`));
console.log(`\n${results.filter((r) => r.ok).length} / ${results.length} checks passed`);
if (errors.length) {
  console.log(`\n${errors.length} problem(s):`);
  [...new Set(errors)].forEach((e) => console.log(`  ✗ ${e}`));
  process.exit(1);
}
console.log('DOM smoke test passed.');
if (lessonId === undefined) process.exit(0);
