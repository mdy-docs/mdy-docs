/*
 * Composition: how one document's tree gets inside another's.
 *
 * A template writes MDY and its code produces more of it, so what a template
 * hands back is lines of text. A nested render is not text — it is a finished
 * tree, made at its own document's boundary and complete before the caller
 * ever sees it. The two have to travel together through the same string, and
 * this file is how: `hold` parks a tree and returns a token to stand in its
 * place, the token rides along in the text like any other characters, and
 * `splice` puts the tree back once the text around it has been parsed.
 *
 * The tokens are U+E000/U+E001, from the private use area — codepoints no
 * document means anything by, so they survive MDY's own grammar untouched
 * and there is nothing for them to collide with.
 *
 * What this buys is the thing that could not be had while pages were built by
 * concatenating source: a document's tree is complete before it is composed,
 * so there is no such thing as an unclosed element to escape it. An author's
 * malformed tag stays inside the document it was written in.
 */

const OPEN = '\uE000';
const CLOSE = '\uE001';
// One definition of what an id looks like, because there are three regexes
// below that have to agree about it — they did not, once, and a token whose id
// stopped being purely numeric silently stopped being recognised as a token at
// all (it rendered as `<p><h1>…</h1></p>`: matched by one pattern, missed by
// the next). Base36, so `$.render`'s content-derived ids and the counter's
// plain digits are both covered.
const ID = '[0-9a-z]+';
const TOKEN = new RegExp(`${OPEN}(${ID})${CLOSE}`, 'g');
const ONE_TOKEN = new RegExp(`^\\s*${OPEN}(${ID})${CLOSE}\\s*$`);
const ONLY_TOKENS = new RegExp(`^(?:\\s*${OPEN}${ID}${CLOSE})+\\s*$`);

/*
 * Held trees outlive the render that made them. A token can be written into a
 * string, kept in a variable, dropped, or used twice, and nothing here gets to
 * decide when the last of those happened — so within a render nothing is
 * reclaimed. The trees are the same objects the renders already produced;
 * holding them costs what having rendered them already cost.
 *
 * Across renders it is knowable, and has to be: `mdy dev` rebuilds the whole
 * site on every save, and a store that only ever grew held every tree of every
 * rebuild for the life of the process — measured at 115 MB retained per save,
 * so a dev server left open through fifty of them carried about 6 GB of dead
 * article trees. `releaseHeld` below is the reclaim point, and `live` is what
 * makes it safe to use: every `hold` happens inside a render (they are all
 * `$` natives), so with no render in flight no token can be created, and every
 * token an earlier render made has already been composed into the text around
 * it. A caller that reclaims mid-render would strand tokens that are still
 * going to be looked up, which is why this counts rather than trusting the
 * caller to know.
 */
const held = new Map();
let next = 0;
let live = 0;

/** Mark a render as started/finished — see `releaseHeld`. Paired in a
 * `finally`, so a render that throws still decrements. */
export function enterRender() {
  live += 1;
}

export function exitRender() {
  live -= 1;
}

/**
 * Drop every held tree and start numbering again, if it is safe to: with a
 * render in flight the store is still being read, so this does nothing and
 * says so. Call it at the START of a build rather than the end — what the
 * previous build handed back (a document set's own `text`, say) stays
 * resolvable until the next one begins.
 *
 * @returns {boolean} whether the store was actually reclaimed
 */
export function releaseHeld() {
  if (live > 0) return false;
  held.clear();
  next = 0;
  return true;
}

/**
 * Park a tree and get the token that stands for it.
 *
 * `id` names the tree by what it IS rather than by when it was parked, and a
 * caller that can say so should. A token travels in the text a document hands
 * back, and reaches its parent inside `req` — so the token IS part of the
 * parent's input, and a cache keyed on that input is only correct if the token
 * changes whenever the tree behind it does. Sequential numbering does not: two
 * builds either side of an edit both call the article's render fifth, both get
 * `5`, and the parent's input looks untouched while its content changed. That
 * is a stale page, not a slow one. `$.render` passes the key of the render
 * that made the tree (see mdy.js), which changes exactly when the document,
 * its data, or its own input does.
 *
 * Without an `id` the counter still applies — for a tree a document built
 * itself (`$.node`, `$.table`), which never leaves that document's own
 * composition, and so has nothing to be stale to.
 *
 * @param {import('hast').Root | import('hast').ElementContent} tree
 * @param {string} [id] stable identity for the tree, if the caller has one
 * @returns {string}
 */
export function hold(tree, id) {
  const key = id === undefined ? String(next++) : id;
  held.set(key, { kind: 'tree', tree });
  return OPEN + key + CLOSE;
}

/**
 * A token standing for "this document's own table of contents", filled in
 * once the document has one — after its code has run and its transforms have
 * had the tree, so a contents list at the top can name a heading written
 * below it by a loop.
 *
 * @returns {string}
 */
export function holdToc() {
  const id = String(next++);
  held.set(id, { kind: 'toc' });
  return OPEN + id + CLOSE;
}

/**
 * The tree a string stands for, when the string is nothing but one token.
 *
 * A token is how a finished tree travels through a document's own code, so
 * anything that takes "a tree" has to take one of these too — `$.toc` handed
 * the result of a `$.render` is asking about that document, not about a few
 * private-use characters.
 *
 * @param {unknown} value
 * @returns {import('hast').Root | undefined}
 */
export function heldTree(value) {
  if (typeof value !== 'string') return undefined;

  const match = ONE_TOKEN.exec(value);
  const entry = match ? held.get(match[1]) : undefined;

  return entry?.kind === 'tree' ? entry.tree : undefined;
}

/** @returns {boolean} */
export function hasToken(value) {
  return typeof value === 'string' && value.includes(OPEN);
}

/**
 * Replace every token in a string with what `resolve` makes of what it holds.
 *
 * This is the string-shaped half of composition: a token that reaches text
 * rather than a tree — `$.emit`'s content, an attribute, a JSON payload —
 * becomes HTML, because a string is what the thing asking for it can hold.
 *
 * @param {string} value
 * @param {(entry: {kind: string, tree?: object}) => string} resolve
 * @returns {string}
 */
export function fillTokens(value, resolve) {
  return String(value).replace(TOKEN, (match, id) => {
    const entry = held.get(id);
    return entry ? resolve(entry) : match;
  });
}

/**
 * Put held trees back into a parsed tree, wherever their tokens landed.
 *
 * Two shapes, decided by where the token ended up rather than by anything the
 * author had to declare:
 *
 *   A paragraph holding nothing but tokens — one, or a run of them a loop
 *   wrote on consecutive lines — is those documents standing on their own, so
 *   the paragraph goes and the held trees' own children take its place:
 *   headings stay headings, lists stay lists.
 *
 *   A token in the middle of a sentence is that document standing inside a
 *   line of prose, so its blocks are unwrapped to their content and spliced
 *   where the token was. A paragraph inside a paragraph is not a thing hast
 *   can hold, and this is the honest reading of what was written.
 *
 * `toc` entries are left where they are: they cannot be filled until the
 * whole tree exists, which is after the transforms have run (see spliceToc).
 *
 * @param {import('hast').Parent} parent
 * @returns {import('hast').Parent}
 */
export function splice(parent) {
  if (!parent || !Array.isArray(parent.children)) return parent;

  const out = [];

  for (const child of parent.children) {
    const only = onlyTokens(child);

    if (only) {
      let filled = false;

      for (const id of only) {
        const entry = held.get(id);

        if (entry?.kind === 'tree') {
          out.push(...blockContent(entry.tree));
          filled = true;
        }
      }

      if (filled) continue;
    }

    if (child.type === 'text' && hasToken(child.value)) {
      out.push(...inlineContent(child.value));
      continue;
    }

    if (Array.isArray(child.children)) splice(child);
    out.push(child);
  }

  parent.children = out;
  return parent;
}

/**
 * Fill in every `toc` token with a link list of the tree's own headings.
 *
 * Run last, on the finished tree: the ids are the ones mdy's parser gave the
 * headings, so every link lands without anything having to agree with
 * anything.
 *
 * @param {import('hast').Root} tree
 * @returns {import('hast').Root}
 */
export function spliceToc(tree) {
  const entries = [];

  collectHeadings(tree, entries);

  const fill = (parent) => {
    if (!parent || !Array.isArray(parent.children)) return;

    const out = [];

    for (const child of parent.children) {
      const only = onlyTokens(child);
      const entry = only?.length === 1 ? held.get(only[0]) : undefined;

      if (entry?.kind === 'toc') {
        const list = tocList(entries);
        if (list) out.push(list);
        continue;
      }

      fill(child);
      out.push(child);
    }

    parent.children = out;
  };

  fill(tree);
  return tree;
}

/**
 * The headings of a tree, in document order, with the ids they carry.
 *
 * @param {import('hast').Node} node
 * @param {Array<{depth: number, text: string, id: string | undefined}>} entries
 */
function collectHeadings(node, entries) {
  const tag = node.tagName ?? '';

  if (/^h[1-6]$/.test(tag)) {
    entries.push({
      depth: Number(tag.slice(1)),
      text: textOf(node),
      id: node.properties?.id,
    });
  }

  for (const child of node.children ?? []) collectHeadings(child, entries);
}

/**
 * A nested `<ul>` of headings, or nothing when there are none.
 *
 * @param {Array<{depth: number, text: string, id: string | undefined}>} entries
 * @returns {import('hast').Element | undefined}
 */
function tocList(entries) {
  const listed = entries.filter((entry) => entry.id !== undefined);
  if (listed.length === 0) return undefined;

  const min = Math.min(...listed.map((entry) => entry.depth));
  const root = { type: 'element', tagName: 'ul', properties: {}, children: [] };
  // One list per depth, the deepest last: a heading goes in the list at its
  // own level, and a level that opens goes inside the item above it.
  const stack = [{ depth: min, list: root }];

  for (const entry of listed) {
    while (stack.length > 1 && entry.depth < stack.at(-1).depth) stack.pop();

    while (entry.depth > stack.at(-1).depth) {
      const above = stack.at(-1).list.children.at(-1);
      const nested = { type: 'element', tagName: 'ul', properties: {}, children: [] };

      if (above) above.children.push(nested);
      else stack.at(-1).list.children.push({ type: 'element', tagName: 'li', properties: {}, children: [nested] });

      stack.push({ depth: stack.at(-1).depth + 1, list: nested });
    }

    stack.at(-1).list.children.push({
      type: 'element',
      tagName: 'li',
      properties: {},
      children: [
        {
          type: 'element',
          tagName: 'a',
          properties: { href: '#' + entry.id },
          children: [{ type: 'text', value: entry.text }],
        },
      ],
    });
  }

  return root;
}

/**
 * The tokens a node holds, when tokens and whitespace are all it holds.
 *
 * A loop writing one `{{ $.render(…) }}` per line leaves a run of them in one
 * paragraph, because consecutive lines are one paragraph — and a paragraph
 * saying nothing but "these documents go here" is a block position, not a
 * sentence with something in the middle of it.
 *
 * @param {import('hast').RootContent} node
 * @returns {Array<string> | undefined}
 */
function onlyTokens(node) {
  const text =
    node.type === 'text'
      ? node.value
      : node.type === 'element' &&
          node.tagName === 'p' &&
          node.children.length === 1 &&
          node.children[0].type === 'text'
        ? node.children[0].value
        : undefined;

  if (text === undefined) return undefined;
  if (!ONLY_TOKENS.test(text)) return undefined;

  return [...text.matchAll(TOKEN)].map((match) => match[1]);
}

/**
 * What a held tree contributes where a block was expected.
 *
 * @param {import('hast').Root} tree
 * @returns {Array<import('hast').RootContent>}
 */
function blockContent(tree) {
  return tree.type === 'root' ? tree.children : [tree];
}

/**
 * A run of text holding tokens, as the inline content it becomes.
 *
 * @param {string} value
 * @returns {Array<import('hast').ElementContent>}
 */
function inlineContent(value) {
  const out = [];
  let last = 0;

  for (const match of String(value).matchAll(TOKEN)) {
    if (match.index > last) out.push({ type: 'text', value: value.slice(last, match.index) });

    const entry = held.get(match[1]);

    if (entry?.kind === 'tree') {
      // A block cannot sit inside a sentence, so it gives up its wrapper and
      // lends its content instead — as far down as the blocks go, since
      // unwrapping a `<div>` only to find a `<p>` under it has solved
      // nothing. What is left is phrasing content, which is what a sentence
      // can actually hold.
      out.push(...unwrap(blockContent(entry.tree)));
    } else {
      out.push({ type: 'text', value: match[0] });
    }

    last = match.index + match[0].length;
  }

  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });

  return out;
}

// Elements that hold a line of their own, and so cannot hold one of somebody
// else's — the ones a nested render is likely to produce at its top level.
const block = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'footer']);

/**
 * Block wrappers off, phrasing content out, and the newlines between blocks
 * with them — those were the tree's own spacing, not the sentence's.
 *
 * @param {Array<import('hast').RootContent>} children
 * @returns {Array<import('hast').ElementContent>}
 */
function unwrap(children) {
  const out = [];

  for (const child of children) {
    if (child.type === 'element' && block.has(child.tagName)) {
      out.push(...unwrap(child.children));
    } else if (child.type === 'text' && child.value.trim() === '') {
      continue;
    } else {
      out.push(child);
    }
  }

  return out;
}

/**
 * All the text under a node.
 *
 * @param {import('hast').Node} node
 * @returns {string}
 */
function textOf(node) {
  if (!node) return '';
  if (node.type === 'text') return node.value;
  if (node.type === 'comment' || node.type === 'doctype') return '';

  return (node.children ?? []).map(textOf).join('');
}
