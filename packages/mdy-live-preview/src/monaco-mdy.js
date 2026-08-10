import * as monaco from 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/+esm';
import { createHighlighter } from 'shiki';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { shikiToMonaco } from '@shikijs/monaco';
import mdyGrammar from 'vscode-mdy/syntaxes/mdy.tmLanguage.json';

// Monaco doesn't execute TextMate grammars natively — shiki does, so the
// vscode extension's own mdy.tmLanguage.json drives Monaco's tokenization
// (and its dark-plus/light-plus themes) via @shikijs/monaco. One grammar,
// every editor.
export const setupMdyLanguage = async () => {
  const highlighter = await createHighlighter({
    themes: ['dark-plus', 'light-plus'],
    langs: ['markdown', 'yaml', 'javascript', { ...mdyGrammar, name: 'mdy' }],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  monaco.languages.register({ id: 'mdy' });
  shikiToMonaco(highlighter, monaco);
};

// Monaco's web workers are stubbed out: this demo wants tokenization and
// nothing else from the language services.
self.MonacoEnvironment = {
  getWorker() {
    return new Proxy({}, { get: () => () => {} });
  },
};
