// Builds the static site that GitHub Pages serves: public/ + content/ plus an
// app-config.json that tells the front end how to compile code without a server.
//
//   node scripts/build-static.mjs
//
// The output lands in dist/. Everything is referenced with relative URLs, so the
// site works at a domain root, at /repo/, or from any subdirectory.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');

const DOCS_BASE = process.env.DOCS_BASE || 'https://doc.rust-lang.org/stable/';
const RUNNER = process.env.RUNNER || 'playground';
const PLAYGROUND_ENDPOINT = process.env.PLAYGROUND_ENDPOINT || 'https://play.rust-lang.org/execute';

const config = {
  mode: 'static',
  runner: RUNNER,
  playgroundEndpoint: PLAYGROUND_ENDPOINT,
  docsBase: DOCS_BASE,
  notice:
    'This copy is hosted on GitHub Pages, so it has no server of its own: code is compiled by the public Rust Playground API and documentation links point at doc.rust-lang.org. Run the site locally (node server.mjs) for your own rustc and the offline docshelf.',
};

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

function countFiles(dir) {
  let files = 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = countFiles(full);
      files += inner.files;
      bytes += inner.bytes;
    } else {
      files += 1;
      bytes += fs.statSync(full).size;
    }
  }
  return { files, bytes };
}

// Guard rails: a build without lessons or without the entry point is a broken deploy.
const lessonsDir = path.join(ROOT, 'content', 'lessons');
const lessons = fs.existsSync(lessonsDir)
  ? fs.readdirSync(lessonsDir).filter((f) => f.endsWith('.json')).sort()
  : [];
if (!lessons.length) {
  console.error('build-static: no lessons found in content/lessons — refusing to build an empty site');
  process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, 'public', 'index.html'))) {
  console.error('build-static: public/index.html is missing');
  process.exit(1);
}

const curriculum = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'curriculum.json'), 'utf8'));
const listed = curriculum.modules.flatMap((m) => m.lessons).sort();
const missing = listed.filter((id) => !lessons.includes(`${id}.json`));
const extra = lessons.filter((f) => !listed.includes(f.replace(/\.json$/, '')));
if (missing.length || extra.length) {
  console.error('build-static: curriculum.json and content/lessons disagree');
  if (missing.length) console.error(`  listed but missing: ${missing.join(', ')}`);
  if (extra.length) console.error(`  present but unlisted: ${extra.join(', ')}`);
  process.exit(1);
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

copyTree(path.join(ROOT, 'public'), DIST);
copyTree(path.join(ROOT, 'content'), path.join(DIST, 'content'));
fs.writeFileSync(path.join(DIST, 'app-config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
// Pages runs Jekyll by default; it would strip files starting with an underscore.
fs.writeFileSync(path.join(DIST, '.nojekyll'), '', 'utf8');

const totals = countFiles(DIST);
console.log('build-static: wrote dist/');
console.log(`  chapters        ${lessons.length}`);
console.log(`  files           ${totals.files}`);
console.log(`  size            ${(totals.bytes / 1024).toFixed(0)} KB`);
console.log(`  runner          ${config.runner}${config.runner === 'playground' ? ` -> ${config.playgroundEndpoint}` : ''}`);
console.log(`  docs base       ${config.docsBase}`);
