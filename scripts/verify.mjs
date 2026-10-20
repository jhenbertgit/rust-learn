// Verifies the whole course: JSON shape, compiler pass, claimed output, exercise
// solutions, and docs links that exist on disk.
//
//   node scripts/verify.mjs            every lesson
//   node scripts/verify.mjs 06-moves   one lesson

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LESSON_DIR = path.join(ROOT, 'content', 'lessons');
const SCRATCH = path.join(ROOT, 'run-tmp', 'verify');

let SYSROOT = '';

// Captured through files rather than pipes: sandboxes (and some CI containers) deny
// piped stdio for spawned programs.
function runCaptureSync(cmd, args, cwd, timeoutMs) {
  const id = crypto.randomUUID().slice(0, 12);
  const outFile = path.join(SCRATCH, `probe-${id}.out`);
  const errFile = path.join(SCRATCH, `probe-${id}.err`);
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  const res = spawnSync(cmd, args, {
    cwd: cwd || SCRATCH,
    stdio: ['ignore', outFd, errFd],
    timeout: timeoutMs || 30_000,
  });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  const stdout = fs.readFileSync(outFile, 'utf8');
  const stderr = fs.readFileSync(errFile, 'utf8');
  fs.rmSync(outFile, { force: true });
  fs.rmSync(errFile, { force: true });
  return { code: res.status, stdout, stderr };
}

fs.mkdirSync(SCRATCH, { recursive: true });
{
  const probe = runCaptureSync('rustc', ['--print', 'sysroot']);
  SYSROOT = probe.code === 0 ? probe.stdout.trim() : '';
}

if (!SYSROOT) {
  const required = process.env.VERIFY_REQUIRE_TOOLCHAIN === '1';
  const message = 'rustc is not on PATH, so snippets cannot be verified';
  console.log(required ? `\nFAIL — ${message}.` : `\n${message}: skipping.\nSet VERIFY_REQUIRE_TOOLCHAIN=1 to make this an error.`);
  process.exit(required ? 1 : 0);
}

// The docshelf only exists where `rustup component add rust-docs` has run. Without it the
// href targets cannot be checked, so they are validated for shape instead of existence.
const DOCS = process.env.RUST_DOCS || path.join(SYSROOT, 'share', 'doc', 'rust', 'html');
const DOCS_AVAILABLE = fs.existsSync(path.join(DOCS, 'index.html'));

/** Compile+run through file descriptors (sandboxes may deny piped stdio). */
function compileAndRun(code, mode) {
  const dir = path.join(SCRATCH, crypto.randomUUID().slice(0, 12));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'main.rs'), code, 'utf8');
  const runCapture = (cmd, args, timeoutMs) => {
    const outFile = path.join(dir, 'out.txt');
    const errFile = path.join(dir, 'err.txt');
    const outFd = fs.openSync(outFile, 'w');
    const errFd = fs.openSync(errFile, 'w');
    const res = spawnSync(cmd, args, { cwd: dir, stdio: ['ignore', outFd, errFd], timeout: timeoutMs });
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    const read = (file) => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          return fs.readFileSync(file, 'utf8');
        } catch {
          // Windows can hold a freshly written file briefly; retry.
        }
      }
      return '';
    };
    return {
      code: res.status,
      timedOut: res.signal === 'SIGTERM' || res.error !== undefined,
      stdout: read(outFile),
      stderr: read(errFile),
    };
  };
  try {
    const args = ['--edition', '2021', '--color', 'never'];
    if (mode === 'test') args.push('--test');
    args.push('main.rs', '-o', 'main.exe');
    const compile = runCapture('rustc', args, 60_000);
    if (compile.code !== 0) return { compiled: false, compile };
    const run = runCapture(path.join(dir, 'main.exe'), [], 6_000);
    return { compiled: true, compile, run };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const problems = [];
const notes = [];
function problem(where, message) {
  problems.push(`${where}: ${message}`);
}

function evaluateChecks(checks, result) {
  const stdout = ((result.run && result.run.stdout) || '').trim();
  const lines = stdout.split('\n').filter((l) => l.trim());
  return (checks || []).map((check) => {
    switch (check.kind) {
      case 'compiles':
        return result.compiled;
      case 'outputEquals':
        return stdout === String(check.value).trim();
      case 'outputContains':
        return stdout.includes(String(check.value));
      case 'stdoutLines':
        return lines.length === Number(check.value);
      default:
        return false;
    }
  });
}

const only = process.argv[2];
const files = fs
  .readdirSync(LESSON_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .filter((f) => !only || f.startsWith(only));

let snippets = 0;
let runs = 0;

for (const file of files) {
  const full = path.join(LESSON_DIR, file);
  const where = file.replace(/\.json$/, '');
  let lesson;
  try {
    lesson = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (err) {
    problem(where, `invalid JSON — ${err.message}`);
    continue;
  }

  if (lesson.id !== where) problem(where, `id "${lesson.id}" does not match the filename`);
  if (!lesson.title) problem(where, 'missing title');
  if (!lesson.summary) problem(where, 'missing summary');
  if (typeof lesson.minutes !== 'number') problem(where, 'minutes must be a number');
  if (!Array.isArray(lesson.blocks) || lesson.blocks.length < 4) problem(where, 'needs at least 4 blocks');
  if (!Array.isArray(lesson.quiz) || lesson.quiz.length < 2) problem(where, 'needs at least 2 quiz items');
  if (!lesson.exercise) problem(where, 'missing exercise');

  (lesson.quiz || []).forEach((item, i) => {
    if (!Array.isArray(item.options) || item.options.length < 2) problem(where, `quiz[${i}] needs 2+ options`);
    if (typeof item.answer !== 'number' || item.answer < 0 || item.answer >= (item.options || []).length) {
      problem(where, `quiz[${i}] has an out-of-range answer index`);
    }
    if (!item.why) problem(where, `quiz[${i}] missing why`);
  });

  (lesson.blocks || []).forEach((block, i) => {
    if (!['prose', 'code', 'callout', 'diagram'].includes(block.type)) {
      problem(where, `blocks[${i}] unknown type "${block.type}"`);
      return;
    }
    if (block.type === 'code') {
      snippets += 1;
      const mode = block.mode === 'test' ? 'test' : 'bin';
      const result = compileAndRun(block.code, mode);

      // A fragment (runnable: false) never gets a Run button. Some are deliberately
      // broken so the prose can quote real compiler output; either outcome is fine,
      // it is only worth a note.
      if (block.runnable === false) {
        if (result.compiled) {
          notes.push(`${where}: blocks[${i}] is marked as a fragment but compiles standalone`);
        } else {
          const code = (result.compile.stderr.match(/error\[(E\d+)\]/) || [])[1] || 'no code';
          notes.push(`${where}: blocks[${i}] fragment rejected by the compiler (${code}), as intended`);
        }
        return;
      }

      if (!result.compiled) {
        problem(where, `blocks[${i}] does not compile:\n${(result.compile.stderr || '').split('\n').slice(0, 6).join('\n')}`);
        return;
      }
      runs += 1;
      if (result.run.timedOut) {
        problem(where, `blocks[${i}] did not finish within 6 seconds`);
      }
      if (block.output) {
        const want = String(block.output).trim();
        const got = (result.run.stdout || '').trim();
        if (mode === 'test') {
          if (!got.includes('test result: ok')) {
            problem(where, `blocks[${i}] claims test output but the harness printed:\n${got.slice(0, 300)}`);
          }
        } else if (!got.includes(want.split('\n')[0].trim())) {
          problem(where, `blocks[${i}] claims output ${JSON.stringify(want)} but printed ${JSON.stringify(got.slice(0, 200))}`);
        }
      }
    }
    if (block.type === 'diagram' && block.ascii) {
      const long = block.ascii.split('\n').filter((l) => l.length > 74);
      if (long.length) problem(where, `blocks[${i}] diagram has ${long.length} line(s) over 74 chars`);
    }
  });

  if (lesson.exercise) {
    const ex = lesson.exercise;
    if (!ex.brief) problem(where, 'exercise missing brief');
    if (!ex.starter) problem(where, 'exercise missing starter');
    if (!Array.isArray(ex.checks) || !ex.checks.length) problem(where, 'exercise needs at least one check');
    if (!ex.solution) problem(where, 'exercise missing solution');

    if (ex.starter) {
      const starterResult = compileAndRun(ex.starter, 'bin');
      if (!starterResult.compiled) {
        problem(where, `exercise starter does not compile:\n${(starterResult.compile.stderr || '').split('\n').slice(0, 5).join('\n')}`);
      }
    }
    if (ex.solution) {
      const solResult = compileAndRun(ex.solution, 'bin');
      if (!solResult.compiled) {
        problem(where, `exercise solution does not compile:\n${(solResult.compile.stderr || '').split('\n').slice(0, 5).join('\n')}`);
      } else {
        runs += 1;
        const results = evaluateChecks(ex.checks, solResult);
        if (results.some((ok) => !ok)) {
          problem(
            where,
            `exercise solution fails its own checks (${JSON.stringify(ex.checks)}) — stdout was ${JSON.stringify((solResult.run.stdout || '').trim().slice(0, 200))}`,
          );
        }
      }
    }
  }

  (lesson.docs || []).forEach((doc, i) => {
    if (!doc.label || !doc.href) {
      problem(where, `docs[${i}] needs both label and href`);
      return;
    }
    const href = String(doc.href);
    if (/^([a-z][a-z0-9+.-]*:|\/)/i.test(href) || href.includes('..')) {
      problem(where, `docs[${i}] must be a path inside the docshelf, not an absolute URL: ${href}`);
      return;
    }
    if (!/^[\w./-]+$/.test(href)) {
      problem(where, `docs[${i}] has characters a docshelf path should not have: ${href}`);
      return;
    }
    if (DOCS_AVAILABLE && !fs.existsSync(path.join(DOCS, href))) {
      problem(where, `docs[${i}] points at a file that is not in the docshelf: ${href}`);
    }
  });
}

// curriculum cross-check
try {
  const curriculum = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'curriculum.json'), 'utf8'));
  const listed = curriculum.modules.flatMap((m) => m.lessons);
  const present = fs.readdirSync(LESSON_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  listed.forEach((id) => {
    if (!present.includes(id)) problems.push(`curriculum: lists ${id} but content/lessons/${id}.json is missing`);
  });
  present.forEach((id) => {
    if (!listed.includes(id)) problems.push(`curriculum: ${id}.json exists but is not listed in curriculum.json`);
  });
} catch (err) {
  problems.push(`curriculum.json: ${err.message}`);
}

const unique = [...new Set(problems)];
const docsStatus = DOCS_AVAILABLE
  ? 'docshelf links checked for existence'
  : `docshelf absent at ${DOCS} — links checked for shape only`;
console.log(`\nchecked ${files.length} lesson file(s), ${snippets} code block(s), ${runs} program run(s)`);
console.log(`${docsStatus}`);
if (notes.length) {
  console.log(`\nnotes (${notes.length}):`);
  notes.forEach((n) => console.log(`  - ${n}`));
}
if (unique.length) {
  console.log(`\nFAIL — ${unique.length} problem(s):`);
  unique.forEach((p) => console.log(`  ✗ ${p}`));
  process.exit(1);
}
console.log('\nPASS — every snippet compiled, every claimed output matched, every exercise solution passed its checks.');
