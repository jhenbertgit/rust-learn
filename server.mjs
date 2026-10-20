// Rust, hands on — local learning server.
// Zero dependencies. Serves the app, proxies the offline Rust docshelf, and compiles
// snippets with the rustc on this machine.
//
//   node server.mjs            -> http://127.0.0.1:7878
//   PORT=8000 node server.mjs
//   RUST_DOCS="C:\\path\\to\\html" node server.mjs

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
const CONTENT_DIR = path.join(HERE, 'content');
const TMP_DIR = path.join(HERE, 'run-tmp');
const PORT = Number(process.env.PORT || 7878);
const HOST = '127.0.0.1';
const MAX_BODY = 256 * 1024;
const COMPILE_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 8_000;
const MAX_STREAM = 64 * 1024;
const MAX_PARALLEL_COMPILES = 4;

// ---------------------------------------------------------------- toolchain

fs.mkdirSync(TMP_DIR, { recursive: true });

// Child process output is captured through files, never pipes: some sandboxes
// deny piped stdio for spawned programs, file descriptors are always fine.
function runCapturedSync(cmd, args, timeoutMs) {
  const id = crypto.randomUUID();
  const outFile = path.join(TMP_DIR, `cap-${id}.out`);
  const errFile = path.join(TMP_DIR, `cap-${id}.err`);
  let outFd;
  let errFd;
  try {
    outFd = fs.openSync(outFile, 'w');
    errFd = fs.openSync(errFile, 'w');
    const result = spawnSync(cmd, args, {
      stdio: ['ignore', outFd, errFd],
      timeout: timeoutMs || 10_000,
      windowsHide: true,
    });
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    outFd = undefined;
    errFd = undefined;
    const stdout = fs.readFileSync(outFile, 'utf8');
    const stderr = fs.readFileSync(errFile, 'utf8');
    return { code: result.status, stdout, stderr };
  } catch (err) {
    return { code: -1, stdout: '', stderr: String(err && err.message) };
  } finally {
    if (outFd !== undefined) try { fs.closeSync(outFd); } catch { /* ignore */ }
    if (errFd !== undefined) try { fs.closeSync(errFd); } catch { /* ignore */ }
    fs.rmSync(outFile, { force: true });
    fs.rmSync(errFile, { force: true });
  }
}

function resolveSysroot() {
  const out = runCapturedSync('rustc', ['--print', 'sysroot']);
  if (out.code === 0 && out.stdout.trim()) return out.stdout.trim();
  return null;
}

function resolveRustcVersion() {
  const out = runCapturedSync('rustc', ['--version']);
  return out.code === 0 ? out.stdout.trim() : null;
}

const SYSROOT = resolveSysroot();
const DOCS_DIR = process.env.RUST_DOCS
  || (SYSROOT ? path.join(SYSROOT, 'share', 'doc', 'rust', 'html') : null);
const RUSTC_VERSION = resolveRustcVersion();
const DOCS_OK = !!DOCS_DIR && fs.existsSync(path.join(DOCS_DIR, 'index.html'));

// ---------------------------------------------------------------- mime

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

const mimeFor = (file) => MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';

// ---------------------------------------------------------------- fs helpers

async function sendFile(res, filePath, { cache = 'no-store' } = {}) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return notFound(res);
  }
  if (stat.isDirectory()) return sendFile(res, path.join(filePath, 'index.html'), { cache });

  const headers = {
    'Content-Type': mimeFor(filePath),
    'Content-Length': stat.size,
    'Cache-Control': cache,
  };
  res.writeHead(200, headers);
  if (res.req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
  return undefined;
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

/** Resolve `rel` inside `root`, refusing anything that escapes it. */
function safeJoin(root, rel) {
  if (!root) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const clean = decoded.replace(/^[/\\]+/, '').replace(/\\/g, '/');
  const target = path.resolve(root, clean);
  const rootResolved = path.resolve(root);
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) return null;
  return target;
}

// ---------------------------------------------------------------- compile+run

const resultCache = new Map(); // hash -> result, small LRU
const CACHE_LIMIT = 120;

let active = 0;
const waiting = [];
function acquire() {
  if (active < MAX_PARALLEL_COMPILES) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}
function release() {
  active -= 1;
  const next = waiting.shift();
  if (next) {
    active += 1;
    next();
  }
}

function cap(text) {
  if (typeof text !== 'string') return '';
  if (text.length <= MAX_STREAM) return text;
  return `${text.slice(0, MAX_STREAM)}\n… output truncated (${text.length} bytes)`;
}

function execFileP(cmd, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const id = crypto.randomUUID();
    const outFile = path.join(TMP_DIR, `io-${id}.out`);
    const errFile = path.join(TMP_DIR, `io-${id}.err`);
    let outFd;
    let errFd;
    const finish = (payload) => {
      if (outFd !== undefined) try { fs.closeSync(outFd); } catch { /* ignore */ }
      if (errFd !== undefined) try { fs.closeSync(errFd); } catch { /* ignore */ }
      outFd = undefined;
      errFd = undefined;
      fs.rmSync(outFile, { force: true });
      fs.rmSync(errFile, { force: true });
      resolve(payload);
    };
    let child;
    let timedOut = false;
    try {
      outFd = fs.openSync(outFile, 'w');
      errFd = fs.openSync(errFile, 'w');
      // stdio: file descriptors, not pipes — see runCapturedSync.
      child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', outFd, errFd] });
    } catch (err) {
      finish({ code: -1, stdout: '', stderr: String(err && err.message), timedOut, ms: 0 });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    const collect = (code) => {
      clearTimeout(timer);
      let stdout = '';
      let stderr = '';
      try { stdout = fs.readFileSync(outFile, 'utf8'); } catch { /* empty */ }
      try { stderr = fs.readFileSync(errFile, 'utf8'); } catch { /* empty */ }
      finish({ code: code === null ? -1 : code, stdout: cap(stdout), stderr: cap(stderr), timedOut, ms: Date.now() - started });
    };
    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ code: -1, stdout: '', stderr: cap(String(err && err.message)), timedOut, ms: Date.now() - started });
    });
    child.on('close', (code) => collect(code));
  });
}

async function cleanup(dir) {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function compileAndRun(code, mode) {
  const key = `${mode}:${crypto.createHash('sha256').update(code).digest('hex')}`;
  const cached = resultCache.get(key);
  if (cached) return { ...cached, cached: true };

  await acquire();
  // Each run gets its own directory containing a file literally named main.rs,
  // so compiler diagnostics read "main.rs:4:16" instead of a scratch path.
  const dir = path.join(TMP_DIR, crypto.randomUUID().slice(0, 12));
  const exe = 'main.exe';
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'main.rs'), code, 'utf8');

    const compileArgs = mode === 'test'
      ? ['--edition', '2021', '--test', '--color', 'never', 'main.rs', '-o', exe]
      : ['--edition', '2021', '--color', 'never', 'main.rs', '-o', exe];

    const compile = await execFileP('rustc', compileArgs, {
      cwd: dir,
      timeoutMs: COMPILE_TIMEOUT_MS,
    });

    if (compile.timedOut) {
      return { ok: false, stage: 'compile', timeout: true, compile, output: null };
    }
    if (compile.code !== 0) {
      return { ok: false, stage: 'compile', timeout: false, compile, output: null };
    }

    const output = await execFileP(path.join(dir, exe), [], { cwd: dir, timeoutMs: RUN_TIMEOUT_MS });
    const result = {
      ok: output.code === 0 && !output.timedOut,
      stage: 'run',
      timeout: output.timedOut,
      compile: { stdout: compile.stdout, stderr: compile.stderr, ms: compile.ms },
      output,
    };
    if (resultCache.size >= CACHE_LIMIT) {
      resultCache.delete(resultCache.keys().next().value);
    }
    resultCache.set(key, result);
    return result;
  } finally {
    await cleanup(dir);
    release();
  }
}

// ---------------------------------------------------------------- http

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (err) {
        reject(new Error(`invalid JSON: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const pathname = url.pathname;

  if (pathname === '/app-config.json') {
    // The local build compiles with this machine's rustc; the static build for GitHub
    // Pages ships its own app-config.json with a remote runner instead.
    return json(res, 200, {
      mode: 'local',
      runner: 'local',
      docsBase: null,
      notice: '',
    });
  }

  if (pathname === '/api/health') {
    return json(res, 200, {
      ok: true,
      rustc: RUSTC_VERSION,
      sysroot: SYSROOT,
      docs: DOCS_DIR,
      docsAvailable: DOCS_OK,
    });
  }

  if (pathname === '/api/run') {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
    const code = typeof body.code === 'string' ? body.code : '';
    if (!code.trim()) return json(res, 400, { error: 'code is empty' });
    if (code.length > 120_000) return json(res, 413, { error: 'code too long' });
    const mode = body.mode === 'test' ? 'test' : 'bin';
    try {
      const result = await compileAndRun(code, mode);
      return json(res, 200, result);
    } catch (err) {
      return json(res, 500, { error: String(err && err.message) });
    }
  }

  if (pathname.startsWith('/docs')) {
    if (!DOCS_OK) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Rust docshelf not found. Set RUST_DOCS to the directory containing index.html.');
    }
    const rest = pathname.slice('/docs'.length) || '/';
    const target = safeJoin(DOCS_DIR, rest === '/' ? 'index.html' : rest);
    if (!target) return notFound(res);
    return sendFile(res, target, { cache: 'public, max-age=3600' });
  }

  if (pathname.startsWith('/content')) {
    const rest = pathname.slice('/content'.length) || '/';
    const target = safeJoin(CONTENT_DIR, rest);
    if (!target) return notFound(res);
    return sendFile(res, target);
  }

  const target = safeJoin(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!target) return notFound(res);
  return sendFile(res, target);
});

server.listen(PORT, HOST, () => {
  const banner = [
    '',
    `  Rust, hands on   http://${HOST}:${PORT}`,
    `  rustc            ${RUSTC_VERSION || 'not found on PATH'}`,
    `  docshelf         ${DOCS_OK ? DOCS_DIR : 'NOT FOUND — set RUST_DOCS'}`,
    `  scratch          ${TMP_DIR}`,
    '',
  ].join('\n');
  process.stdout.write(banner);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
