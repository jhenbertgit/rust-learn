/* Minimal Rust tokenizer for display. Not a parser: it colors what Rust looks
   like so the eye can find keywords, types, and strings quickly. */
(function () {
  const KEYWORDS = new Set([
    'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum',
    'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod',
    'move', 'mut', 'pub', 'ref', 'return', 'static', 'struct', 'super', 'trait', 'true',
    'type', 'unsafe', 'use', 'where', 'while', 'self', 'Self', 'yield',
  ]);

  const VARIANTS = new Set(['Some', 'None', 'Ok', 'Err']);

  const TYPES = new Set([
    'i8', 'i16', 'i32', 'i64', 'i128', 'isize', 'u8', 'u16', 'u32', 'u64', 'u128', 'usize',
    'f32', 'f64', 'bool', 'char', 'str', 'String', 'Vec', 'Option', 'Result', 'HashMap',
    'Box', 'Rc', 'Arc', 'RefCell', 'Ordering', 'Duration', 'BTreeMap', 'VecDeque', 'Self',
  ]);

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  const span = (cls, text) => `<span class="${cls}">${escapeHtml(text)}</span>`;
  const NUMBER_RE = /^0[xX][0-9a-fA-F_]+|^0[oO][0-7_]+|^0[bB][01_]+|^[0-9][0-9_]*(?:\.[0-9][0-9_]*)?(?:[eE][+-]?[0-9]+)?(?:[iuf](?:8|16|32|64|128|size))?/;
  const RAW_RE = /^(?:b)?r(#*)"/;
  const PUNCT_STOP = /[A-Za-z0-9_"'\/]/;

  function highlight(src) {
    let out = '';
    let i = 0;
    const n = src.length;
    let afterFn = false;

    while (i < n) {
      const c = src[i];
      const next = src[i + 1];

      if (c === '/' && next === '/') {
        let j = src.indexOf('\n', i);
        if (j < 0) j = n;
        out += span('tok-com', src.slice(i, j));
        i = j;
        continue;
      }

      if (c === '/' && next === '*') {
        let depth = 1;
        let j = i + 2;
        while (j < n && depth > 0) {
          if (src[j] === '/' && src[j + 1] === '*') { depth += 1; j += 2; }
          else if (src[j] === '*' && src[j + 1] === '/') { depth -= 1; j += 2; }
          else j += 1;
        }
        out += span('tok-com', src.slice(i, j));
        i = j;
        continue;
      }

      const raw = RAW_RE.exec(src.slice(i));
      if (raw && c !== 'b') {
        const closer = `"${raw[1]}`;
        const bodyStart = i + raw[0].length;
        const end = src.indexOf(closer, bodyStart);
        const j = end < 0 ? n : end + closer.length;
        out += span('tok-str', src.slice(i, j));
        i = j;
        continue;
      }

      if (c === 'b' && next === 'r') {
        const byteRaw = /^br(#*)"/.exec(src.slice(i));
        if (byteRaw) {
          const closer = `"${byteRaw[1]}`;
          const bodyStart = i + byteRaw[0].length;
          const end = src.indexOf(closer, bodyStart);
          const j = end < 0 ? n : end + closer.length;
          out += span('tok-str', src.slice(i, j));
          i = j;
          continue;
        }
      }

      if (c === 'b' && next === '"') {
        let j = i + 2;
        while (j < n) {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '"') { j += 1; break; }
          j += 1;
        }
        out += span('tok-str', src.slice(i, j));
        i = j;
        continue;
      }

      if (c === '"') {
        let j = i + 1;
        while (j < n) {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '"') { j += 1; break; }
          j += 1;
        }
        out += span('tok-str', src.slice(i, j));
        i = j;
        continue;
      }

      if (c === "'") {
        const life = /^'[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
        if (life && src[i + life[0].length] !== "'") {
          out += span('tok-life', life[0]);
          i += life[0].length;
          continue;
        }
        let j = i + 1;
        if (src[j] === '\\') j += 2; else j += 1;
        while (j < n && src[j] !== "'" && j - i < 14) j += 1;
        if (src[j] === "'") j += 1;
        out += span('tok-str', src.slice(i, j));
        i = j;
        continue;
      }

      if (c >= '0' && c <= '9') {
        const num = NUMBER_RE.exec(src.slice(i));
        const text = num ? num[0] : c;
        out += span('tok-num', text);
        i += text.length;
        afterFn = false;
        continue;
      }

      if (/[A-Za-z_]/.test(c)) {
        let j = i;
        while (j < n && /[A-Za-z0-9_]/.test(src[j])) j += 1;
        const word = src.slice(i, j);
        let cls;
        if (src[j] === '!') {
          out += span('tok-macro', `${word}!`);
          i = j + 1;
          afterFn = false;
          continue;
        }
        if (afterFn) cls = 'tok-fn';
        else if (KEYWORDS.has(word)) cls = 'tok-kw';
        else if (VARIANTS.has(word)) cls = 'tok-macro';
        else if (TYPES.has(word) || /^[A-Z]/.test(word)) cls = 'tok-type';
        else cls = 'tok-var';

        out += span(cls, word);
        afterFn = word === 'fn';
        i = j;
        continue;
      }

      let j = i;
      while (j < n && !PUNCT_STOP.test(src[j]) && !(src[j] === '/' && (src[j + 1] === '/' || src[j + 1] === '*'))) {
        j += 1;
      }
      if (j === i) j = i + 1;
      out += span('tok-punct', src.slice(i, j));
      i = j;
      afterFn = false;
    }

    return out;
  }

  window.RustHL = { highlight, escapeHtml };
}());
