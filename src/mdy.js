import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import { remarkAlert } from 'remark-github-blockquote-alert';
import remarkStringify from 'remark-stringify';
import rehypeRaw from 'rehype-raw';
import rehypeStringify from 'rehype-stringify';
import { load as loadYaml } from 'js-yaml';
import { connect, MemoryStorageProvider } from '@mdy-docs/nisaba-db';
import { runProgram } from './vm.js';

/**
 * mdy — markdown documents with front matter data + a JS template layer.
 *
 * A source is processed in two passes:
 *
 *   1. parseDocuments() — the source is split into documents on bare `---`
 *                         separator lines, then each document is split on its
 *                         first bare `+++` line into YAML front matter (parsed
 *                         into a data object) and a markdown body (the
 *                         template). A document with no `+++` is all body.
 *                         ```data fences in the body are extracted as YAML and
 *                         merged into the data (front matter first, later
 *                         fences win); inline #hashtags union into data.tags.
 *
 *   2. compileTemplate() — the body is compiled into ONE JavaScript function
 *                          that appends to an output buffer. Because the whole
 *                          document becomes one function body, every `{{ … }}`
 *                          shares a single scope. The function receives the
 *                          front matter data as `self` ({{ self.title }})
 *                          and caller-passed data as `arg` ({{ arg.name }}),
 *                          producing a markdown string that is finally
 *                          rendered to HTML.
 *
 * Template syntax:
 *   {{ expr }}    append the expression's value to the output
 *   {% code %}    run statements, append nothing (loops, if, let, …)
 *                 (append explicitly from code with write(value, …))
 *   \{{  \{%      a literal "{{" / "{%"
 *
 * SECURITY: template code runs via `new Function` with full runtime access.
 * Only process trusted documents, or sandbox with `node:vm` / isolated-vm.
 */

/**
 * Compile a template string into a JavaScript statement sequence that builds
 * the generated markdown in `__out` (declared by the sequence itself, holding
 * the finished string when it ends). This is the exact code both executors
 * run — the lamassu VM (the real, sandboxed path used by render*) and
 * compileTemplate()'s host-side debug path.
 *
 * The prologue also declares `write(...values)` — the DOCUMENTED way for
 * `{% %}` code to append to the output ({% write($.render(card, m)) %} is
 * the code-tag equivalent of {{ $.render(card, m) }}), with the same string
 * coercion as `{{ }}`. It lives here, next to `__out`, so it exists by
 * construction in every context the statements run in (VM, host debug,
 * --emit-js); `__out` itself stays an internal. `write`, `self`, `arg`, and
 * `$` are the template layer's reserved names.
 *
 * The statements reference data through two bindings the embedder declares
 * first: `self` — the document's own parsed data (`{{ self.title }}`) — and
 * `arg` — whatever the caller passed in (`{{ arg.name }}`), never merged.
 * Property access on an object never throws for a missing key, so optional
 * data reads as `undefined` (`{{ arg.age ?? self.age ?? 'n/a' }}`) with no
 * machinery behind it — and a key that isn't a valid identifier is just
 * `arg["the key"]`.
 *
 * @param {string} template
 * @returns {string} JavaScript statements
 */
export function compileTemplateSource(template) {
  let code = 'let __out = "";\nconst write = (...values) => { for (const v of values) __out += v; };\n';
  let pos = 0;

  const emitLiteral = (text) => {
    if (!text) return;
    const unescaped = text.replace(/\\\{([{%])/g, '{$1'); // \{{ -> {{ , \{% -> {%
    code += `__out += ${jsonForEval(unescaped)};\n`;
  };

  // Next unescaped tag open: `{{` (output) or `{%` (code). Null when none left.
  const nextOpen = (from) => {
    let i = from;
    for (;;) {
      const out = template.indexOf('{{', i);
      const stmt = template.indexOf('{%', i);
      const idx = out === -1 ? stmt : stmt === -1 ? out : Math.min(out, stmt);
      if (idx === -1) return null;
      if (idx > 0 && template[idx - 1] === '\\') { i = idx + 2; continue; }
      return { idx, isOutput: idx === out };
    }
  };

  for (;;) {
    const open = nextOpen(pos);
    if (!open) { emitLiteral(template.slice(pos)); break; }
    const { idx, isOutput } = open;

    let literal = template.slice(pos, idx);
    const closeTag = isOutput ? '}}' : '%}';
    const close = template.indexOf(closeTag, idx + 2);
    if (close === -1) {
      throw new Error(`mdy: unclosed "${isOutput ? '{{' : '{%'}" in template`);
    }

    const inner = template.slice(idx + 2, close).trim();
    let after = close + 2;

    // Whitespace control: when a `{% %}` tag sits alone on its own line,
    // collapse the line so it leaves no blank line in the output. This keeps
    // generated markdown (tables, lists) contiguous.
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
      code += `__out += (${inner});\n`; // output expression
    } else {
      code += `${inner}\n`;             // control flow
    }
    pos = after;
  }

  return code;
}

// JSON that is safe to embed directly in JavaScript source: U+2028/U+2029
// are valid in JSON strings but line terminators in (older) JS.
function jsonForEval(value) {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * Compile a template string into `(self, arg) => markdownString`, executed
 * in the HOST runtime via `new Function`. This is a debug/inspection path —
 * it is NOT sandboxed. Rendering documents through render / renderToMarkdown
 * / renderDocumentSet runs the same compiled statements inside the lamassu
 * VM. The two parameters mirror the real pipeline's bindings: `self` is the
 * document's own data ({{ self.title }}), `arg` is caller-passed data
 * ({{ arg.name }}). The generated statements are available as `.source`.
 * @param {string} template
 * @returns {(self?: object, arg?: object) => string}
 */
export function compileTemplate(template) {
  const body = compileTemplateSource(template);
  const generate = (self = {}, arg = {}) => {
    // eslint-disable-next-line no-new-func
    const fn = new Function('self', 'arg', `${body}\nreturn __out;`);
    return fn(self, arg);
  };
  generate.source = body;
  return generate;
}

// A bare `---` line: a document separator. Every such line is structural
// (use `***` or `___` for a thematic break inside a document body).
const DOCUMENT_SEPARATOR = /^---[ \t]*$/;

// A bare `+++` line: the front matter separator inside a document. The first
// one splits YAML front matter (before) from the markdown body (after).
const FRONT_MATTER_SEPARATOR = /^\+\+\+[ \t]*$/;

// A hashtag: `#` preceded by start-of-line or whitespace, then a letter, then
// letters/digits/underscores/hyphens. This excludes ATX headings (`# heading`
// has a space), issue numbers (`#42` has no letter), URL fragments
// (`page#top` has no preceding whitespace), and markdown-escaped `\#tag`
// (the backslash blocks the match; markdown renders `\#` as a plain `#`).
const HASHTAG = /(?<=^|\s)#([\p{L}][\p{L}\p{N}_-]*)/gmu;

// The $.parse / $.stringify natives' processors. Parsing speaks the same
// markdown dialect as the render pipeline (remark-parse + remark-gfm), so a
// tree a template inspects is the tree its output would render from; the
// stringifier is that dialect in reverse. mdast trees are plain JSON, so
// they cross the VM boundary through the ordinary __hostcall channel with
// no marshaling of their own.
const mdastParser = unified().use(remarkParse).use(remarkGfm);
// bullet '-' matches how this repo (and most hand-written markdown) authors
// lists, so normalized output stays close to what templates typically emit.
const mdastStringifier = unified().use(remarkStringify, { bullet: '-' }).use(remarkGfm);

// $.table cell → phrasing children. A cell is parsed as markdown so inline
// syntax (**bold**, `code`, links) survives into the table; block content has
// no place in a GFM cell, so anything that doesn't parse to a single
// paragraph falls back to the literal text (which the serializer escapes).
const tableCellChildren = (value) => {
  const text = value === null || value === undefined ? '' : String(value);
  if (text.trim() === '') return [];
  const parsed = mdastParser.parse(text).children;
  return parsed.length === 1 && parsed[0].type === 'paragraph'
    ? parsed[0].children
    : [{ type: 'text', value: text }];
};

// $.table's align argument → mdast table align. Accepts full words or
// initials ('l' / 'center' / 'R'); anything else in the array means default.
const TABLE_ALIGN = { l: 'left', c: 'center', r: 'right' };
const tableAlign = (align) => {
  if (align === null || align === undefined) return undefined;
  if (!Array.isArray(align)) {
    throw new Error("mdy: $.table align must be an array like ['left', 'center', 'right']");
  }
  return align.map((a) => TABLE_ALIGN[String(a ?? '').toLowerCase()[0]] ?? null);
};

// The block-level placeholder `$.toc()` (no argument) leaves in the output;
// the program epilogue replaces it with a link list built from the FINAL
// tree — after the whole template ran and any $.transform was applied — so
// a TOC at the top of a document sees headings generated below it.
const TOC_MARKER = '<!--mdy:toc-->';

// Heading anchor slugs — same algorithm as the site layer's slugify (core
// cannot import from src/site/); duplicate headings dedupe GitHub-style
// (`intro`, `intro-1`, …).
const slugifyHeading = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const uniqueSlug = (slug, seen) => {
  const n = seen.get(slug) ?? 0;
  seen.set(slug, n + 1);
  return n === 0 ? slug : `${slug}-${n}`;
};

/** Concatenated text content of an mdast (or hast) node's subtree. */
const textContent = (node) =>
  typeof node.value === 'string' ? node.value : (node.children ?? []).map(textContent).join('');

/** All headings of an mdast tree, in document order, with deduped slugs. */
const tocEntries = (tree) => {
  const seen = new Map();
  const entries = [];
  const walk = (node) => {
    if (node.type === 'heading') {
      const text = textContent(node);
      entries.push({ depth: node.depth, text, slug: uniqueSlug(slugifyHeading(text), seen) });
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return entries;
};

// Guard against a cycle of `$.render` calls rendering each other forever.
// Each nesting level holds a live VM instance while suspended (Asyncify is
// not reentrant), so this is deliberately modest.
const MAX_RENDER_DEPTH = 16;

/**
 * Extract inline hashtags from a document body.
 *
 * The scan runs over the RAW template body — tags are static metadata about
 * the authored document, so a tag generated at render time (`#{{ topic }}`)
 * does not count, and no rendering is needed to know a document's tags.
 * Template tags (`{{ … }}` / `{% … %}`), fenced code blocks, and inline code
 * spans are skipped. Tags are lowercased and deduped, in order of first
 * appearance, without the leading `#`.
 *
 * @param {string} body raw template body
 * @returns {string[]} lowercase tag names
 */
export function extractTags(body) {
  const noTemplates = body
    .replace(/\{\{[\s\S]*?\}\}/g, ' ')
    .replace(/\{%[\s\S]*?%\}/g, ' ');

  const lines = [];
  let inFence = false;
  for (const line of noTemplates.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (!inFence) lines.push(line);
  }
  const text = lines.join('\n').replace(/`[^`\n]*`/g, ' '); // inline code spans

  const tags = [];
  for (const m of text.matchAll(HASHTAG)) {
    const tag = m[1].toLowerCase();
    if (!tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

/**
 * Normalize a declared `tags` value (from front matter or a ```data fence):
 * a list or a single string; anything else is an error.
 */
function declaredTags(value) {
  if (value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.map(String);
  throw new Error('mdy: `tags` must be a list (or a single string)');
}

/** Lowercase and dedupe tags, preserving first-appearance order. */
function uniqueTags(all) {
  const tags = [];
  for (const t of all) {
    const tag = t.toLowerCase();
    if (!tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

// Parser used only to LOCATE ```data fences. Using a real markdown parser
// (rather than a hand-rolled scan) inherits CommonMark's fence rules:
// indentation, `~~~` and longer fence runs, fences inside lists, and a
// ```data example shown inside a longer outer fence correctly counting as
// display, not data. remark-parse alone suffices — no plugins change fences.
const fenceParser = unified().use(remarkParse);

/** Depth-first walk over an mdast tree's fenced/indented code nodes. */
function* codeNodes(node) {
  if (node.type === 'code') yield node;
  if (node.children) for (const child of node.children) yield* codeNodes(child);
}

/**
 * Pull ```data fences out of a document body, returning the parsed YAML
 * blocks (in document order) and the body with those fences removed. All
 * other fences (```yaml, ```js, …) are left untouched. Each fence must be a
 * YAML mapping; an empty fence contributes nothing. Extraction happens at
 * parse time, before the template runs, so fences are order-independent —
 * template code may reference data declared anywhere, even below it.
 *
 * @param {string} body raw template body
 * @returns {{ blocks: object[], template: string }}
 */
function extractDataBlocks(body) {
  const tree = fenceParser.parse(body);
  const blocks = [];
  const drop = new Set();

  for (const node of codeNodes(tree)) {
    // `lang` is the info string's first word; extra words (```data foo) keep
    // the fence as display content, matching the previous whole-info match.
    if ((node.lang ?? '').toLowerCase() !== 'data' || node.meta) continue;
    const parsed = node.value.trim() === '' ? undefined : loadYaml(node.value);
    if (parsed != null) {
      if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('mdy: a ```data fence must contain a YAML mapping');
      }
      blocks.push(parsed);
    }
    const pos = node.position;
    if (pos) for (let i = pos.start.line - 1; i < pos.end.line; i++) drop.add(i);
  }

  if (drop.size === 0) return { blocks, template: body };
  const lines = body.split('\n');
  return { blocks, template: lines.filter((_, i) => !drop.has(i)).join('\n') };
}

/**
 * Split a source file into per-document chunks on bare `---` separator lines.
 *
 * Text before the first `---`, between any two, and after the last is each a
 * document; a source with no `---` line is a single document. Whitespace-only
 * documents are dropped, so a leading/trailing `---`, or two `---` in a row,
 * contribute nothing.
 *
 * The returned chunks are the raw document text (front matter not yet split
 * out). A single source yields its own documents; see parseDocuments for the
 * combined multi-source form.
 *
 * @param {string} source
 * @returns {string[]} document chunks, in order
 */
export function splitDocuments(source) {
  const docs = [];
  let current = [];
  for (const line of source.split('\n')) {
    if (DOCUMENT_SEPARATOR.test(line)) {
      docs.push(current.join('\n'));
      current = [];
    } else {
      current.push(line);
    }
  }
  docs.push(current.join('\n'));
  const kept = docs.filter((doc) => doc.trim() !== '');
  // The whitespace filter drops blank chunks BETWEEN separators; when
  // nothing at all survives (an empty or all-whitespace source), the
  // source is ONE empty document, not zero documents — an empty file
  // renders to nothing instead of erroring on "no document at index 0".
  return kept.length > 0 ? kept : [''];
}

/**
 * Split one document chunk into its YAML front matter data and markdown body.
 *
 * The YAML runs from the start of the document to the first bare `+++` line;
 * everything after `+++` is the body, verbatim (it is plain markdown, so any
 * number of blank lines is fine). A document with no `+++` line is all body and
 * has no front matter. Front matter must be a YAML mapping (nest to group
 * values); an empty front matter block is allowed and yields no data.
 *
 * The body's ```data fences (see extractDataBlocks) merge into the data —
 * shallowly, later keys win: front matter first, then each fence in document
 * order. `tags` is special-cased as a union: declared tags (front matter,
 * then fences) plus inline hashtags (see extractTags), lowercased and
 * deduped. The key is only added when the document has tags (or declares
 * `tags:` somewhere), so an untagged document's data is untouched.
 *
 * @param {string} chunk
 * @returns {{ data: object, content: string }}
 */
function parseDocument(chunk) {
  const lines = chunk.split('\n');
  const sep = lines.findIndex((line) => FRONT_MATTER_SEPARATOR.test(line));

  let frontMatter = {};
  let content = chunk;
  if (sep !== -1) {
    const yamlText = lines.slice(0, sep).join('\n');
    content = lines.slice(sep + 1).join('\n');
    const loaded = yamlText.trim() === '' ? {} : loadYaml(yamlText);
    frontMatter = loaded ?? {};
    if (typeof frontMatter !== 'object' || Array.isArray(frontMatter)) {
      throw new Error('mdy: front matter must be a YAML mapping');
    }
  }

  const { blocks, template } = extractDataBlocks(content);
  content = template;

  const parts = [frontMatter, ...blocks];
  const data = Object.assign({}, ...parts);

  const declared = parts.flatMap((p) => declaredTags(p.tags));
  const tags = uniqueTags([...declared, ...extractTags(content)]);
  if (tags.length > 0 || parts.some((p) => 'tags' in p)) data.tags = tags;
  return { data, content };
}

/**
 * Parse a source file into its documents: front matter data + markdown body.
 *
 * An array of sources is parsed as ONE document set: each source is split
 * individually and the documents are concatenated in order, so a template
 * file and separate data files can address each other through `$` exactly
 * as if they lived in a single file.
 *
 * A source may be a plain string or `{ text, meta }`. `meta` is a mapping
 * merged into the data of every document the source contains, AFTER front
 * matter and ```data fences — it is source-level identity (which file a
 * document came from, fields computed from that file's path), so documents
 * cannot override it from the inside.
 *
 * @param {string | { text: string, meta?: object } | (string | { text: string, meta?: object })[]} source
 * @returns {{ data: object, content: string }[]}
 */
export function parseDocuments(source) {
  const sources = Array.isArray(source) ? source : [source];
  let index = 0;
  return sources.flatMap((s) => {
    const { text, meta } = typeof s === 'string' ? { text: s } : s;
    if (typeof text !== 'string') {
      throw new Error('mdy: a source must be a string or { text, meta }');
    }
    if (meta !== undefined && (typeof meta !== 'object' || meta === null || Array.isArray(meta))) {
      throw new Error('mdy: source `meta` must be a mapping');
    }
    return splitDocuments(text).map((chunk) => {
      const i = index++;
      try {
        const doc = parseDocument(chunk);
        return meta ? { ...doc, data: { ...doc.data, ...meta } } : doc;
      } catch (err) {
        const detail = String(err.message).replace(/^mdy:\s*/, '');
        throw new Error(`mdy: document ${i}: ${detail}`);
      }
    });
  });
}

// A native name becomes a $.<name>(...) passthrough in the generated
// program (see buildProgram) — it has to be a safe JS identifier, since
// it's spliced directly into that program's source text.
const VALID_NATIVE_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Assemble one self-contained VM program for a render.
 *
 * The program is an IIFE (nothing leaks into the engine's persistent scope)
 * that binds the context keys as identifiers, defines the `$` helper, runs
 * the compiled template statements, and returns a one-line JSON envelope as
 * its completion value: { out: "…" } on success, { tree: {…} } when the
 * document ended in tree form (see below), { error: "…" } if the template
 * threw.
 *
 * Tree form — the epilogue after the template statements:
 *
 *   `$.transform = (tree) => …`  a template may install a transform; the
 *   epilogue parses the generated markdown to mdast and runs it IN the VM
 *   (the function never crosses the boundary, only the JSON tree does). The
 *   unified transformer convention applies: return a node, or mutate in
 *   place and return nothing.
 *
 *   `{{ $.toc() }}`  (no argument) drops a block-level placeholder into the
 *   output; the epilogue replaces it — in the FINAL tree, after any
 *   transform — with a nested link list of the document's own headings, so
 *   a TOC at the top sees headings generated below it. Anchors match the
 *   heading ids createProcessor's HTML emits. With an argument,
 *   `$.toc(markdownOrTree)` is instead a host call returning plain
 *   [{ depth, text, slug }] entries for the template to render itself.
 *
 * Either way the envelope carries the tree, not re-stringified markdown —
 * the host feeds it straight into the HTML half of the pipeline (see
 * createProcessor's renderTree), or stringifies it only where markdown text
 * is genuinely needed (a nested $.render embedding, renderToMarkdown).
 *
 * The IIFE is `async` and awaited at the program's top level (the engine
 * resolves top-level await into the completion value) — so `await` is legal
 * anywhere in template code. The one thing that genuinely needs it is
 * dynamic `import()` of a JS module (see buildDocumentSet's
 * `options.loadModule`): a real ES `import` statement stays impossible here
 * (function body, not module top level — see docs/site-plan.md), but the
 * expression form works anywhere, and the module registry it populates
 * lives host-side of the template's own scope.
 *
 * `$` methods that need the host (find / findOne / render / emit /
 * parse / stringify / table, and any `extraNativeNames`) call the engine's
 * `__hostcall` native: the VM
 * execution suspends while the host's async native runs (the nisaba query,
 * a nested render, an emitted output, or an embedder-supplied native — see
 * buildDocumentSet's `options.natives`), then resumes with the result — a
 * synchronous-looking call from the template's point of view.
 * `$.documents` / `$.count` / `$.data` are preloaded — no host round-trip.
 *
 * `$.emit(path, content)` is the generic "produce a named output" native —
 * see buildDocumentSet's `options.onEmit` doc comment for the whole
 * rationale. It's fixed/always-present, the same tier as find/findOne/
 * render, not part of `extraNativeNames` — every mdy-docs consumer gets it
 * for free, not just ones that opt into embedder-specific natives.
 *
 * `$.parse(markdown)` / `$.stringify(tree)` are the same fixed tier:
 * markdown ⇄ mdast, in the exact dialect the render pipeline speaks
 * (remark-parse + remark-gfm). mdast is plain JSON, so trees cross the VM
 * boundary like any other native's args — a template can walk another
 * document's rendered output (`$.parse($.render(target))`), build a TOC
 * from its headings, or assemble a tree and stringify it back, all in
 * ordinary template JS with no host access beyond these two calls.
 *
 * `$.table(rows, align?)` is a convenience over that same stringifier: a 2-D
 * array (first row = header) becomes a GFM table via remark-gfm's own
 * serializer (the `markdown-table` package underneath), so padding,
 * alignment, and pipe-escaping match what the pipeline itself would emit.
 *
 * `extraNativeNames` gets a generic `(...args) => __call(name, args)`
 * passthrough per name — mdy itself has no opinion on what these do (that's
 * entirely the embedder-supplied native function's business), it only
 * wires the guest-side call shape.
 */
function buildProgram({ body, selfData, ctx, documents, extraNativeNames = [] }) {
  for (const name of extraNativeNames) {
    if (!VALID_NATIVE_NAME.test(name)) {
      throw new Error(`mdy: invalid native name ${JSON.stringify(name)} (must be a valid identifier)`);
    }
  }
  const extraNativeLines = extraNativeNames
    .map((name) => `  ${name}: (...args) => __call(${JSON.stringify(name)}, args),`)
    .join('\n');
  return `await (async () => {
const self = ${jsonForEval(selfData)};
const arg = ${jsonForEval(ctx)};
const __call = (method, args) => JSON.parse(__hostcall(method, JSON.stringify(args)));
const $ = {
  documents: ${jsonForEval(documents)},
  count: ${documents.length},
  data: (i) => { const m = $.documents.filter((d) => d.index === i)[0]; return m ? m.data : undefined; },
  find: (q) => __call("find", [q === undefined ? {} : q]),
  findOne: (q) => __call("findOne", [q === undefined ? {} : q]),
  withTag: (t) => __call("find", [{ tags: String(t).toLowerCase() }]),
  render: (target, data) => __call("render", [target, data === undefined ? {} : data]),
  emit: (path, content) => __call("emit", [path, content]),
  parse: (markdown) => __call("parse", [markdown]),
  stringify: (tree) => __call("stringify", [tree]),
  table: (rows, align) => __call("table", [rows, align === undefined ? null : align]),
  toc: (target) => target === undefined ? ${jsonForEval(TOC_MARKER)} : __call("toc", [target]),
${extraNativeLines}
};
let __done = null;
let __tree = null;
let __err = null;
try {
${body}
__done = __out;
if (typeof $.transform === "function" || __done.indexOf(${jsonForEval(TOC_MARKER)}) !== -1) {
  __tree = $.parse(__done);
  if (typeof $.transform === "function") {
    const returned = $.transform(__tree);
    if (returned !== undefined && returned !== null) __tree = returned;
    if (__tree === null || typeof __tree !== "object" || typeof __tree.type !== "string") {
      throw "$.transform must return an mdast node ({ type, ... }), or undefined after mutating in place";
    }
  }
  if (__done.indexOf(${jsonForEval(TOC_MARKER)}) !== -1) {
    const entries = __call("toc", [__tree]);
    let items = [];
    if (entries.length > 0) {
      let min = 6;
      for (const e of entries) if (e.depth < min) min = e.depth;
      const lines = [];
      for (const e of entries) {
        let indent = "";
        for (let d = e.depth - min; d > 0; d--) indent += "  ";
        lines.push(indent + "- [" + e.text + "](#" + e.slug + ")");
      }
      items = $.parse(lines.join("\\n")).children;
    }
    const splice = (node) => {
      if (!node.children) return;
      for (let i = node.children.length - 1; i >= 0; i--) {
        const child = node.children[i];
        if (child.type === "html" && child.value.trim() === ${jsonForEval(TOC_MARKER)}) {
          node.children = node.children.slice(0, i).concat(items).concat(node.children.slice(i + 1));
        } else {
          splice(child);
        }
      }
    };
    splice(__tree);
  }
}
} catch (e) { __err = "" + e; }
return JSON.stringify(__err !== null ? { error: __err } : __tree !== null ? { tree: __tree } : { out: __done });
})()`;
}

/**
 * Compile a source (or array of sources) into a runnable document set backed
 * by a nisaba database: every document's data is inserted into an in-memory
 * collection, `$.find`/`$.findOne` run real MongoDB-style queries against it,
 * and `$.render` can select its target document by query. Templates execute
 * inside the lamassu VM (see buildProgram / src/vm.js).
 *
 * Query results are returned in document order (an insertedId → index map
 * both restores deterministic ordering and lets a query hit map back to its
 * compiled template for `$.render`).
 *
 * `options.onQuery({ query, docIndex })`, if given, fires for every query
 * this set ever runs — `$.find`/`$.findOne`/`$.withTag`/`$.render`-by-query
 * from inside a template (`docIndex`: the index of the document currently
 * rendering), and `find`/`findOne`/`render`-by-query called host-side on the
 * returned handle (`docIndex: null` — a host call isn't attributed to any
 * document's own render). This is the one chokepoint both paths share
 * (`hostFind`), so one hook sees every query in the set regardless of who
 * asked — an embedder building an incremental cache (which document's
 * output actually depends on which query, to know what to re-render when
 * content changes without a matching template edit) needs exactly this;
 * mdy itself has no opinion on what to do with the record.
 *
 * `options.natives` — extra `{ name: (...args) => value | Promise<value> }`
 * entries, merged alongside find/findOne/render into every render's host
 * natives AND wired as `$.<name>(...)` in the generated program (see
 * buildProgram). Lets an embedder extend what a template can call out to
 * (edubba: an image-resize native) without mdy needing any opinion on what
 * that native does — same "generic hook, no baked-in policy" shape as
 * onQuery. Args/return value cross the VM boundary JSON-serialized, same as
 * find/findOne/render. Each extra native is called with `(docIndex,
 * docData)` appended after the template's own args — which document is
 * currently rendering, and its data (including `path`, for a native whose
 * behavior depends on which file is calling, e.g. resolving an import
 * relative to the declaring file) — ignorable by any native that doesn't
 * need it.
 *
 * `options.onEmit({ path, content, docIndex })` fires for every
 * `$.emit(path, content)` a template calls — a FIXED native (unlike
 * `options.natives`' embedder-defined ones), because "produce a named
 * output as a side effect of rendering" is generic to any mdy-docs
 * consumer, not specific to one (a static site generator emitting pages;
 * a notes exporter emitting files; anything that renders one document but
 * needs to produce several). mdy has no opinion on what "producing" an
 * output means — collecting it in memory, writing it to disk, ignoring it
 * — that's entirely `onEmit`'s business, same as onQuery/natives. `content`
 * crosses the VM boundary JSON-serialized like any native's args, so it's
 * naturally text/JSON-shaped, not binary — a consumer needing binary
 * output (edubba's image resize) computes it entirely host-side instead,
 * via `options.natives`, and never round-trips bytes through the VM at
 * all. Without the option, `$.emit` is a harmless no-op — nothing breaks
 * for a consumer that doesn't care about it.
 *
 * `options.loadModule(specifier, referrer, docIndex, docData)` enables
 * guest-side dynamic `import()`: template code may `await import("…")` a
 * real ES module, and every module in the resulting graph — the imported
 * one and anything it imports in turn — is fetched through this function
 * (return the module's source text; may be async). `referrer` is the
 * importing module's canonical specifier, or "" when the import came from
 * template code itself; `(docIndex, docData)` are appended the same way
 * they are for `options.natives`, since resolving a template's own import
 * usually depends on which file is asking (see src/site/imports.js for the
 * vault-backed implementation). `options.canonicalizeModule` (same
 * signature, synchronous) maps a raw specifier to the module's registry
 * identity first — the loader receives canonical specifiers only. Without
 * `loadModule`, a guest `import()` rejects: no loader, no filesystem reach.
 *
 * @param {string | string[]} source
 * @param {{
 *   onQuery?: (info: { query: object, docIndex: number | null }) => void,
 *   onEmit?: (info: { path: string, content: any, docIndex: number | null }) => void,
 *   natives?: Record<string, (...args: any[]) => any>,
 *   loadModule?: (specifier: string, referrer: string, docIndex: number, docData: object) => string | Promise<string>,
 *   canonicalizeModule?: (specifier: string, referrer: string, docIndex: number, docData: object) => string,
 * }} [options]
 * @returns {Promise<{ docs: { index: number, data: object }[], runDoc: Function }>}
 */
async function buildDocumentSet(source, options = {}) {
  const { onQuery, onEmit, natives: extraNatives = {}, loadModule, canonicalizeModule } = options;
  const extraNativeNames = Object.keys(extraNatives);
  const docs = parseDocuments(source).map(({ data, content }, index) => {
    return { index, data, body: compileTemplateSource(content) };
  });
  const documents = docs.map(({ index, data }) => ({ index, data }));

  const db = await connect(new MemoryStorageProvider());
  const collection = await db.collection('documents');
  const idToIndex = new Map();
  for (const doc of docs) {
    const { insertedId } = await collection.insertOne({ ...doc.data });
    idToIndex.set(String(insertedId), doc.index);
  }

  const hostFind = async (query) => {
    const hits = await collection.find(query ?? {}).toArray();
    return hits
      .map((d) => ({ d, i: idToIndex.get(String(d._id)) }))
      .sort((a, b) => a.i - b.i)
      .map(({ d }) => d);
  };

  // Every query this set ever runs passes through here, tagged with which
  // document's render (if any) it belongs to — see buildDocumentSet's
  // onQuery doc above.
  const trackedFind = (query, docIndex) => {
    onQuery?.({ query: query ?? {}, docIndex });
    return hostFind(query);
  };

  // A render target is a document index; a document REFERENCE — a
  // $.find/$.findOne result, carrying the store's _id, resolved by identity
  // with no re-query (so `$.render($.findOne({...}), data)` renders exactly
  // the document the template already holds); or a query whose first hit
  // (in document order) is the target. A string _id the set doesn't know is
  // an error rather than a query fallback — the caller clearly held a
  // reference, just not to a document of this set. `null` gets its own
  // message because a missed $.findOne is the obvious way to produce it.
  const resolveIndex = async (target, docIndex) => {
    if (typeof target === 'number') return target;
    if (target === null || target === undefined) {
      throw new Error('mdy: render: target is null/undefined (a $.findOne with no match?)');
    }
    if (typeof target._id === 'string') {
      const index = idToIndex.get(target._id);
      if (index === undefined) {
        throw new Error(`mdy: render: _id ${JSON.stringify(target._id)} is not a document of this set`);
      }
      return index;
    }
    const hit = (await trackedFind(target, docIndex))[0];
    if (!hit) {
      throw new Error(`mdy: render: no document matches ${JSON.stringify(target)}`);
    }
    return idToIndex.get(String(hit._id));
  };

  const runDoc = async (i, ctx, depth) => {
    if (depth > MAX_RENDER_DEPTH) {
      throw new Error('mdy: render depth exceeded (cyclic $.render?)');
    }
    const doc = docs[i];
    if (!doc) throw new Error(`mdy: no document at index ${i}`);

    // The `$` host natives for this render. Each may be async — the VM
    // suspends at the guest's __hostcall until it settles. A nested $.render
    // recurses into runDoc, which runs on its OWN pooled VM instance (a
    // suspended instance cannot be re-entered).
    const natives = {
      find: (query) => trackedFind(query, i),
      findOne: async (query) => (await trackedFind(query, i))[0] ?? null,
      render: async (target, data) =>
        embedMarkdown(await runDoc(await resolveIndex(target, i), data ?? {}, depth + 1)),
      emit: (path, content) => {
        onEmit?.({ path, content, docIndex: i });
        return null;
      },
      // markdown ⇄ mdast, the same dialect the render pipeline speaks. Pure
      // functions of their input — no document identity, no set state.
      parse: (markdown) => mdastParser.parse(String(markdown ?? '')),
      stringify: (tree) => {
        if (tree === null || typeof tree !== 'object' || typeof tree.type !== 'string') {
          throw new Error('mdy: $.stringify expects an mdast node ({ type, … })');
        }
        return mdastStringifier.stringify(tree);
      },
      table: (rows, align) => {
        if (!Array.isArray(rows) || rows.some((row) => !Array.isArray(row))) {
          throw new Error('mdy: $.table expects an array of row arrays (first row is the header)');
        }
        if (rows.length === 0) return '';
        return mdastStringifier.stringify({
          type: 'table',
          align: tableAlign(align),
          children: rows.map((row) => ({
            type: 'tableRow',
            children: row.map((cell) => ({ type: 'tableCell', children: tableCellChildren(cell) })),
          })),
        });
      },
      toc: (target) => {
        const tree = typeof target === 'string' ? mdastParser.parse(target) : target;
        if (tree === null || typeof tree !== 'object' || typeof tree.type !== 'string') {
          throw new Error('mdy: $.toc expects markdown text or an mdast node');
        }
        return tocEntries(tree);
      },
      // Every extra native gets (docIndex, docData) appended after whatever
      // args the template itself passed — a generic "which document is
      // calling" hook, not specific to any one native. edubba's import
      // mechanism (src/site/imports.js) is the reason this exists: an
      // imported package is resolved relative to the FILE that declared the
      // import, so its native needs to know which document's data.path that
      // was; a plain object native (resize, tokenize, …) just ignores the
      // extra args, same as any JS function ignoring trailing arguments.
      ...Object.fromEntries(
        Object.entries(extraNatives).map(([name, fn]) => [name, (...args) => fn(...args, i, doc.data)])
      ),
    };

    // Same "(docIndex, docData) appended" contract as the extra natives: a
    // loader resolving a template's own import needs to know which file is
    // asking; module-to-module imports carry that in `referrer` instead.
    const moduleOptions = loadModule
      ? {
          loadModule: (specifier, referrer) => loadModule(specifier, referrer, i, doc.data),
          canonicalizeModule: canonicalizeModule
            ? (specifier, referrer) => canonicalizeModule(specifier, referrer, i, doc.data)
            : undefined,
        }
      : undefined;

    // Two data bindings, never merged: `self` is the document's OWN parsed
    // data (front matter + data fences), `arg` is exactly what the caller
    // passed ({} when nothing was) — so a template can tell its declared
    // data from its input, and defaulting is the template's own explicit
    // `arg.x ?? self.x`. Missing keys are graceful by construction:
    // property access never throws for an absent key. A bare identifier the
    // template never declared is a genuine template error and surfaces as
    // one.
    const program = buildProgram({
      body: doc.body,
      selfData: doc.data,
      ctx,
      documents,
      extraNativeNames,
    });
    const reply = await runProgram(program, natives, moduleOptions);
    let envelope;
    try {
      envelope = JSON.parse(reply);
    } catch {
      throw new Error(`mdy: unexpected engine reply: ${reply}`);
    }
    if (envelope.error !== undefined) {
      throw new Error(`mdy: template error in document ${i}: ${envelope.error}`);
    }
    // Two completion shapes (see buildProgram): plain markdown, or — when
    // the document installed a $.transform or used a no-arg $.toc() — the
    // final mdast tree, kept AS a tree so the HTML path never
    // re-stringifies it.
    return envelope.tree !== undefined
      ? { markdown: null, tree: envelope.tree }
      : { markdown: envelope.out, tree: null };
  };

  // Text of a render result for EMBEDDING into another template's output (a
  // nested $.render): byte-exact for string-form documents — a template may
  // legitimately produce non-markdown text this way (the blog example's
  // RSS / robots.txt layouts, emitted verbatim) — while tree-form documents
  // ($.transform / no-arg $.toc()) serialize through remark-stringify, the
  // only text they can have.
  const embedMarkdown = (result) =>
    result.tree !== null ? mdastStringifier.stringify(result.tree) : result.markdown;

  // Markdown text at the PUBLIC markdown boundary (openDocumentSet's render,
  // and renderToMarkdown / renderEach / the CLI's markdown output on top of
  // it): ALWAYS emitted through remark-stringify — string-form output is
  // parsed and re-serialized — so the markdown these APIs return is one
  // consistent dialect regardless of how any document produced its text. The
  // byte-exact template output stays reachable via renderResult().markdown.
  const resultMarkdown = (result) =>
    mdastStringifier.stringify(result.tree !== null ? result.tree : mdastParser.parse(result.markdown));

  return { docs: documents, runDoc, embedMarkdown, resultMarkdown, hostFind, resolveIndex, trackedFind };
}

/**
 * Open a source (or array of sources) as a long-lived document-set handle:
 * parse, compile, and insert into nisaba ONCE, then query and render against
 * the set repeatedly. This is the embedder-facing form of the machinery
 * behind renderDocumentSet — use it when many renders share one set (a
 * static site build rendering every page, a notes app rendering on demand).
 *
 * The handle:
 *
 *   docs                 [{ index, data }, …] in document order
 *   find(query)          matching documents' data, in document order —
 *                        host-side, same semantics as the in-template $.find
 *   findOne(query)       first match or null
 *   render(target, ctx)  render the document at index `target`, the exact
 *                        document of a find/findOne result `target`
 *                        (resolved by its _id, no re-query), or the first
 *                        one matching query `target`, with `ctx` as the
 *                        template's `arg` (its own data stays separate, as
 *                        `self`) → generated markdown. ALWAYS emitted
 *                        through remark-stringify (the template's output is
 *                        parsed and re-serialized), so formatting is one
 *                        consistent dialect whether the document ended as a
 *                        string or a tree ($.transform / no-arg $.toc())
 *   renderRaw(target, ctx)  same render, embedding semantics: byte-exact
 *                        template output for string-form documents (which may
 *                        deliberately not be markdown — RSS, robots.txt),
 *                        tree-form serialized. What the in-set $.render (and
 *                        a cross-package import's .render) returns
 *   renderResult(target, ctx)  same render, but the raw completion shape:
 *                        { markdown, tree } with exactly one non-null —
 *                        `markdown` is the template's byte-exact output (no
 *                        normalization), `tree` the final mdast when the
 *                        document ended in tree form. createProcessor's HTML
 *                        path uses this to feed the tree straight into
 *                        rehype, never re-stringifying
 *
 * Sources may carry identity (`{ text, meta }`, see parseDocuments), so
 * `find` can route on file-level fields and rendered documents know where
 * they came from. Everything the handle holds is in memory; there is nothing
 * to close — drop the handle when done.
 *
 * `options.onQuery` — see buildDocumentSet's doc comment; fires for every
 * query anywhere in the set, template-level or host-level (this handle's
 * own find/findOne/render-by-query calls, tagged `docIndex: null`).
 *
 * `options.natives` — see buildDocumentSet's doc comment; extra functions
 * exposed to every template in the set as `$.<name>(...)`.
 *
 * `options.onEmit` — see buildDocumentSet's doc comment; fires for every
 * `$.emit(path, content)` a template calls — template-level only, there is
 * no host-level equivalent (there's no "current render" to emit alongside
 * when the host calls in from outside one).
 *
 * `options.loadModule` / `options.canonicalizeModule` — see
 * buildDocumentSet's doc comment; enable guest-side `await import("…")` of
 * real ES modules, sourced entirely through the embedder's loader.
 *
 * @param {string | { text: string, meta?: object } | (string | { text: string, meta?: object })[]} source
 * @param {{
 *   onQuery?: (info: { query: object, docIndex: number | null }) => void,
 *   onEmit?: (info: { path: string, content: any, docIndex: number | null }) => void,
 *   natives?: Record<string, (...args: any[]) => any>,
 * }} [options]
 * @returns {Promise<{
 *   docs: { index: number, data: object }[],
 *   find: (query?: object) => Promise<object[]>,
 *   findOne: (query?: object) => Promise<object | null>,
 *   render: (target: number | object, ctx?: object) => Promise<string>,
 *   renderRaw: (target: number | object, ctx?: object) => Promise<string>,
 *   renderResult: (target: number | object, ctx?: object) => Promise<{ markdown: string | null, tree: object | null }>,
 * }>}
 */
export async function openDocumentSet(source, options = {}) {
  const { docs, runDoc, embedMarkdown, resultMarkdown, resolveIndex, trackedFind } = await buildDocumentSet(source, options);
  const renderResult = async (target, ctx = {}) => runDoc(await resolveIndex(target, null), ctx, 0);
  return {
    docs,
    find: (query) => trackedFind(query, null),
    findOne: async (query) => (await trackedFind(query, null))[0] ?? null,
    render: async (target, ctx = {}) => resultMarkdown(await renderResult(target, ctx)),
    renderRaw: async (target, ctx = {}) => embedMarkdown(await renderResult(target, ctx)),
    renderResult,
  };
}

/**
 * Process a multi-document source and render the entry document (index `entry`,
 * default 0) to markdown. Every document is a standard mdy unit (front matter
 * + template body). An array of sources forms one combined set (see
 * parseDocuments). The set's data lives in a nisaba collection; templates
 * receive a `$` helper that queries it MongoDB-style:
 *
 *   $.find(query)          data of the documents matching `query`, in
 *                          document order (full Mongo operator support)
 *   $.findOne(query)       first match or null
 *   $.render(target, data) run the document matching `target` (a query, or an
 *                          index) with `data` overriding its own, → markdown
 *   $.withTag(tag)         shorthand for $.find({ tags: tag })
 *   $.data(i)              document i's data (positional)
 *   $.documents            [{ index, data }, …] (positional)
 *   $.count                number of documents
 *   $.parse(markdown)      markdown → mdast syntax tree (plain JSON)
 *   $.stringify(tree)      mdast syntax tree → markdown
 *   $.toc()                (no argument) placeholder replaced at end of
 *                          render with a link list of THIS document's final
 *                          headings; $.toc(markdownOrTree) instead returns
 *                          [{ depth, text, slug }] entries to render manually
 *   $.transform = fn       install (tree) => tree | undefined, run on the
 *                          document's final mdast before output (see
 *                          buildProgram)
 *
 * One-shot: the set is built, one document renders, the set is dropped. To
 * render many pages from one set, use openDocumentSet.
 *
 * @param {string | string[]} source
 * @param {object} [extraContext] extra context for the entry document
 * @param {number} [entry] index of the document to render (default 0)
 * @returns {Promise<string>} generated markdown
 */
export async function renderDocumentSet(source, extraContext = {}, entry = 0) {
  const set = await openDocumentSet(source);
  return set.render(entry, extraContext);
}

/**
 * Apply the entry document's template to every OTHER document in the set,
 * one render per data document. Each data document's front matter (merged
 * with `extraContext`, which wins) arrives as the template's `arg`; the
 * entry's own front matter is its `self`, so sample-data defaults are the
 * template's explicit `arg.x ?? self.x`. With no other documents the entry
 * renders once with an empty `arg`, so a template file written that way
 * still works standalone.
 *
 * This is the mail-merge companion to renderDocumentSet: keep a display
 * template in one file, data records in others, and pass them together:
 *
 *   renderEach([templateSource, dataSource])  // → one markdown string per record
 *
 * @param {string | string[]} source
 * @param {object} [extraContext] extra context for every render
 * @param {number} [entry] index of the template document (default 0)
 * @returns {Promise<string[]>} generated markdown, one entry per data document
 */
export async function renderEach(source, extraContext = {}, entry = 0) {
  const set = await openDocumentSet(source);
  if (!set.docs[entry]) throw new Error(`mdy: no document at index ${entry}`);
  const others = set.docs.filter((d) => d.index !== entry);
  if (others.length === 0) return [await set.render(entry, extraContext)];
  const out = [];
  for (const d of others) {
    out.push(await set.render(entry, { ...d.data, ...extraContext }));
  }
  return out;
}

// Default rehype plugin: give every heading a GitHub-style id, computed with
// the SAME slugger (and dedupe order) as the $.toc native's entries — that
// shared algorithm is what makes a template-built TOC's `#anchors` land on
// the rendered headings. Runs after rehype-raw, so raw `<h2>` headings get
// ids too. Headings that already carry an id keep it.
const rehypeHeadingIds = () => (tree) => {
  const seen = new Map();
  const visit = (node) => {
    if (/^h[1-6]$/.test(node.tagName ?? '')) {
      node.properties ??= {};
      if (node.properties.id === undefined) {
        node.properties.id = uniqueSlug(slugifyHeading(textContent(node)), seen);
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
};

/**
 * Create a processor bound to a configured unified (remark → rehype) pipeline.
 *
 * The base chain is remark-parse → remark-gfm → github alerts →
 * remark-rehype → rehype-raw → heading ids → rehype-stringify: GFM covers
 * the old `linkify` behavior (autolink literals, plus tables/strikethrough
 * templates commonly generate), `> [!NOTE]`-style blockquotes become
 * GitHub alert boxes (`.markdown-alert-*` markup, an HTML-side transform
 * only — $.parse still sees them as plain blockquotes), rehype-raw
 * preserves raw HTML in documents (the old `html: true`), and every heading
 * gets a GitHub-style `id` so `$.toc()` links (or any deep link) land.
 *
 * @param {object} [options]
 * @param {Array} [options.remarkPlugins] plugins run on the markdown (mdast)
 *   side, before the tree converts to HTML — each a plugin or
 *   `[plugin, options]` tuple
 * @param {Array} [options.rehypePlugins] plugins run on the HTML (hast) side,
 *   after raw HTML is reparsed — e.g. a syntax highlighter
 * @returns {{ processor: object, renderMarkdown: Function, renderTree: Function, renderToMarkdown: Function, render: Function }}
 */
export function createProcessor(options = {}) {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkAlert)
    .use(options.remarkPlugins ?? [])
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeHeadingIds)
    .use(options.rehypePlugins ?? [])
    .use(rehypeStringify);

  /** Markdown string → HTML string (no template layer — just the pipeline). */
  const renderMarkdown = async (markdown) => String(await processor.process(markdown));

  /** mdast tree → HTML string — the parse step skipped, the transformers and
   * compiler applied as usual. This is where a document that ended in tree
   * form ($.transform / no-arg $.toc()) becomes HTML with no intermediate
   * re-stringification to markdown. */
  const renderTree = async (tree) => String(processor.stringify(await processor.run(tree)));

  /** Document source(s) → generated markdown string (front matter extracted + templates run). */
  const renderToMarkdown = (source, extraContext = {}, entry = 0) =>
    renderDocumentSet(source, extraContext, entry);

  /** Document source(s) → final HTML. */
  const render = async (source, extraContext = {}, entry = 0) => {
    const set = await openDocumentSet(source);
    const { markdown, tree } = await set.renderResult(entry, extraContext);
    return tree !== null ? renderTree(tree) : renderMarkdown(markdown);
  };

  return { processor, renderMarkdown, renderTree, renderToMarkdown, render };
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
