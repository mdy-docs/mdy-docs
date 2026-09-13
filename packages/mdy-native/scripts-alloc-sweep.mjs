/*
 * The allocation sweep, in parallel. See `make check-alloc`.
 *
 * build/mdy-af is build/mdy with the allocator replaced by one that refuses
 * the nth request and only that one (src/allocfail.c). This runs a whole build
 * once per ordinal and asserts:
 *
 *   a run that exits 0 produced the SAME SITE as an uninterfered one; a run
 *   that could not must say so and exit non-zero.
 *
 * Not "it does not crash". Silently dropping a page is worse than the crash it
 * replaces, because the build reports success with files missing — which is
 * what 306 of the first sweep's 1,809 ordinals did (B24).
 *
 * WHY THIS IS PARALLEL, and not a shell loop as it started: one ordinal is one
 * process with its own output directory, so the sweep is embarrassingly so.
 * Serially, `blog` took 25 minutes and `docs-site` 35, which is the whole
 * reason neither was a target and nothing re-ran them (B41). At -j12 they are
 * a few minutes, and a check somebody runs is worth more than a thorough one
 * they do not.
 *
 *   node scripts-alloc-sweep.mjs --bin build/mdy-af --ref build/mdy \
 *        --site fixture [--jobs N] [--from N] [--to N]
 */
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const bin = flag('bin', 'build/mdy-af');
const ref = flag('ref', 'build/mdy');
const site = flag('site', 'fixture');
const jobs = Math.max(1, Number(flag('jobs', availableParallelism())));

const work = mkdtempSync(join(tmpdir(), 'mdy-alloc-'));
const cleanup = () => rmSync(work, { recursive: true, force: true });
process.on('exit', cleanup);

/* The tree as a Map of path -> bytes, so a comparison is content and not
 * `diff -r`'s exit code. A missing file and an empty one are different. */
function treeOf(dir) {
  const files = new Map();
  const walk = (d, rel) => {
    let entries;
    try {
      entries = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      const path = join(d, name);
      const child = rel ? `${rel}/${name}` : name;
      if (statSync(path).isDirectory()) walk(path, child);
      else files.set(child, readFileSync(path));
    }
  };
  walk(dir, '');
  return files;
}

const same = (a, b) => {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w || !v.equals(w)) return false;
  }
  return true;
};

const refDir = join(work, 'ref');
execFileSync(ref, ['build', site, '--out', refDir, '--quiet'], { stdio: 'ignore' });
const reference = treeOf(refDir);

// The count is written to stderr at exit, so it is stderr that is read.
const counted = spawnSync(bin, ['build', site, '--out', join(work, 'count'), '--quiet'], {
  env: { ...process.env, MDY_ALLOC_COUNT: '1' },
  encoding: 'utf8',
});
const total = Number(/mdy-af: (\d+) allocations/.exec(counted.stderr ?? '')?.[1]);
if (!Number.isFinite(total) || total < 1) {
  console.error('alloc-sweep: could not read the allocation count from ' + bin);
  process.exit(2);
}

const from = Number(flag('from', 1));
const to = Number(flag('to', total));
console.log(`${site}: ${total} allocations, sweeping ${from}..${to} on ${jobs} job(s)`);

const crashed = [];
const wrong = [];
let ok = 0;
let reported = 0;

let next = from;
const runOne = (n, slot) =>
  new Promise((resolve) => {
    const out = join(work, `out${slot}`);
    rmSync(out, { recursive: true, force: true });
    execFile(
      bin,
      ['build', site, '--out', out, '--quiet'],
      { env: { ...process.env, MDY_ALLOC_FAIL_NTH: String(n) }, encoding: 'buffer' },
      (err) => {
        // A signal is a crash; a non-zero code is the run reporting it could
        // not finish, which is what the invariant allows.
        if (err?.signal) crashed.push(`${n}:${err.signal}`);
        else if (err?.code) reported++;
        else if (same(reference, treeOf(out))) ok++;
        else wrong.push(n);
        resolve();
      }
    );
  });

const worker = async (slot) => {
  for (;;) {
    const n = next++;
    if (n > to) return;
    await runOne(n, slot);
  }
};
await Promise.all(Array.from({ length: jobs }, (_, i) => worker(i)));

console.log(`  succeeded-correctly=${ok}  reported-failure=${reported}`);
if (crashed.length) console.log(`  CRASHED at: ${crashed.sort((a, b) => parseInt(a) - parseInt(b)).join(' ')}`);
if (wrong.length) console.log(`  reported success with a DIFFERENT site at: ${wrong.sort((a, b) => a - b).join(' ')}`);
if (crashed.length || wrong.length) {
  console.log(`  ${crashed.length + wrong.length} of ${to - from + 1}`);
  process.exit(1);
}
console.log(`  ${to - from + 1} refusals: every one was either survived exactly or reported`);
