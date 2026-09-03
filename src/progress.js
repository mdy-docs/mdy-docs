/*
 * Build progress as one line that updates in place.
 *
 * A build used to be silent between starting and finishing, which for a site
 * of any size is indistinguishable from a hang. This turns the hooks a build
 * already offers into something to watch, in the order they fire:
 *
 *   onSource   once per file walked          -> "reading N file(s)"
 *   onIngest   once per document inserted    -> a real bar; the total is known
 *   onQuery    the entry's first query       -> "running the site script"
 *   onEmit     once per page produced        -> a bar, if a total is known
 *
 * The middle two matter more than they look. Between the last file read and
 * the first page emitted the entry script is running and nothing is read or
 * written — seconds, on a large site — and without those signals the display
 * sat claiming to still be reading files.
 *
 * The percentage is only ever shown when it means something. A script-defined
 * site does not know how many pages it will emit until it has emitted them —
 * the entry document decides what exists — so on a first build there is no
 * total to divide by and this counts instead. On a rebuild the previous
 * build's page count is a good estimate, which is exactly the case where
 * somebody is sitting and waiting. A rebuild that emits more than the estimate
 * holds at 99% rather than claiming to be finished.
 *
 * Painting is driven by the hooks, throttled — NOT by the ticker alone. A
 * build spends long stretches not yielding (parsing, and the site script
 * running inside the VM), and a timer cannot fire while the event loop is
 * blocked; relying on one left the line frozen for seconds at a time. The
 * ticker remains for genuinely idle moments so the clock still moves.
 *
 * Only a TTY gets the moving line. Anywhere else this is off and the caller
 * keeps whatever logging it had — a log full of carriage returns and bar
 * characters helps nobody, and a pipeline reading the output should not have
 * its format changed underneath it.
 *
 * A caller that also logs per file routes those lines through `log()`, which
 * takes the moving line down, prints, and puts it back. That is the only way
 * the two can share a terminal: a line printed on top of the bar leaves half
 * of it stranded on screen, and one printed without repainting loses it. When
 * the bar is off, `log()` is just a write, so the same call site serves both.
 */

const BAR_WIDTH = 24;
const TICK_MS = 100;
const SPINNER = ['|', '/', '-', '\\'];
const CLEAR_LINE = '\r\x1b[2K';

/** Node's stderr, if there is one — this module is reachable from a browser
 * bundle, where there is not. */
function err() {
  return typeof process !== 'undefined' && process.stderr ? process.stderr : null;
}

/** True when a moving line makes sense: an interactive terminal, and not
 * turned off. */
export function progressSupported() {
  const e = err();
  return Boolean(e && e.isTTY);
}

/** A bar, or a spinner when there is no total to divide by. */
function meter(done, total, frame) {
  if (!total) return `${SPINNER[frame % SPINNER.length]} `;
  const ratio = Math.min(done / total, 1);
  const shown = done >= total ? 99 : Math.round(ratio * 100);
  const filled = Math.round(ratio * BAR_WIDTH);
  return `[${'#'.repeat(filled)}${'.'.repeat(BAR_WIDTH - filled)}] ${String(shown).padStart(3)}% `;
}

/**
 * A progress display for one build or a succession of them.
 *
 * `enabled` defaults to progressSupported(); pass false to make every hook a
 * no-op, which is what a caller wants when it is logging per file instead.
 *
 * The hooks are the ones renderSite/serveSite take, and they start a build by
 * themselves: the first event after a finish begins a new one. That is what
 * makes this usable with `mdy dev`, whose rebuilds the caller does not drive.
 *
 * `finish(summary)` ends the current build and leaves exactly one line — pass
 * the caller's own summary, or nothing to leave none. `pages` reports the last
 * finished build's page count, which is the estimate for the next one.
 */
export function createProgress(options = {}) {
  const enabled = options.enabled ?? progressSupported();
  let expected = options.expectedPages ?? 0;

  let live = null; /* the build in flight, or null between builds */

  const begin = () => {
    if (!enabled || live) return live;
    const started = Date.now();
    const state = {
      started,
      phase: 'reading',
      files: 0,
      ingested: 0,
      ingestTotal: 0,
      pages: 0,
      frame: 0,
      lastPaint: 0,
      painted: false,
      timer: null,
    };

    const paint = () => {
      const e = err();
      if (!e) return;
      const spin = SPINNER[state.frame % SPINNER.length];
      const secs = `${((Date.now() - state.started) / 1000).toFixed(1)}s`;
      let line;
      if (state.phase === 'reading') line = `${spin} reading ${state.files} file(s)  ${secs}`;
      else if (state.phase === 'ingesting')
        line = `${meter(state.ingested, state.ingestTotal, state.frame)}${state.ingested}/${state.ingestTotal} document(s)  ${secs}`;
      else if (state.phase === 'running')
        line = `${spin} running the site script, ${state.files} file(s) read  ${secs}`;
      else
        line = `${meter(state.pages, expected, state.frame)}${state.pages}${expected ? `/${expected}` : ''} page(s)  ${secs}`;
      e.write(CLEAR_LINE + line.slice(0, (e.columns || 80) - 1));
      state.painted = true;
    };

    state.paint = paint;
    state.maybePaint = () => {
      const now = Date.now();
      if (now - state.lastPaint < TICK_MS) return;
      state.lastPaint = now;
      state.frame += 1;
      paint();
    };
    /* unref'd: a progress display must never be the reason a process stays up */
    state.timer = setInterval(() => {
      state.frame += 1;
      state.lastPaint = Date.now();
      paint();
    }, TICK_MS);
    state.timer.unref?.();

    live = state;
    return live;
  };

  const stop = () => {
    if (!live) return null;
    clearInterval(live.timer);
    const e = err();
    if (e && live.painted) e.write(CLEAR_LINE);
    const done = live;
    live = null;
    return done;
  };

  return {
    onSource() {
      const s = begin();
      if (!s) return;
      s.files += 1;
      if (s.phase === 'reading') s.maybePaint();
    },
    onIngest({ done, total }) {
      const s = begin();
      if (!s) return;
      /* An import graph runs this once per package, so a later package
       * restarts the count — hence resetting when `total` changes. */
      if (s.phase !== 'ingesting' || total !== s.ingestTotal) {
        s.phase = 'ingesting';
        s.ingestTotal = total;
        s.lastPaint = 0;
      }
      s.ingested = done;
      s.maybePaint();
    },
    onQuery() {
      const s = begin();
      if (!s) return;
      if (s.phase === 'reading' || s.phase === 'ingesting') {
        s.phase = 'running';
        s.lastPaint = 0; /* show the change at once, not up to a tick later */
      }
      if (s.phase === 'running') s.maybePaint();
    },
    onEmit() {
      const s = begin();
      if (!s) return;
      if (s.phase !== 'rendering') {
        s.phase = 'rendering';
        s.lastPaint = 0;
      }
      s.pages += 1;
      s.maybePaint();
    },
    /*
     * Print a line ABOVE the moving one. The bar is erased, the line goes to
     * stdout — where the caller's logging already went, so redirecting it
     * still works and the bar stays on stderr — and the bar is drawn again
     * underneath. Unthrottled on purpose: the repaint has to happen before
     * the next line arrives, or the bar is missing for a whole tick.
     */
    log(text) {
      const e = err();
      if (live && live.painted && e) e.write(CLEAR_LINE);
      if (typeof process !== 'undefined' && process.stdout) process.stdout.write(`${text}\n`);
      if (live) {
        live.lastPaint = Date.now();
        live.paint();
      }
    },
    finish(summary) {
      const done = stop();
      if (done && done.pages > 0) expected = done.pages;
      const e = err();
      if (summary && e) e.write(`${summary}\n`);
      return done ? { files: done.files, pages: done.pages, ms: Date.now() - done.started } : null;
    },
    get pages() {
      return expected;
    },
    get enabled() {
      return enabled;
    },
  };
}
