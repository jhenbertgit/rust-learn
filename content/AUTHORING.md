# Writing lessons for "Rust, hands on"

Every lesson is one JSON file in `content/lessons/NN-slug.json`. It is rendered by `public/js/app.js`.
The audience is a **total beginner to Rust** who does know how to program in some other language.
Write like a patient senior engineer sitting next to them. Short sentences. Concrete examples.

## Hard rules

1. **Every snippet must compile and pass `rustc --edition 2021`** before you save the file. Verify each one.
   ```powershell
   $c = Get-Content -Raw lesson.json | ConvertFrom-Json
   # for each runnable block / exercise starter / exercise solution:
   Set-Content run.rs $code -Encoding utf8
   rustc --edition 2021 run.rs -o run.exe    # must exit 0
   .\run.exe                                 # check it prints what you claim
   ```
2. Snippets run as a **single file** with `fn main()` (or `#![allow(...)]` attrs on top). No `cargo`, no
   external crates, no `use` of anything outside `std`. `src/` layout and `cargo test` are *described in
   prose*, never executed by the app.
3. Do **not** teach anything a later lesson undoes. Ownership is introduced in lesson 06: before that,
   avoid `&`, `String` moves, and `.clone()`.
4. Exercises must be completable by a beginner in under five minutes and must be checkable mechanically:
   the checks below are literal string comparisons against the program's stdout + whether it compiles.
5. British/American spelling: pick American ("behavior", "initialize"). No emoji. No exclamation marks
   in prose. Second person for instructions, first person plural for explanations ("we hand the value over").
6. Never claim output you did not observe. If unsure, run it.

## File shape

```json
{
  "id": "01-hello",
  "title": "Your first Rust program",
  "minutes": 7,
  "summary": "One sentence, under 90 characters, shown in the chapter list.",
  "keywords": ["println", "main", "comments"],
  "blocks": [ ...blocks in reading order... ],
  "quiz": [ ...2 or 3 items... ],
  "exercise": { ...one... },
  "docs": [ {"label": "The Book · 1.2 Hello, World!", "href": "book/ch01-02-hello-world.html"} ]
}
```

`id` must equal the filename without `.json`. `minutes` is 5–12.

## Blocks

Ordered array, rendered top to bottom. Exactly these types:

| type | fields | notes |
|---|---|---|
| `prose` | `html` | Allowed tags only: `<p> <strong> <em> <code> <a> <ul> <ol> <li> <br>`. Inline code uses `<code>`. |
| `code` | `code`, optional `title`, optional `runnable` (default `true`), optional `output`, optional `mode` | A Rust source block. `runnable: false` for fragments that cannot stand alone (e.g. a bare `impl` block) — those get no Run button. `output` is a short plain-text string of what the program prints, shown as a faint note under the block. `mode` is `"bin"` (default) or `"test"`. |
| `callout` | `tone`, `html` | `tone` is `"help"`, `"warn"`, or `"note"`. Rendered as a left-ruled aside with a `help:` / `warning:` / `note:` marker, like compiler output. |
| `diagram` | `title`, `ascii` | Monospace ASCII diagram in the code slab, not runnable. Use for memory/ownership/control-flow pictures. Keep lines under 62 chars. |

Lesson rhythm for a 9-minute lesson: prose → code you run → prose that names the rule → short code →
one `callout` with the pitfall → a `diagram` if memory is involved → quiz → exercise. Do not write walls
of prose; no block longer than ~120 words.

## Quiz items

```json
{"q": "Which line fails to compile?", "options": ["let x = 1; x = 2;", "let mut x = 1; x = 2;"], "answer": 1, "why": "Bindings are immutable unless declared with mut."}
```

2–3 items. `answer` is the 0-based index of the correct option. 2–4 options. `why` explains the correct
answer in one or two sentences — it is shown after the learner answers, right or wrong.

## Exercise

```json
"exercise": {
  "brief": "Print the sum of the numbers 1 through 5 using a for loop.",
  "starter": "fn main() {\n    // your code here\n}\n",
  "hint": "Ranges are written 1..=5 and produce every number in between.",
  "checks": [{"kind": "outputEquals", "value": "15"}],
  "solution": "fn main() {\n    let mut sum = 0;\n    for n in 1..=5 {\n        sum += n;\n    }\n    println!(\"{sum}\");\n}\n"
}
```

`starter` must compile as-is (it is loaded into the editor immediately, and a beginner may press Run
before writing anything — a resulting compile error is fine and instructive, but the starter should
usually be a program that prints nothing yet or a comment stub). `solution` must compile and pass
`checks`. Check kinds:

- `{"kind": "compiles"}` — the snippet compiled.
- `{"kind": "outputEquals", "value": "15"}` — trimmed stdout equals the value exactly.
- `{"kind": "outputContains", "value": "hello"}` — trimmed stdout contains the substring.
- `{"kind": "stdoutLines", "value": 3}` — number of non-empty stdout lines.

At least one check, always. Prefer `outputEquals`/`outputContains` over `stdoutLines`.

## Docs links

`href` is a path relative to the Rust docshelf root (`rustup doc` root), e.g.
`book/ch04-01-what-is-ownership.html`, `rust-by-example/flow_control/match.html`,
`std/vec/struct.Vec.html`, `error_codes/E0382.html`, `reference/expressions.html`.
Verify the file exists under
`C:\Users\Jhenbert\.rustup\toolchains\stable-x86_64-pc-windows-msvc\share\doc\rust\html\`.
Give 1–3 links: the single official chapter worth reading next, not a pile.

## Voice, by example

Good: "`let` creates a binding. The binding is immutable: you get one chance to set it, then it is
locked. If that is not what you want, say so up front with `mut`."

Bad: "In Rust, variables are immutable by default, which is a core design decision that provides many
benefits such as safety and concurrency advantages." — vague, no example, no instruction.
