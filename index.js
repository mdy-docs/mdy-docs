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
export { walkVault, walkFiles, walkRawSources } from './src/vault.js';

// The static-site layer, built entirely on the primitives above: every
// site is a script-defined site (one entry document deciding everything
// itself via $.find/$.render/$.emit — see script-site.js and
// docs/site-plan.md's "Toward a script-defined site" for the full design).
export { renderSite, buildSite, urlToOutFile } from './src/site/build.js';
export { serveSite } from './src/site/serve.js';
export { slugify, normalizeDate, rfc822 } from './src/site/vault.js';
export { tokenize } from './src/site/search.js';
export { createResizeNative } from './src/site/images.js';
export { renderScriptSite } from './src/site/script-site.js';
