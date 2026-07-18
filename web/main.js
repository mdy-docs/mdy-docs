// mdy playground — the full pipeline (parse → nisaba → lamassu VM →
// markdown-it) running client-side. Both engines are WebAssembly modules;
// the first render boots them, later renders reuse the instances.
import { render, renderToMarkdown, parseDocuments, compileTemplateSource } from '../index.js';

import documentSet from '../examples/document-set.mdy?raw';
import hashtags from '../examples/hashtags.mdy?raw';
import roster from '../examples/roster.mdy?raw';
import invoice from '../examples/invoice.mdy?raw';
import orderIndependent from '../examples/order-independent.mdy?raw';
import sharedScope from '../examples/shared-scope.mdy?raw';

const EXAMPLES = {
  'document set — $.find + $.render': documentSet,
  'hashtags — #tags feed $.withTag': hashtags,
  'roster — front matter + template': roster,
  'invoice — computed totals': invoice,
  'data fences — order-independent': orderIndependent,
  'shared scope — fibonacci': sharedScope,
};

const $id = (id) => document.getElementById(id);
const source = $id('source');
const example = $id('example');
const status = $id('status');
const errorBox = $id('error');
const tabs = { preview: $id('tab-preview'), markdown: $id('tab-markdown'), compiled: $id('tab-compiled') };

for (const name of Object.keys(EXAMPLES)) {
  const opt = document.createElement('option');
  opt.textContent = name;
  example.appendChild(opt);
}
source.value = EXAMPLES[example.value];

example.addEventListener('change', () => {
  source.value = EXAMPLES[example.value];
  scheduleRender();
});

// Tab switching.
for (const btn of document.querySelectorAll('.tabs button')) {
  btn.addEventListener('click', () => {
    for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b === btn);
    for (const [name, el] of Object.entries(tabs)) el.hidden = name !== btn.dataset.tab;
  });
}

// Debounced last-wins rendering: a stale render never overwrites a newer one.
let seq = 0;
let timer = null;

function scheduleRender() {
  clearTimeout(timer);
  timer = setTimeout(doRender, 350);
}

async function doRender() {
  const mySeq = ++seq;
  const src = source.value;
  status.textContent = 'rendering…';
  const started = performance.now();
  try {
    const [html, md] = await Promise.all([render(src), renderToMarkdown(src)]);
    if (mySeq !== seq) return; // superseded
    const compiled = parseDocuments(src)
      .map(({ content }, i) => `// document ${i}\nfunction __doc${i}(__ctx) {\n${compileTemplateSource(content)}\nreturn __out;\n}`)
      .join('\n\n');
    tabs.preview.innerHTML = html;
    tabs.markdown.textContent = md;
    tabs.compiled.textContent = compiled;
    errorBox.hidden = true;
    status.textContent = `rendered in ${(performance.now() - started).toFixed(0)} ms`;
  } catch (err) {
    if (mySeq !== seq) return;
    errorBox.textContent = String(err.message ?? err);
    errorBox.hidden = false;
    status.textContent = 'error';
  }
}

source.addEventListener('input', scheduleRender);

doRender();
