import { connect, MemoryStorageProvider } from '@mdy-docs/nisaba-db';
import rehypeStringify from 'rehype-stringify';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { parse as loadYaml } from 'yaml';

import { enterRender, exitRender, fillTokens, heldTree, hold, holdToc, splice, spliceToc } from './compose.js';
import { markdownToHast } from './markdown.js';
import { fromMdy } from './parse/block.js';
import { compileScript, scriptLines, scriptOutput } from './parse/script.js';
import { messageName, nameProblem } from './publish.js';
import { runProgram } from './vm.js';

/**
 * mdy — documents with data, a script layer, and one tree.
 *
 * A source is processed in three passes:
 *
 *   1. parseDocuments() — the source is split into documents on bare `---`
 *                         separator lines, then each document is split on its
 *                         first bare `+++` line into YAML front matter (parsed
 *                         into a data object) and an MDY body. A document with
 *                         no `+++` is all body. ```data fences in the body are
 *                         extracted as YAML and merged into the data (front
 *                         matter first, later fences win); inline #hashtags
 *                         union into data.tags.
 *
 *   2. compileTemplateSource() — the body's `%` and `%%` lines are compiled
 *                         into ONE run of JavaScript statements (mdy's own
 *                         compileScript, see src/parse/script.js), which run
 *                         inside the lamassu VM and return the lines of MDY
 *                         the document produced. Because the whole document
 *                         becomes one function body, every `{{ … }}` shares a
 *                         single scope. The statements receive the caller's
 *                         request as `req` and answer on `res`, whose `data`
 *                         is the document's own front matter.
 *
 *   3. the parser —       those lines are parsed to hast, and that is the
 *                         last change of representation there is. A `.md`
 *                         document takes the other front end (src/markdown.js)
 *                         to the same place. Nothing downstream sees markup
 *                         as text again: composition, `transform`, the TOC,
 *                         the HTML writer and the React target all work on one
 *                         kind of tree from two kinds of file.
 *
 * Script syntax (see src/parse/script.js for the whole of it):
 *   % code        one line of JavaScript; what it leaves open encloses the
 *                 markup under it, which is how a loop is written
 *   %% code       JavaScript that runs on until its brackets come back to even
 *   {{ expr }}    interpolate the expression into the line
 *   \%  \{{       a literal `%` at the start of a line, a literal `{{`
 *
 * SECURITY: compileTemplate() below runs a document's code via `new Function`
 * with full runtime access — it is a debug path. Everything that renders
 * (render / renderDocumentSet / openDocumentSet) runs the same statements
 * inside the lamassu VM instead, which is a real sandbox.
 */

/**
 * Compile a document body into the JavaScript statements that produce its
 * lines: `__out`, an array of `[sourceLine, text]` pairs, declared and filled
 * by the statements themselves.
 *
 * This is mdy's own compileScript (src/parse/script.js) with the body split
 * into lines first — the exact code both executors run, the lamassu VM (the
 * real, sandboxed path used by render*) and compileTemplate()'s host-side
 * debug path.
 *
 * The statements reference data through the two bindings the executor
 * declares first: `req` — whatever the caller is asking with — and `res`,
 * whose `data` is the document's own front matter and whose `doc` is its
 * finished tree, once there is one. Property access on an object never throws
 * for a missing key, so optional data reads as `undefined`
 * (`{{ req.age ?? res.data.age ?? 'n/a' }}`) with no machinery behind it.
 *
 * @param {string} template
 * @returns {string} JavaScript statements
 */
export function compileTemplateSource(template) {
  return compileTemplateSourceMemo(String(template));
}

const compileTemplateSourceMemo = memoize(
  (template) => compileScript(template.split('\n')).source,
  (source) => source
);

// JSON that is safe to embed directly in JavaScript source: U+2028/U+2029
// are valid in JSON strings but line terminators in (older) JS.
function jsonForEval(value) {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * Compile a document body into `(req, res) => mdyText`, executed in the HOST
 * runtime via `new Function`. This is a debug/inspection path — it is NOT
 * sandboxed. Rendering documents through render / renderDocumentSet /
 * openDocumentSet runs the same compiled statements inside the lamassu VM.
 * The two parameters mirror the real pipeline's bindings. The generated
 * statements are available as `.source`.
 *
 * @param {string} template
 * @returns {(req?: object, res?: object) => string}
 */
export function compileTemplate(template) {
  const body = compileTemplateSource(template);
  const generate = (req = {}, res = { data: {}, doc: undefined }) => {
    // eslint-disable-next-line no-new-func
    const fn = new Function('req', 'res', `${body}\nreturn __out;`);
    return scriptOutput(fn(req, res)).lines.join('\n');
  };
  generate.source = body;
  return generate;
}

// A bare `---` line: a document separator. Every such line is structural
// (use `***` or `___` for a thematic break inside a document body).
const DOCUMENT_SEPARATOR = /^---[ \t]*$/;

// A bare `+++` line: the fence that opens and closes a document's YAML front
// matter. A document set used to read this as a SEPARATOR instead — YAML
// above the first one, body below, no opening fence — which is not what the
// language says (docs/language.md §11, and extractMatter in
// src/parse/matter.js, both of which want a fenced block). The two disagreed
// in a way that failed silently one way and visibly the other: a fenced
// document in a set had no data at all, and a separator-style document put
// through the parser directly rendered its own YAML into the page as a
// paragraph. The fence wins, because it is the language.
const FRONT_MATTER_SEPARATOR = /^\+\+\+[ \t]*$/;

// A hashtag: `#` preceded by start-of-line or whitespace, then a letter, then
// letters/digits/underscores/hyphens. This excludes issue numbers (`#42` has
// no letter), URL fragments (`page#top` has no preceding whitespace), and an
// escaped `\#tag`.
const HASHTAG = /(?<=^|\s)#([\p{L}][\p{L}\p{N}_-]*)/gmu;

// Guard against a cycle of `$.render` calls rendering each other forever.
// Each nesting level holds a live VM instance while suspended (Asyncify is
// not reentrant), so this is deliberately modest.
const MAX_RENDER_DEPTH = 16;

// The options every MDY document in a set is parsed with. Sanitizing is off:
// these are the author's own files, and a site's own layout has every right
// to a `<script>` tag. Front matter and document splitting are mdy-docs' own
// job and already done by the time the parser sees a body, so both are off
// here too — the parser is handed one document's markup and nothing else.
const PARSE = {
  frontmatter: false,
  documents: false,
  script: false,
  sanitize: false,
};

/**
 * Extract inline hashtags from a document body.
 *
 * The scan runs over the RAW body — tags are static metadata about the
 * authored document, so a tag generated at render time (`#{{ topic }}`) does
 * not count, and no rendering is needed to know a document's tags. That is
 * the whole point of it, and the reason it survives mdy's own reference
 * collector rather than being replaced by it: mdy collects tags while
 * PARSING, which is after the code has run, so `res.data.tags` says what the
 * rendered document says. This says what the file says, before anything has
 * run — which is what `$.withTag` needs to answer a query without rendering
 * every document in the set to find out.
 *
 * The grammar is mdy's: `%` and `%%` lines are code and hold no prose, `{{ …
 * }}` is an interpolation, fenced code blocks and inline code spans are
 * display. Tags are lowercased and deduped, in order of first appearance,
 * without the leading `#`.
 *
 * @param {string} body raw document body
 * @returns {string[]} lowercase tag names
 */
export function extractTags(body) {
  const source = String(body).split('\n');
  const code = scriptLines(source);

  const lines = [];
  let inFence = false;
  for (const [index, line] of source.entries()) {
    if (code[index]) continue;
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (!inFence) lines.push(line);
  }
  const text = lines
    .join('\n')
    .replace(/\{\{[\s\S]*?\}\}/g, ' ')
    .replace(/`[^`\n]*`/g, ' '); // inline code spans

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
 * parse time, before a line of the document's own code runs, so fences are
 * order-independent — the code may reference data declared anywhere, even
 * below it.
 *
 * @param {string} body raw template body
 * @returns {{ blocks: object[], template: string }}
 */
// Could this body hold a ```data fence at all? A fenced block's info string
// begins immediately after its run of backticks or tildes, and `lang` is that
// string's first word — so a node with `lang === 'data'` is impossible unless
// the text literally contains a fence run followed by optional spaces and
// "data". Deliberately unanchored: a fence can open inside a blockquote or a
// nested list, where the line starts with `>` or spaces-and-a-bullet, and
// anchoring to the line start would miss those. Matching more than it must is
// free (it just means the real parse runs); matching less would silently drop
// somebody's data.
//
// This is worth a pre-test because the parse it skips is a full CommonMark
// parse of every document in the site, and most sites have no data fences at
// all: on a 10 MB corpus with none, 4.9 s of parsing to answer a question a
// 9 ms scan answers.
const MAYBE_DATA_FENCE = /(?:`{3,}|~{3,})[ \t]*data(?![\w-])/i;

function extractDataBlocks(body) {
  if (!MAYBE_DATA_FENCE.test(body)) return { blocks: [], template: body };
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

/*
 * Ingest memo. parseDocument and compileTemplateSource are pure functions of
 * their input text — front matter YAML, ```data fences, the markdown parse
 * extractTags does to find inline hashtags, and the `%`-line compile. `mdy
 * dev` walks the whole directory on every save — the entry decides what the
 * site is, so it always reruns — which without this re-parsed every file in
 * the site because one article changed. Keyed by the source text, so
 * a hit is only ever a file whose bytes did not change; a miss costs one map
 * write. Bounded, and cleared wholesale rather than evicted one at a time —
 * this is a dev-loop cache, not a working set worth managing precisely.
 *
 * parseDocument's `data` is CLONED on the way out. The cached object would
 * otherwise be handed to every caller that asked for the same text, and
 * downstream code merges identity into it and inserts it into a collection;
 * one mutation would poison every later rebuild. `content` is a string and
 * needs no such care.
 */
/*
 * A 64-bit FNV-1a in two lanes, base36. Deliberately not node:crypto — this
 * file is bundled for the browser, and hashing here has to work there too.
 * It names inputs, it does not defend against anybody choosing them.
 */
function hashString(input) {
  let a = 0x811c9dc5;
  let b = 0xc9dc5118;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x85ebca6b);
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

/*
 * The render memo: a finished render, reusable by the NEXT build.
 *
 * A render is a pure function of three things — the document's own code, its
 * own data, and the `req` it was handed — but only if it asked the host for
 * nothing else along the way. A document that queries, renders another
 * document, reads $.data, emits, publishes, or calls any embedder native has
 * reached outside those three, and its result is not ours to keep (an emit
 * skipped is an output that silently stops being produced). runDoc marks those
 * renders impure and they are never stored. What is left — layouts, and any
 * document that is only markup — is the bulk of a site's renders.
 *
 * Two generations rather than a bounded map: what a rebuild can reuse is the
 * build before it, and nothing older is worth the memory. Rotating at the
 * start of a build keeps at most two builds of trees alive, and those are the
 * same tree objects compose.js is holding anyway.
 */
let renderMemoNow = new Map();
let renderMemoPrev = new Map();

/** Start a new generation. Called at the start of each build (see build.js);
 * a caller that never calls it gets a memo that only grows within one build,
 * which is correct, just not useful. */
export function rotateRenderMemo() {
  renderMemoPrev = renderMemoNow;
  renderMemoNow = new Map();
}

const MEMO_MAX = 4096;

// Exported for src/vault.js, which memoises its own YAML parse the same way.
// Package-internal on purpose — it is not in index.js and is not API.

export function memoize(fn, revive) {
  const cache = new Map();
  return (input) => {
    if (cache.has(input)) return revive(cache.get(input));
    const value = fn(input);
    if (cache.size >= MEMO_MAX) cache.clear();
    cache.set(input, value);
    return revive(value);
  };
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
function parseDocumentUncached(chunk) {
  const lines = chunk.split('\n');

  /*
   * Front matter opens on the document's first line, give or take blank
   * ones, and it has to close. An opening fence with no partner is left
   * alone — it is likelier to be prose than a block somebody forgot to
   * finish, and guessing would swallow the rest of the document. The same
   * rule extractMatter applies, deliberately: one language, one answer.
   */
  let open = 0;
  while (open < lines.length && lines[open].trim() === '') open += 1;

  let frontMatter = {};
  let content = chunk;
  if (FRONT_MATTER_SEPARATOR.test(lines[open] ?? '')) {
    let close = open + 1;
    while (close < lines.length && !FRONT_MATTER_SEPARATOR.test(lines[close])) close += 1;

    if (close < lines.length) {
      const yamlText = lines.slice(open + 1, close).join('\n');
      content = lines.slice(close + 1).join('\n');
      const loaded = yamlText.trim() === '' ? {} : loadYaml(yamlText);
      frontMatter = loaded ?? {};
      if (typeof frontMatter !== 'object' || Array.isArray(frontMatter)) {
        throw new Error('mdy: front matter must be a YAML mapping');
      }
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

const parseDocument = memoize(parseDocumentUncached, ({ data, content }) => ({
  data: structuredClone(data),
  content,
}));

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
 * A document's `format` comes from the source's own extension: `.md` names
 * the other front end (src/markdown.js), everything else is MDY. It is the
 * only thing the format decides — front matter, data fences, hashtags,
 * identity and querying are all the same either way.
 *
 * @param {string | { text: string, meta?: object } | (string | { text: string, meta?: object })[]} source
 * @returns {{ data: object, content: string, format: 'mdy' | 'md' }[]}
 */
export function parseDocuments(source) {
  const sources = Array.isArray(source) ? source : [source];
  let index = 0;
  return sources.flatMap((s) => {
    const { text, meta } = typeof s === 'string' ? { text: s } : s;
    const format = String(meta?.ext ?? '').toLowerCase() === '.md' ? 'md' : 'mdy';
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
        return meta ? { ...doc, format, data: { ...doc.data, ...meta } } : { ...doc, format };
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

/*
 * The toolkit every document gets, written as guest source rather than bound
 * as host functions.
 *
 * mdy's own runner hands a document `visit`, `h`, `toText` and `slug` as real
 * JavaScript, because there it runs in the same process as the parser. Here it
 * does not: the document runs inside lamassu and only JSON crosses the
 * boundary, so a helper that takes a callback — which `visit` and `transform`
 * both do — cannot be a host call. They are guest code, and the same four
 * names mean the same four things in both runtimes.
 */
const TOOLKIT = `
const toText = (node) => {
  if (!node) return "";
  if (node.type === "text") return node.value;
  if (node.type === "comment" || node.type === "doctype") return "";
  let out = "";
  for (const child of node.children ?? []) out += toText(child);
  return out;
};
const slug = (label) => String(label)
  .trim()
  .toLowerCase()
  .replace(/\\s+/g, "-")
  .replace(/[^\\p{L}\\p{N}\\-\\/._#]+/gu, "");
const visit = (tree, test, visitor) => {
  const fn = visitor === undefined ? test : visitor;
  const wanted = visitor === undefined ? undefined : test;
  const matches = (node) => {
    if (wanted === undefined) return true;
    if (typeof wanted === "function") return wanted(node);
    if (typeof wanted === "string") return node.type === wanted || node.tagName === wanted;
    return true;
  };
  const walk = (node, index, parent) => {
    if (!node) return;
    if (matches(node)) fn(node, index, parent);
    const children = node.children ?? [];
    for (let i = 0; i < children.length; i += 1) walk(children[i], i, node);
  };
  walk(tree, undefined, undefined);
};
const h = (selector, properties, ...rest) => {
  const text = String(selector ?? "");
  const name = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(text);
  const tagName = name ? name[0] : "div";
  const props = {};
  const classes = [];
  for (const part of text.slice(name ? name[0].length : 0).split(/(?=[.#])/)) {
    if (part.startsWith(".")) classes.push(part.slice(1));
    else if (part.startsWith("#")) props.id = part.slice(1);
  }
  if (classes.length > 0) props.className = classes;
  let children = rest;
  if (properties !== undefined) {
    const isProps =
      properties !== null &&
      typeof properties === "object" &&
      !Array.isArray(properties) &&
      typeof properties.type !== "string";
    if (isProps) {
      for (const [key, value] of Object.entries(properties)) props[key] = value;
    } else {
      children = [properties, ...rest];
    }
  }
  const flat = [];
  const add = (child) => {
    if (child === undefined || child === null || child === false) return;
    if (Array.isArray(child)) { for (const one of child) add(one); return; }
    flat.push(typeof child === "object" ? child : { type: "text", value: String(child) });
  };
  for (const child of children) add(child);
  return { type: "element", tagName: tagName, properties: props, children: flat };
};
`;

/**
 * Assemble one self-contained VM program for a render.
 *
 * The program is an IIFE (nothing leaks into the engine's persistent scope)
 * that declares the document's two bindings, defines the `$` helper and the
 * toolkit, runs the compiled statements, and returns a one-line JSON envelope
 * as its completion value: `{ out: [[line, text], …] }` for the ordinary case,
 * `{ tree: {…} }` when the document installed a transform, `{ error: "…" }` if
 * it threw.
 *
 * The two bindings, and why there are two:
 *
 *   `req` is whatever the caller is asking with — the data a nested
 *   `$.render(target, data)` passed, the build's own context at the top. It is
 *   exactly what was passed and never merged with anything.
 *
 *   `res` is what the document answers with. `res.data` is the document's OWN
 *   parsed data (front matter + data fences + the source's identity), ready
 *   before a line has run because it was read off the top first. `res.doc` is
 *   the finished tree, which cannot be ready before the code runs — making it
 *   is what the code is for — so it is undefined until a `transform` gets it.
 *
 *   Defaulting is therefore the document's own explicit
 *   `req.x ?? res.data.x`, and a template can always tell its declared data
 *   from its input. Missing keys are graceful by construction: property access
 *   never throws for an absent key.
 *
 * Tree form — the epilogue after the statements:
 *
 *   `transform((tree) => …)` installs a function to run on the document's
 *   finished tree. The tree is parsed by a host call and the function runs IN
 *   the VM (the function never crosses the boundary, only the JSON tree does).
 *   The unified transformer convention applies: return a node, or change it in
 *   place and return nothing.
 *
 * Composition — `$.render(target, data)` returns a TOKEN, not text. The host
 * renders the target to its own finished tree, parks it, and hands back a few
 * private-use characters standing in its place (see src/compose.js). The token
 * travels through the document's output like any other string, and the tree
 * goes back in once the text around it has been parsed. Which is why there is
 * no `indent`: the parser knows which element is open where the token landed,
 * so there is no column for the caller to compute.
 *
 * The IIFE is `async` and awaited at the program's top level (the engine
 * resolves top-level await into the completion value) — so `await` is legal
 * anywhere in a document's code. The one thing that genuinely needs it is
 * dynamic `import()` of a JS module (see buildDocumentSet's
 * `options.loadModule`): a real ES `import` statement stays impossible here
 * (function body, not module top level), but the expression form works
 * anywhere, and the module registry it populates lives host-side of the
 * document's own scope.
 *
 * `$` methods that need the host (find / findOne / data / render / text /
 * emit / publish / parse / markdown / html / table / toc, and any
 * `extraNativeNames`) call the
 * engine's `__hostcall` native: the VM suspends while the host's async native
 * runs, then resumes with the result — a synchronous-looking call from the
 * document's point of view. Only `$.count` is preloaded: it is one number, so
 * it costs nothing to embed. There is deliberately no preloaded array of every
 * document — `$.find({})` returns the whole set, in document order, and each
 * result carries the identity `$.render`/`$.text` resolve without re-querying.
 * The set used to be embedded in every program as a JSON literal, which made a
 * build quadratic: n renders each parsing an n-sized prelude, so a 1 KB layout
 * rendered once per page still paid for the entire corpus every time.
 *
 * `$.publish(name, data)` is `$.render(name, data)` in the other tense: the
 * same call, deferred and handed to whatever transport the embedder has, so
 * a page can be given work to do later instead of rendered now. Core resolves
 * the name and validates it — a name resolves to a page or it doesn't, which
 * is why there is no `$.subscribe` and nothing to register — and then does
 * exactly what `$.emit` does with an output: hands it to a hook and forms no
 * opinion about what happens next. It returns null, never a broker's message
 * id, because at call time nothing has been sent.
 *
 * `$.emit(path, content)` is the generic "produce a named output" native —
 * see buildDocumentSet's `options.onEmit` doc comment for the whole
 * rationale. Tokens in `content` become HTML on the way out, because a file
 * is a string and that is the shape it can hold: `$.emit(url, $.render(page))`
 * writes the page.
 *
 * `extraNativeNames` gets a generic `(...args) => __call(name, args)`
 * passthrough per name — mdy itself has no opinion on what these do (that's
 * entirely the embedder-supplied native function's business), it only wires
 * the guest-side call shape.
 */
function buildProgram({ body, selfData, ctx, count, extraNativeNames = [] }) {
  const extraNativeLines = extraNativeNames
    .map((name) => `  ${name}: (...args) => __call(${JSON.stringify(name)}, args),`)
    .join('\n');
  return `await (async () => {
const __call = (method, args) => JSON.parse(__hostcall(method, JSON.stringify(args)));
const req = ${jsonForEval(ctx)};
const res = { data: ${jsonForEval(selfData)}, doc: undefined };
const $ = {
  count: ${count},
  data: (i) => __call("data", [i]),
  find: (q) => __call("find", [q === undefined ? {} : q]),
  findOne: (q) => __call("findOne", [q === undefined ? {} : q]),
  withTag: (t) => __call("find", [{ tags: String(t).toLowerCase() }]),
  render: (target, data) => __call("render", [target, data === undefined ? {} : data]),
  text: (target, data) => __call("text", [target, data === undefined ? {} : data]),
  emit: (path, content) => __call("emit", [path, content]),
  publish: (name, data) => __call("publish", [name, data === undefined ? {} : data]),
  parse: (source) => __call("parse", [source]),
  markdown: (source) => __call("markdown", [source]),
  node: (tree) => __call("node", [tree]),
  html: (value) => __call("html", [value]),
  table: (rows, align) => __call("table", [rows, align === undefined ? null : align]),
  toc: (target) => target === undefined ? __call("toc", []) : __call("toc", [target]),
${extraNativeLines}
};
const __transforms = [];
const transform = (fn) => { __transforms.push(fn); };
${TOOLKIT}
let __err = null;
let __result = null;
try {
${body}
if (__transforms.length > 0) {
  let __tree = __call("compose", [__out]);
  res.doc = __tree;
  for (const fn of __transforms) {
    const returned = fn(__tree);
    if (returned !== undefined && returned !== null) {
      if (typeof returned !== "object" || typeof returned.type !== "string") {
        throw "transform must return a hast node ({ type, ... }), or undefined after changing the tree in place";
      }
      __tree = returned;
    }
    res.doc = __tree;
  }
  __result = { tree: __tree };
} else {
  __result = { out: __out };
}
} catch (e) { __err = "" + e; }
return JSON.stringify(__err !== null ? { error: __err } : __result);
})()`;
}

// The one HTML writer. Every tree that becomes text — an $.emit'd page, a
// token that reached a string, the public render — goes through this, so a
// page and a fragment are written the same way.
const htmlWriter = unified().use(rehypeStringify, { allowDangerousHtml: true }).freeze();

/**
 * A hast tree as an HTML string.
 *
 * @param {import('hast').Root | import('hast').ElementContent} tree
 * @returns {string}
 */
export function toHtml(tree) {
  return htmlWriter.stringify(tree.type === 'root' ? tree : { type: 'root', children: [tree] });
}

/** Tokens in a string become the HTML of what they hold. */
const fillHtml = (value) =>
  fillTokens(value, (entry) => (entry.kind === 'tree' ? toHtml(entry.tree) : ''));

/**
 * Compile a source (or array of sources) into a runnable document set backed
 * by a nisaba database: every document's data is inserted into an in-memory
 * collection, `$.find`/`$.findOne` run real MongoDB-style queries against it,
 * and `$.render` can select its target document by query. Documents execute
 * inside the lamassu VM (see buildProgram / src/vm.js).
 *
 * Query results are returned in document order (an insertedId → index map
 * both restores deterministic ordering and lets a query hit map back to its
 * compiled document for `$.render`).
 *
 * `options.onQuery({ query, docIndex })`, if given, fires for every query
 * this set ever runs — `$.find`/`$.findOne`/`$.withTag`/`$.render`-by-query
 * from inside a document (`docIndex`: the index of the document currently
 * rendering), and `find`/`findOne`/`render`-by-query called host-side on the
 * returned handle (`docIndex: null`). This is the one chokepoint both paths
 * share (`hostFind`), so one hook sees every query in the set regardless of
 * who asked.
 *
 * `options.natives` — extra `{ name: (...args) => value | Promise<value> }`
 * entries, merged alongside find/findOne/render into every render's host
 * natives AND wired as `$.<name>(...)` in the generated program. Args/return
 * value cross the VM boundary JSON-serialized. Each extra native is called
 * with `(docIndex, docData)` appended after the document's own args — which
 * document is currently rendering, and its data (including `path`) —
 * ignorable by any native that doesn't need it.
 *
 * `options.onEmit({ path, content, docIndex })` fires for every
 * `$.emit(path, content)` a document calls — a FIXED native (unlike
 * `options.natives`' embedder-defined ones), because "produce a named output
 * as a side effect of rendering" is generic to any mdy-docs consumer. mdy has
 * no opinion on what "producing" an output means. Without the option,
 * `$.emit` is a harmless no-op.
 *
 * `options.onPublish({ name, data, docIndex })` fires for every
 * `$.publish(name, data)` a document calls — a FIXED native, like `$.emit`,
 * and for the same reason: "hand this page some work for later" is generic to
 * any mdy-docs consumer, and mdy has no opinion on what sending means. Core
 * resolves the name against this set first, so the hook only ever sees
 * messages addressed to a page that exists; an unknown or ambiguous name
 * throws inside the document, the way `$.render`'s does. Without the option,
 * `$.publish` still resolves (so a typo is still an error) and is otherwise a
 * no-op.
 *
 * `options.loadModule(specifier, referrer, docIndex, docData)` enables
 * guest-side dynamic `import()`: document code may `await import("…")` a real
 * ES module, and every module in the resulting graph is fetched through this
 * function (return the module's source text; may be async). `referrer` is the
 * importing module's canonical specifier, or "" when the import came from
 * document code itself. `options.canonicalizeModule` (same signature,
 * synchronous) maps a raw specifier to the module's registry identity first.
 * Without `loadModule`, a guest `import()` rejects: no loader, no filesystem
 * reach.
 *
 * @param {string | string[]} source
 * @param {{
 *   onQuery?: (info: { query: object, docIndex: number | null }) => void,
 *   onEmit?: (info: { path: string, content: any, docIndex: number | null }) => void,
 *   onPublish?: (info: { name: string, data: any, docIndex: number | null }) => void,
 *   natives?: Record<string, (...args: any[]) => any>,
 *   loadModule?: (specifier: string, referrer: string, docIndex: number, docData: object) => string | Promise<string>,
 *   canonicalizeModule?: (specifier: string, referrer: string, docIndex: number, docData: object) => string,
 * }} [options]
 */
async function buildDocumentSet(source, options = {}) {
  const { onQuery, onEmit, onIngest, onPublish, natives: extraNatives = {}, loadModule, canonicalizeModule } = options;
  const extraNativeNames = Object.keys(extraNatives);
  // Checked once, when the set is built, rather than on every render that
  // happens to reach buildProgram — it is a fact about the embedder's natives,
  // not about any one render, and a render served from the memo never reaches
  // buildProgram at all.
  for (const name of extraNativeNames) {
    if (!VALID_NATIVE_NAME.test(name)) {
      throw new Error(`mdy: invalid native name ${JSON.stringify(name)} (must be a valid identifier)`);
    }
  }
  const docs = parseDocuments(source).map(({ data, content, format }, index) => ({
    index,
    data,
    format,
    // A `.md` document has no code to compile: it is markup and nothing else,
    // and it reaches hast through the other front end (src/markdown.js).
    body: format === 'md' ? null : compileTemplateSource(content),
    content,
  }));
  const documents = docs.map(({ index, data }) => ({ index, data }));

  // What a document IS, for the render memo: its code and its own data. Hashed
  // once per build rather than per render — a document is rendered many times
  // (a layout, once per page) and none of this changes between them.
  //
  // The native NAMES go in as well, because the memo is shared by every set in
  // the process and two sets built from identical text would otherwise share
  // its entries — including when one of them offers `$.resize` and the other
  // does not, which is a different program for the same document.
  const setSignature = extraNativeNames.join(',');
  for (const doc of docs) {
    doc.fingerprint = hashString(
      `${setSignature}\u0000${doc.data?.path ?? doc.index}\u0000${doc.body ?? ''}\u0000${JSON.stringify(doc.data ?? null)}`
    );
  }

  // $.publish's address book: message name -> the documents deriving it.
  // An array rather than one document because two paths can collapse to the
  // same name (a/b/c.mdy and a.b/c.mdy both make a.b.c), and delivering
  // somebody's messages to whichever of them was indexed last would be worse
  // than an error.
  //
  // A document carrying an `ext` that is not .mdy/.md is skipped: a set built
  // from a directory holds raw records too (a .yaml of data, a .png), and a
  // message renders the page it names, so a record with nothing to run is not
  // an endpoint. That also stops static/logo.png and static/logo.jpg from
  // colliding on static.logo before either could be published to. Reading one
  // data field is not the same as knowing about vaults: a set built from a
  // string has no `ext` at all, and every document in it stays addressable.
  const messagePages = new Map();
  for (const doc of documents) {
    const ext = doc.data?.ext;
    if (typeof ext === 'string' && !/^\.(mdy|md)$/i.test(ext)) continue;
    const name = messageName(doc.data);
    if (name === null || nameProblem(name) !== null) continue;
    if (messagePages.has(name)) messagePages.get(name).push(doc);
    else messagePages.set(name, [doc]);
  }

  const db = await connect(new MemoryStorageProvider());
  const collection = await db.collection('documents');
  const idToIndex = new Map();
  for (const doc of docs) {
    const { insertedId } = await collection.insertOne({ ...doc.data });
    idToIndex.set(String(insertedId), doc.index);
    // The one phase of a build with a total known in advance, and the one a
    // caller could not see at all: onSource has already fired for every file
    // by now, and the entry has not started, so between them a build looked
    // stopped. `done`/`total` are documents of THIS set, so a caller watching
    // an import graph sees one run of it per package.
    onIngest?.({ done: idToIndex.size, total: docs.length });
  }

  // `path` is the natural key of a set built from a directory, and nisaba's
  // `_id` cannot be one: it must be an ObjectId (the primary tree's keys are
  // fixed-width OID bytes), and the error it throws for a string points here
  // instead — "keep natural keys in their own field with a unique index".
  // Every render written as `$.render({ path: … })` resolves through a query
  // on this field, so without the index each one is a scan of the whole set:
  // measured at 9.3 ms unindexed against 0.5 ms indexed, several hundred times
  // per build.
  //
  // SPARSE because a document need not have a path at all — a set built from a
  // bare string has none, and a non-sparse index rejects any document missing
  // the field. NOT unique: one file can hold several documents (split on bare
  // `---`), and they all carry the path of the file they came from.
  await collection.createIndex({ path: 1 }, { sparse: true });

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
  // the document the caller already holds); or a query whose first hit (in
  // document order) is the target. A string _id the set doesn't know is an
  // error rather than a query fallback — the caller clearly held a reference,
  // just not to a document of this set. `null` gets its own message because a
  // missed $.findOne is the obvious way to produce it.
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

  /**
   * A finished render.
   *
   * `text` is what the document's code actually wrote, byte for byte — which
   * a document may legitimately mean as its whole output (an RSS feed, a
   * robots.txt). `tree` is that text parsed, with every nested render spliced
   * in and every transform applied.
   *
   * `tree` is a getter because parsing is not always wanted: a feed rendered
   * only for its text should not be read as MDY on the way past. Once asked
   * for, it is kept — a tree spliced into two places is the same tree.
   */
  const finish = (out, tree, text) => {
    let made = tree === undefined ? undefined : spliceToc(tree);

    return {
      text: text ?? (out === null ? toHtml(made) : scriptOutput(out).lines.join('\n')),
      get tree() {
        if (!made) made = spliceToc(compose(out));
        return made;
      },
    };
  };

  // Lines from a document's code, parsed and composed: the parser sees only
  // markup (the code came out before a column was counted), and every token a
  // nested render left behind becomes the tree it stands for.
  const compose = (out) => splice(fromMdy(scriptOutput(out).lines.join('\n'), PARSE));

  // Every render is bracketed so compose.js knows whether any is in flight —
  // that is what lets a later build reclaim held trees without stranding a
  // token something is still going to look up (see releaseHeld).
  const runDoc = async (i, ctx, depth) => {
    enterRender();
    try {
      return await runDocInner(i, ctx, depth);
    } finally {
      exitRender();
    }
  };

  const runDocInner = async (i, ctx, depth) => {
    if (depth > MAX_RENDER_DEPTH) {
      throw new Error('mdy: render depth exceeded (cyclic $.render?)');
    }
    const doc = docs[i];
    if (!doc) throw new Error(`mdy: no document at index ${i}`);

    // This render's identity: what the document is, plus what it was asked
    // with. `req` is part of it because the same layout rendered with
    // different data is a different render — and because a nested render
    // reaches its parent as a token inside `req`, an input that changed
    // downstream shows up here (see compose.js's `hold`).
    const key = hashString(`${doc.fingerprint}\u0000${JSON.stringify(ctx)}`);
    const memoized = renderMemoNow.get(key) ?? renderMemoPrev.get(key);
    if (memoized !== undefined) {
      renderMemoNow.set(key, memoized);
      return memoized;
    }
    // Set by any native that reaches outside (code, data, req) — see the
    // render memo's comment. A render that trips this is never stored.
    let impure = false;
    const taint = () => {
      impure = true;
    };
    const keep = (result) => {
      Object.defineProperty(result, 'key', { value: key });
      if (!impure) renderMemoNow.set(key, result);
      return result;
    };

    // The other front end. A `.md` file is markup with no code in it, so
    // there is nothing to run: it goes straight to hast at its own boundary
    // and joins everything else as a tree. walkRawSources keeps a `.md`
    // file's real text on its data rather than as a body to compile, which
    // is where this reads it from.
    if (doc.format === 'md') {
      const text = typeof doc.data.body === 'string' ? doc.data.body : doc.content;
      // Its own markdown is the text it wrote — there was no code to write
      // anything else — so `$.text` on a `.md` document gives back the file.
      return keep(finish(null, markdownToHast(text), text));
    }

    // The `$` host natives for this render. Each may be async — the VM
    // suspends at the guest's __hostcall until it settles. A nested $.render
    // recurses into runDoc, which runs on its OWN pooled VM instance (a
    // suspended instance cannot be re-entered).
    const nested = async (target, data) =>
      runDoc(await resolveIndex(target, i), data ?? {}, depth + 1);

    const natives = {
      find: (query) => (taint(), trackedFind(query, i)),
      // Backs `$.data(i)`: one document's data, positionally. A host call —
      // there is no preloaded set in the program to read it out of, and a
      // single document is a far smaller thing to send than all of them.
      data: (index) => (taint(), docs[index]?.data ?? null),
      findOne: async (query) => (taint(), (await trackedFind(query, i))[0] ?? null),
      // A nested render is a TREE, parked host-side; what crosses back is the
      // token standing for it (see src/compose.js).
      render: async (target, data) => {
        taint();
        const result = await nested(target, data);
        // The token carries the child's render key, so a parent that holds it
        // in `req` is re-keyed whenever the child's own inputs change.
        return hold(result.tree, result.key);
      },
      // …and the same render as the text its code wrote, for a document whose
      // output was never markup to begin with (a feed, a robots.txt).
      text: async (target, data) => (taint(), (await nested(target, data)).text),
      emit: (path, content) => {
        taint();
        onEmit?.({ path, content: typeof content === 'string' ? fillHtml(content) : content, docIndex: i });
        return null;
      },
      // $.render's other tense. Core's whole job is deciding that the name
      // means a page of this set — after which the message is the
      // embedder's, exactly as an emitted output is.
      publish: (name, data) => {
        taint();
        const problem = nameProblem(name);
        if (problem !== null) throw new Error(`mdy: publish: a message name ${problem}`);
        const targets = messagePages.get(name) ?? [];
        if (targets.length === 0) {
          throw new Error(`mdy: publish: no document is named ${JSON.stringify(name)} (a page's name is its path without the extension, "/" written as ".")`);
        }
        if (targets.length > 1) {
          const paths = targets.map((d) => d.data?.path ?? '?').join(', ');
          throw new Error(`mdy: publish: ${JSON.stringify(name)} is ambiguous — ${targets.length} documents share it (${paths}); give one of them a messageName`);
        }
        onPublish?.({ name, data, docIndex: i });
        return null;
      },
      // MDY text → hast, the same front end the document itself came through,
      // so a tree a document inspects is the tree its own output would make.
      parse: (source) => splice(fromMdy(String(source ?? ''), PARSE)),
      // Markdown text → hast, the OTHER front end: a `.md` file's body, or
      // any markdown a document holds and wants as a tree.
      markdown: (source) => hold(markdownToHast(String(source ?? ''))),
      // A tree the document built ITSELF — with `h`, or by hand, or in a
      // module it imported — parked like any other and spliced where its
      // token lands. This is what a helper that used to return a string of
      // HTML returns instead: hast is plain JSON, so it crosses the boundary
      // as it is, and a fragment built this way is a node from the start
      // rather than text somebody has to parse back.
      node: (tree) => {
        if (tree === null || typeof tree !== 'object' || typeof tree.type !== 'string') {
          throw new Error('mdy: $.node expects a hast node ({ type, … })');
        }
        return hold(tree);
      },
      // A tree (or a token standing for one) as HTML text.
      html: (value) => {
        if (typeof value === 'string') return fillHtml(value);
        if (value === null || typeof value !== 'object' || typeof value.type !== 'string') {
          throw new Error('mdy: $.html expects a hast node ({ type, … }) or a string');
        }
        return toHtml(value);
      },
      table: (rows, align) => {
        if (!Array.isArray(rows) || rows.some((row) => !Array.isArray(row))) {
          throw new Error('mdy: $.table expects an array of row arrays (first row is the header)');
        }
        if (rows.length === 0) return '';
        return hold(tableTree(rows, align));
      },
      // No argument: a token for this document's own contents list, filled in
      // once the whole tree exists. With one: the headings of what was passed,
      // for a document that would rather render the list itself.
      toc: (target) => {
        if (target === undefined) return holdToc();
        const tree =
          heldTree(target) ?? (typeof target === 'string' ? fromMdy(target, PARSE) : target);
        if (tree === null || typeof tree !== 'object' || typeof tree.type !== 'string') {
          throw new Error('mdy: $.toc expects MDY text, a hast node, or a rendered document');
        }
        return headings(tree);
      },
      // The document's lines, parsed and composed — the host half of a
      // `transform`, which needs a tree to be handed and cannot make one
      // itself.
      compose: (out) => compose(out),
      // Every extra native gets (docIndex, docData) appended after whatever
      // args the document itself passed — a generic "which document is
      // calling" hook, not specific to any one native (src/imports.js
      // resolves an import relative to the FILE that declared it, so its
      // native needs to know which document's data.path that was).
      // An embedder's own native does who-knows-what — $.resize writes a file,
      // an import renders out of another set entirely — so a render that calls
      // one is never kept.
      ...Object.fromEntries(
        Object.entries(extraNatives).map(([name, fn]) => [name, (...args) => (taint(), fn(...args, i, doc.data))])
      ),
    };

    // Same "(docIndex, docData) appended" contract as the extra natives: a
    // loader resolving a document's own import needs to know which file is
    // asking; module-to-module imports carry that in `referrer` instead.
    const moduleOptions = loadModule
      ? {
          // A module's SOURCE is not part of this render's key, so a render
          // that loads one cannot be kept — editing the module would other-
          // wise keep serving the render made before the edit.
          loadModule: (specifier, referrer) => (taint(), loadModule(specifier, referrer, i, doc.data)),
          canonicalizeModule: canonicalizeModule
            ? (specifier, referrer) => canonicalizeModule(specifier, referrer, i, doc.data)
            : undefined,
        }
      : undefined;

    const program = buildProgram({
      body: doc.body,
      selfData: doc.data,
      ctx,
      count: documents.length,
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
      throw new Error(`mdy: document ${i} failed: ${envelope.error}`);
    }
    return keep(
      envelope.tree !== undefined
        ? finish(null, envelope.tree, undefined)
        : finish(envelope.out, undefined, undefined)
    );
  };

  return { docs: documents, messagePages, runDoc, hostFind, resolveIndex, trackedFind };
}

/**
 * A 2-D array as a hast table. The first row is the header; a cell's text is
 * parsed as MDY inline content, so **bold**, `code` and links survive into it.
 *
 * @param {Array<Array<unknown>>} rows
 * @param {Array<string> | null} align
 * @returns {import('hast').Element}
 */
function tableTree(rows, align) {
  if (align !== null && align !== undefined && !Array.isArray(align)) {
    throw new Error("mdy: $.table align must be an array like ['left', 'center', 'right']");
  }
  const columnAlign = (i) => {
    const value = String(align?.[i] ?? '').toLowerCase()[0];
    return { l: 'left', c: 'center', r: 'right' }[value];
  };
  const cell = (value, i, header) => {
    const text = value === null || value === undefined ? '' : String(value);
    const parsed = fromMdy(text, PARSE).children;
    const children =
      parsed.length === 1 && parsed[0].type === 'element' && parsed[0].tagName === 'p'
        ? parsed[0].children
        : [{ type: 'text', value: text }];
    const at = columnAlign(i);
    return {
      type: 'element',
      tagName: header ? 'th' : 'td',
      properties: at ? { style: `text-align: ${at}` } : {},
      children,
    };
  };
  const row = (cells, header) => ({
    type: 'element',
    tagName: 'tr',
    properties: {},
    children: cells.map((value, i) => cell(value, i, header)),
  });
  const [head, ...body] = rows;
  const children = [
    { type: 'element', tagName: 'thead', properties: {}, children: [row(head, true)] },
  ];
  if (body.length > 0) {
    children.push({
      type: 'element',
      tagName: 'tbody',
      properties: {},
      children: body.map((cells) => row(cells, false)),
    });
  }
  return { type: 'element', tagName: 'table', properties: {}, children };
}

/**
 * A tree's headings, in document order, with the ids they carry.
 *
 * @param {import('hast').Node} tree
 * @returns {Array<{depth: number, text: string, slug: string | undefined}>}
 */
function headings(tree) {
  const entries = [];
  const walk = (node) => {
    const tag = node.tagName ?? '';
    if (/^h[1-6]$/.test(tag)) {
      entries.push({ depth: Number(tag.slice(1)), text: textOf(node), slug: node.properties?.id });
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return entries;
}

/** All the text under a hast node. */
function textOf(node) {
  if (!node) return '';
  if (node.type === 'text') return node.value;
  if (node.type === 'comment' || node.type === 'doctype') return '';
  return (node.children ?? []).map(textOf).join('');
}

/**
 * Open a source (or array of sources) as a long-lived document-set handle:
 * parse, compile, and insert into nisaba ONCE, then query and render against
 * the set repeatedly. This is the embedder-facing form of the machinery
 * behind renderDocumentSet — use it when many renders share one set (a static
 * site build rendering every page, a notes app rendering on demand).
 *
 * The handle:
 *
 *   docs                 [{ index, data }, …] in document order
 *   find(query)          matching documents' data, in document order —
 *                        host-side, same semantics as the in-document $.find
 *   findOne(query)       first match or null
 *   render(target, ctx)  render the document at index `target`, the exact
 *                        document of a find/findOne result `target` (resolved
 *                        by its _id, no re-query), or the first one matching
 *                        query `target`, with `ctx` as the document's `req`
 *                        (its own data stays separate, as `res.data`) → HTML
 *   renderTree(target, ctx)  the same render as its finished hast tree — no
 *                        HTML written, nothing to take apart again. This is
 *                        what a consumer with its own renderer wants
 *   renderText(target, ctx)  the same render as the text its code wrote,
 *                        byte-exact — for a document that deliberately is not
 *                        markup (a feed, a robots.txt)
 *   renderResult(target, ctx)  both: { text, tree }, the raw completion shape
 *
 * Sources may carry identity (`{ text, meta }`, see parseDocuments), so `find`
 * can route on file-level fields and rendered documents know where they came
 * from. Everything the handle holds is in memory; there is nothing to close —
 * drop the handle when done.
 *
 * `options.onQuery` / `options.onEmit` / `options.natives` /
 * `options.loadModule` / `options.canonicalizeModule` — see
 * buildDocumentSet's doc comment.
 *
 * @param {string | { text: string, meta?: object } | (string | { text: string, meta?: object })[]} source
 * @param {object} [options]
 */
export async function openDocumentSet(source, options = {}) {
  const { docs, messagePages, runDoc, resolveIndex, trackedFind } = await buildDocumentSet(source, options);
  const renderResult = async (target, ctx = {}) => runDoc(await resolveIndex(target, null), ctx, 0);
  return {
    docs,
    // Message name -> the document(s) of that name. A host that delivers
    // messages needs the same address book $.publish resolves against, or
    // the two disagree about what a name means.
    messagePages,
    find: (query) => trackedFind(query, null),
    findOne: async (query) => (await trackedFind(query, null))[0] ?? null,
    render: async (target, ctx = {}) => toHtml((await renderResult(target, ctx)).tree),
    renderTree: async (target, ctx = {}) => (await renderResult(target, ctx)).tree,
    renderText: async (target, ctx = {}) => (await renderResult(target, ctx)).text,
    renderResult,
  };
}

/**
 * Process a multi-document source and render the entry document (index
 * `entry`, default 0) to HTML. Every document is a standard mdy unit (front
 * matter + body). An array of sources forms one combined set (see
 * parseDocuments). The set's data lives in a nisaba collection; documents
 * receive a `$` helper that queries it MongoDB-style:
 *
 *   $.find(query)          data of the documents matching `query`, in
 *                          document order (full Mongo operator support)
 *   $.findOne(query)       first match or null
 *   $.render(target, data) run the document matching `target` (a query, or an
 *                          index) with `data` as its `req` → a token standing
 *                          for its finished tree
 *   $.text(target, data)   the same render as the text its code wrote
 *   $.withTag(tag)         shorthand for $.find({ tags: tag })
 *   $.data(i)              document i's data (positional)
 *   $.count                number of documents
 *   $.parse(mdy)           MDY text → hast
 *   $.markdown(md)         markdown text → a token for its tree
 *   $.node(tree)           a tree the document built itself → a token
 *   $.html(treeOrText)     a tree (or a token) as HTML text
 *   $.emit(path, content)  produce a named output
 *   $.table(rows, align)   a 2-D array → a token for a table
 *   $.toc()                (no argument) a token replaced at the end of the
 *                          render with a link list of THIS document's final
 *                          headings; $.toc(mdyOrTree) instead returns
 *                          [{ depth, text, slug }] entries to render manually
 *   transform(fn)          run (tree) => tree | undefined on the document's
 *                          finished tree before output
 *
 * One-shot: the set is built, one document renders, the set is dropped. To
 * render many pages from one set, use openDocumentSet.
 *
 * @param {string | string[]} source
 * @param {object} [extraContext] the entry document's `req`
 * @param {number} [entry] index of the document to render (default 0)
 * @returns {Promise<string>} HTML
 */
export async function renderDocumentSet(source, extraContext = {}, entry = 0) {
  const set = await openDocumentSet(source);
  return set.render(entry, extraContext);
}

/**
 * Apply the entry document's template to every OTHER document in the set, one
 * render per data document. Each data document's front matter (merged with
 * `extraContext`, which wins) arrives as the template's `req`; the entry's own
 * front matter is its `res.data`, so sample-data defaults are the template's
 * explicit `req.x ?? res.data.x`. With no other documents the entry renders
 * once with an empty `req`, so a template file written that way still works
 * standalone.
 *
 * This is the mail-merge companion to renderDocumentSet: keep a display
 * template in one file, data records in others, and pass them together:
 *
 *   renderEach([templateSource, dataSource])  // → one HTML string per record
 *
 * @param {string | string[]} source
 * @param {object} [extraContext] extra context for every render
 * @param {number} [entry] index of the template document (default 0)
 * @returns {Promise<string[]>} HTML, one entry per data document
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

/**
 * Create a processor bound to a configured output stage.
 *
 * There is no chain left to configure on the way IN: both front ends produce
 * hast directly, so what used to be a remark pipeline with a raw-HTML repair
 * step in the middle is now a parse and nothing else. What remains
 * configurable is what happens to the finished tree — `rehypePlugins` run on
 * it, and `compiler` decides what it becomes.
 *
 * @param {object} [options]
 * @param {Array} [options.rehypePlugins] plugins run on the finished tree —
 *   e.g. a syntax highlighter
 * @param {Function} [options.compiler] the unified compiler that terminates
 *   the chain, replacing rehype-stringify. Everything above it is
 *   output-agnostic — hast is hast — so swapping only this last step
 *   retargets mdy at another renderer without touching a single transform:
 *   @mdy-docs/react passes a hast → React element compiler here. A custom
 *   compiler's return value is passed through as-is (no String() coercion).
 * @returns {{ processor: object, renderTree: Function, renderMarkdown: Function, renderMdy: Function, render: Function }}
 */
export function createProcessor(options = {}) {
  const compiler = options.compiler ?? rehypeStringify;
  const processor = unified()
    .use(function () {
      // A parser is required for a processor to be usable; MDY is what this
      // one reads when it is handed text rather than a tree.
      this.parser = (document) => fromMdy(document, PARSE);
    })
    .use(options.rehypePlugins ?? [])
    .use(compiler, compiler === rehypeStringify ? { allowDangerousHtml: true } : undefined);

  // Only the default HTML compiler produces a string. unified parks any other
  // compiler's return value on file.result (file.value stays undefined), so
  // the String() coercion that is right for HTML would stringify a React
  // element to "[object Object]" — take .result instead, uncoerced.
  const html = compiler === rehypeStringify;
  const fromValue = (value) => (html ? String(value) : value);

  /** A hast tree → the output. The transformers and compiler applied; no
   * parse step, because the tree already is one. */
  const renderTree = async (tree) => fromValue(processor.stringify(await processor.run(tree)));

  /** MDY text → the output, with no document layer — just the front end. */
  const renderMdy = async (source) => renderTree(fromMdy(String(source ?? ''), PARSE));

  /** Markdown text → the output, through the other front end. */
  const renderMarkdown = async (source) => renderTree(markdownToHast(String(source ?? '')));

  /** Document source(s) → the output. */
  const render = async (source, extraContext = {}, entry = 0) => {
    const set = await openDocumentSet(source);
    return renderTree(await set.renderTree(entry, extraContext));
  };

  return { processor, renderTree, renderMarkdown, renderMdy, render };
}

// A ready-to-use default processor.
const processor = createProcessor();

/** Process a document string into HTML using the default processor. */
export function render(source, extraContext = {}, entry = 0) {
  return processor.render(source, extraContext, entry);
}
