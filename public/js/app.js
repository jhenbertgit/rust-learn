/* Rust, hands on — application.
   Renders chapters, runs snippets through the local compiler, keeps progress. */

(function () {
  'use strict';

  const { highlight, escapeHtml } = window.RustHL;
  const $ = (sel, root = document) => root.querySelector(sel);
  const STORE_KEY = 'rust-handson-v2';

  const DOC_KINDS = {
    book: 'The Book',
    'rust-by-example': 'By Example',
    std: 'Standard library',
    core: 'core',
    alloc: 'alloc',
    reference: 'Reference',
    nomicon: 'Nomicon',
    cargo: 'Cargo',
    rustc: 'rustc',
    rustdoc: 'rustdoc',
    clippy: 'Clippy',
    error_codes: 'Error code',
    'edition-guide': 'Editions',
    'style-guide': 'Style guide',
    'unstable-book': 'Unstable',
    'embedded-book': 'Embedded',
    proc_macro: 'proc_macro',
  };

  /* ------------------------------------------------------------- progress -- */

  function defaultProgress() {
    return { v: 2, code: {}, exercise: {}, quiz: {}, visited: {} };
  }

  function loadProgress() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return defaultProgress();
      const parsed = JSON.parse(raw);
      return Object.assign(defaultProgress(), parsed, {
        code: parsed.code || {},
        exercise: parsed.exercise || {},
        quiz: parsed.quiz || {},
        visited: parsed.visited || {},
      });
    } catch {
      return defaultProgress();
    }
  }

  function saveProgress() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state.progress));
    } catch {
      /* storage may be unavailable; the course still works */
    }
  }

  /* ------------------------------------------------------------------ api -- */

  // Two ways to run this course. Served by server.mjs, everything is compiled by the
  // rustc on this machine. Deployed to GitHub Pages there is no server, so the static
  // build ships app-config.json and code goes to the public Rust Playground API.
  const CONFIG = {
    mode: 'local',
    runner: 'local',
    playgroundEndpoint: 'https://play.rust-lang.org/execute',
    docsBase: null,
    notice: '',
  };

  const isHosted = () => CONFIG.runner !== 'local';

  async function loadConfig() {
    try {
      Object.assign(CONFIG, await fetchJson('app-config.json'));
    } catch {
      /* no config file: this is the local server build */
    }
  }

  function docsHref(href) {
    const rel = String(href || '').replace(/^\/+/, '');
    return CONFIG.docsBase ? CONFIG.docsBase + rel : `docs/${rel}`;
  }

  async function fetchJson(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
    return res.json();
  }

  async function runLocal(code, mode) {
    const res = await fetch('api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, mode: mode || 'bin' }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || `compile request failed (${res.status})`);
    return payload;
  }

  // Cargo chatter is noise in a teaching receipt; the diagnostics are the signal.
  function stripCargoNoise(raw) {
    return String(raw || '')
      .replace(/\r/g, '')
      .split('\n')
      .filter((line) => !/^\s*(Compiling|Finished|Running)\b/.test(line))
      .join('\n')
      .trim();
  }

  async function runPlayground(code, mode) {
    let res;
    try {
      res = await fetch(CONFIG.playgroundEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: 'stable',
          mode: 'debug',
          edition: '2021',
          crateType: 'bin',
          tests: mode === 'test',
          backtrace: false,
          code,
        }),
      });
    } catch (err) {
      throw new Error(`could not reach play.rust-lang.org (${err.message}) — copy the code and paste it there instead`);
    }
    const raw = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(raw.error || `the Playground API answered ${res.status} — try again in a moment`);
    }

    const stderrRaw = String(raw.stderr || '');
    const reachedRun = /Running\s+(`|unittests)/.test(stderrRaw);
    const stage = reachedRun ? 'run' : 'compile';
    const cleaned = stripCargoNoise(stderrRaw);

    return {
      ok: !!raw.success,
      stage,
      timeout: false,
      remote: true,
      compile: { stdout: '', stderr: stage === 'compile' ? cleaned : '', ms: 0 },
      output: {
        stdout: raw.stdout || '',
        stderr: stage === 'run' ? cleaned : '',
        code: raw.success ? 0 : 1,
        ms: 0,
      },
    };
  }

  async function runCode(code, mode) {
    return CONFIG.runner === 'playground' ? runPlayground(code, mode) : runLocal(code, mode);
  }

  /* ---------------------------------------------------------------- state -- */

  const state = {
    curriculum: null,
    bookshelf: null,
    lessons: new Map(),
    order: [],
    currentId: null,
    progress: loadProgress(),
    benchMode: 'bin',
    exerciseUI: null,
    pendingReceipt: null,
  };

  const dom = {};

  /* ------------------------------------------------------------- helpers -- */

  function sanitize(html) {
    const holder = document.createElement('div');
    holder.innerHTML = String(html || '');
    const allowed = new Set([
      'P', 'STRONG', 'EM', 'CODE', 'A', 'UL', 'OL', 'LI', 'BR', 'SPAN',
      'H3', 'H4', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'SUP', 'SUB',
    ]);
    holder.querySelectorAll('*').forEach((node) => {
      const tag = node.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'IFRAME' || tag === 'OBJECT') {
        node.remove();
        return;
      }
      if (!allowed.has(tag)) {
        node.replaceWith(...Array.from(node.childNodes));
        return;
      }
      Array.from(node.attributes).forEach((attr) => {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on') || name === 'style' || name === 'srcdoc') {
          node.removeAttribute(attr.name);
        }
      });
      if (tag === 'A') {
        const href = node.getAttribute('href') || '';
        if (/^\s*javascript:/i.test(href)) node.removeAttribute('href');
        if (/^https?:/i.test(href)) {
          node.target = '_blank';
          node.rel = 'noopener noreferrer';
        }
      }
    });
    return holder.innerHTML;
  }

  function lessonMeta(id) {
    const lesson = state.lessons.get(id);
    if (!lesson) return null;
    for (const mod of state.curriculum.modules) {
      if (mod.lessons.includes(id)) return { lesson, mod };
    }
    return { lesson, mod: state.curriculum.modules[0] };
  }

  function chapterNumber(id) {
    const idx = state.order.indexOf(id);
    return String(idx + 1).padStart(2, '0');
  }

  function moduleNumber(modId) {
    const mod = state.curriculum.modules.find((m) => m.id === modId);
    return mod ? mod.numeral : '00';
  }

  function isDone(id) {
    return state.progress.exercise[id] === 'passed';
  }

  /* ------------------------------------------------------------ rail/toc -- */

  function buildToc() {
    const frag = document.createDocumentFragment();
    state.curriculum.modules.forEach((mod) => {
      const available = mod.lessons.filter((id) => state.lessons.has(id));
      if (!available.length) return;
      const wrap = document.createElement('div');
      wrap.className = 'toc-module';

      const head = document.createElement('div');
      head.className = 'toc-module-head';
      head.innerHTML = `<span class="toc-numeral">${escapeHtml(mod.numeral)}</span>
        <h2 class="toc-module-title">${escapeHtml(mod.title)}</h2>`;
      wrap.appendChild(head);

      const list = document.createElement('ul');
      list.className = 'toc-list';
      available.forEach((id) => {
        const lesson = state.lessons.get(id);
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.className = 'toc-link';
        a.href = `#/c/${id}`;
        a.dataset.lesson = id;
        a.innerHTML = `<span class="toc-mark" aria-hidden="true"></span><span>${escapeHtml(lesson.title)}</span>`;
        li.appendChild(a);
        list.appendChild(li);
      });
      wrap.appendChild(list);
      frag.appendChild(wrap);
    });

    const shelf = document.createElement('a');
    shelf.className = 'toc-shelf-link';
    shelf.href = '#/shelf';
    shelf.textContent = 'Bookshelf and search';
    frag.appendChild(shelf);

    dom.toc.replaceChildren(frag);
  }

  function buildRail() {
    const frag = document.createDocumentFragment();
    state.order.forEach((id) => {
      const seg = document.createElement('span');
      seg.className = 'seg';
      seg.dataset.lesson = id;
      const lesson = state.lessons.get(id);
      seg.title = lesson ? `Chapter ${chapterNumber(id)} — ${lesson.title}` : id;
      frag.appendChild(seg);
    });
    dom.railProgress.replaceChildren(frag);
    updateProgressUI();
  }

  function updateProgressUI() {
    let doneCount = 0;
    state.order.forEach((id) => {
      const done = isDone(id);
      const visited = !!state.progress.visited[id];
      if (done) doneCount += 1;

      const seg = $(`.seg[data-lesson="${id}"]`, dom.railProgress);
      if (seg) {
        seg.classList.toggle('is-done', done);
        seg.classList.toggle('is-visited', visited && !done);
        seg.classList.toggle('is-current', id === state.currentId);
      }

      const link = $(`.toc-link[data-lesson="${id}"]`, dom.toc);
      if (link) {
        link.classList.toggle('is-done', done);
        link.classList.toggle('is-visited', visited && !done);
        link.classList.toggle('is-current', id === state.currentId);
        const mark = $('.toc-mark', link);
        if (mark) mark.textContent = done ? '✓' : visited ? '·' : '';
      }
    });

    const total = state.order.length || 14;
    dom.railCount.textContent = `${doneCount} / ${total}`;
    dom.railProgress.setAttribute(
      'aria-label',
      `Course progress: ${doneCount} of ${total} chapters complete`,
    );
  }

  /* ---------------------------------------------------------- receipt UI -- */

  function colorizeCompiler(text) {
    return String(text || '')
      .split('\n')
      .map((line) => {
        let cls = null;
        if (/^\s*error(\[[A-Z]\d+\])?:/.test(line)) cls = 'd-err';
        else if (/^\s*warning:/.test(line)) cls = 'd-warn';
        else if (/^\s*(help|note):/.test(line)) cls = 'd-help';
        else if (/^\s*=\s*(help|note):/.test(line)) cls = 'd-help';
        else if (/^\s*-->/.test(line)) cls = 'd-loc';
        else if (/^\s*= note:/.test(line)) cls = 'd-help';
        else if (/^\s*[0-9]*\s*\|/.test(line) || /^\s*\|/.test(line)) cls = 'd-frame';
        const safe = escapeHtml(line);
        return cls ? `<span class="${cls}">${safe}</span>` : safe;
      })
      .join('\n');
  }

  function buildReceipt(result, options) {
    const opts = options || {};
    const remote = !!result.remote;
    const camd = remote
      ? (opts.mode === 'test' ? 'cargo test' : 'cargo run')
      : (opts.mode === 'test' ? 'rustc --test main.rs && ./main' : 'rustc main.rs && ./main');
    const kind = result.ok ? 'ok' : 'err';
    const el = document.createElement('div');
    el.className = 'receipt';
    el.dataset.kind = kind;

    let bodyText = '';
    let label = '';
    if (result.stage === 'compile' && !result.ok) {
      label = 'did not compile';
      bodyText = (result.compile.stderr || result.compile.stdout || '').trim() || 'no diagnostics';
    } else if (result.timeout) {
      label = 'stopped — the program ran too long';
      bodyText = (result.output && result.output.stdout) || '';
    } else if (result.output) {
      const out = (result.output.stdout || '').replace(/\s+$/, '');
      const err = (result.output.stderr || '').replace(/\s+$/, '');
      label = result.ok ? 'ran' : `exited with code ${result.output.code}`;
      bodyText = [out, err].filter(Boolean).join('\n') || '(no output)';
    } else {
      label = 'no result';
    }

    const compileMs = result.compile ? result.compile.ms : 0;
    const runMs = result.output ? result.output.ms : 0;

    el.innerHTML = `
      <div class="receipt-head">
        <span class="cmd">$ ${escapeHtml(camd)}</span>
        <span class="spacer">${label}</span>
      </div>
      <pre class="receipt-body"></pre>
      <div class="receipt-foot">${remote
        ? 'compiled on play.rust-lang.org'
        : `compile ${compileMs} ms · run ${runMs} ms${result.cached ? ' · cached' : ''}`}</div>`;

    const body = $('.receipt-body', el);
    const isCompilerText = result.stage === 'compile' && !result.ok;
    body.innerHTML = isCompilerText
      ? colorizeCompiler(bodyText)
      : escapeHtml(bodyText);
    return el;
  }

  function buildPendingReceipt(message) {
    const el = document.createElement('div');
    el.className = 'receipt is-running';
    el.dataset.kind = 'ok';
    el.innerHTML = `
      <div class="receipt-head"><span class="cmd">$ rustc main.rs</span><span class="spacer">working</span></div>
      <pre class="receipt-body d-muted"></pre>`;
    $('.receipt-body', el).textContent = message || 'compiling…';
    return el;
  }

  /* --------------------------------------------------------- block render -- */

  function renderBlock(block) {
    const type = block.type;

    if (type === 'prose') {
      const div = document.createElement('div');
      div.className = 'prose';
      div.innerHTML = sanitize(block.html);
      return div;
    }

    if (type === 'callout') {
      const tone = ['help', 'warn', 'note'].includes(block.tone) ? block.tone : 'note';
      const aside = document.createElement('aside');
      aside.className = `callout tone-${tone}`;
      const label = tone === 'help' ? 'help:' : tone === 'warn' ? 'warning:' : 'note:';
      aside.innerHTML = `<span class="callout-label">${label}</span>${sanitize(block.html)}`;
      return aside;
    }

    if (type === 'diagram') {
      const figure = document.createElement('figure');
      figure.className = 'diagram';
      const caption = block.title
        ? `<p class="diagram-title">${escapeHtml(block.title)}</p>`
        : '';
      figure.innerHTML = `${caption}<pre></pre>`;
      $('pre', figure).textContent = block.ascii || '';
      return figure;
    }

    if (type === 'code') {
      const runnable = block.runnable !== false;
      const mode = block.mode === 'test' ? 'test' : 'bin';
      const figure = document.createElement('figure');
      figure.className = 'snippet';

      const frame = document.createElement('div');
      frame.className = 'snippet-frame slab';

      const bar = document.createElement('div');
      bar.className = 'snippet-bar';
      const name = document.createElement('span');
      name.className = 'snippet-name';
      name.textContent = block.title || (runnable ? 'main.rs' : 'fragment');
      bar.appendChild(name);

      let runBtn = null;
      if (runnable) {
        runBtn = document.createElement('button');
        runBtn.type = 'button';
        runBtn.className = 'snippet-btn is-run';
        runBtn.textContent = 'Run';
        bar.appendChild(runBtn);

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'snippet-btn';
        editBtn.textContent = 'Open in workbench';
        editBtn.addEventListener('click', () => {
          loadIntoBench(block.code, mode);
          openBench();
        });
        bar.appendChild(editBtn);
      }

      const pre = document.createElement('pre');
      pre.className = 'hl';
      const codeEl = document.createElement('code');
      codeEl.innerHTML = highlight(block.code || '');
      pre.appendChild(codeEl);

      frame.appendChild(bar);
      frame.appendChild(pre);

      const out = document.createElement('div');
      out.className = 'snippet-out';
      out.hidden = true;
      frame.appendChild(out);

      figure.appendChild(frame);

      if (block.output) {
        const note = document.createElement('p');
        note.className = 'snippet-note';
        note.innerHTML = `prints <b>${escapeHtml(String(block.output).replace(/\n/g, ' ⏎ '))}</b>`;
        figure.appendChild(note);
      }

      if (runBtn) {
        runBtn.addEventListener('click', async () => {
          runBtn.disabled = true;
          runBtn.textContent = 'Running';
          out.hidden = false;
          out.replaceChildren(buildPendingReceipt(`compiling ${mode === 'test' ? 'with --test' : 'main.rs'}…`));
          try {
            const result = await runCode(block.code, mode);
            out.replaceChildren(buildReceipt(result, { mode }));
          } catch (err) {
            out.replaceChildren(buildErrorReceipt(err.message));
          } finally {
            runBtn.disabled = false;
            runBtn.textContent = 'Run';
          }
        });
      }

      return figure;
    }

    return document.createElement('div');
  }

  function buildErrorReceipt(message) {
    const el = document.createElement('div');
    el.className = 'receipt';
    el.dataset.kind = 'err';
    el.innerHTML = `
      <div class="receipt-head"><span class="cmd">$ request</span><span class="spacer">failed</span></div>
      <pre class="receipt-body"></pre>`;
    $('.receipt-body', el).textContent = message;
    return el;
  }

  /* ---------------------------------------------------------------- quiz -- */

  function renderQuiz(lesson) {
    const items = Array.isArray(lesson.quiz) ? lesson.quiz : [];
    if (!items.length) return null;

    const section = document.createElement('section');
    section.className = 'quiz';
    const head = document.createElement('h2');
    head.className = 'quiz-head';
    head.textContent = 'Check yourself';
    section.appendChild(head);

    const saved = Array.isArray(state.progress.quiz[lesson.id]) ? state.progress.quiz[lesson.id] : [];

    items.forEach((item, qi) => {
      const wrap = document.createElement('div');
      wrap.className = 'quiz-item';
      const q = document.createElement('p');
      q.className = 'quiz-q';
      q.innerHTML = sanitize(item.q);
      wrap.appendChild(q);

      const opts = document.createElement('div');
      opts.className = 'quiz-opts';
      const why = document.createElement('p');
      why.className = 'quiz-why';
      why.hidden = true;
      why.innerHTML = sanitize(item.why || '');

      const buttons = [];
      (item.options || []).forEach((option, oi) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'quiz-opt';
        btn.innerHTML = `<span class="mark" aria-hidden="true"></span><span>${sanitize(option)}</span>`;
        btn.addEventListener('click', () => {
          const correct = oi === item.answer;
          buttons.forEach((b, bi) => {
            b.disabled = true;
            if (bi === item.answer) {
              b.classList.add('is-right');
              $('.mark', b).textContent = '✓';
            } else if (bi === oi) {
              b.classList.add('is-wrong');
              $('.mark', b).textContent = '×';
            }
          });
          why.hidden = false;
          why.classList.toggle('is-wrong', !correct);
          if (!Array.isArray(state.progress.quiz[lesson.id])) state.progress.quiz[lesson.id] = [];
          state.progress.quiz[lesson.id][qi] = oi;
          saveProgress();
        });
        opts.appendChild(btn);
        buttons.push(btn);
      });

      wrap.appendChild(opts);
      wrap.appendChild(why);
      section.appendChild(wrap);

      const answered = saved[qi];
      if (typeof answered === 'number') {
        buttons.forEach((b, bi) => {
          b.disabled = true;
          if (bi === item.answer) {
            b.classList.add('is-right');
            $('.mark', b).textContent = '✓';
          } else if (bi === answered) {
            b.classList.add('is-wrong');
            $('.mark', b).textContent = '×';
          }
        });
        why.hidden = false;
        why.classList.toggle('is-wrong', answered !== item.answer);
      }
    });

    return section;
  }

  /* ------------------------------------------------------------ exercise -- */

  function checkResult(lesson, result) {
    const checks = (lesson.exercise && lesson.exercise.checks) || [];
    const compiled = result && result.stage !== 'compile';
    const stdout = ((result && result.output && result.output.stdout) || '').trim();
    const lines = stdout.split('\n').filter((l) => l.trim().length);

    return checks.map((check) => {
      switch (check.kind) {
        case 'compiles':
          return { ok: compiled, label: 'it compiles' };
        case 'outputEquals':
          return {
            ok: compiled && stdout === String(check.value).trim(),
            label: `output is exactly ${JSON.stringify(String(check.value))}`,
          };
        case 'outputContains':
          return {
            ok: compiled && stdout.includes(String(check.value)),
            label: `output contains ${JSON.stringify(String(check.value))}`,
          };
        case 'stdoutLines':
          return {
            ok: compiled && lines.length === Number(check.value),
            label: `prints ${check.value} non-empty line${Number(check.value) === 1 ? '' : 's'}`,
          };
        default:
          return { ok: false, label: 'unknown check' };
      }
    });
  }

  function renderExercise(lesson) {
    if (!lesson.exercise) return null;
    const ex = lesson.exercise;

    const section = document.createElement('section');
    section.className = 'exercise';

    const head = document.createElement('div');
    head.className = 'exercise-head';
    head.innerHTML = `<h3>Exercise</h3><span class="exercise-state">not checked</span>`;
    section.appendChild(head);

    const body = document.createElement('div');
    body.className = 'exercise-body';

    const brief = document.createElement('p');
    brief.className = 'exercise-brief';
    brief.innerHTML = sanitize(ex.brief);
    body.appendChild(brief);

    const actions = document.createElement('div');
    actions.className = 'exercise-actions';

    const writeBtn = document.createElement('button');
    writeBtn.type = 'button';
    writeBtn.className = 'btn';
    writeBtn.textContent = 'Write it in the workbench';
    writeBtn.addEventListener('click', () => {
      loadIntoBench(state.progress.code[lesson.id] || ex.starter, 'bin');
      openBench();
      dom.editor.focus();
    });
    actions.appendChild(writeBtn);

    const checkBtn = document.createElement('button');
    checkBtn.type = 'button';
    checkBtn.className = 'btn btn-run';
    checkBtn.textContent = 'Check my answer';
    checkBtn.addEventListener('click', () => {
      if (state.currentId !== lesson.id) return;
      runBench(true);
    });
    actions.appendChild(checkBtn);

    let hintEl = null;
    if (ex.hint) {
      const hintBtn = document.createElement('button');
      hintBtn.type = 'button';
      hintBtn.className = 'btn btn-quiet';
      hintBtn.textContent = 'Hint';
      hintEl = document.createElement('div');
      hintEl.className = 'exercise-hint';
      hintEl.hidden = true;
      hintEl.innerHTML = sanitize(ex.hint);
      hintBtn.addEventListener('click', () => {
        hintEl.hidden = !hintEl.hidden;
        hintBtn.textContent = hintEl.hidden ? 'Hint' : 'Hide hint';
      });
      actions.appendChild(hintBtn);
    }

    let solEl = null;
    if (ex.solution) {
      const solBtn = document.createElement('button');
      solBtn.type = 'button';
      solBtn.className = 'btn btn-quiet';
      solBtn.textContent = 'Solution';
      solEl = document.createElement('div');
      solEl.className = 'exercise-solution';
      solEl.hidden = true;
      solEl.innerHTML = '<pre></pre>';
      $('pre', solEl).textContent = ex.solution;
      solBtn.addEventListener('click', () => {
        solEl.hidden = !solEl.hidden;
        solBtn.textContent = solEl.hidden ? 'Solution' : 'Hide solution';
      });
      actions.appendChild(solBtn);
    }

    body.appendChild(actions);
    if (hintEl) body.appendChild(hintEl);
    if (solEl) body.appendChild(solEl);

    const checkList = document.createElement('ul');
    checkList.className = 'exercise-checks';
    checkList.hidden = true;
    body.appendChild(checkList);

    section.appendChild(body);

    state.exerciseUI = {
      lessonId: lesson.id,
      stateEl: $('.exercise-state', head),
      checkList,
      checkBtn,
      writeBtn,
      lesson,
    };
    applyExerciseState(lesson);
    return section;
  }

  function applyExerciseState(lesson) {
    const ui = state.exerciseUI;
    if (!ui || ui.lessonId !== lesson.id) return;
    const passed = isDone(lesson.id);
    ui.stateEl.classList.toggle('is-pass', passed);
    ui.stateEl.textContent = passed ? 'passed' : 'not checked';
  }

  function paintChecks(results, passed) {
    const ui = state.exerciseUI;
    if (!ui) return;
    ui.checkList.hidden = false;
    ui.checkList.replaceChildren(
      ...results.map((r) => {
        const li = document.createElement('li');
        li.className = r.ok ? 'pass' : 'fail';
        li.innerHTML = `<span class="tick" aria-hidden="true">${r.ok ? '✓' : '×'}</span><span>${escapeHtml(r.label)}</span>`;
        return li;
      }),
    );
    ui.stateEl.classList.toggle('is-pass', passed);
    ui.stateEl.textContent = passed ? 'passed' : 'not yet';
  }

  /* --------------------------------------------------------------- lesson -- */

  function renderLesson(id) {
    const meta = lessonMeta(id);
    if (!meta) return;
    const { lesson, mod } = meta;

    state.currentId = id;
    state.progress.visited[id] = true;
    state.progress.lastVisited = id;
    saveProgress();

    const inner = document.createElement('div');
    inner.className = 'lesson-inner';

    const head = document.createElement('header');
    head.className = 'chapter-head';
    head.innerHTML = `
      <div class="chapter-eyebrow">
        <span>Chapter ${escapeHtml(chapterNumber(id))}</span>
        <span class="dot">·</span>
        <span>${escapeHtml(mod.title)}</span>
        <span class="dot">·</span>
        <span>${escapeHtml(String(lesson.minutes || 8))} min</span>
      </div>
      <h1 class="chapter-title">${escapeHtml(lesson.title)}</h1>
      <p class="chapter-summary">${escapeHtml(lesson.summary || '')}</p>`;
    inner.appendChild(head);

    (lesson.blocks || []).forEach((block) => {
      const node = renderBlock(block);
      if (node) inner.appendChild(node);
    });

    const quiz = renderQuiz(lesson);
    if (quiz) inner.appendChild(quiz);

    const exercise = renderExercise(lesson);
    if (exercise) inner.appendChild(exercise);

    const docs = renderDocs(lesson);
    if (docs) inner.appendChild(docs);

    inner.appendChild(renderChapterNav(id));

    dom.lesson.replaceChildren(inner);
    dom.lesson.scrollTop = 0;
    dom.lesson.focus({ preventScroll: true });

    bindBench(lesson);
    updateProgressUI();
    closeToc();
    document.title = `${lesson.title} — Rust, hands on`;
    if (window.innerWidth <= 900) closeBench();
  }

  function renderDocs(lesson) {
    const links = Array.isArray(lesson.docs) ? lesson.docs : [];
    if (!links.length) return null;
    const list = document.createElement('ul');
    list.className = 'docs-list';
    links.forEach((link) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = docsHref(link.href);
      a.target = '_blank';
      a.rel = 'noopener';
      const kind = DOC_KINDS[String(link.href).split('/')[0]] || 'Docs';
      a.innerHTML = `<span class="arrow" aria-hidden="true">→</span><span>${escapeHtml(link.label)}</span><span class="doc-kind">${escapeHtml(kind)}</span>`;
      li.appendChild(a);
      list.appendChild(li);
    });
    return list;
  }

  function renderChapterNav(id) {
    const nav = document.createElement('nav');
    nav.className = 'chapter-nav';
    const idx = state.order.indexOf(id);
    const prev = idx > 0 ? state.order[idx - 1] : null;
    const next = idx >= 0 && idx < state.order.length - 1 ? state.order[idx + 1] : null;

    if (prev) {
      const a = document.createElement('a');
      a.href = `#/c/${prev}`;
      a.innerHTML = `<span class="nav-dir">Previous</span><span class="nav-title">${escapeHtml(state.lessons.get(prev).title)}</span>`;
      nav.appendChild(a);
    } else {
      const span = document.createElement('span');
      span.className = 'spacer';
      nav.appendChild(span);
    }

    if (next) {
      const a = document.createElement('a');
      a.className = 'is-next';
      a.href = `#/c/${next}`;
      a.innerHTML = `<span class="nav-dir">Next chapter</span><span class="nav-title">${escapeHtml(state.lessons.get(next).title)}</span>`;
      nav.appendChild(a);
    } else {
      const a = document.createElement('a');
      a.className = 'is-next';
      a.href = '#/shelf';
      a.innerHTML = '<span class="nav-dir">Finished</span><span class="nav-title">Where to read next</span>';
      nav.appendChild(a);
    }
    return nav;
  }

  /* ---------------------------------------------------------------- shelf -- */

  function renderShelf() {
    state.currentId = null;
    const inner = document.createElement('div');
    inner.className = 'shelf-inner';

    inner.innerHTML = `
      <h1 class="shelf-title">The bookshelf${isHosted() ? ' (online copies)' : ' on this machine'}</h1>
      <p class="shelf-intro">${escapeHtml(state.bookshelf.intro || '')}</p>
      ${isHosted() ? `<p class="shelf-note hosted-note">${escapeHtml(
        CONFIG.notice
          || 'This copy is hosted on GitHub Pages, so it links to the official documentation on doc.rust-lang.org and compiles code through the public Rust Playground. Run the site locally for the offline docshelf and your own compiler.',
      )}</p>` : ''}
      <form class="std-search" id="std-form">
        <input type="search" name="search" id="std-input" placeholder="Search the standard library — try Vec, HashMap, Iterator" aria-label="Search the standard library">
        <button class="btn" type="submit">Search docs</button>
      </form>`;

    (state.bookshelf.groups || []).forEach((group) => {
      const section = document.createElement('section');
      section.className = 'shelf-group';
      const h2 = document.createElement('h2');
      h2.textContent = group.title;
      section.appendChild(h2);

      (group.items || []).forEach((item) => {
        const a = document.createElement('a');
        a.className = 'shelf-item';
        a.href = docsHref(item.href);
        a.target = '_blank';
        a.rel = 'noopener';
        a.innerHTML = `
          <span class="shelf-label">${escapeHtml(item.label)}</span>
          ${item.tag ? `<span class="shelf-tag">${escapeHtml(item.tag)}</span>` : ''}
          <span class="shelf-note">${escapeHtml(item.note || '')}</span>`;
        section.appendChild(a);
      });
      inner.appendChild(section);
    });

    const referenced = collectReferencedDocs();
    if (referenced.length) {
      const section = document.createElement('section');
      section.className = 'shelf-group';
      section.innerHTML = '<h2>Chapters this course points at</h2>';
      referenced.forEach((item) => {
        const a = document.createElement('a');
        a.className = 'shelf-item';
        a.href = docsHref(item.href);
        a.target = '_blank';
        a.rel = 'noopener';
        a.innerHTML = `<span class="shelf-label">${escapeHtml(item.label)}</span>
          <span class="shelf-note">${escapeHtml(item.source)}</span>`;
        section.appendChild(a);
      });
      inner.appendChild(section);
    }

    if (state.curriculum.afterword) {
      const after = state.curriculum.afterword;
      const section = document.createElement('section');
      section.className = 'afterword';
      section.innerHTML = `
        <h2>${escapeHtml(after.title)}</h2>
        <p class="prose">${escapeHtml(after.body)}</p>`;
      const list = document.createElement('ul');
      list.className = 'afterword-links';
      (after.links || []).forEach((link) => {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = docsHref(link.href);
        a.target = '_blank';
        a.rel = 'noopener';
        a.innerHTML = `<span class="arrow" aria-hidden="true">→</span><span>${escapeHtml(link.label)}</span><span class="note">${escapeHtml(link.note || '')}</span>`;
        li.appendChild(a);
        list.appendChild(li);
      });
      section.appendChild(list);
      inner.appendChild(section);
    }

    dom.lesson.replaceChildren(inner);
    dom.lesson.scrollTop = 0;
    updateProgressUI();
    closeToc();
    document.title = 'Bookshelf — Rust, hands on';

    const form = $('#std-form', inner);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const q = $('#std-input', inner).value.trim();
      const base = docsHref('std/index.html');
      const url = q ? `${base}?search=${encodeURIComponent(q)}` : base;
      window.open(url, '_blank', 'noopener');
    });
  }

  function collectReferencedDocs() {
    const seen = new Map();
    state.order.forEach((id) => {
      const lesson = state.lessons.get(id);
      (lesson.docs || []).forEach((doc) => {
        if (!seen.has(doc.href)) {
          seen.set(doc.href, { href: doc.href, label: doc.label, source: `Chapter ${chapterNumber(id)} · ${lesson.title}` });
        }
      });
    });
    return Array.from(seen.values());
  }

  /* ---------------------------------------------------------------- bench -- */

  function paintEditor() {
    const code = dom.editor.value;
    const target = $('code', dom.editorHl);
    target.innerHTML = `${highlight(code)}\n`;
    const lineCount = code.split('\n').length;
    let numbers = '';
    for (let i = 1; i <= lineCount; i += 1) numbers += `${i}\n`;
    dom.gutter.textContent = numbers;
    syncEditorScroll();
  }

  function syncEditorScroll() {
    dom.editorHl.scrollTop = dom.editor.scrollTop;
    dom.editorHl.scrollLeft = dom.editor.scrollLeft;
    dom.gutter.scrollTop = dom.editor.scrollTop;
  }

  function setEditorCode(code) {
    dom.editor.value = code || '';
    paintEditor();
    dom.editor.scrollTop = 0;
    dom.editor.scrollLeft = 0;
    syncEditorScroll();
  }

  function loadIntoBench(code, mode) {
    setEditorCode(code);
    state.benchMode = mode === 'test' ? 'test' : 'bin';
    dom.benchMode.textContent = state.benchMode;
  }

  function setStatus(text, kind) {
    dom.benchStatus.textContent = text || '';
    dom.benchStatus.className = `bench-status${kind ? ` is-${kind}` : ''}`;
  }

  function emptyBenchOutput() {
    const div = document.createElement('div');
    div.className = 'bench-out-empty';
    div.innerHTML = isHosted()
      ? `<p>Run a snippet and the answer lands here.</p>
      <p class="bench-out-sub">Compiled by the public Rust Playground API (play.rust-lang.org), then executed there. Run this site locally for your own compiler and the offline docshelf.</p>`
      : `<p>Run a snippet and the compiler's answer lands here.</p>
      <p class="bench-out-sub">Compiled with the rustc on this machine, then executed. Nothing is simulated.</p>`;
    dom.benchOut.replaceChildren(div);
  }

  function bindBench(lesson) {
    const saved = state.progress.code[lesson.id];
    const starter = (lesson.exercise && lesson.exercise.starter) || 'fn main() {\n    println!("hello");\n}\n';
    loadIntoBench(saved || starter, 'bin');
    dom.benchFilename.textContent = 'main.rs';
    setStatus('');
    emptyBenchOutput();
    dom.benchOut.dataset.lesson = lesson.id;
  }

  function saveEditorCode() {
    if (!state.currentId) return;
    state.progress.code[state.currentId] = dom.editor.value;
    saveProgress();
  }

  function insertAtCursor(text) {
    const start = dom.editor.selectionStart;
    const end = dom.editor.selectionEnd;
    dom.editor.setRangeText(text, start, end, 'end');
    paintEditor();
    saveEditorCode();
  }

  async function runBench(checkExercise) {
    const lesson = state.lessons.get(state.currentId);
    if (!lesson) return;
    const code = dom.editor.value;
    dom.runBtn.disabled = true;
    dom.checkBtn.disabled = true;
    setStatus('compiling…', 'busy');
    dom.benchOut.replaceChildren(buildPendingReceipt(`compiling ${state.benchMode === 'test' ? 'with --test' : 'main.rs'}…`));

    try {
      const result = await runCode(code, state.benchMode);
      dom.benchOut.replaceChildren(buildReceipt(result, { mode: state.benchMode }));

      if (result.ok) {
        const took = result.remote
          ? 'ran'
          : `ran · ${result.compile.ms + (result.output ? result.output.ms : 0)} ms`;
        setStatus(took, 'ok');
      } else if (result.stage === 'compile') {
        setStatus('compile error — read the help lines', 'err');
      } else {
        setStatus(`exited with code ${result.output ? result.output.code : '?'}`, 'err');
      }

      if (lesson.exercise) {
        const results = checkResult(lesson, result);
        const passed = results.length > 0 && results.every((r) => r.ok);
        paintChecks(results, passed);
        if (passed) {
          state.progress.exercise[lesson.id] = 'passed';
          saveProgress();
          updateProgressUI();
          applyExerciseState(lesson);
          if (checkExercise) setStatus('exercise passed', 'ok');
        } else if (checkExercise) {
          setStatus('not yet — the checks above show what is missing', 'err');
        }
      }
    } catch (err) {
      dom.benchOut.replaceChildren(buildErrorReceipt(err.message));
      setStatus('could not reach the compiler', 'err');
    } finally {
      dom.runBtn.disabled = false;
      dom.checkBtn.disabled = false;
    }
  }

  function openBench() {
    dom.bench.classList.add('is-open');
    if (window.innerWidth <= 900) dom.scrim.hidden = false;
  }

  function closeBench() {
    dom.bench.classList.remove('is-open');
    dom.scrim.hidden = true;
  }

  /* ------------------------------------------------------------------ toc -- */

  function openToc() {
    dom.toc.classList.add('is-open');
    dom.btnToc.setAttribute('aria-expanded', 'true');
    dom.scrim.hidden = false;
  }

  function closeToc() {
    dom.toc.classList.remove('is-open');
    dom.btnToc.setAttribute('aria-expanded', 'false');
    if (!dom.bench.classList.contains('is-open')) dom.scrim.hidden = true;
  }

  /* --------------------------------------------------------------- search -- */

  function setupSearch() {
    const input = dom.searchInput;
    const results = dom.searchResults;

    const close = () => {
      results.hidden = true;
      input.setAttribute('aria-expanded', 'false');
    };

    const render = () => {
      const q = input.value.trim().toLowerCase();
      if (!q) {
        close();
        return;
      }
      const matches = state.order
        .map((id) => ({ id, lesson: state.lessons.get(id), meta: lessonMeta(id) }))
        .filter(({ lesson }) => {
          const hay = [lesson.title, lesson.summary, (lesson.keywords || []).join(' ')].join(' ').toLowerCase();
          return hay.includes(q);
        })
        .slice(0, 8);

      results.replaceChildren();
      if (!matches.length) {
        const empty = document.createElement('div');
        empty.className = 'r-empty';
        empty.textContent = `No chapter mentions “${input.value.trim()}”.`;
        results.appendChild(empty);
      } else {
        matches.forEach(({ id, lesson, meta }) => {
          const a = document.createElement('a');
          a.href = `#/c/${id}`;
          a.innerHTML = `${escapeHtml(lesson.title)}<span class="r-meta">Chapter ${chapterNumber(id)} · ${escapeHtml(meta.mod.title)}</span>`;
          a.addEventListener('click', close);
          results.appendChild(a);
        });
      }
      results.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    };

    input.addEventListener('input', render);
    input.addEventListener('focus', render);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        input.value = '';
        close();
        input.blur();
      } else if (event.key === 'Enter') {
        const first = results.querySelector('a');
        if (first) {
          first.click();
          input.value = '';
          close();
        }
      }
    });
    document.addEventListener('click', (event) => {
      if (!input.closest('.search').contains(event.target)) close();
    });
  }

  /* ------------------------------------------------------------- wiring --- */

  function setupEditor() {
    paintEditor();
    dom.editor.addEventListener('input', () => {
      paintEditor();
      saveEditorCode();
    });
    dom.editor.addEventListener('scroll', syncEditorScroll, { passive: true });

    dom.editor.addEventListener('keydown', (event) => {
      if (event.key === 'Tab') {
        event.preventDefault();
        insertAtCursor('    ');
        return;
      }
      if (event.key === 'Enter') {
        const value = dom.editor.value;
        const pos = dom.editor.selectionStart;
        const lineStart = value.lastIndexOf('\n', pos - 1) + 1;
        const line = value.slice(lineStart, pos);
        const indent = (/^[ \t]*/.exec(line) || [''])[0];
        const opensBlock = /\{\s*$/.test(line);
        const after = value.slice(pos);
        const closesNext = /^\s*\}/.test(after);
        if (opensBlock || indent) {
          event.preventDefault();
          let insertion = `\n${indent}${opensBlock ? '    ' : ''}`;
          if (opensBlock && closesNext) {
            dom.editor.setRangeText(`${insertion}\n${indent}`, pos, dom.editor.selectionEnd, 'end');
            const caret = pos + insertion.length;
            dom.editor.setSelectionRange(caret, caret);
            paintEditor();
            saveEditorCode();
            return;
          }
          dom.editor.setRangeText(insertion, pos, pos, 'end');
          paintEditor();
          saveEditorCode();
        }
      }
    });

    dom.runBtn.addEventListener('click', () => runBench(false));
    dom.checkBtn.addEventListener('click', () => runBench(true));
    dom.btnReset.addEventListener('click', () => {
      const lesson = state.lessons.get(state.currentId);
      if (!lesson) return;
      const starter = (lesson.exercise && lesson.exercise.starter) || '';
      setEditorCode(starter);
      saveEditorCode();
      setStatus('reset to the starting code');
      emptyBenchOutput();
      applyExerciseState(lesson);
      if (state.exerciseUI) state.exerciseUI.checkList.hidden = true;
    });
    dom.btnSolution.addEventListener('click', () => {
      const lesson = state.lessons.get(state.currentId);
      if (!lesson || !lesson.exercise || !lesson.exercise.solution) return;
      setEditorCode(lesson.exercise.solution);
      saveEditorCode();
      setStatus('solution loaded — run it, then write your own');
    });
    dom.btnToc.addEventListener('click', () => {
      if (dom.toc.classList.contains('is-open')) closeToc();
      else openToc();
    });
    dom.btnBenchClose.addEventListener('click', closeBench);
    dom.scrim.addEventListener('click', () => {
      closeToc();
      closeBench();
    });
  }

  function setupGlobalKeys() {
    document.addEventListener('keydown', (event) => {
      const inField = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)
        || document.activeElement.isContentEditable;
      if (event.key === '/' && !inField) {
        event.preventDefault();
        dom.searchInput.focus();
        return;
      }
      if (event.key === 'Escape') {
        closeToc();
        if (window.innerWidth <= 900) closeBench();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        runBench(false);
      }
    });
  }

  /* ----------------------------------------------------------------- boot -- */

  function resumeTarget() {
    // Returning to the course should not restart it: pick up the chapter that was
    // last open, otherwise the first one not yet passed.
    const last = state.progress.lastVisited;
    if (last && state.lessons.has(last)) return last;
    const unfinished = state.order.find((id) => !isDone(id));
    return unfinished || state.order[0];
  }

  function route() {
    const hash = location.hash.replace(/^#/, '');
    if (hash.startsWith('/shelf')) {
      renderShelf();
      return;
    }
    const match = /^\/c\/([\w-]+)/.exec(hash);
    const id = match && state.lessons.has(match[1]) ? match[1] : resumeTarget();
    if (!id) {
      dom.lesson.innerHTML = '<div class="lesson-inner"><p class="prose">No chapters found. Check that content/lessons exists.</p></div>';
      return;
    }
    if (state.currentId !== id) renderLesson(id);
  }

  async function boot() {
    dom.toc = $('#toc');
    dom.lesson = $('#lesson-body');
    dom.bench = $('#bench');
    dom.benchOut = $('#bench-out');
    dom.benchStatus = $('#bench-status');
    dom.benchFilename = $('#bench-filename');
    dom.benchMode = $('#bench-mode');
    dom.editor = $('#editor');
    dom.editorHl = $('#editor-hl');
    dom.gutter = $('#gutter');
    dom.runBtn = $('#btn-run');
    dom.checkBtn = $('#btn-check');
    dom.btnReset = $('#btn-reset');
    dom.btnSolution = $('#btn-solution');
    dom.btnToc = $('#btn-toc');
    dom.btnBenchClose = $('#btn-bench-close');
    dom.scrim = $('#scrim');
    dom.railProgress = $('#rail-progress');
    dom.railCount = $('#rail-count');
    dom.railToolchain = $('#rail-toolchain');
    dom.searchInput = $('#search-input');
    dom.searchResults = $('#search-results');

    setupEditor();
    setupSearch();
    setupGlobalKeys();

    try {
      await loadConfig();
      const [curriculum, bookshelf] = await Promise.all([
        fetchJson('content/curriculum.json'),
        fetchJson('content/bookshelf.json').catch(() => ({ groups: [], intro: '' })),
      ]);
      state.curriculum = curriculum;
      state.bookshelf = bookshelf;
      state.order = curriculum.modules.flatMap((mod) => mod.lessons);

      const loaded = await Promise.all(
        state.order.map(async (id) => {
          try {
            state.lessons.set(id, await fetchJson(`content/lessons/${id}.json`));
            return id;
          } catch (err) {
            console.warn(`lesson ${id} unavailable`, err);
            return null;
          }
        }),
      );
      state.order = loaded.filter(Boolean);

      buildToc();
      buildRail();
      route();

      window.addEventListener('hashchange', route);

      if (isHosted()) {
        dom.railToolchain.textContent = 'playground';
        dom.railToolchain.title = 'Code is compiled by the public Rust Playground API (play.rust-lang.org). Run the site locally for your own rustc.';
      } else {
        fetchJson('api/health')
          .then((health) => {
            const version = String(health.rustc || '').replace(/^rustc\s+/, '').split(' ')[0];
            dom.railToolchain.textContent = version ? `rustc ${version}` : 'rustc';
            dom.railToolchain.title = health.docsAvailable
              ? `Snippets compile with ${health.rustc}`
              : 'Compiler found, but the offline docshelf is missing';
          })
          .catch(() => {
            dom.railToolchain.textContent = 'no compiler';
            dom.railToolchain.title = 'The compile service is not reachable — start server.mjs';
          });
      }
    } catch (err) {
      dom.lesson.innerHTML = `<div class="lesson-inner"><h1 class="chapter-title">Cannot load the course</h1>
        <p class="prose">${escapeHtml(err.message)}</p>
        <p class="prose">Start the server with <code>node server.mjs</code> in the rust-learn folder, then reload this page.</p></div>`;
    }
  }

  boot();
}());
