/**
 * HTML containers — indentation as structure.
 *
 * A line that is nothing but an opening tag WITHOUT its closing `>` opens a
 * container; every following line indented two spaces past it is the
 * container's content, rendered as ordinary markdown with those two spaces
 * removed; the first non-blank line that drops back out of the indent closes
 * it. The closing tag is never written — the indent marks it.
 *
 *   <div class="note"
 *     # heading in the div
 *   # heading after div closed
 *
 * The missing `>` is the whole sigil, and it is deliberately not optional: a
 * line ending in `>` stays exactly what CommonMark already says it is (a raw
 * HTML block), so every hand-written `<div class="x">…</div>` in existing
 * documents keeps its current meaning, including `<pre>` blocks whose leading
 * whitespace must survive verbatim. Nothing is reinterpreted — `<div` with no
 * `>` currently parses as a malformed HTML block that swallows the rest of
 * the paragraph and renders to nothing, so the syntax this claims was dead.
 *
 * Expansion is a pure string → string rewrite into the blank-line-separated
 * form the pipeline already handles (raw open tag / markdown / raw close tag,
 * reassembled by remark-rehype's allowDangerousHtml + rehype-raw), which is
 * why this is a preprocessor rather than a micromark extension. It runs
 * wherever mdy turns markdown TEXT into a tree or into HTML — the renderer,
 * `$.parse`, `$.toc(markdown)`, and the public markdown boundary — so the
 * template layer and the HTML layer never disagree about what a container is.
 * Because the expanded form ends in `>`, expansion is idempotent.
 */

// Elements that cannot hold children: an opener naming one is a standalone
// tag, and indented content under it is an authoring error, not a body.
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img',
  'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// Elements whose content is raw text rather than markdown. Their body is
// de-indented and emitted verbatim between the tags — no blank-line padding
// (which would become content) and no recursive expansion.
const RAW_TEXT_ELEMENTS = new Set(['pre', 'script', 'style', 'textarea']);

// A container opener: up to three spaces of indent (CommonMark's allowance
// for every block construct, which also lets an opener sit at a list item's
// content column), `<`, a tag name, then optional attributes. The `[ \t/]`
// start for the attribute run keeps `<br/` working alongside `<br /`.
const OPENER = /^( {0,3})<([a-zA-Z][a-zA-Z0-9-]*)((?:[ \t/][^\n]*)?)$/;

// A fenced code block delimiter. Fences are tracked so that a `<div` shown
// INSIDE a code sample is displayed, not expanded.
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Number of leading space characters (a tab is not a container indent). */
const leadingSpaces = (line) => {
  let n = 0;
  while (line[n] === ' ') n++;
  return n;
};

/**
 * Expand every HTML container in a markdown string.
 *
 * @param {string} markdown markdown text (post-template, pre-parse)
 * @returns {string} the same markdown with containers rewritten to raw
 *   open/close tags around their now-unindented content
 */
export function expandHtmlContainers(markdown) {
  const text = String(markdown ?? '');
  // No `<` at the start of any line means no opener can exist — the common
  // case, and worth not splitting the document for.
  if (!/^ {0,3}</m.test(text)) return text;
  return expandLines(text.split('\n')).join('\n');
}

/**
 * Expand containers in one block of lines, at one indentation level. A
 * container's body recurses through here after being de-indented, so nesting
 * works at any depth without the opener regex ever seeing the outer indent.
 */
function expandLines(lines) {
  const out = [];
  let fence = null; // { char, size } while inside a fenced code block

  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    const fenceEdge = FENCE.exec(line);

    if (fence) {
      out.push(line);
      i++;
      // A closing fence is the same character, at least as long, bare.
      if (fenceEdge && fenceEdge[1][0] === fence.char
        && fenceEdge[1].length >= fence.size && fenceEdge[2].trim() === '') fence = null;
      continue;
    }
    if (fenceEdge) {
      fence = { char: fenceEdge[1][0], size: fenceEdge[1].length };
      out.push(line);
      i++;
      continue;
    }

    const opener = OPENER.exec(line);
    // Ending in `>` means an ordinary raw HTML block — left alone.
    if (!opener || line.trimEnd().endsWith('>')) {
      out.push(line);
      i++;
      continue;
    }

    const [, indent, tag, rawAttrs] = opener;
    const bodyIndent = indent.length + 2;

    // The body: every following line that is blank, or indented two past the
    // opener. Blank lines do NOT close a container (its content is block
    // content, and blocks are separated by blank lines); the first non-blank
    // line back out of the indent does. Body lines are collected RELATIVE to
    // the opener, so the recursion below sees them at column zero.
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '') { body.push(''); continue; }
      if (leadingSpaces(l) < bodyIndent) break;
      body.push(l.slice(bodyIndent));
    }
    // Blank lines trailing the body belong outside the container.
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    i = j;

    const name = tag.toLowerCase();
    let attrs = rawAttrs.trimEnd();
    let explicitlyEmpty = false;
    if (attrs.endsWith('/')) { explicitlyEmpty = true; attrs = attrs.slice(0, -1).trimEnd(); }
    if (attrs !== '' && !/^[ \t]/.test(attrs)) attrs = ` ${attrs}`;

    if (VOID_ELEMENTS.has(name) || explicitlyEmpty) {
      if (body.length > 0) {
        throw new Error(
          `mdy: <${tag}> cannot have indented content (${VOID_ELEMENTS.has(name)
            ? 'a void element'
            : 'written self-closing'})`
        );
      }
      // `<div />` would read as an UNCLOSED div — HTML honours self-closing
      // syntax only for void elements — so an explicitly-empty non-void
      // element gets a real empty pair instead.
      out.push(VOID_ELEMENTS.has(name)
        ? `${indent}<${tag}${attrs} />`
        : `${indent}<${tag}${attrs}></${tag}>`, '');
      continue;
    }

    // Re-indent the expanded body back under the opener, so a container
    // inside a list item keeps its content in the list item.
    const prefix = (l) => (l === '' ? '' : indent + l);

    if (RAW_TEXT_ELEMENTS.has(name)) {
      out.push(`${indent}<${tag}${attrs}>`, ...body.map(prefix), `${indent}</${tag}>`, '');
      continue;
    }

    out.push(`${indent}<${tag}${attrs}>`);
    if (body.length > 0) {
      // A nested container's expansion already ends in the blank line that
      // separates it from what follows; drop it so the padding around this
      // body stays exactly one blank line deep however far containers nest.
      const expanded = expandLines(body).map(prefix);
      while (expanded.length > 0 && expanded[expanded.length - 1] === '') expanded.pop();
      out.push('', ...expanded, '');
    }
    // The blank line after the close tag is load-bearing: without it the
    // following line is swallowed into the closing tag's raw HTML block.
    out.push(`${indent}</${tag}>`, '');
  }

  return out;
}
