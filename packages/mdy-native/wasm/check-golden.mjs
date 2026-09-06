/*
 * The golden sites, built through the wasm engine under node, diffed against
 * golden/ byte for byte — the same bar build/mdy is held to by
 * `make check-golden`, so a difference here is the wasm build's alone.
 *
 *   make check-wasm
 *
 * The three sites are the Makefile's GOLDEN_SITES. fixture-pkg imports
 * "../fixture-style", so that directory is mounted beside it; the other two
 * stand alone.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from './index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');

/* name -> { mounts: [dir, ...] mounted under their basenames; site: basename } */
const SITES = [
  { name: 'fixture',     mounts: [join(pkg, 'fixture')],                                  site: 'fixture' },
  { name: 'fixture-pkg', mounts: [join(pkg, 'fixture-pkg'), join(pkg, 'fixture-style')],  site: 'fixture-pkg' },
  { name: 'messaging',   mounts: [join(pkg, '..', '..', 'examples', 'messaging')],        site: 'messaging' },
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
  for (const [rel, path] of filesUnder(join(pkg, 'golden', name))) golden.set(rel, readFileSync(path));

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
process.exit(failed);
