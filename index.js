export {
  compileTemplate,
  compileTemplateSource,
  contextBindings,
  splitDocuments,
  parseDocuments,
  extractTags,
  openDocumentSet,
  renderDocumentSet,
  renderEach,
  createProcessor,
  render,
  renderToMarkdown,
  MarkdownIt,
} from './src/mdy.js';

// "Getting files into the document set" — the filesystem/vault layer,
// formerly the separate @mdy-docs/vault package (edubba's own experience:
// mdy-docs' own bin/mdy.js had started hand-rolling a weaker duplicate of
// exactly this — one-off readFileSync/watch calls — which is precisely the
// kind of thing that should exist once, here, not per-consumer). See
// src/fs-provider.js and src/vault.js's own file-level comments for the
// full shape.
export {
  nodeFsProvider,
  memoryFsProvider,
  opfsFsProvider,
  watchByPolling,
} from './src/fs-provider.js';
export { walkVault, walkFiles } from './src/vault.js';
