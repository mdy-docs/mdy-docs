/*
 * check.mjs — the page, driven.
 *
 * `npm run check` against a dev server on :8092 (or CHECK_URL): opens the
 * page in a headless Chromium, and asserts what the JavaScript demo showed
 * and this one must show too — the seeded document set rendered, its two
 * messages sent and delivered with the welcome page's output under each;
 * then, typed into the editor, a document with a mermaid fence and a
 * publish of its own; then one that throws, which must leave the last
 * good render on screen under an error bar.
 *
 * Monaco comes from a CDN, so this needs the network the page needs.
 */
import { chromium } from 'playwright';

const url = process.env.CHECK_URL ?? 'http://localhost:8092/';
const results = [];
const ok = (what, cond, detail) => {
  results.push({ what, cond });
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${what}${cond || detail === undefined ? '' : `\n        ${detail}`}`);
};

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  page error:', e.message));

await page.goto(url);
await page.waitForSelector('#output h1', { timeout: 60_000 });

/* the seeded set, as the C renders it */
ok('the entry renders its title', (await page.textContent('#output h1')).trim() === 'Team Roster');
const members = await page.$$eval('#output h3', (hs) => hs.map((h) => h.textContent.trim()));
ok('...and a card per member, by query', members.join(',') === 'Alice,Bob', members.join(','));
ok('no error bar', (await page.$('.mdy-error-bar')) === null);

/* its messages, sent and delivered by the broker in the module */
await page.waitForSelector('.mdy-messages li.mdy-msg-deliver', { timeout: 30_000 });
await page.waitForFunction(() => !document.querySelector('.mdy-messages-run'));
const kinds = await page.$$eval('.mdy-messages li .mdy-msg-kind', (es) => es.map((e) => e.textContent));
ok('two sends, two deliveries', kinds.join(' ') === '[send] [send] [deliver] [deliver]', kinds.join(' '));
const outputs = await page.$$eval('.mdy-messages .mdy-msg-output', (es) => es.map((e) => e.textContent.trim()));
ok('each delivery shows what the welcome page rendered',
   outputs.length === 2 && /Alice.*message #1.*js and python/.test(outputs[0]) && /Bob.*message #2.*go and rust/.test(outputs[1]),
   outputs.join(' | '));

/* typed: a diagram and a message of its own */
const typed = [
  '= Typed',
  '',
  '```mermaid',
  'graph TD; A-->B;',
  '```',
  '',
  '```js',
  'const answer = 42;',
  '```',
  '',
  "% $.publish('hi', { n: 7 })",
  '---',
  '+++',
  'messageName: hi',
  '+++',
  'hi {{ req.n }}',
  '',
].join('\n');
await page.click('.monaco-editor .view-lines');
await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
await page.keyboard.insertText(typed);
await page.waitForFunction(() => document.querySelector('#output h1')?.textContent.trim() === 'Typed', null, { timeout: 30_000 });
ok('an edit re-renders', true);
await page.waitForSelector('#output .mermaid svg', { timeout: 30_000 });
ok('a mermaid fence is drawn', true);
ok('a code fence is highlighted by the engine', (await page.$('#output code.hljs .hljs-keyword')) !== null);
await page.waitForFunction(
  () => [...document.querySelectorAll('.mdy-messages .mdy-msg-output')].some((e) => e.textContent.trim() === 'hi 7'),
  null, { timeout: 30_000 },
);
ok('...and its message is delivered to the page it names', true);

/* a throw: the error bar, over the last good render */
await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
await page.keyboard.insertText("= Broken\n\n% throw new Error('nope')\n");
await page.waitForSelector('.mdy-error-bar', { timeout: 30_000 });
const bar = await page.textContent('.mdy-error-bar');
ok('a throw shows the error bar', /nope/.test(bar), bar);
ok('...over the last good render, kept', (await page.textContent('#output h1')).trim() === 'Typed');
ok('...marked stale', (await page.getAttribute('#output', 'class')).includes('is-stale'));

await browser.close();
const failed = results.filter((r) => !r.cond).length;
console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
