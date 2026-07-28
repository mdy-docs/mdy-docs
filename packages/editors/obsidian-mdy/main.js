/*
 * mdy for Obsidian — .mdy files open in a custom view with two modes:
 * a live rendered PREVIEW of the whole document set (the real engine:
 * `---`-split documents, front matter, ```data fences, #hashtags, the $
 * query API, template tags running sandboxed in WebAssembly), and a plain
 * SOURCE editor. Edits auto-save through Obsidian's normal TextFileView
 * machinery; the preview re-renders debounced as you type.
 *
 * The engine is the SAME bundle the vscode extension ships, converted to
 * CommonJS for Electron's renderer (dist/mdy-engine.cjs + lamassu.wasm +
 * nisaba.wasm — see scripts/build.mjs for why import() and fetch() are
 * both unusable here). require() of an absolute path is why this plugin
 * is desktop-only.
 *
 * Like the vscode preview and the CLI's file input, a file renders ALONE:
 * its own documents form the set, the first is the entry — no vault walk,
 * no access to sibling notes. Template code runs inside the wasm sandbox
 * and can reach exactly two things: the document's data and the $ API —
 * never the vault, never the app.
 */
const { Plugin, TextFileView, Notice } = require('obsidian');

const VIEW_TYPE = 'mdy-view';

class MdyView extends TextFileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.mode = 'preview'; // 'preview' | 'source'
    this.data = '';
    this.renderTimer = null;
    this.renderVersion = 0;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return this.file ? this.file.basename : 'mdy';
  }

  getIcon() {
    return 'braces';
  }

  getViewData() {
    return this.data;
  }

  setViewData(data, clear) {
    this.data = data;
    if (this.sourceEl && this.sourceEl.value !== data) this.sourceEl.value = data;
    this.scheduleRender(0);
  }

  clear() {
    this.data = '';
    if (this.sourceEl) this.sourceEl.value = '';
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('mdy-view');

    this.previewEl = root.createDiv({ cls: 'mdy-preview markdown-rendered' });
    this.sourceEl = root.createEl('textarea', { cls: 'mdy-source' });
    this.sourceEl.setAttr('spellcheck', 'false');
    this.sourceEl.addEventListener('input', () => {
      this.data = this.sourceEl.value;
      this.requestSave();
      this.scheduleRender(400);
    });

    this.modeAction = this.addAction('code-2', 'Toggle source / preview', () => this.toggleMode());
    this.applyMode();
  }

  toggleMode() {
    this.mode = this.mode === 'preview' ? 'source' : 'preview';
    this.applyMode();
  }

  applyMode() {
    const preview = this.mode === 'preview';
    this.previewEl.toggleClass('mdy-hidden', !preview);
    this.sourceEl.toggleClass('mdy-hidden', preview);
    if (preview) this.scheduleRender(0);
    else this.sourceEl.focus();
  }

  scheduleRender(delay) {
    if (this.mode !== 'preview' && delay !== 0) return; // source mode: render on switch instead
    clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => this.renderPreview(), delay);
  }

  async renderPreview() {
    const version = ++this.renderVersion;
    let html;
    try {
      const engine = await this.plugin.loadEngine();
      html = await engine.render(this.data);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      if (version !== this.renderVersion) return;
      this.previewEl.empty();
      this.previewEl.createEl('pre', { cls: 'mdy-error', text: message });
      return;
    }
    if (version !== this.renderVersion) return; // superseded by newer keystrokes
    // The rendered document is the user's own vault file — the same trust
    // boundary as Obsidian rendering their markdown. Template code itself
    // ran sandboxed in wasm and cannot emit anything the file's author
    // didn't write.
    this.previewEl.innerHTML = html;
  }

  async onClose() {
    clearTimeout(this.renderTimer);
  }
}

module.exports = class MdyPlugin extends Plugin {
  async onload() {
    this.enginePromise = null;
    this.registerView(VIEW_TYPE, (leaf) => new MdyView(leaf, this));
    try {
      this.registerExtensions(['mdy'], VIEW_TYPE);
    } catch (err) {
      new Notice('mdy: .mdy extension already registered by another plugin');
    }
    this.addCommand({
      id: 'toggle-mode',
      name: 'Toggle source / preview',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MdyView);
        if (!view) return false;
        if (!checking) view.toggleMode();
        return true;
      },
    });
  }

  /** The engine, require()d once from the plugin's own dist/ — CommonJS,
   * because the renderer blocks dynamic import() of file URLs (see
   * scripts/build.mjs); its wasm loads via Node fs beside it. */
  loadEngine() {
    if (!this.enginePromise) {
      const adapter = this.app.vault.adapter;
      if (typeof adapter.getBasePath !== 'function') {
        return Promise.reject(new Error('mdy needs the desktop app (file-system vault)'));
      }
      const entry = `${adapter.getBasePath()}/${this.manifest.dir}/dist/mdy-engine.cjs`;
      this.enginePromise = Promise.resolve().then(() => require(entry));
      this.enginePromise.catch(() => (this.enginePromise = null));
    }
    return this.enginePromise;
  }

  onunload() {}
};
