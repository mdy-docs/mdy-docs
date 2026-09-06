/*
 * Vendor the grammars from the highlight.js mdy-docs depends on, and record
 * the versions this fork tracks.
 *
 *   node third_party/highlight.js/sync.mjs
 *
 * The grammars are lowlight's `common` set — the 37 mdy-docs registers — and
 * they are copied as they are, with the few rewrites lamassu needs applied
 * on the way: eight `var` lines in java and kotlin become `const`, two
 * `splice` calls in swift and typescript become what they meant, and one
 * regex literal in perl becomes the string it was only ever read as. Each rewrite
 * is asserted, so an upgrade that moves one of those lines fails here rather
 * than at bundle time.
 *
 * core.js and lowlight.js are NOT synced: they are hand-ported, and an
 * upgrade of either upstream is a diff to read against this fork.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/* mdy-docs' own copies, by path: both packages hide package.json behind
 * `exports`, so require.resolve cannot find it. */
const nodeModules = join(here, '..', '..', '..', '..', 'node_modules');
const hljsDir = join(nodeModules, 'highlight.js');
const lowlightDir = join(nodeModules, 'lowlight');
const hljsVersion = JSON.parse(readFileSync(join(hljsDir, 'package.json'), 'utf8')).version;
const lowlightVersion = JSON.parse(readFileSync(join(lowlightDir, 'package.json'), 'utf8')).version;

/* The `common` set, read from lowlight's own list so the two cannot drift. */
const commonSource = readFileSync(join(lowlightDir, 'lib', 'common.js'), 'utf8');
const names = [...commonSource.matchAll(/from 'highlight\.js\/lib\/languages\/([\w-]+)'/g)].map((m) => m[1]);
if (names.length === 0) throw new Error('could not read the common grammar list from lowlight');

/* What lamassu will not parse, and what stands in for it. Exact strings,
 * asserted present, so a changed upstream line is noticed. */
const REWRITES = {
  java: [['^var ', 'const ', 4]],
  kotlin: [['^var ', 'const ', 4]],
  swift: [['args.splice(args.length - 1, 1);', 'args.pop();', 1]],
  typescript: [['mode.contains.splice(indx, 1, replacement);', 'mode.contains[indx] = replacement;', 1]],
  // A backreference with no group in its own literal: V8 parses it, baru-re
  // does not. The grammar only ever reads its source, and a string is that.
  perl: [['/\\1/)', "'\\\\1')", 1]],
};

const out = join(here, 'languages');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const name of names) {
  let source = readFileSync(join(hljsDir, 'lib', 'languages', `${name}.js`), 'utf8');
  for (const [from, to, count] of REWRITES[name] ?? []) {
    const re = from.startsWith('^') ? new RegExp(from, 'gm') : new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    const found = (source.match(re) ?? []).length;
    if (found !== count) {
      throw new Error(`${name}.js: expected ${count} of "${from}", found ${found} — upstream moved; update REWRITES`);
    }
    source = source.replace(re, to);
  }
  writeFileSync(join(out, `${name}.js`), source);
}

/* The aliases each grammar declares, read by running it under the real
 * highlight.js — so the fork can resolve `js` to javascript without having
 * run the grammar yet (core.js registers lazily; see there). */
const { createRequire } = await import('node:module');
const require = createRequire(join(nodeModules, 'x'));
const hljs = require(join(hljsDir, 'lib', 'core.js')).newInstance();
const aliases = {};
for (const name of names) {
  hljs.registerLanguage(name, require(join(hljsDir, 'lib', 'languages', `${name}.js`)));
  const lang = hljs.getLanguage(name);
  if (lang.aliases && lang.aliases.length) aliases[name] = lang.aliases;
}
writeFileSync(join(here, 'aliases.json'), JSON.stringify(aliases, null, 2) + '\n');

/* Words a grammar lists in more than one keyword scope of one `keywords`
 * object — `true` as keyword and as literal, say. Upstream compiles the
 * scopes in the object's source order and the last one wins; lamassu's
 * Object.keys is hash order (a documented deviation), so the fork cannot
 * know which came last. This table says: for each grammar, the winning
 * scope and the entry it came from (`word` or `word|score`). Asserted
 * consistent across a grammar's modes, since it is applied per grammar. */
const winners = {};
for (const name of names) {
  const lang = hljs.getLanguage(name);
  const seen = new Set();
  const walk = (mode) => {
    if (!mode || typeof mode !== 'object' || seen.has(mode)) return;
    seen.add(mode);
    const kw = mode.keywords;
    if (kw && typeof kw === 'object' && !Array.isArray(kw)) {
      const found = new Map();
      for (const scope of Object.keys(kw)) {
        if (scope === '$pattern') continue;
        const list = typeof kw[scope] === 'string' ? kw[scope].split(' ') : kw[scope];
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
          const word = entry.split('|')[0];
          const scopes = found.get(word) ?? [];
          scopes.push([scope, entry]);
          found.set(word, scopes);
        }
      }
      for (const [word, scopes] of found) {
        if (new Set(scopes.map((s) => s[0])).size < 2) continue;
        const [scope, entry] = scopes[scopes.length - 1];
        const table = winners[name] ?? (winners[name] = {});
        if (table[word] && (table[word][0] !== scope || table[word][1] !== entry)) {
          throw new Error(`${name}: "${word}" wins differently in two modes (${table[word]} vs ${[scope, entry]})`);
        }
        table[word] = [scope, entry];
      }
    }
    for (const key of ['contains', 'variants', 'starts']) {
      const v = mode[key];
      if (Array.isArray(v)) v.forEach(walk); else if (v) walk(v);
    }
  };
  walk(lang);
}
writeFileSync(join(here, 'keyword-scopes.json'), JSON.stringify(winners, null, 2) + '\n');

writeFileSync(join(here, 'VERSION'),
  `highlight.js ${hljsVersion}\nlowlight ${lowlightVersion}\n`);

console.log(`${names.length} grammars from highlight.js ${hljsVersion}, lowlight ${lowlightVersion} → ${out}`);
console.log(`  ${readdirSync(out).length} files; rewrites applied in ${Object.keys(REWRITES).join(', ')}`);
console.log(`  aliases for ${Object.keys(aliases).length} grammars; keyword-scope winners for ${Object.keys(winners).length}`);
