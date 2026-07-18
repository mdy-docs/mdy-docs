import MarkdownIt from 'markdown-it';
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
 *                          shares a single scope. The function is run with the
 *                          front matter data as its context, producing a
 *                          markdown string that is finally rendered to HTML.
 *
 * Template syntax:
 *   {{ expr }}    append the expression's value to the output
 *   {% code %}    run statements, append nothing (loops, if, let, …)
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
 * The statements reference the document's data as bare identifiers; the
 * embedder binds them first (see contextBindings) — there is no `with`, so
 * only data keys that are valid identifiers become bindings.
 *
 * @param {string} template
 * @returns {string} JavaScript statements
 */
export function compileTemplateSource(template) {
  let code = 'let __out = "";\n';
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

// Names that must not become context bindings: JS reserved words, globals the
// generated program itself relies on (shadowing JSON/String would break the
// protocol tail and the $ helpers), and the program's own internals.
const NO_BIND = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'finally', 'for',
  'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'return',
  'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while',
  'with', 'yield', 'await', 'static', 'implements', 'interface', 'package',
  'private', 'protected', 'public', 'null', 'true', 'false', 'undefined',
  'arguments', 'eval', 'NaN', 'Infinity',
  'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'Date',
  'RegExp', 'print',
  '$', '__ctx', '__out', '__call', '__hostcall', '__err', '__done',
]);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * `let` bindings exposing a context object's keys as bare identifiers, for
 * prepending to compiled template statements. Keys that aren't valid
 * identifiers (or would shadow the program's own names) are skipped — they
 * stay reachable as `__ctx["the key"]`.
 * @param {object} context
 * @returns {string} JavaScript statements
 */
export function contextBindings(context) {
  return Object.keys(context)
    .filter((k) => IDENTIFIER.test(k) && !NO_BIND.has(k))
    .map((k) => `let ${k} = __ctx[${jsonForEval(k)}];`)
    .join('\n');
}

/**
 * Compile a template string into `(context) => markdownString`, executed in
 * the HOST runtime via `new Function`. This is a debug/inspection path — it
 * is NOT sandboxed. Rendering documents through render / renderToMarkdown /
 * renderDocumentSet runs the same compiled statements inside the lamassu VM.
 * The generated statements are available as `.source`.
 * @param {string} template
 * @returns {(context?: object) => string}
 */
export function compileTemplate(template) {
  const body = compileTemplateSource(template);
  const generate = (context = {}) => {
    // eslint-disable-next-line no-new-func
    const fn = new Function('__ctx', `${contextBindings(context)}\n${body}\nreturn __out;`);
    return fn(context);
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

// Parser used only to LOCATE ```data fences. Using markdown-it itself (rather
// than a hand-rolled scan) inherits CommonMark's fence rules: indentation,
// `~~~` and longer fence runs, fences inside lists, and a ```data example
// shown inside a longer outer fence correctly counting as display, not data.
const fenceMd = new MarkdownIt();

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
  const tokens = fenceMd.parse(body, {});
  const blocks = [];
  const drop = new Set();

  for (const t of tokens) {
    if (t.type !== 'fence' || t.info.trim().toLowerCase() !== 'data') continue;
    const parsed = t.content.trim() === '' ? undefined : loadYaml(t.content);
    if (parsed != null) {
      if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('mdy: a ```data fence must contain a YAML mapping');
      }
      blocks.push(parsed);
    }
    if (t.map) for (let i = t.map[0]; i < t.map[1]; i++) drop.add(i);
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
  return docs.filter((doc) => doc.trim() !== '');
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
 * @param {string | string[]} source
 * @returns {{ data: object, content: string }[]}
 */
export function parseDocuments(source) {
  const sources = Array.isArray(source) ? source : [source];
  return sources.flatMap(splitDocuments).map((chunk, index) => {
    try {
      return parseDocument(chunk);
    } catch (err) {
      const detail = String(err.message).replace(/^mdy:\s*/, '');
      throw new Error(`mdy: document ${index}: ${detail}`);
    }
  });
}

/**
 * Assemble one self-contained VM program for a render.
 *
 * The program is an IIFE (nothing leaks into the engine's persistent scope)
 * that binds the context keys as identifiers, defines the `$` helper, runs
 * the compiled template statements, and returns a one-line JSON envelope as
 * its completion value: { out: "…" } on success, { error: "…" } if the
 * template threw.
 *
 * `$` methods that need the host (find / findOne / render) call the engine's
 * `__hostcall` native: the VM execution suspends while the host's async
 * native runs (the nisaba query, or a nested render), then resumes with the
 * result — a synchronous-looking call from the template's point of view.
 * `$.documents` / `$.count` / `$.data` are preloaded — no host round-trip.
 */
function buildProgram({ body, ctx, documents }) {
  return `(() => {
const __ctx = ${jsonForEval(ctx)};
const __call = (method, args) => JSON.parse(__hostcall(method, JSON.stringify(args)));
const $ = {
  documents: ${jsonForEval(documents)},
  count: ${documents.length},
  data: (i) => { const m = $.documents.filter((d) => d.index === i)[0]; return m ? m.data : undefined; },
  find: (q) => __call("find", [q === undefined ? {} : q]),
  findOne: (q) => __call("findOne", [q === undefined ? {} : q]),
  withTag: (t) => __call("find", [{ tags: String(t).toLowerCase() }]),
  render: (target, data) => __call("render", [target, data === undefined ? {} : data]),
};
${contextBindings(ctx)}
let __done = null;
let __err = null;
try {
${body}
__done = __out;
} catch (e) { __err = "" + e; }
return JSON.stringify(__err !== null ? { error: __err } : { out: __done });
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
 * @param {string | string[]} source
 * @returns {Promise<{ docs: { index: number, data: object }[], runDoc: Function }>}
 */
async function buildDocumentSet(source) {
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

  const runDoc = async (i, ctx, depth) => {
    if (depth > MAX_RENDER_DEPTH) {
      throw new Error('mdy: render depth exceeded (cyclic $.render?)');
    }
    const doc = docs[i];
    if (!doc) throw new Error(`mdy: no document at index ${i}`);
    const fullCtx = { ...doc.data, ...ctx };

    // The `$` host natives for this render. Each may be async — the VM
    // suspends at the guest's __hostcall until it settles. A nested $.render
    // recurses into runDoc, which runs on its OWN pooled VM instance (a
    // suspended instance cannot be re-entered).
    const natives = {
      find: (query) => hostFind(query),
      findOne: async (query) => (await hostFind(query))[0] ?? null,
      render: async (target, data) => {
        let index = target;
        if (typeof target !== 'number') {
          const hit = (await hostFind(target))[0];
          if (!hit) {
            throw new Error(`mdy: $.render: no document matches ${JSON.stringify(target)}`);
          }
          index = idToIndex.get(String(hit._id));
        }
        return runDoc(index, data ?? {}, depth + 1);
      },
    };

    const program = buildProgram({ body: doc.body, ctx: fullCtx, documents });
    const reply = await runProgram(program, natives);
    let envelope;
    try {
      envelope = JSON.parse(reply);
    } catch {
      throw new Error(`mdy: unexpected engine reply: ${reply}`);
    }
    if (envelope.error !== undefined) {
      throw new Error(`mdy: template error in document ${i}: ${envelope.error}`);
    }
    return envelope.out;
  };

  return { docs: documents, runDoc };
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
 *
 * @param {string | string[]} source
 * @param {object} [extraContext] extra context for the entry document
 * @param {number} [entry] index of the document to render (default 0)
 * @returns {Promise<string>} generated markdown
 */
export async function renderDocumentSet(source, extraContext = {}, entry = 0) {
  const set = await buildDocumentSet(source);
  return set.runDoc(entry, extraContext, 0);
}

/**
 * Apply the entry document's template to every OTHER document in the set,
 * one render per data document. The entry's own front matter acts as
 * defaults; each data document's front matter overrides it, and
 * `extraContext` overrides both. With no other documents the entry renders
 * once with just its own data, so a template file still works standalone.
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
  const { docs, runDoc } = await buildDocumentSet(source);
  if (!docs[entry]) throw new Error(`mdy: no document at index ${entry}`);
  const others = docs.filter((d) => d.index !== entry);
  if (others.length === 0) return [await runDoc(entry, extraContext, 0)];
  const out = [];
  for (const d of others) {
    out.push(await runDoc(entry, { ...d.data, ...extraContext }, 0));
  }
  return out;
}

/**
 * Create a processor bound to a configured markdown-it instance.
 * @param {object} [options]
 * @param {MarkdownIt} [options.md] a preconfigured markdown-it (e.g. with a highlighter)
 * @returns {{ md: MarkdownIt, renderToMarkdown: Function, render: Function }}
 */
export function createProcessor(options = {}) {
  const md = options.md ?? new MarkdownIt({ html: true, linkify: true });

  /** Document source(s) → generated markdown string (front matter extracted + templates run). */
  const renderToMarkdown = (source, extraContext = {}, entry = 0) =>
    renderDocumentSet(source, extraContext, entry);

  /** Document source(s) → final HTML. */
  const render = async (source, extraContext = {}, entry = 0) =>
    md.render(await renderToMarkdown(source, extraContext, entry));

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
