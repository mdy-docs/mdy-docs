/*
 * The allocation sweep, through the wasm engine. See `make check-alloc-wasm`.
 *
 * The native sweep (make check-alloc) refuses the nth allocation of a build
 * and asserts the run either produced the same site or said it could not.
 * This is that sweep against `build/wasm/mdy-native-af.mjs`, and it exists
 * because the native one cannot answer the question the wasm target actually
 * raises (B41):
 *
 *   B24's fix ends a hopeless run with `_Exit(1)`. Under emscripten main() is
 *   called through `callMain` with EXIT_RUNTIME=0, and an exit arrives at the
 *   host as a thrown ExitStatus rather than a process that stopped. The
 *   wrapper turns that back into a status — but the FILES are still read out
 *   of MEMFS afterwards and handed back beside it. If that status were ever
 *   lost, a caller would be given a half-written site with nothing to say it
 *   was half-written, which is the exact failure B24 was about.
 *
 * So the invariant is the native one, plus the reason it holds here:
 *
 *   a run reporting status 0 produced the SAME files as an uninterfered one;
 *   a run that could not must report a non-zero status.
 *
 * One module instance per ordinal. Sharing one would be faster and wrong: the
 * engine's memo and MEMFS both persist inside an instance, so the second
 * build would be served the first one's renders and read the first one's
 * output directory.
 *
 *   node wasm/check-alloc.mjs [--site fixture] [--from N] [--to N]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from './index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');

/* Same shape as check-golden.mjs: a site is one or more directories mounted
 * under their basenames, and `site` names the one to build. */
const SITES = {
  fixture: { mounts: [join(pkg, 'fixture')], site: 'fixture' },
  'fixture-pkg': {
    mounts: [join(pkg, 'fixture-pkg'), join(pkg, 'fixture-style')],
    site: 'fixture-pkg',
  },
  messaging: { mounts: [join(pkg, '..', '..', 'examples', 'messaging')], site: 'messaging' },
  // blog imports "../blog-style-x", so that directory is mounted beside it
  // the way check-golden.mjs mounts fixture-style beside fixture-pkg.
  blog: {
    mounts: [
      join(pkg, '..', '..', 'examples', 'blog'),
      join(pkg, '..', '..', 'examples', 'blog-style-x'),
    ],
    site: 'blog',
  },
  'docs-site': { mounts: [join(pkg, '..', '..', 'examples', 'docs-site')], site: 'docs-site' },
};

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const name = flag('site', 'fixture');
const chosen = SITES[name];
if (!chosen) {
  console.error(`check-alloc-wasm: no site ${name} (have ${Object.keys(SITES).join(', ')})`);
  process.exit(2);
}

function* filesUnder(dir, rel = '') {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    const child = rel ? `${rel}/${entry}` : entry;
    if (statSync(path).isDirectory()) yield* filesUnder(path, child);
    else yield [child, path];
  }
}

const input = new Map();
for (const dir of chosen.mounts) {
  const top = dir.split('/').filter(Boolean).pop();
  for (const [rel, path] of filesUnder(dir)) input.set(`${top}/${rel}`, readFileSync(path));
}

/*
 * ONE import, many instances. A MODULARIZE=1 factory hands back an
 * independent Module every call — its own linear memory, its own MEMFS, its
 * own copy of the engine's statics — which is all "a fresh instance" needs.
 *
 * This was a cache-busting `import(...?${Math.random()})` first, out of
 * caution, and that is a leak: node keeps every distinct specifier in the
 * module registry with its compiled wasm attached. It survives the fixture's
 * 1,807 and kills the process somewhere in the blog's 14,298.
 */
const createModule = (await import('../build/wasm/mdy-native-af.mjs')).default;

/* `arm` runs before main(), so the count is of that build alone. */
async function once(nth) {
  let armed;
  const out = await build(input, {
    site: chosen.site,
    createModule: (opts) =>
      createModule(opts).then((m) => {
        armed = m;
        m._mdy_af_arm(nth);
        return m;
      }),
  });
  return { ...out, total: armed ? armed._mdy_af_total() : 0 };
}

const same = (a, b) => {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w || w.length !== v.length) return false;
    for (let i = 0; i < v.length; i++) if (v[i] !== w[i]) return false;
  }
  return true;
};

const reference = await once(-1);
if (reference.status !== 0) {
  console.error(`check-alloc-wasm: the unarmed build failed (status ${reference.status})\n${reference.log}`);
  process.exit(1);
}
const total = reference.total;
const from = Number(flag('from', 1));
const to = Number(flag('to', total));
console.log(`${name}: ${total} allocations through wasm, sweeping ${from}..${to}`);

const wrong = [];
const threw = [];
let ok = 0;
let reported = 0;
for (let n = from; n <= to; n++) {
  let r;
  try {
    r = await once(n);
  } catch (e) {
    // Not an ExitStatus — index.mjs rethrows those it cannot read a status
    // from, and a trap or an unhandled abort arrives here.
    threw.push(`${n}:${(e && e.message ? e.message : String(e)).slice(0, 60)}`);
    continue;
  }
  if (r.status !== 0) reported++;
  else if (same(reference.files, r.files)) ok++;
  else wrong.push(n);
}

console.log(`  succeeded-correctly=${ok}  reported-failure=${reported}`);
if (threw.length) console.log(`  THREW without a status: ${threw.join(' ')}`);
if (wrong.length) console.log(`  reported success with a DIFFERENT site at: ${wrong.join(' ')}`);
if (threw.length || wrong.length) process.exit(1);

/*
 * Explicitly, and it is not belt-and-braces: emscripten sets
 * `process.exitCode` to the module's own exit status on every run, so this
 * process inherits whichever ordinal happened to go last. A sweep whose final
 * refusal was reported would exit 1 having found nothing wrong.
 */
process.exitCode = 0;
console.log(`  ${to - from + 1} refusals: every one was either survived exactly or reported`);
