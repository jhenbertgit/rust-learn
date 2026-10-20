# Rust, hands on

An offline course that sits on top of the Rust documentation already installed on this
machine. Fourteen short chapters take a beginner from `println!` to ownership, structs,
enums, collections, errors, traits, modules and tests.

The point of difference: **the Run button compiles your code with the `rustc` on this
machine.** Nothing is simulated, no playground over the network, no internet needed. Every
snippet in the course shows the compiler's real answer, and you can break any of them.

```
node server.mjs          ->  http://127.0.0.1:7878
```

No dependencies. No build step. Node 18 or newer, and a Rust toolchain on `PATH`.
On Windows, `start.cmd` does the same thing and opens the browser for you.

## What is in here

| Path | What it is |
|---|---|
| `server.mjs` | Local server: the app, a read-only proxy to the docshelf, and the compile endpoint |
| `public/` | The front end: `index.html`, `styles.css`, `js/app.js`, `js/highlight.js` |
| `content/curriculum.json` | Module order, chapter order, closing reading list |
| `content/lessons/*.json` | One file per chapter: prose, code, quiz, exercise, docs links |
| `content/bookshelf.json` | The offline book listing shown on the Bookshelf page |
| `content/AUTHORING.md` | The lesson schema and style rules, for writing more chapters |
| `scripts/verify.mjs` | Compiles every snippet in every lesson and checks claimed output |
| `scripts/build-static.mjs` | Builds `dist/`, the static site GitHub Pages serves |
| `.github/workflows/pages.yml` | Verify, build, deploy to Pages on push to `main` |
| `tools/smoke.mjs` | Dev-only end-to-end DOM test of the page (needs `npm install --prefix tools`) |
| `tools/pages-sim.mjs` | Dev-only server that mimics Pages, serving `dist/` under `/repo/` |
| `run-tmp/` | Scratch space for compiles; wiped per run, safe to delete |

## The Run button

`POST /api/run` writes the source into `run-tmp/<id>/main.rs`, calls
`rustc --edition 2021 main.rs -o main.exe`, then executes the binary with a 8 s limit and a
30 s compile limit. Diagnostics come back verbatim and are rendered line by line: `error:` in
red, `warning:` in amber, `help:` and `note:` in cyan, and the `-->` locations and caret
frames as compiler output looks. Compile is roughly 1 s warm, so a snippet round-trip feels
immediate; identical code is cached.

Snipets run inline under each example. The workbench on the right (or the bottom drawer on a
narrow window) is where you write the exercise; `Check my answer` compiles it and ticks off
the exercise's mechanical checks (`it compiles`, exact output, output contains, line count).

## The docshelf

`GET /docs/...` serves the installed Rust documentation tree read-only
(`rustc --print sysroot` → `share/doc/rust/html`), so every relative link, the rustdoc search
index and the mdbook search of The Book work from `http://127.0.0.1:7878/docs/` instead of
being blocked by `file://` restrictions. Nothing under `.rustup` is ever written to.

Override the location with `RUST_DOCS` if you keep docs elsewhere:

```powershell
$env:RUST_DOCS = "D:\rust-docs\html"; node server.mjs
```

## Keyboard

| Key | Does |
|---|---|
| `/` | Jump to chapter search |
| `Ctrl` + `Enter` | Compile and run what is in the workbench |
| `Tab` / `Shift`+`Tab` | Indent / outdent in the editor |
| `Esc` | Close the chapter list or the workbench drawer |

Progress (chapters opened, exercises passed, quiz answers, your code) is kept in
`localStorage` under `rust-handson-v2`, so it survives reloads on this machine.

## Verify the course

```powershell
node scripts/verify.mjs            # every chapter
node scripts/verify.mjs 06-moves   # one chapter
```

It fails loudly if a snippet does not compile, if a claimed `output` does not match what the
program actually prints, if an exercise solution fails its own checks, or if a `docs` link
points at a file that is not in the docshelf.

The page itself has an end-to-end test. It needs jsdom once, then runs against a live server:

```powershell
npm install --prefix tools        # dev-only, the course itself stays dependency-free
node server.mjs                   # in another terminal
node tools/smoke.mjs
```

It loads the real page in a DOM, clicks a chapter's Run button through to a real compile,
answers a quiz, writes the exercise solution into the editor, presses `Check my answer`, and
asserts the progress marks and receipt colours that result.

## Adding a chapter

Read `content/AUTHORING.md`, write `content/lessons/NN-slug.json` with an id matching the
filename, add that id to a `lessons` array in `content/curriculum.json`, then run the
verifier. The chapter appears in the list and gets a progress segment automatically.

## Deploying to GitHub Pages

`.github/workflows/pages.yml` builds the course into `dist/` and publishes it with GitHub
Pages on every push to `main`, and on demand from the Actions tab.

One-time setup, in the repository: **Settings → Pages → Build and deployment → Source:
GitHub Actions**. Nothing is pushed to a `gh-pages` branch.

The workflow runs three things in order:

1. `node scripts/verify.mjs` — compiles every snippet in every chapter and compares the
   output against what the lesson claims. **A lesson that no longer compiles blocks the
   deploy**, so the published course cannot drift from the compiler's reality. The job
   installs the `rust-docs` component first, so every `docs` link is also confirmed to point
   at a chapter that exists; if that component cannot be installed, links are checked for
   shape only and the run says so.
2. `node scripts/build-static.mjs` — writes `dist/`: `public/`, `content/`, a `.nojekyll`
   marker, and `app-config.json`.
3. Upload the artifact and deploy it.

### What changes when it is hosted

There is no server on Pages, so `app-config.json` switches the front end to a remote runner:

| | Local (`node server.mjs`) | Hosted on Pages |
|---|---|---|
| Compiles with | your own `rustc` | the public [Rust Playground API](https://play.rust-lang.org/execute) |
| Documentation links | the offline docshelf, proxied at `/docs/` | `doc.rust-lang.org/stable` |
| Needs a network | no | yes, to compile |
| Rail badge | `rustc 1.99.1` | `playground` |

Exercise checks, quizzes, progress, and the editor all behave the same in both. Hosted code
is sent to `play.rust-lang.org` to be compiled, and the Bookshelf page says so.

All front-end URLs are relative, so the site also works from a subpath such as
`https://you.github.io/rust-learn/` with no configuration.

### Preview the Pages build locally

```powershell
node scripts/build-static.mjs
node tools/pages-sim.mjs                              # serves dist/ at /repo/, like Pages does
$env:BASE = "http://127.0.0.1:8088/repo/"
node tools/smoke.mjs                                  # same 38 checks, hosted mode
```

### If your repository root is a parent folder

If this folder is committed as a subdirectory rather than as the repository root, add
`working-directory: rust-learn` to the `run:` steps and point the artifact at
`rust-learn/dist`.

### Pointing the hosted build somewhere else

`build-static.mjs` reads three environment variables, so a fork can use its own runner or
docs mirror without touching code:

```powershell
$env:DOCS_BASE = "https://doc.rust-lang.org/nightly/"
$env:RUNNER = "playground"
$env:PLAYGROUND_ENDPOINT = "https://play.rust-lang.org/execute"
node scripts/build-static.mjs
```

