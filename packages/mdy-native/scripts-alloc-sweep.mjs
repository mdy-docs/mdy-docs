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
 * WHAT IS SWEPT is --mode, because `build` is not the only thing this binary
 * does and for a while it was the only thing swept (B43):
 *
 *   build     a whole site, compared as a tree
 *   document  one file through `mdy <path> -o`, compared as a file — a
 *             different path into the engine: one source, no directory walk,
 *             no static/ copy
 *   dev       the server, which does not exit. The invariant has to be
 *             restated for it: either it stops and says why, or it serves the
 *             same site. Wedging is its own outcome and is reported as one,
 *             because a dev server that neither dies nor answers is the
 *             worst of the three and the other modes have no analogue.
 *
 *   node scripts-alloc-sweep.mjs --bin build/mdy-af --ref build/mdy \
 *        --site fixture [--mode build|document|dev] [--jobs N] [--from N] [--to N]
 */
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
const mode = flag('mode', 'build');
/*
 * --trace turns the shim's backtrace on for every run and keeps the one from
 * each failure. Chasing an ordinal by hand does not work: which allocation is
 * the nth depends on the exact sequence, and a sweep's sequence is not one a
 * shell can reproduce by eye. The sweep is the only thing that knows.
 */
const trace = argv.includes('--trace');
if (!['build', 'document', 'dev'].includes(mode)) {
  console.error(`alloc-sweep: no mode ${mode}`);
  process.exit(2);
}
/* A dev worker is a server and a handful of requests, so it is heavier than a
 * build and there is less to gain from crowding the machine with them. */
const jobs = Math.max(1, Number(flag('jobs', mode === 'dev'
  ? Math.max(2, Math.floor(availableParallelism() / 2))
  : availableParallelism())));

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

/* The reference, and the argv each mode runs. `document` writes one file, so
 * its "tree" is that file under a fixed name. */
const argsFor = (out) =>
  mode === 'document' ? [site, '-o', join(out, 'document.out')]
                      : ['build', site, '--out', out, '--quiet'];

/* ---- dev mode ------------------------------------------------------------
 *
 * The server does not exit, so "the same site, or a reported failure" has to
 * be restated: it either stops and says why, or it comes up and serves the
 * same site. A third outcome exists here and nowhere else — it does neither,
 * and sits there — so that is counted separately rather than folded into one
 * of the two.
 */
const DEV_TIMEOUT_MS = 20000;

/* Start a server, wait for its banner, ask it for every page the reference
 * build produced, stop it. `env` is what differs between the measuring run
 * and a swept one. */
function devRun(env, paths) {
  return new Promise((resolve) => {
    const child = spawn(bin, ['dev', site, '--port', '0'], {
      env: { ...process.env, ...env },
    });
    let log = '';
    let done = false;
    /*
     * The kill comes first and the resolve comes after the process is
     * actually gone, so `log` is complete when it is read: the shim's
     * allocation count is written from the SIGTERM handler, which is to say
     * after everything else this process will ever say.
     */
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        const hard = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 2000);
        child.on('close', () => { clearTimeout(hard); resolve({ ...r, log }); });
      } else {
        resolve({ ...r, log });
      }
    };
    const timer = setTimeout(() => finish({ outcome: 'stalled', log }), DEV_TIMEOUT_MS);

    child.stdout.on('data', (b) => { log += b; onLog(); });
    child.stderr.on('data', (b) => { log += b; onLog(); });
    child.on('exit', (code, signal) => {
      // SIGTERM here is our own kill, after the pages were read.
      if (!done) finish({ outcome: signal && signal !== 'SIGTERM' ? 'crashed' : 'exited',
                          code, signal, log });
    });

    let fetching = false;
    async function onLog() {
      if (fetching || done) return;
      const m = /http:\/\/localhost:(\d+)/.exec(log);
      if (!m) return;
      fetching = true;
      const port = m[1];
      const files = new Map();
      try {
        for (const path of paths) {
          const res = await fetch(`http://127.0.0.1:${port}/${path}`);
          if (!res.ok) { finish({ outcome: 'served', files, log, short: path }); return; }
          files.set(path, Buffer.from(await res.arrayBuffer()));
        }
      } catch (e) {
        finish({ outcome: 'served', files, log, short: String(e && e.message) });
        return;
      }
      finish({ outcome: 'served', files, log });
    }
  });
}

/*
 * The reference for `dev` is an unarmed DEV run, not the build.
 *
 * The server injects its live-reload script into every HTML page, so a page
 * it serves never equals the one `mdy build` writes — holding one against the
 * other reports every HTML file as wrong and says nothing about allocations.
 * The build is still what supplies the LIST of paths; what they should
 * contain comes from the server itself.
 */
async function devReference(paths) {
  const r = await devRun({ MDY_ALLOC_COUNT: '1' }, paths);
  if (r.outcome !== 'served' || r.short !== undefined) {
    console.error(`alloc-sweep: the unarmed dev server did not serve (${r.outcome} ${r.short ?? ''})\n${r.log}`);
    process.exit(2);
  }
  return r;
}

const refDir = join(work, 'ref');
if (mode === 'document') mkdirSync(refDir, { recursive: true });
if (mode === 'dev') {
  // The dev server serves what a build produces, so a build is what it is
  // held against — see devOnce.
  execFileSync(ref, ['build', site, '--out', refDir, '--quiet'], { stdio: 'ignore' });
} else {
  execFileSync(ref, argsFor(refDir), { stdio: 'ignore' });
}
const reference = treeOf(refDir);
if (reference.size === 0) {
  console.error(`alloc-sweep: the reference build of ${site} produced nothing`);
  process.exit(2);
}

/*
 * How many allocations the sequence makes, which is what there is to sweep.
 *
 * `dev` does not exit, so atexit never runs and there is no count to read at
 * the end of it — the shim reports on SIGTERM for exactly this (allocfail.c),
 * and the measuring run therefore has to be the SAME sequence the sweep runs:
 * start, wait for the banner, fetch every page, stop. Measuring a bare
 * startup would sweep a prefix and call it the whole.
 */
let devPaths = null;
let devFiles = null;
if (mode === 'dev') {
  devPaths = [...reference.keys()].sort();
  const r = await devReference(devPaths);
  devFiles = r.files;
}
const counted = mode === 'dev'
  ? (await devReference(devPaths)).log
  : spawnSync(bin, argsFor(join(work, 'count')), {
      env: { ...process.env, MDY_ALLOC_COUNT: '1' },
      encoding: 'utf8',
    }).stderr ?? '';
const total = Number(/mdy-af: (\d+) allocations/.exec(counted)?.[1]);
if (!Number.isFinite(total) || total < 1) {
  console.error('alloc-sweep: could not read the allocation count from ' + bin);
  process.exit(2);
}

const from = Number(flag('from', 1));
const to = Number(flag('to', total));
console.log(`${site} (${mode}): ${total} allocations, sweeping ${from}..${to} on ${jobs} job(s)`);

const crashed = [];
const wrong = [];
const stalled = [];
const traces = new Map();
let ok = 0;
let reported = 0;

let next = from;

const runBuild = (n, slot) =>
  new Promise((resolve) => {
    const out = join(work, `out${slot}`);
    rmSync(out, { recursive: true, force: true });
    if (mode === 'document') mkdirSync(out, { recursive: true });
    execFile(
      bin,
      argsFor(out),
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

/* The server SAID the build failed. `mdy dev` deliberately stays up when the
 * first build fails — there is nothing to fall back to and a broken save
 * should not take the server down (B10) — so serving nothing while saying so
 * is a reported failure, not a wrong answer. Saying nothing is not. */
const saidItFailed = (log) => /build failed|out of memory|cannot read/i.test(log);

const runDev = async (n) => {
  const env = { MDY_ALLOC_FAIL_NTH: String(n) };
  if (trace) env.MDY_ALLOC_FAIL_TRACE = '1';
  const before = wrong.length + crashed.length + stalled.length;
  const r = await devRun(env, devPaths);
  const keep = () => {
    if (trace && wrong.length + crashed.length + stalled.length > before) traces.set(n, r.log);
  };
  setTimeout(keep, 0);
  if (r.outcome === 'crashed') crashed.push(`${n}:${r.signal}`);
  else if (r.outcome === 'stalled') stalled.push(n);
  else if (r.outcome === 'exited') {
    // Stopping is allowed; stopping with 0, having served nothing, is not.
    if (r.code) reported++;
    else wrong.push(n);
  } else if (r.short !== undefined) {
    /*
     * It came up and then REFUSED a request — a dropped connection or a
     * non-2xx. That is the server telling the client it could not, in the
     * only place an HTTP client listens, so it is a reported failure rather
     * than a wrong answer.
     *
     * The property this sweep is for survives the distinction, and it is
     * worth stating exactly: the server never answers 200 with bytes that
     * are not the site's. Everything else it might do — drop the connection,
     * 500, 404 — is visible to whoever asked.
     */
    reported++;
  } else if (same(devFiles, r.files)) ok++;
  else if (saidItFailed(r.log)) reported++;
  else wrong.push(n);
  if (trace && wrong.length + crashed.length + stalled.length > before) traces.set(n, r.log);
};

const runOne = (n, slot) => (mode === 'dev' ? runDev(n) : runBuild(n, slot));

const worker = async (slot) => {
  for (;;) {
    const n = next++;
    if (n > to) return;
    await runOne(n, slot);
  }
};
await Promise.all(Array.from({ length: jobs }, (_, i) => worker(i)));

if (trace && traces.size) {
  const slide = /mdy-af: slide (0x[0-9a-f]+)/;
  for (const [n, log] of [...traces].sort((a, b) => a[0] - b[0])) {
    const m = slide.exec(log);
    const addrs = [...log.matchAll(/^ {2}(0x[0-9a-f]+)$/gm)].map((x) => x[1]).slice(2, 8);
    if (!m || !addrs.length) { console.log(`  ${n}: no trace`); continue; }
    let named = addrs.join(' ');
    try {
      named = execFileSync('atos', ['-o', bin, '-s', m[1], ...addrs], { encoding: 'utf8' })
        .split('\n').filter(Boolean).map((l) => l.replace(` (in ${bin.split('/').pop()})`, '')).join(' | ');
    } catch { /* atos is a mac thing; the addresses are still something */ }
    console.log(`  ${n}: ${named}`);
  }
}
console.log(`  succeeded-correctly=${ok}  reported-failure=${reported}`);
if (crashed.length) console.log(`  CRASHED at: ${crashed.sort((a, b) => parseInt(a) - parseInt(b)).join(' ')}`);
if (stalled.length) console.log(`  NEITHER SERVED NOR STOPPED at: ${stalled.sort((a, b) => a - b).join(' ')}`);
if (wrong.length) {
  const what = mode === 'dev' ? 'served a DIFFERENT site (or nothing, with status 0)' : 'reported success with a DIFFERENT site';
  console.log(`  ${what} at: ${wrong.sort((a, b) => a - b).join(' ')}`);
}
if (crashed.length || wrong.length || stalled.length) {
  console.log(`  ${crashed.length + wrong.length + stalled.length} of ${to - from + 1}`);
  process.exit(1);
}
console.log(`  ${to - from + 1} refusals: every one was either survived exactly or reported`);
