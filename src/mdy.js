import MarkdownIt from 'markdown-it';
import { load as loadYaml } from 'js-yaml';

/**
 * mdy — markdown documents with embedded data + a JS template layer.
 *
 * A document is processed in two passes:
 *
 *   1. extractData()  — ```data fences are parsed as YAML and merged into a
 *                       single data object, then stripped from the source.
 *                       All other fences (```yaml, ```js, …) are left alone
 *                       and render normally.
 *
 *   2. compileTemplate() — the remaining text is compiled into ONE JavaScript
 *                          function that appends to an output buffer. Because
 *                          the whole document becomes one function body, every
 *                          `{{ … }}` shares a single scope. The function is run
 *                          with the extracted data as its context, producing a
 *                          markdown string that is finally rendered to HTML.
 *
 * Template syntax:
 *   {{= expr }}   append the expression's value to the output
 *   {{  code }}   run statements, append nothing (loops, if, let, …)
 *   \{{           a literal "{{"
 *
 * SECURITY: template code runs via `new Function` with full runtime access.
 * Only process trusted documents, or sandbox with `node:vm` / isolated-vm.
 */

/**
 * Compile a template string into `(context) => markdownString`.
 * @param {string} template
 * @returns {(context?: object) => string}
 */
export function compileTemplate(template) {
  let code = 'let __out = "";\n';
  let pos = 0;

  const emitLiteral = (text) => {
    if (!text) return;
    const unescaped = text.replace(/\\\{\{/g, '{{'); // \{{  ->  literal {{
    code += `__out += ${JSON.stringify(unescaped)};\n`;
  };

  // Index of the next unescaped "{{", or -1.
  const nextOpen = (from) => {
    let i = from;
    for (;;) {
      const idx = template.indexOf('{{', i);
      if (idx === -1) return -1;
      if (idx > 0 && template[idx - 1] === '\\') { i = idx + 2; continue; }
      return idx;
    }
  };

  for (;;) {
    const open = nextOpen(pos);
    if (open === -1) { emitLiteral(template.slice(pos)); break; }

    let literal = template.slice(pos, open);
    const close = template.indexOf('}}', open + 2);
    if (close === -1) throw new Error('mdy: unclosed "{{" in template');

    const inner = template.slice(open + 2, close).trim();
    const isOutput = inner.startsWith('=');
    let after = close + 2;

    // Whitespace control: when a control-flow tag (not `{{= }}`) sits alone on
    // its own line, collapse the line so it leaves no blank line in the output.
    // This keeps generated markdown (tables, lists) contiguous.
    if (!isOutput) {
      const lastNl = literal.lastIndexOf('\n');
      const leadOnLine = literal.slice(lastNl + 1);   // text between newline and tag
      let t = after;
      while (t < template.length && (template[t] === ' ' || template[t] === '\t')) t++;
      const trailingNewline = t < template.length && template[t] === '\n';

      if (/^[ \t]*$/.test(leadOnLine) && (trailingNewline || t >= template.length)) {
        literal = literal.slice(0, lastNl + 1);        // drop leading indent on the tag's line
        after = trailingNewline ? t + 1 : t;           // consume trailing newline
      }
    }

    emitLiteral(literal);
    if (isOutput) {
      code += `__out += (${inner.slice(1).trim()});\n`; // output expression
    } else {
      code += `${inner}\n`;                             // control flow
    }
    pos = after;
  }

  code += 'return __out;\n';

  // Non-strict body so `with` exposes context keys as bare identifiers and
  // `let`/`const` declared in one `{{ }}` stay in scope for the whole document.
  // eslint-disable-next-line no-new-func
  const fn = new Function('__ctx', `with (__ctx || {}) {\n${code}\n}`);
  return (context = {}) => fn(context);
}

/**
 * Pull ```data fences out of a document as YAML, returning the merged data and
 * the source with those fences removed. All other fences are left untouched.
 *
 * Every ```data fence must be a YAML mapping; all of them merge into a single
 * data object (later keys win). To group values, nest them in YAML.
 *
 * @param {string} source
 * @param {MarkdownIt} md  parser used to locate fences reliably
 * @returns {{ data: object, template: string }}
 */
export function extractData(source, md) {
  const tokens = md.parse(source, {});
  const lines = source.split('\n');
  const data = {};
  const drop = new Set();

  for (const t of tokens) {
    if (t.type !== 'fence' || t.info.trim().toLowerCase() !== 'data') continue;

    const parsed = loadYaml(t.content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      Object.assign(data, parsed);
    } else if (parsed != null) {
      throw new Error('mdy: a ```data fence must contain a YAML mapping');
    }

    if (t.map) for (let i = t.map[0]; i < t.map[1]; i++) drop.add(i);
  }

  const template = lines.filter((_, i) => !drop.has(i)).join('\n');
  return { data, template };
}

// A line that is exactly `---` (YAML document separator).
const DOC_SEPARATOR = /^---[ \t]*$/;

// Guard against a cycle of `$.render(i)` calls rendering each other forever.
const MAX_RENDER_DEPTH = 50;

/**
 * Split a source file into its constituent documents on `---` separator lines.
 * Documents are anonymous and positional (standard YAML-stream semantics): text
 * before the first `---` is document 0. A file with no separators yields a single
 * document, so single-document processing is just the one-element case.
 *
 * @param {string} source
 * @returns {string[]} document bodies, in order
 */
export function splitDocuments(source) {
  const docs = [];
  let current = [];
  for (const line of source.split('\n')) {
    if (DOC_SEPARATOR.test(line)) {
      docs.push(current.join('\n'));
      current = [];
    } else {
      current.push(line);
    }
  }
  docs.push(current.join('\n'));
  return docs;
}

/**
 * Process a multi-document source and render the entry document (index `entry`,
 * default 0) to markdown. Every document is a standard mdy unit (its own ```data
 * fences + template). Templates receive a `$` helper for addressing sibling
 * documents by index:
 *
 *   $.render(i, data)   run document i with `data` (overriding its own data),
 *                       returning markdown
 *   $.data(i)           document i's extracted data
 *   $.documents         [{ index, data }, …] for slicing / iteration
 *   $.count             number of documents
 *
 * @param {string} source
 * @param {MarkdownIt} md
 * @param {object} [extraContext] extra context for the entry document
 * @param {number} [entry] index of the document to render (default 0)
 * @returns {string} generated markdown
 */
export function renderDocumentSet(source, md, extraContext = {}, entry = 0) {
  const docs = splitDocuments(source).map((body, index) => {
    const { data, template } = extractData(body, md);
    return { index, data, generate: compileTemplate(template) };
  });

  const documents = docs.map(({ index, data }) => ({ index, data }));

  const runDoc = (i, ctx, depth) => {
    if (depth > MAX_RENDER_DEPTH) {
      throw new Error('mdy: render depth exceeded (cyclic $.render?)');
    }
    const doc = docs[i];
    if (!doc) throw new Error(`mdy: no document at index ${i}`);
    return doc.generate({ ...doc.data, ...ctx, $: makeApi(depth) });
  };

  const makeApi = (depth) => ({
    documents,
    count: docs.length,
    data: (i) => docs[i]?.data,
    render: (i, ctx = {}) => runDoc(i, ctx, depth + 1),
  });

  return runDoc(entry, extraContext, 0);
}

/**
 * Create a processor bound to a configured markdown-it instance.
 * @param {object} [options]
 * @param {MarkdownIt} [options.md] a preconfigured markdown-it (e.g. with a highlighter)
 * @returns {{ md: MarkdownIt, renderToMarkdown: Function, render: Function }}
 */
export function createProcessor(options = {}) {
  const md = options.md ?? new MarkdownIt({ html: true, linkify: true });

  /** Document source → generated markdown string (data extracted + templates run). */
  const renderToMarkdown = (source, extraContext = {}, entry = 0) =>
    renderDocumentSet(source, md, extraContext, entry);

  /** Document source → final HTML. */
  const render = (source, extraContext = {}, entry = 0) =>
    md.render(renderToMarkdown(source, extraContext, entry));

  return { md, renderToMarkdown, render };
}

// A ready-to-use default processor.
const processor = createProcessor();

/** Process a document string into HTML using the default processor. */
export function render(source, extraContext = {}, entry = 0) {
  return processor.render(source, extraContext, entry);
}

/** Process a document string into the generated markdown (pre-HTML). */
export function renderToMarkdown(source, extraContext = {}, entry = 0) {
  return processor.renderToMarkdown(source, extraContext, entry);
}

export { MarkdownIt };
