import { useEffect, useImperativeHandle, useRef } from 'react';
import * as monaco from 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/+esm';

// Monaco owns its own DOM and its own model, so it stays imperative — a
// component that creates it once, hands it a node, and disposes it. Wrapping
// it in React is not the interesting half of this app; the preview pane is.
export function Editor({ ref, defaultValue, theme, onChange, onScrollRatio }) {
  const host = useRef(null);
  const editor = useRef(null);

  // Read once, at creation. Monaco owns the buffer from then on — treating
  // this as a controlled value would fight the editor for the cursor.
  const initial = useRef(defaultValue);

  // The editor is created once. Callbacks are read through refs so a new
  // closure on a parent render never means tearing down the editor — that
  // would drop the cursor, the undo stack and the selection on every
  // keystroke.
  const handlers = useRef({ onChange, onScrollRatio });
  handlers.current = { onChange, onScrollRatio };

  useImperativeHandle(ref, () => ({
    getValue: () => editor.current?.getValue() ?? '',
    setValue: (value) => {
      const instance = editor.current;
      if (!instance) return;
      instance.setValue(value);
      instance.revealPosition({ lineNumber: 1, column: 1 });
      instance.focus();
    },
  }));

  useEffect(() => {
    const instance = monaco.editor.create(host.current, {
      value: initial.current,
      fontSize: 14,
      language: 'mdy',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      scrollbar: { vertical: 'visible', horizontal: 'visible' },
      wordWrap: 'on',
      hover: { enabled: false },
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
      folding: false,
    });
    editor.current = instance;
    instance.revealPosition({ lineNumber: 1, column: 1 });
    instance.focus();

    const changed = instance.onDidChangeModelContent(() =>
      handlers.current.onChange(instance.getValue()),
    );

    const scrolled = instance.onDidScrollChange((event) => {
      const maxScrollTop = event.scrollHeight - instance.getLayoutInfo().height;
      if (maxScrollTop > 0) handlers.current.onScrollRatio(event.scrollTop / maxScrollTop);
    });

    return () => {
      changed.dispose();
      scrolled.dispose();
      instance.dispose();
      editor.current = null;
    };
  }, []);

  useEffect(() => {
    monaco.editor.setTheme(theme === 'dark' ? 'dark-plus' : 'light-plus');
  }, [theme]);

  return (
    <div id="editor-wrapper">
      <div id="editor" ref={host} />
    </div>
  );
}
