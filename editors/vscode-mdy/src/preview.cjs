'use strict';

/*
 * Pure helpers behind the preview panel — everything extension.cjs's
 * webview adapter needs that does not touch the vscode API, unit-tested
 * directly (test/preview.test.js) with no VSCode install. Same split as
 * structure.cjs: logic here, adapter there.
 *
 * The preview shows exactly what `mdy <file> --html` prints: the file's
 * own `---`-split documents form a set, the FIRST document is the entry,
 * and its generated markdown goes through the same markdown-it
 * configuration (createProcessor). Like the CLI's file input, the file
 * renders alone — no site walk, no access to sibling files.
 *
 * The engine loads from one of two places, workspace first:
 * resolveEnginePackage finds the mdy-docs package the previewed file
 * actually lives with (nearest node_modules/mdy-docs walking up from the
 * file, or a checkout of mdy-docs itself), the way the eslint/prettier
 * extensions resolve their library from the workspace — so a project
 * that carries the engine previews with its OWN version, not a copy
 * frozen at extension-build time. When no workspace engine exists (any
 * random .mdy file, an unsaved buffer), the adapter falls back to the
 * engine bundled into the extension's dist/ (scripts/bundle-engine.mjs),
 * so every .mdy previews regardless of context.
 */

const { join, dirname } = require('node:path');

/**
 * Walk up from `startDir` to the mdy-docs package the previewed file lives
 * with: the nearest `node_modules/mdy-docs` wins; a directory whose own
 * package.json is named `mdy-docs` (a checkout of the repo itself — which
 * is what makes examples/**.mdy previewable in this repo) counts the same.
 *
 * `io` is injected ({ isFile(path), readText(path) }) so tests drive this
 * against a fake filesystem; extension.cjs passes node:fs equivalents.
 *
 * @returns {string | null} the package directory, or null if no engine found
 */
function resolveEnginePackage(startDir, io) {
  for (let dir = startDir; ; dir = dirname(dir)) {
    const installed = join(dir, 'node_modules', 'mdy-docs');
    if (io.isFile(join(installed, 'package.json'))) return installed;
    const pkgPath = join(dir, 'package.json');
    if (io.isFile(pkgPath)) {
      try {
        if (JSON.parse(io.readText(pkgPath)).name === 'mdy-docs') return dir;
      } catch {
        // unparseable package.json: not the engine, keep walking
      }
    }
    if (dirname(dir) === dir) return null;
  }
}

/**
 * The module to import from a resolved engine package. src/mdy.js is
 * preferred over index.js: it carries everything the preview needs
 * (openDocumentSet, createProcessor) without pulling the whole static-site
 * and image-codec layer into the extension host; index.js is the fallback
 * so a future engine that reshapes src/ still previews.
 */
function engineEntry(pkgDir, io) {
  const direct = join(pkgDir, 'src', 'mdy.js');
  return io.isFile(direct) ? direct : join(pkgDir, 'index.js');
}

/**
 * One render pass, the CLI's file-input pipeline exactly (bin/mdy.js):
 * the source's own documents form a set, document 0 is the entry, its
 * markdown renders to HTML. $.emit output has nowhere to go in a preview,
 * so emitted paths are just collected for the adapter to report (the CLI
 * prints the equivalent "not written" notice).
 *
 * @param {object} engine the imported mdy module (openDocumentSet, createProcessor)
 * @param {string} text the .mdy source
 * @param {object} [context] extra context, overrides front matter (CLI: -d/--data-file)
 * @returns {Promise<{ html: string, emittedPaths: string[] }>}
 */
async function renderPreview(engine, text, context = {}) {
  const emittedPaths = [];
  const set = await engine.openDocumentSet(text, {
    onEmit: ({ path }) => emittedPaths.push(path),
  });
  const markdown = await set.render(0, context);
  return { html: engine.createProcessor().md.render(markdown), emittedPaths };
}

/** Minimal HTML text escaping for error messages and notes. */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Rewrite relative resource URLs in rendered HTML through `rewrite` —
 * the adapter maps them to webview URIs (a webview cannot load plain
 * file paths). Only embedded-resource attributes are touched (img/video/
 * audio/source/track/embed src and poster): links stay as authored, and
 * values that already carry a scheme (https:, data:, vscode-webview:),
 * are protocol-relative, or are fragment-only pass through untouched.
 * Root-absolute values ARE handed to `rewrite` — what "/" means (the
 * workspace root, here) is the adapter's call, not this function's.
 */
function rewriteResourceUrls(html, rewrite) {
  const attr = /(<(?:img|source|video|audio|track|embed)\b[^>]*?\s(?:src|poster)\s*=\s*)("([^"]*)"|'([^']*)')/gi;
  return html.replace(attr, (match, prefix, quoted, dq, sq) => {
    const value = dq ?? sq;
    if (value === '' || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)) return match;
    const q = quoted[0];
    return `${prefix}${q}${escapeHtml(rewrite(value))}${q}`;
  });
}

/** A render failure, shown in place of content — the preview's version of the CLI's red stderr line. */
function errorHtml(message) {
  return `<div class="mdy-error"><strong>mdy: render failed</strong><pre>${escapeHtml(message)}</pre></div>`;
}

/** Footnote listing $.emit output the preview had nowhere to write — mirrors the CLI's "not written" notice. */
function emitNoteHtml(paths) {
  if (paths.length === 0) return '';
  return `<p class="mdy-emit-note">${paths.length} file(s) emitted via $.emit — not written by the preview: ${escapeHtml(paths.join(', '))}</p>`;
}

/**
 * The full webview document. The initial body is embedded directly (a
 * message posted before the webview finishes loading would be dropped);
 * later renders arrive as `{ type: 'update', body }` messages so the
 * scroll position survives re-renders while typing. Updates land via
 * innerHTML, which never executes scripts — combined with the CSP
 * (scripts only by nonce, resources only through the webview origin)
 * that keeps document-authored HTML inert.
 */
function previewShellHtml({ body, nonce, cspSource }) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https: data:; media-src ${cspSource} https: data:; style-src 'unsafe-inline'; font-src ${cspSource}; script-src 'nonce-${nonce}';">
<style>
  body {
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    font-size: 14px;
    line-height: 1.6;
    color: var(--vscode-editor-foreground);
    background: transparent;
    margin: 0 auto;
    padding: 0 26px 26px;
    max-width: 60em;
    word-wrap: break-word;
  }
  h1 { padding-bottom: 0.3em; border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(136, 136, 136, 0.4)); }
  a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  a:hover { text-decoration: underline; }
  img, video { max-width: 100%; }
  code, pre {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
    background-color: var(--vscode-textCodeBlock-background, rgba(136, 136, 136, 0.15));
    border-radius: 3px;
  }
  code { padding: 0.1em 0.3em; }
  pre { padding: 0.8em 1em; overflow-x: auto; }
  pre code { padding: 0; background: none; }
  blockquote {
    margin: 0 0 1em;
    padding: 0.2em 1em;
    border-left: 4px solid var(--vscode-textBlockQuote-border, rgba(136, 136, 136, 0.4));
    background: var(--vscode-textBlockQuote-background, transparent);
  }
  hr { border: none; border-top: 1px solid var(--vscode-editorWidget-border, rgba(136, 136, 136, 0.4)); }
  table { border-collapse: collapse; }
  th, td { padding: 0.3em 0.8em; border: 1px solid var(--vscode-editorWidget-border, rgba(136, 136, 136, 0.4)); }
  .mdy-error {
    margin: 1em 0;
    padding: 0.5em 1em;
    border-left: 4px solid var(--vscode-editorError-foreground, #f48771);
  }
  .mdy-error pre { white-space: pre-wrap; background: none; padding: 0; }
  .mdy-emit-note {
    margin-top: 2em;
    padding-top: 0.5em;
    border-top: 1px solid var(--vscode-editorWidget-border, rgba(136, 136, 136, 0.4));
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
  }
</style>
</head>
<body>
<main id="content">${body}</main>
<script nonce="${nonce}">
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message && message.type === 'update') {
      document.getElementById('content').innerHTML = message.body;
    }
  });
</script>
</body>
</html>`;
}

module.exports = {
  resolveEnginePackage,
  engineEntry,
  renderPreview,
  rewriteResourceUrls,
  escapeHtml,
  errorHtml,
  emitNoteHtml,
  previewShellHtml,
};
