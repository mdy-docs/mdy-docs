#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parse as loadYaml } from 'yaml';
import {
  parseDocuments,
  compileTemplateSource,
  nodeFsProvider,
  openDocumentSet,
  walkRawSources,
  renderScriptSite,
  buildSite,
  serveSite,
  createProgress,
  progressSupported,
} from '../index.js';

// Minimal ANSI color helpers — no dependency, since this is presentation
// for the CLI only (not something a library embedder should have forced on
// them). Honors NO_COLOR (https://no-color.org/) and FORCE_COLOR, and
// disables automatically when stdout isn't a TTY — piped output, or a test
// harness capturing output via child_process, never gets escape codes.
const useColor = Boolean(process.env.FORCE_COLOR) || (Boolean(process.stdout.isTTY) && !process.env.NO_COLOR);
const paint = (open, close) => (s) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
const bold = paint(1, 22);
const dim = paint(2, 22);
const red = paint(31, 39);
const green = paint(32, 39);
const yellow = paint(33, 39);
const blue = paint(34, 39);
const cyan = paint(36, 39);
const magenta = paint(35, 39);
const mdyTag = () => cyan('[mdy]');
const timestamp = () => dim(new Date().toLocaleTimeString());

// Ingested (read into the document set), written (produced on disk/in
// memory), and changed (a watched file whose save triggered a rebuild) —
// one color each, used consistently across build/serve and the plain CLI.
const tagRead = () => blue('[read]');
const tagWrite = () => green('[write]');
const tagChange = () => yellow('[change]');
const tagSend = () => magenta('[send]');

// `mdy build`/`mdy dev` — the static-site layer. Handled first and
// unconditionally: a bare `mdy [input...]` treats every positional as a
// document path, so these two verbs have to be claimed before that parsing
// ever runs.
const SITE_USAGE = `mdy — build sites from mdy documents.

Usage:
  mdy build [site-dir] [--out <dir>] [--drafts] [--future] [--entry <path>]
            [--publish [--broker <url>]]
      render the site (default dir: ., out: <site-dir>/dist)
  mdy dev [site-dir] [--port <n>] [--drafts] [--future] [--entry <path>]
          [--broker <url>] [--consumer <name>] [--group <name>]
          [--max-attempts <n>] [--backoff <ms>] [--max-backoff <ms>]
      development server: watch, rebuild, live reload (default port: 4321)
      — and, when a broker answers, publish and deliver messages too.
      For development only: it rebuilds the whole site on every save and
      injects a live-reload script into every page. Deploy \`mdy build\`'s
      output.
  mdy dead <page-name> [--broker <url>] [--requeue <index>]
      what could not be rendered, and putting one back

On a terminal, build and dev keep the [read]/[write] line per file and add
a progress line beneath it — files read, documents ingested, then pages
rendered, with a real percentage once a previous build has said how many
pages to expect. Redirected output gets the per-file lines alone, so a
pipeline reading them is unaffected.

Every site is a script-defined site: site-dir's entry document (main.mdy,
or --entry <path>) decides everything itself — content, URLs, layouts,
output shape — via $/$.find/$.render/$.emit. --drafts/--future are
threaded through as plain context booleans for it to interpret, not
filtered here.

$.publish(name, data) queues a message for another page — $.render
deferred and made durable. Messages are collected during the build and
sent only once it has fully succeeded, so a failed build publishes
nothing and a watch-mode rebuild does not re-fire what the last one sent.
Without --publish they are reported and dropped; with it they go to a
sukkal broker (--broker, default http://127.0.0.1:8080).

\`mdy dev\` is also the other end. With a broker reachable it sends what a
rebuild publishes and renders whichever page each delivered message is
addressed to, with the message bound as \`req\` — so the whole loop is one
process and editing a page changes what the next message renders. Nothing
subscribes and no front matter marks a page as a handler: a page is
addressable because it exists, and its name is its path without the
extension, "/" written as ".". A render that throws does not acknowledge,
so the message comes back; pages reached this way have to be idempotent.
`;

/** Shared flag parsing for build/dev: positional root + options. */
function parseSiteArgs(args) {
  const opts = { root: '.' };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--out') opts.outDir = args[++i];
    else if (a === '--port') opts.port = Number(args[++i]);
    else if (a === '--drafts') opts.drafts = true;
    else if (a === '--future') opts.future = true;
    else if (a === '--entry') opts.entry = args[++i];
    else if (a === '--publish') opts.publish = true;
    else if (a === '--consumer') opts.consumer = args[++i];
    else if (a === '--group') opts.group = args[++i];
    else if (a === '--max-attempts') opts.maxAttempts = args[++i];
    else if (a === '--backoff') opts.backoff = args[++i];
    else if (a === '--max-backoff') opts.maxBackoff = args[++i];
    else if (a === '--requeue') opts.requeue = args[++i];
    else if (a === '--broker') opts.broker = args[++i];
    else opts.root = a;
  }
  return opts;
}

/*
 * The transport is a separate package, so that mdy-docs itself has no
 * network dependency and its browser bundle stays buildable (see
 * src/publish.js). Loaded only when a command actually needs to talk to a
 * broker, and reported honestly when it is not installed rather than
 * failing with a bare module-not-found.
 */
async function loadBus() {
  try {
    return await import('@mdy-docs/mdy-bus');
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    throw new Error(
      'this needs the messaging transport: npm install @mdy-docs/mdy-bus\n' +
        '  (mdy itself collects messages and sends nothing — see docs/messaging-plan.md)'
    );
  }
}

const siteFail = (message) => {
  console.error(red(String(message)));
  process.exit(1);
};

/*
 * `mdy dev`'s messaging half: publishing and delivering in the one
 * process that already has the document set.
 *
 * Both halves, because half of it is not a loop: a dev server that
 * delivered but never published would still need a second terminal to make
 * a message exist, and one that published but never delivered would give
 * nothing to look at. Editing a page changes what the next message renders,
 * because serve already rebuilds on save and the bus is handed the new set.
 *
 * Publishing from a rebuild is the thing src/publish.js warns about — there
 * is no incremental cache, so every keystroke reruns the entry and would
 * re-send everything it publishes. So a message is sent at most ONCE PER
 * RUN: a fingerprint of name and data is remembered, and a rebuild only
 * sends what this process has not already sent. That is deliberately
 * per-process and not a broker-level dedup key — it needs no decision about
 * where a durable id would come from (see docs/messaging-plan.md's open
 * questions), and restarting serve resending is the right behaviour for a
 * dev loop anyway.
 *
 * Absent a broker this is all skipped and serve behaves exactly as before,
 * holding messages and saying so. Which is why there is no flag: a broker
 * on the other end is the only thing that makes delivery meaningful, and
 * that is a fact to discover rather than a mode to select.
 */
async function connectServeMessaging(brokerUrl, delivery = {}) {
  let mod;
  try {
    mod = await loadBus();
  } catch {
    return null;
  }

  /*
   * Two ways to have a broker, and the preferred one needs nothing
   * installed. sukkal compiles to WASM, so with no --broker given the
   * whole thing runs in this process: no port, no callback URL, no bearer
   * token, no re-registration heartbeat — none of which was ever
   * messaging, only the cost of two processes.
   *
   * A --broker URL still wins, because reaching a real one is how a dev
   * server talks to something a colleague or a deployment is also using.
   */
  let local = null;
  let broker = brokerUrl;
  if (!brokerUrl) {
    try {
      local = await mod.openInProcessBroker();
    } catch {
      return null;                 /* sukkal's wasm is not built; stay quiet */
    }
    broker = 'in-process';
  } else {
    const health = await fetch(`${broker.replace(/\/+$/, '')}/health`).catch(() => null);
    if (!health?.ok) return null;
  }

  const publishMessages = mod.publishMessages;
  const bus = mod.runBus;
  const sent = new Set();
  // The bus prints its own listening banner, which serve has already said
  // in its own; everything else — deliveries, refusals, deaths — is wanted.
  const busLog = makeBusLogger({ banner: false });
  let running = null;

  return {
    broker,
    async rebuilt(info) {
      // The bus is started from the first build's set rather than opening
      // a second one, so serve and its deliveries can never disagree about
      // what a page name means.
      if (!running) {
        const start = local
          ? mod.runLocalBus(info.site, local, { ...delivery, onEvent: busLog })
          : bus(info.site, { ...delivery, broker, onEvent: busLog });
        running = await start.catch((err) => {
          console.error(`${timestamp()} ${red('[bus]')} ${err.message ?? err}`);
          return null;
        });
      } else {
        running.setSite(info.site);
      }

      // DRAIN rather than read. `messages` is one array per built set, and
      // both halves of this process append to it: the entry document's own
      // $.publish calls during the rebuild, and a delivered page's while it
      // renders. The bus flushes whatever it finds there after a render, so
      // anything left behind here would be attributed to the first message
      // that happened to arrive — and re-sent under its name. Emptying it
      // as it is published is what keeps the two halves separate.
      const produced = info.site.messages.splice(0);

      const fresh = produced.filter((m) => {
        const fingerprint = `${m.name}\u0000${JSON.stringify(m.data ?? null)}`;
        if (sent.has(fingerprint)) return false;
        sent.add(fingerprint);
        return true;
      });
      try {
        if (local) {
          // In process, publishing and delivering are the same tick: the
          // page a message names renders before this returns, and anything
          // it publishes onward goes with it.
          for (const m of fresh) {
            const { index, bytes } = await local.publish(m.name, m.data);
            console.log(`${timestamp()} ${magenta('[send]')} ${m.name} ${dim(`#${index}, ${bytes} bytes`)}`);
          }
          await running?.drain();
          return;
        }
        if (fresh.length === 0) return;
        await publishMessages(fresh, {
          url: broker,
          onSend: ({ name, bytes }) => console.log(`${timestamp()} ${magenta('[send]')} ${name} ${dim(`(${bytes} bytes)`)}`),
        });
      } catch (err) {
        console.error(`${timestamp()} ${red('[send]')} ${err.message ?? err}`);
      }
    },
  };
}

/** vite-style "ready" banner, printed once after the dev server's first build completes. */
function serveReadyBanner(url, ms, messaging) {
  return [
    '',
    `  ${bold(magenta('MDY'))}  ${dim('ready in')} ${bold(`${ms} ms`)}`,
    '',
    `  ${green('➜')}  ${bold('Local:')}   ${cyan(url)}`,
    ...(messaging ? [`  ${green('➜')}  ${bold('Broker:')}  ${cyan(messaging.broker)} ${dim('— publishing and delivering')}`] : []),
    `  ${green('➜')}  ${dim('press ctrl+c to stop')}`,
    '',
  ].join('\n');
}

/** serveSite's onRebuild: every rebuild AFTER the first gets its own
 * timestamped line (vite's HMR-update style), prefixed with which watched
 * file(s) triggered it; the first is covered by serveReadyBanner instead,
 * unless it failed — a broken first build still serves, so that's worth
 * surfacing immediately rather than staying silent under the ready banner.
 *
 * A rebuild's $.publish calls are counted on the line and never sent. The
 * dev server deliberately does not publish — there is no incremental cache,
 * so every save reruns the entry and anything that went out would re-fire on
 * every keystroke (src/publish.js) — but silence made $.publish look inert.
 * The names are listed ONCE, the first time this process sees each one, for
 * the same reason `[read]` lines are: a site that publishes on every rebuild
 * would otherwise drown out what changed. `mdy build --publish` is what
 * actually sends. */
function makeServeLogger({ live = false } = {}) {
  const announced = new Set();
  return (info) => {
    const ts = timestamp();
    const held = info.messages ?? [];
    // With a broker on the other end these are sent, and reporting them as
    // held would be a lie — connectServeMessaging logs each `[send]`
    // instead.
    for (const message of live ? [] : held) {
      if (announced.has(message.name)) continue;
      announced.add(message.name);
      console.log(`${ts} ${dim('[hold]')} ${message.name} ${dim('— no broker; mdy build --publish sends')}`);
    }
    if (info.ok && info.first) return;
    for (const path of info.changed ?? []) console.log(`${ts} ${tagChange()} ${path}`);
    if (info.ok) {
      const detail = info.reused > 0 ? dim(` (${info.reused} reused, ${info.rebuilt} rebuilt)`) : '';
      const holding = held.length > 0 && !live ? dim(`, ${held.length} message(s) held`) : '';
      console.log(`${ts} ${mdyTag()} rendered ${bold(info.pages)} page(s) in ${info.ms}ms${detail}${holding}`);
    } else {
      console.error(`${ts} ${red('[mdy] build failed')} — still serving the last good build\n  ${info.error}`);
    }
  };
}

/*
 * The delivery logger, deliberately the same shape as makeServeLogger's.
 *
 * A delivery IS a re-render — the same page, the same engine, reached by a
 * message instead of by a file changing — so it should read like one. A
 * rebuild says what it rendered and how long it took; so does this, plus
 * the two things only a delivery has: which message caused it, and which
 * attempt this is.
 *
 * Retries are the reason `attempt` is on the line at all. A page that
 * fails and comes back looks identical to one being delivered twice
 * unless the line says which it is.
 */
function makeBusLogger({ banner = true } = {}) {
  const attempt = (n, max) => (n > 1 ? ` ${yellow(`attempt ${n}${max ? `/${max}` : ''}`)}` : '');
  let maxAttempts = 0;

  return (e) => {
    const ts = timestamp();
    switch (e.type) {
      case 'registered': {
        // Recorded even when the banner is suppressed (serve prints its
        // own): the retry policy is what puts the "/5" on an attempt, and
        // an attempt count with nothing to compare it to is half a fact.
        maxAttempts = e.policy?.max_attempts ?? 0;
        if (!banner) break;
        console.log(
          [
            '',
            `  ${bold(magenta('MDY'))}  ${dim('bus listening')}`,
            '',
            `  ${green('➜')}  ${bold('Broker:')}    ${cyan(e.broker)}`,
            `  ${green('➜')}  ${bold('Callback:')}  ${cyan(e.callback)}`,
            `  ${green('➜')}  ${bold('Pages:')}     ${e.pages} addressable`,
            `  ${green('➜')}  ${dim(`group ${e.group}, up to ${maxAttempts} attempts — press ctrl+c to stop`)}`,
            '',
          ].join('\n')
        );
        break;
      }
      case 'delivered': {
        const extra = e.published > 0 ? dim(` (published ${e.published})`) : '';
        console.log(
          `${ts} ${green('[deliver]')} ${e.subject} ${dim(`#${e.index}`)} → rendered ${bold(e.path ?? '?')} in ${bold(`${e.ms}ms`)}${extra}${attempt(e.attempts, maxAttempts)}`
        );
        break;
      }
      case 'failed': {
        const last = maxAttempts > 0 && e.attempts >= maxAttempts;
        console.error(
          `${ts} ${red('[refuse]')} ${e.subject} ${dim(`#${e.index}`)} — ${bold(e.path ?? '?')} threw after ${e.ms}ms${attempt(e.attempts, maxAttempts)}\n` +
            `  ${e.error?.message ?? e.error}\n` +
            `  ${dim(last ? `out of attempts — dead-lettering to ${e.subject}.dead` : 'returned; the broker will try again after a backoff')}`
        );
        break;
      }
      case 'dead': {
        const where = e.handled
          ? `→ rendered ${bold(e.path ?? '?')} in ${bold(`${e.ms}ms`)}`
          : dim(`no ${e.subject} page — kept, see \`mdy dead ${e.subject.replace(/\.dead$/, '')}\``);
        console.error(`${ts} ${red('[dead]')} ${e.subject} ${dim(`#${e.index}`)} ${where}`);
        break;
      }
      case 'undeliverable':
        console.error(
          `${ts} ${yellow('[return]')} ${e.subject} ${dim(`(${e.why})`)} — ${e.count} message(s) returned; they will dead-letter`
        );
        break;
      case 'error':
        console.error(`${ts} ${red('[bus]')} ${e.error?.message ?? e.error}`);
        break;
    }
  };
}

/** A given path gets a `[read]` line only the first time this process ever
 * sees it — a script-defined site has no incremental cache (script-site.js),
 * so every rebuild re-walks and re-ingests everything; reporting all of it
 * again on every keystroke-triggered save would drown out what matters
 * (see makeServeLogger's `[change]` line for that instead). */
function makeSourceLogger(write = console.log) {
  const seen = new Set();
  return (meta) => {
    if (seen.has(meta.path)) return;
    seen.add(meta.path);
    write(`${tagRead()} ${meta.path}`);
  };
}

// `serve` was this command's name until it was renamed, and without this a
// stale habit falls through to the single-file path handler and gets told
// "mdy accepts a single input", which explains nothing. Not an alias: the
// rename exists to stop the CLI implying it is somewhere to host a site, and
// a working `serve` would keep implying it.
if (process.argv[2] === 'serve') {
  console.error(
    red('mdy: `mdy serve` is now `mdy dev`') +
      '\n  It was renamed to say what it is: a development server that rebuilds\n' +
      '  the whole site on every save and injects a live-reload script into\n' +
      '  every page. To publish a site, deploy what `mdy build` writes.'
  );
  process.exit(1);
}

if (process.argv[2] === 'dead') {
  const rest = process.argv.slice(3);
  if (rest.includes('--help') || rest.includes('-h') || rest.length === 0) {
    process.stdout.write(SITE_USAGE);
    process.exit(rest.length === 0 ? 1 : 0);
  }
  const { root: name, broker, requeue } = parseSiteArgs(rest.filter((a) => a !== '--requeue' || true));
  try {
    const { deadLetters, requeueDead } = await loadBus();
    const url = broker ?? 'http://127.0.0.1:8080';
    if (requeue !== undefined) {
      const result = await requeueDead(url, name, Number(requeue));
      console.log(`${green('✓')} requeued ${cyan(name)} ${dim(`(dead #${requeue} → #${result?.index ?? '?'})`)}`);
    } else {
      const letters = await deadLetters(url, name);
      if (letters.length === 0) {
        console.log(`${dim(`nothing has died on ${name}`)}`);
      } else {
        for (const letter of letters) {
          const why = letter.error ?? letter.reason ?? '';
          console.log(
            `${red('[dead]')} ${dim(`#${letter.index}`)} ${bold(name)}` +
              `${letter.attempts ? dim(` after ${letter.attempts} attempt(s)`) : ''}${why ? ` — ${why}` : ''}`
          );
        }
        console.log(dim(`  ${letters.length} dead — \`mdy dead ${name} --requeue <index>\` puts one back`));
      }
    }
  } catch (err) {
    siteFail(err.message ?? err);
  }
} else if (['build', 'dev'].includes(process.argv[2])) {
  const [siteCmd, ...siteRest] = process.argv.slice(2);
  if (siteRest.includes('--help') || siteRest.includes('-h')) {
    process.stdout.write(SITE_USAGE);
    process.exit(0);
  }
  switch (siteCmd) {
    case 'build': {
      const { root, publish, broker, ...opts } = parseSiteArgs(siteRest);
      try {
        const started = Date.now();
        // The per-file list scrolls and the moving line stays under it: every
        // [read]/[write] goes through progress.log, which lifts the bar,
        // prints, and puts it back. Off a terminal the bar is disabled and
        // log() is a plain write, so redirected output is exactly what it
        // always was.
        const progress = createProgress();
        const { pages, outDir, messages } = await buildSite(root, {
          ...opts,
          onSource: (meta) => {
            progress.onSource(meta);
            progress.log(`${tagRead()} ${meta.path}`);
          },
          onIngest: progress.onIngest,
          onQuery: progress.onQuery,
          onEmit: progress.onEmit,
          onWrite: (file) => progress.log(`${tagWrite()} ${file}`),
        });
        progress.finish();
        console.log(
          `${green('✓')} built ${bold(pages)} page(s) → ${cyan(outDir)} ${dim(`(${Date.now() - started}ms)`)}`
        );
        // Strictly after the build reported success — that ordering IS
        // the deferred half of $.publish (src/publish.js), not a
        // formatting choice.
        if (messages.length > 0) {
          if (publish) {
            const { publishMessages } = await loadBus();
            const { sent } = await publishMessages(messages, {
              url: broker,
              onSend: ({ name, bytes }) => console.log(`${tagSend()} ${name} ${dim(`(${bytes} bytes)`)}`),
            });
            console.log(`${green('✓')} published ${bold(sent)} message(s)`);
          } else {
            for (const m of messages) console.log(`${dim('[hold]')} ${m.name}`);
            console.log(
              dim(`  ${messages.length} message(s) not sent — pass --publish to send them to a sukkal broker`)
            );
          }
        }
      } catch (err) {
        siteFail(err.message ?? err);
      }
      break;
    }
    case 'dev': {
      const { root, broker, consumer, group, maxAttempts, backoff, maxBackoff, ...opts } =
        parseSiteArgs(siteRest);
      try {
        const started = Date.now();
        const messaging = await connectServeMessaging(broker, {
          consumer,
          group,
          maxAttempts: maxAttempts === undefined ? undefined : Number(maxAttempts),
          backoffMs: backoff === undefined ? undefined : Number(backoff),
          maxBackoffMs: maxBackoff === undefined ? undefined : Number(maxBackoff),
        });
        const logger = makeServeLogger({ live: messaging !== null });
        // Rebuilds are where this matters most: the first build at least
        // printed a [read] line per file, but makeSourceLogger dedupes, so
        // every rebuild after it said nothing at all until it was finished.
        const progress = createProgress();
        const sourceLogger = makeSourceLogger(progress.log);
        const { url } = await serveSite(root, {
          ...opts,
          onSource: (meta) => {
            progress.onSource(meta);
            sourceLogger(meta);
          },
          onIngest: progress.onIngest,
          onQuery: progress.onQuery,
          onEmit: progress.onEmit,
          onRebuild: (info) => {
            // Clear the line before the rebuild's own report — the two must
            // not land on top of each other.
            progress.finish();
            logger(info);
            if (info.ok && messaging) messaging.rebuilt(info);
          },
        });
        console.log(serveReadyBanner(url, Date.now() - started, messaging));
      } catch (err) {
        siteFail(err.message ?? err);
      }
      break;
    }
  }
} else {

  // Reading/watching input files goes through nodeFsProvider (this package's
  // own vault layer) rather than calling node:fs directly — this CLI is a
  // real consumer of the same primitive any embedder gets, not a second,
  // hand-rolled implementation of "read a file, watch a directory" living
  // next to it. (writeFileSync for --out, and readFileSync(0) for stdin,
  // stay direct: neither is "getting a file into the document set", which
  // is what the vault layer is for.)
  const fs = nodeFsProvider();

  const USAGE = `mdy — generate a document from an mdy template, or a script-defined site.

Usage:
  mdy [path] [options]
  mdy build [site-dir] [options]   render a whole site — see: mdy build --help
  mdy dev [site-dir] [options]     development server — see: mdy dev --help

Arguments:
  path                   A .mdy file, a directory, or "-"/omitted for stdin.
                        A FILE renders just that file — its own \`---\`-split
                        documents, the first is the entry — with no access to
                        any other file.
                        A DIRECTORY is scanned in full: every file under it
                        is inserted as a raw document (path/name/ext/size/
                        mtime, plus front matter for .mdy files), so the
                        entry document's $/$.find/$.render reach any of
                        them — it alone decides what any file/path means
                        (which are "posts", what URL/layout each gets, …),
                        entirely in template code. The entry defaults to
                        main.mdy; --entry picks another file.

Options:
  -o, --out <file>      Write output to <file> (default: stdout). If <file>
                        is an existing directory, any $.emit(path, content)
                        the entry produced is written under it instead (the
                        entry's own rendered output still goes to stdout in
                        that case, since there is no filename for it).
      --html            Emit the finished document as HTML instead of the
                        text its own code wrote (which is what an .mdy file
                        producing a feed, a robots.txt or any other
                        non-markup output actually means).
      --entry <path>    Directory input only: the entry document's path,
                        relative to the directory (default: main.mdy).
      --emit-js         Emit the compiled JavaScript instead of rendering
                        (debug): every document for a file input, just the
                        entry document for a directory input.
  -d, --data <k=v>      Add a context value (repeatable). Value is parsed as
                        JSON when possible, otherwise treated as a string.
      --data-file <f>   Merge a YAML/JSON file into the context.
  -w, --watch           Keep running and re-render on any relevant change —
                        the given file (or, for a directory, any file under
                        it) plus --data-file. A failing render reports to
                        stderr and keeps watching. Not available with stdin.
  -h, --help            Show this help.

Extra context (from --data / --data-file) overrides the document's front matter.
A document with no $.emit calls just renders to stdout/-o as always; $.emit
is the idiom for producing more than one output from a single entry.

Examples:
  mdy report.mdy
  mdy report.mdy --html -o report.html
  mdy report.mdy -d env=prod -d 'build=42' --data-file overrides.yaml
  mdy report.mdy -o report.md --watch             # live re-render on save
  cat report.mdy | mdy - --html                   # stdin → HTML on stdout
  mdy ./my-site                                   # scan the dir, render main.mdy
  mdy ./my-site --entry other.mdy -o dist         # write $.emit output`;

  function fail(msg) {
    // Library errors are already prefixed with "mdy:"; don't double it.
    const text = String(msg).replace(/^mdy:\s*/, '');
    process.stderr.write(red(`mdy: ${text}`) + '\n');
    process.exit(1);
  }

  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        out: { type: 'string', short: 'o' },
        html: { type: 'boolean', default: false },
        entry: { type: 'string' },
        'emit-js': { type: 'boolean', default: false },
        data: { type: 'string', short: 'd', multiple: true, default: [] },
        'data-file': { type: 'string' },
        watch: { type: 'boolean', short: 'w', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    fail(err.message);
  }

  const { values, positionals } = parsed;

  if (values.help) {
    process.stdout.write(USAGE + '\n');
    process.exit(0);
  }

  // Parse -d pairs once: they are static, so malformed ones fail immediately.
  const dataPairs = {};
  for (const pair of values.data) {
    const eq = pair.indexOf('=');
    if (eq === -1) fail(`--data expects key=value, got "${pair}"`);
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    try {
      dataPairs[key] = JSON.parse(raw); // numbers, booleans, null, arrays, objects, "quoted"
    } catch {
      dataPairs[key] = raw; // bare string
    }
  }

  if (positionals.length > 1) fail('mdy accepts a single input: one file, one directory, or stdin ("-")');
  const inputArg = positionals[0] ?? '-';
  const isStdin = inputArg === '-';
  const inputAbs = isStdin ? null : resolve(inputArg);

  // 'file' | 'dir' | 'stdin' — decided once, up front, so every later check
  // (flag validity, warnings, watch target) can just branch on it.
  let inputKind = 'stdin';
  if (!isStdin) {
    let stat;
    try {
      stat = statSync(inputAbs);
    } catch (err) {
      fail(`cannot read input: ${err.message}`);
    }
    inputKind = stat.isDirectory() ? 'dir' : 'file';
  }

  if (values.entry !== undefined && inputKind !== 'dir') fail('--entry is only valid with a directory input');
  if (values.watch && inputKind === 'stdin') fail('--watch cannot read from stdin');
  if (values['emit-js'] && values.html) fail('--emit-js cannot be combined with --html');
  if (values.out && inputKind !== 'stdin' && resolve(values.out) === inputAbs) {
    fail('refusing to overwrite the input');
  }
  if (inputKind === 'file' && extname(inputArg).toLowerCase() !== '.mdy') {
    process.stderr.write(`mdy: warning: input "${inputArg}" does not have a .mdy extension\n`);
  }

  // --- one render pass (re-run per change in --watch mode; throws, never exits)

  /** Extra context: --data-file (re-read each pass) first, then -d overrides. */
  async function loadContext() {
    const context = {};
    if (values['data-file']) {
      let fileText;
      try {
        fileText = await fs.read(dirname(values['data-file']), basename(values['data-file']));
      } catch (err) {
        throw new Error(`cannot read --data-file: ${err.message}`);
      }
      const loaded = loadYaml(fileText);
      if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
        Object.assign(context, loaded);
      } else {
        throw new Error('--data-file must contain a YAML/JSON mapping');
      }
    }
    return Object.assign(context, dataPairs);
  }

  /** A given path gets a `[read]` line only the first time this process
   * ever sees it — --watch re-walks the whole directory on every save
   * (see script-site.js), so repeating it all every keystroke would drown
   * out what matters. */
  const seenSources = new Set();
  function logSource(meta) {
    if (seenSources.has(meta.path)) return;
    seenSources.add(meta.path);
    process.stderr.write(`${tagRead()} ${meta.path}\n`);
  }

  /** $.emit output: written under --out if it's an existing directory, else just reported. */
  async function reportEmitted(emitted) {
    if (emitted.size === 0) return;
    const toDir = values.out && existsSync(values.out) && statSync(values.out).isDirectory();
    if (toDir) {
      for (const [path, content] of emitted) {
        const dest = join(values.out, path);
        await mkdir(dirname(dest), { recursive: true });
        // $.emit content is text; $.resize content ($.resize's binaryOutputs)
        // is a Uint8Array of real image bytes — never JSON.stringify that.
        const bytes =
          typeof content === 'string' ? content : content instanceof Uint8Array ? content : JSON.stringify(content);
        await writeFile(dest, bytes);
        process.stderr.write(`${tagWrite()} ${path}\n`);
      }
      process.stderr.write(`mdy: wrote ${emitted.size} emitted file(s) to ${values.out}\n`);
    } else {
      process.stderr.write(
        `mdy: ${emitted.size} file(s) emitted via $.emit not written (pass --out <existing-dir> to write them): ${[...emitted.keys()].join(', ')}\n`
      );
    }
  }

  /**
   * Position of the document whose `data.path === entryPath` in a flattened
   * document array (`set.docs`, or `parseDocuments(sources)`'s own result —
   * both carry `.data.path` and are indexed identically, array position).
   * Resolved AFTER splitting/flattening, not against the pre-split file
   * list: a sibling file with its own internal `---` splits contributes
   * more than one document, which would shift every later file's position.
   */
  function findEntryIndex(docs, entryPath, root) {
    const i = docs.findIndex((d) => d.data.path === entryPath);
    if (i === -1) {
      throw new Error(`entry script not found at ${JSON.stringify(entryPath)} (looked among ${docs.length} document(s) under ${root})`);
    }
    return i;
  }

  async function generateOutput() {
    const context = await loadContext();
    let output;
    let emitted = new Map();

    if (inputKind === 'dir') {
      // The script-entry-point mechanism: walk the whole directory into raw
      // documents and render one designated entry — its $/$.find/$.render
      // reach every other file under the directory, and $.emit/$.resize
      // collect any named side outputs. Shared with mdy build/serve's own
      // script-site detection (src/build.js) — same primitive, same
      // natives, one implementation.
      const entryPath = values.entry ?? 'main.mdy';
      if (values['emit-js']) {
        const sources = await walkRawSources(inputAbs, { fs });
        const docs = parseDocuments(sources);
        const i = findEntryIndex(docs, entryPath, inputAbs);
        output = `// document ${i}\nfunction __doc${i}(req, res) {\n${compileTemplateSource(docs[i].content)}\nreturn __out;\n}`;
      } else {
        const site = await renderScriptSite(inputAbs, {
          entry: entryPath,
          fs,
          context,
          onSource: logSource,
        });
        emitted = new Map([...site.outputs, ...site.binaryOutputs]);
        output = values.html ? site.output : site.text;
      }
    } else {
      // 'file' or 'stdin': just that one input's own text, no site walk.
      let text;
      try {
        text = isStdin ? readFileSync(0, 'utf8') : await fs.read(dirname(inputAbs), basename(inputAbs));
      } catch (err) {
        throw new Error(`cannot read input: ${err.message}`);
      }
      if (!isStdin) logSource({ path: inputAbs });
      if (values['emit-js']) {
        const docs = parseDocuments(text);
        output = docs
          .map(
            (doc, i) =>
              `// document ${i}\nfunction __doc${i}(req, res) {\n${compileTemplateSource(doc.content)}\nreturn __out;\n}`
          )
          .join('\n\n');
      } else {
        const localEmitted = new Map();
        const set = await openDocumentSet(text, {
          onEmit: ({ path, content }) => localEmitted.set(path, content),
        });
        emitted = localEmitted;
        output = values.html ? await set.render(0, context) : await set.renderText(0, context);
      }
    }

    if (!values['emit-js']) await reportEmitted(emitted);
    return output.endsWith('\n') ? output : output + '\n';
  }

  function emitOutput(output) {
    // --out as an existing directory is claimed by $.emit output (see
    // reportEmitted) — there's no filename to write the entry's own
    // rendered text to, so it goes to stdout instead, same as no --out.
    const outIsDir = values.out && existsSync(values.out) && statSync(values.out).isDirectory();
    if (values.out && !outIsDir) {
      try {
        writeFileSync(values.out, output);
      } catch (err) {
        throw new Error(`cannot write --out: ${err.message}`);
      }
    } else {
      process.stdout.write(output);
    }
  }

  if (!values.watch) {
    try {
      emitOutput(await generateOutput());
    } catch (err) {
      fail(err.message);
    }
  } else {
    // --- watch mode: re-render on change, survive render errors.
    // Status/errors go to stderr throughout (unchanged from before) since
    // stdout is the actual rendered output when there's no -o.

    let timer = null;
    let running = false;
    let dirty = false;
    let first = true;
    let pendingChanges = new Set(); // watched paths changed since the last render attempt

    const report = (msg, { error = false } = {}) => {
      const line = `${timestamp()} ${mdyTag()} ${msg}`;
      process.stderr.write((error ? red(line) : line) + '\n');
    };

    /** vite-style "watching" banner, printed once before the first render. */
    const readyBanner = (target) =>
      ['', `  ${bold(magenta('MDY'))}  ${dim('watching')} ${bold(target)}`, `  ${green('➜')}  ${dim('press ctrl+c to stop')}`, ''].join('\n');

    const rerender = async () => {
      if (running) {
        dirty = true; // a change arrived mid-render; run again after
        return;
      }
      running = true;
      const changed = [...pendingChanges];
      pendingChanges = new Set();
      const started = Date.now();
      try {
        if (!first) for (const path of changed) report(`${tagChange()} ${path}`);
        emitOutput(await generateOutput());
        if (!first) report(`rendered in ${Date.now() - started} ms`);
      } catch (err) {
        report(err.message ?? err, { error: true });
      }
      first = false;
      running = false;
      if (dirty) {
        dirty = false;
        rerender();
      }
    };

    // Editors fire several events per save; debounce them into one render.
    const schedule = (changedPath) => {
      if (changedPath) pendingChanges.add(changedPath);
      clearTimeout(timer);
      timer = setTimeout(rerender, 100);
    };

    if (inputKind === 'dir') {
      // One recursive watch on the whole directory: any file under it can
      // affect the render (the entry's $.find reaches all of them).
      await fs.watch(inputAbs, ({ path }) => schedule(path));
      if (values['data-file']) {
        await fs.watch(resolve(dirname(values['data-file'])), ({ path }) => {
          if (path === basename(values['data-file'])) schedule(values['data-file']);
        });
      }
      process.stderr.write(readyBanner(inputAbs) + '\n');
    } else {
      // A single file (+ optional --data-file): editors save atomically
      // (write temp + rename), which kills a watcher attached to the file
      // itself — so watch each containing directory and filter by filename.
      const watched = [inputAbs, ...(values['data-file'] ? [resolve(values['data-file'])] : [])];
      const byDir = new Map();
      for (const p of watched) {
        const dir = dirname(p);
        if (!byDir.has(dir)) byDir.set(dir, new Set());
        byDir.get(dir).add(basename(p));
      }
      for (const [dir, names] of byDir) {
        await fs.watch(dir, ({ path }) => {
          if (names.has(path)) schedule(join(dir, path));
        });
      }
      process.stderr.write(readyBanner(`${watched.length} file(s)`) + '\n');
    }

    await rerender();
  }
}
