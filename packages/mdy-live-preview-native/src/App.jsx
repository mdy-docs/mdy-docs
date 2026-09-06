import { useCallback, useEffect, useRef, useState } from 'react';

import { Editor } from './Editor.jsx';
import { Preview } from './Preview.jsx';
import { Messages } from './Messages.jsx';
import { SplitDivider } from './SplitDivider.jsx';
import { defaultInput } from './default-input.js';
import { setupMdyLanguage } from './monaco-mdy.js';
import { storage, useDebounced, useStored, useTemporary } from './hooks.js';
import { useNative } from './useNative.js';
import { usesMessaging } from './native.js';

const CONTENT_KEY = 'last_state';
const SCROLL_KEY = 'scroll_bar_settings';
const THEME_KEY = 'theme';
const CONFIRM_RESET = 'Are you sure you want to reset? Your changes will be lost.';

const PREVIEW_CSS = {
  light: 'css/github-markdown-light.css',
  dark: 'css/github-markdown-dark_dimmed.css',
};
// The engine highlights fenced code itself, with highlight.js's classes.
const HLJS_CSS = {
  light: 'css/hljs-light.css',
  dark: 'css/hljs-dark.css',
};

const boolStore = { encode: (v) => (v ? '1' : '0'), decode: (v) => v === '1' };
const themeStore = { encode: (v) => v, decode: (v) => (v === 'dark' ? 'dark' : 'light') };

export function App() {
  const [languageReady, setLanguageReady] = useState(false);
  const [source, setSource] = useState(() => storage.get(CONTENT_KEY) ?? defaultInput);
  const [theme, setTheme] = useStored(THEME_KEY, 'light', themeStore);
  const [syncScroll, setSyncScroll] = useStored(SCROLL_KEY, false, boolStore);
  const [leftRatio, setLeftRatio] = useState(0.5);
  const [copyLabel, flashCopyLabel] = useTemporary('Copy', 1000);
  const [hasEdited, setHasEdited] = useState(false);

  const editor = useRef(null);
  const preview = useRef(null);

  // The engine still has to run the template on every change, so the source
  // reaching the preview trails the keystrokes. Everything else — theme,
  // layout, the error bar — is immediate.
  const debouncedSource = useDebounced(source, 200);

  // One run of the engine per settled source: the document's HTML and, if
  // it publishes, what its messages caused — the C does both in one pass.
  const render = useNative(debouncedSource);

  useEffect(() => {
    setupMdyLanguage().then(() => setLanguageReady(true));
  }, []);

  // The document, the theme attribute and the github-markdown stylesheet are
  // the three pieces of state that live outside the React tree.
  useEffect(() => {
    storage.set(CONTENT_KEY, source);
  }, [source]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    const link = document.getElementById('gh-markdown-link');
    if (link) link.setAttribute('href', PREVIEW_CSS[theme]);
    const hljs = document.getElementById('hljs-link');
    if (hljs) hljs.setAttribute('href', HLJS_CSS[theme]);
  }, [theme]);

  const handleChange = useCallback((value) => {
    setSource(value);
    setHasEdited(true);
  }, []);

  const handleScrollRatio = useCallback(
    (ratio) => {
      if (!syncScroll || !preview.current) return;
      const pane = preview.current;
      pane.scrollTo(0, (pane.scrollHeight - pane.clientHeight) * ratio);
    },
    [syncScroll],
  );

  const reset = () => {
    if ((hasEdited || source !== defaultInput) && !window.confirm(CONFIRM_RESET)) return;
    setSource(defaultInput);
    setHasEdited(false);
    editor.current?.setValue(defaultInput);
    preview.current?.scrollTo({ top: 0 });
  };

  const copy = () => {
    navigator.clipboard.writeText(source).then(
      () => flashCopyLabel('Copied!'),
      () => {},
    );
  };

  return (
    <>
      <header>
        <div id="menu-items">
          <div>
            <a href="/">MDY Live Preview</a>
            <span className="engine-note"> · native — the C engine, as WebAssembly</span>
          </div>
          <div id="reset-button">
            <a
              href="#"
              onClick={(event) => {
                event.preventDefault();
                reset();
              }}
            >
              Reset
            </a>
          </div>
          <div id="copy-button">
            <a
              href="#"
              onClick={(event) => {
                event.preventDefault();
                copy();
              }}
            >
              {copyLabel}
            </a>
          </div>
          <div id="sync-button">
            <input
              type="checkbox"
              id="sync-scroll-checkbox"
              checked={syncScroll}
              onChange={(event) => setSyncScroll(event.currentTarget.checked)}
            />
            <label htmlFor="sync-scroll-checkbox">Sync scroll</label>
            <span style={{ marginLeft: 12 }}>
              <input
                type="checkbox"
                id="theme-checkbox"
                checked={theme === 'dark'}
                onChange={(event) => setTheme(event.currentTarget.checked ? 'dark' : 'light')}
              />
              <label htmlFor="theme-checkbox">Dark mode</label>
            </span>
          </div>
        </div>
        <div id="github">
          <a href="https://github.com/mdy-docs/mdy-docs">
            <img src="image/GitHub-Mark-Light-32px.webp" alt="GitHub" />
          </a>
        </div>
      </header>

      <div id="container" className="split-container">
        <div id="edit" className="column editor-pane" style={{ width: `${leftRatio * 100}%` }}>
          {languageReady && (
            <Editor
              ref={editor}
              defaultValue={source}
              theme={theme}
              onChange={handleChange}
              onScrollRatio={handleScrollRatio}
            />
          )}
        </div>

        <SplitDivider onRatio={setLeftRatio} />

        <div
          id="preview"
          className="column preview-pane"
          ref={preview}
          style={{ width: `${(1 - leftRatio) * 100}%` }}
        >
          {/* The error bar, rather than an error *page*: a template error
              while typing leaves the last good render underneath it, so the
              document you are editing stays on screen and in place. The old
              build replaced the whole pane with the message. */}
          {render.error && <div className="mdy-error-bar">{render.error}</div>}
          <div id="preview-wrapper">
            <div
              id="output"
              className={`content markdown-body${render.error ? ' is-stale' : ''}`}
            >
              <Preview html={render.html} theme={theme} />
            </div>
            {/* Below the document rather than beside it: a message is
                something the document DID, and reads as a consequence of
                what is above it. Absent entirely unless the source
                publishes. */}
            <Messages
              active={usesMessaging(debouncedSource)}
              messages={render.messages}
              running={render.pending}
              error={null}
            />
          </div>
        </div>
      </div>
    </>
  );
}
