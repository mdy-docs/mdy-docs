'use strict';

/*
 * Runtime entry point (the grammar/language-configuration side of the
 * extension is fully declarative and needs none of this). What code buys:
 *
 *   - Folding: each front-matter block folds to its first line.
 *     Declarative folding.markers can't express this — markers want
 *     distinct begin/end delimiters, and the block runs from a chunk
 *     boundary to a lone +++. (Per-DOCUMENT folding was tried and
 *     removed — see foldingRanges' doc in src/structure.cjs.)
 *   - Outline: one symbol per document, named by its front-matter
 *     `title:` (falling back to `document N`), with the ENGINE's document
 *     index as the detail — the `i` a template passes to $.render(i) /
 *     $.data(i). This is what makes multi-document files navigable:
 *     Outline panel, breadcrumbs, Ctrl+Shift+O, sticky scroll.
 *   - Preview: a webview panel rendering the file the way `mdy <file>
 *     --html` does — the file's own documents as a set, document 0 the
 *     entry — live-updated as you type. The engine comes from the
 *     previewed file's own project when it has one (see src/preview.cjs),
 *     falling back to the copy bundled into dist/ so any .mdy anywhere
 *     previews. Like the built-in markdown preview, the panel follows
 *     the active editor: focusing a different .mdy file retargets it.
 *
 * All logic lives in src/structure.cjs and src/preview.cjs (pure,
 * engine-mirroring, unit-tested); this file only adapts them to the
 * vscode API, and stays untested-by-design — keep it too thin to be
 * worth testing.
 */

const vscode = require('vscode');
const { randomBytes } = require('node:crypto');
const { statSync, readFileSync } = require('node:fs');
const { basename, dirname, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { scanDocuments, foldingRanges } = require('./src/structure.cjs');
const {
  resolveEnginePackage,
  engineEntry,
  renderPreview,
  rewriteResourceUrls,
  errorHtml,
  emitNoteHtml,
  previewShellHtml,
} = require('./src/preview.cjs');

// preview.cjs's injected filesystem — the pure layer never touches node:fs.
const io = {
  isFile: (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  readText: (path) => readFileSync(path, 'utf8'),
};

// The engine bundled into the extension (scripts/bundle-engine.mjs, built
// by `npm test` / vscode:prepublish) — the fallback that makes any .mdy
// file previewable, workspace engine or not.
const bundledEngine = join(__dirname, 'dist', 'mdy-engine.mjs');

// One import per engine entry file, cached as its promise — every preview
// of files under the same project shares the same loaded engine. A
// workspace-resolved engine is preferred over the bundled one so the
// preview matches the engine version the project actually builds with.
const engines = new Map();
function engineFor(startDir) {
  const pkg = startDir ? resolveEnginePackage(startDir, io) : null;
  const entry = pkg ? engineEntry(pkg, io) : bundledEngine;
  if (!engines.has(entry)) {
    if (!io.isFile(entry)) {
      throw new Error(
        'bundled engine missing (a development-install only state) — build it with: npm run bundle-engine'
      );
    }
    engines.set(entry, import(pathToFileURL(entry).href));
  }
  return engines.get(entry);
}

/** Render one pass of `document` to a webview-ready body (never throws — errors become the body). */
async function previewBody(document, webview) {
  const fileDir = document.uri.scheme === 'file' ? dirname(document.uri.fsPath) : null;
  const workspaceDir = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? null;
  try {
    // startDir may be null (an unsaved buffer outside any workspace) —
    // engineFor then skips workspace resolution and goes straight to the
    // bundled engine, so such buffers still preview.
    const engine = await engineFor(fileDir ?? workspaceDir);
    const { html, emittedPaths } = await renderPreview(engine, document.getText());
    // Relative resources resolve against the file, root-absolute ones
    // against the workspace folder — then through asWebviewUri, since a
    // webview cannot load plain file paths. An unsaved buffer has no base
    // to resolve against, so its URLs stay as authored.
    const rewritten = rewriteResourceUrls(html, (src) => {
      const base = src.startsWith('/') ? (workspaceDir ?? fileDir) : fileDir;
      if (!base) return src;
      const target = src.startsWith('/') ? src.slice(1) : src;
      return webview.asWebviewUri(vscode.Uri.file(join(base, target))).toString();
    });
    return rewritten + emitNoteHtml(emittedPaths);
  } catch (err) {
    return errorHtml(err?.message ?? err);
  }
}

function registerPreview(context) {
  // ONE panel, following the active editor — the built-in markdown
  // preview's behavior: switching to another .mdy editor retargets the
  // panel to that document; switching to anything else leaves it showing
  // the last previewed file.
  let panel = null;
  let current = null; // uri string of the document the panel is showing
  let timer = null;

  const webviewOptions = (document) => ({
    enableScripts: true,
    // Relative resources resolve against the previewed file, so its
    // directory must be a resource root even outside the workspace.
    localResourceRoots: [
      ...(vscode.workspace.workspaceFolders?.map((f) => f.uri) ?? []),
      ...(document.uri.scheme === 'file' ? [vscode.Uri.file(dirname(document.uri.fsPath))] : []),
    ],
  });

  /** Point the panel at `document`: retitle, re-root, render. */
  async function retarget(document) {
    current = document.uri.toString();
    clearTimeout(timer);
    panel.title = `Preview ${basename(document.uri.path)}`;
    panel.webview.options = webviewOptions(document);
    panel.webview.postMessage({ type: 'update', body: await previewBody(document, panel.webview) });
  }

  /**
   * The two commands differ only in placement, mirroring the built-in
   * markdown pair: "to the Side" opens Beside without stealing focus,
   * plain "Open Preview" opens full-size in the active group and takes
   * focus. An existing panel is revealed in the requested column (so the
   * full-size command pulls a side preview into the editor's group).
   */
  async function showPreview(document, viewColumn, preserveFocus) {
    if (panel) {
      panel.reveal(viewColumn, preserveFocus);
      if (document.uri.toString() !== current) await retarget(document);
      return;
    }

    panel = vscode.window.createWebviewPanel(
      'mdy.preview',
      `Preview ${basename(document.uri.path)}`,
      { viewColumn, preserveFocus },
      {
        ...webviewOptions(document),
        // Keep the webview alive while hidden: updates arrive as messages
        // (scroll position survives), and a recreated webview would show
        // the stale initial html.
        retainContextWhenHidden: true,
      }
    );
    current = document.uri.toString();

    panel.webview.html = previewShellHtml({
      body: await previewBody(document, panel.webview),
      nonce: randomBytes(16).toString('hex'),
      cspSource: panel.webview.cspSource,
    });

    // Editors fire many change events while typing; debounce into one
    // render, same 100ms the CLI's --watch uses (templates are cheap to
    // run — sandboxed wasm — but not free).
    const changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() !== current) return;
      const changed = event.document;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        panel.webview.postMessage({ type: 'update', body: await previewBody(changed, panel.webview) });
      }, 100);
    });

    // The follow behavior itself. activeTextEditor goes through undefined
    // (and to non-mdy editors, including the panel taking focus) on every
    // switch — only a DIFFERENT mdy document retargets.
    const editorListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
      const doc = editor?.document;
      if (doc?.languageId === 'mdy' && doc.uri.toString() !== current) retarget(doc);
    });

    panel.onDidDispose(() => {
      clearTimeout(timer);
      changeListener.dispose();
      editorListener.dispose();
      panel = null;
      current = null;
    });
  }

  const previewCommand = (viewColumn, preserveFocus) => () => {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId === 'mdy') {
      showPreview(editor.document, viewColumn, preserveFocus);
    }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('mdy.showPreview', previewCommand(vscode.ViewColumn.Active, false)),
    vscode.commands.registerCommand(
      'mdy.showPreviewToSide',
      previewCommand(vscode.ViewColumn.Beside, true)
    )
  );
}

function activate(context) {
  const selector = { language: 'mdy' };

  context.subscriptions.push(
    vscode.languages.registerFoldingRangeProvider(selector, {
      provideFoldingRanges(document) {
        return foldingRanges(document.getText().split('\n')).map(
          (r) => new vscode.FoldingRange(r.start, r.end, vscode.FoldingRangeKind.Region)
        );
      },
    }),

    vscode.languages.registerDocumentSymbolProvider(selector, {
      provideDocumentSymbols(document) {
        const lines = document.getText().split('\n');
        const lineRange = (n) => new vscode.Range(n, 0, n, lines[n].length);
        return scanDocuments(lines).map((doc) => {
          const first = doc.separatorLine ?? doc.startLine;
          const range = new vscode.Range(first, 0, doc.endLine, lines[doc.endLine].length);
          return new vscode.DocumentSymbol(
            doc.title ?? `document ${doc.index}`,
            `#${doc.index}`,
            vscode.SymbolKind.File,
            range,
            lineRange(doc.titleLine ?? doc.startLine)
          );
        });
      },
    })
  );

  registerPreview(context);
}

function deactivate() {}

module.exports = { activate, deactivate };
