/*
 * The golden sites, built through the wasm engine under node, diffed against
 * test/golden/ byte for byte — the same bar build/mdy is held to by
 * `make check-golden`, so a difference here is the wasm build's alone.
 *
 *   make check-wasm
 *
 * The four sites are the Makefile's GOLDEN_SITES. fixture-pkg imports
 * "../fixture-style", so that directory is mounted beside it; the other two
 * stand alone.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, document } from './index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');

/* name -> { mounts: [dir, ...] mounted under their basenames; site: basename } */
const SITES = [
  { name: 'fixture',     mounts: [join(pkg, 'test', 'fixture')],                                  site: 'fixture' },
  { name: 'fixture-pkg', mounts: [join(pkg, 'test', 'fixture-pkg'), join(pkg, 'test', 'fixture-style')],  site: 'fixture-pkg' },
  { name: 'messaging',   mounts: [join(pkg, '..', '..', 'examples', 'messaging')],        site: 'messaging' },
  /* The inputs that were bugs (§4). Its golden output is committed like the
   * others', so the wasm build is held to it too. */
  { name: 'fixture-awkward', mounts: [join(pkg, 'test', 'fixture-awkward')],                    site: 'fixture-awkward' },
];

function* filesUnder(dir, base = dir) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* filesUnder(path, base);
    else yield [relative(base, path).split('\\').join('/'), path];
  }
}

let failed = 0;
for (const { name, mounts, site } of SITES) {
  const input = new Map();
  for (const dir of mounts) {
    const top = dir.split(/[\\/]/).pop();
    for (const [rel, path] of filesUnder(dir)) input.set(`${top}/${rel}`, readFileSync(path));
  }

  const { files, log, status } = await build(input, { site });
  if (status !== 0) {
    console.log(`  ${name}: the build FAILED (exit ${status})\n${log}`);
    failed = 1;
    continue;
  }

  const golden = new Map();
  for (const [rel, path] of filesUnder(join(pkg, 'test', 'golden', name))) golden.set(rel, readFileSync(path));

  const diffs = [];
  for (const [rel, want] of golden) {
    const got = files.get(rel);
    if (!got) diffs.push(`missing ${rel}`);
    else if (Buffer.compare(Buffer.from(got), want) !== 0) diffs.push(`differs ${rel}`);
  }
  for (const rel of files.keys()) if (!golden.has(rel)) diffs.push(`extra ${rel}`);

  if (diffs.length === 0) {
    console.log(`  ${name}: identical to golden (${files.size} files, wasm)`);
  } else {
    console.log(`  ${name}: DIFFERS from golden`);
    for (const d of diffs.slice(0, 20)) console.log(`    ${d}`);
    failed = 1;
  }
}

/*
 * document(): the one-document API the live preview and the language tour
 * run on. A publish, a refusal and its dead-letter page, a sanitizer warning
 * with its line, the request's data and the answered response — each read
 * back through the wrapper's own parsers, against what build/mdy says.
 */
{
  const source =
    '+++\ntitle: main\n+++\n' +
    '% $.publish("orders.new", { id: 7 })\n% $.publish("orders.bad", { id: 8 })\n' +
    '<script\n  alert(1)\nsent {{ req.who }}\n' +
    '---\n+++\nmessageName: orders.new\n+++\ngot {{ req.msg ? req.msg.name : "page" }}\n' +
    '---\n+++\nmessageName: orders.bad\n+++\n% if (req.msg) throw new Error("nope")\nbad\n' +
    '---\n+++\nmessageName: orders.bad.dead\n+++\ndead: {{ req.msg ? req.msg.name : "page" }}\n';
  const r = await document(source, { publish: true, sanitize: true, data: { who: 'ada' }, response: true });
  const kinds = r.messages.map((m) => `${m.kind} ${m.name} #${m.index}`).join(' | ');
  const problems = [];
  if (r.status !== 0) problems.push(`exit ${r.status}: ${r.errors}`);
  if (r.output !== '<p>sent ada</p>\n') problems.push(`output ${JSON.stringify(r.output)}`);
  if (kinds !== 'send orders.new #1 | send orders.bad #1 | refuse orders.bad #1 | deliver orders.new #1 | dead orders.bad.dead #1')
    problems.push(`messages ${kinds}`);
  const delivered = r.messages.find((m) => m.kind === 'deliver');
  if (!delivered || delivered.output !== '<p>got orders.new</p>') problems.push(`delivery output ${JSON.stringify(delivered?.output)}`);
  const refused = r.messages.find((m) => m.kind === 'refuse');
  if (!refused || !/failed: nope/.test(refused.error || '') || !/dead-lettering to orders\.bad\.dead/.test(refused.verdict || ''))
    problems.push(`refusal ${JSON.stringify(refused)}`);
  const dead = r.messages.find((m) => m.kind === 'dead');
  if (!dead || dead.output !== '<p>dead: orders.bad.dead</p>') problems.push(`dead page ${JSON.stringify(dead?.output)}`);
  if (r.warnings.length !== 1 || r.warnings[0].line !== 6 || r.warnings[0].rule !== 'sanitize')
    problems.push(`warnings ${JSON.stringify(r.warnings)}`);
  if (!r.data || !r.data.data || r.data.data.title !== 'main') problems.push(`response ${JSON.stringify(r.data)}`);
  if (problems.length === 0) {
    console.log('  document(): output, messages, warnings and response as build/mdy gives them (wasm)');
  } else {
    console.log('  document(): DIFFERS');
    for (const p of problems) console.log(`    ${p}`);
    failed = 1;
  }
}

process.exit(failed);
