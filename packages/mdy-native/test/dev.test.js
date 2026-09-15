/*
 * The dev server.
 *
 * `mdy dev` goes on serving when the FIRST build fails — there is nothing to
 * fall back to, and a broken save should not take the server down — so the
 * engine is absent, and the first message delivered read documents off it and
 * killed the process.
 *
 * Native only, deliberately. The in-process broker is this binary's (`mdy dev
 * runs its own broker`); node's dev server has no delivery endpoint at all and
 * answers 404, so there is no shared behaviour to pin and test/cli.test.js is
 * the wrong place.
 *
 * The same reasoning has since made this the home for the rest of the
 * broker-facing side — `mdy dead` talking to a wedged broker, below — for
 * which node has no equivalent either.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { connect } from 'node:net';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, unlinkSync, mkdirSync, renameSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode } from '../../../third_party/nisaba-db/third_party/binjson/js/binjson.js';

const here = dirname(fileURLToPath(import.meta.url));
const bin = process.env.MDY_CLI ?? join(here, '..', 'build', 'mdy');

/* Every site here gets a throwaway directory; collect them and remove the
 * lot at the end rather than leaving one per test under . */
const temps = [];
const mkTemp = () => { const d = mkdtempSync(join(tmpdir(), 'mdy-dev-')); temps.push(d); return d; };
const cleanup = () => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); };
after(cleanup);
/* And on the way out however the run ends: a timed-out or killed run does
 * not reach `after`. */
process.on('exit', cleanup);

/* One delivery, in the shape sukkal POSTs: an array of jobs. A `payload` is
 * not needed to reach what is under test and would only say less clearly what
 * is. */
const batch = Buffer.from(encode([{ index: 1, attempts: 1 }]));

const BROKEN = '% const = \n= this does not compile\n';
/* Answers to `a.b`, and renders as a page too — the entry render has no
 * `req.msg`, and a document that assumed one would fail the build for a
 * reason that has nothing to do with what is being tested. */
const WORKING = '+++\nmessageName: a.b\n+++\ngot {{ req.msg ? req.msg.name : "page" }}\n';

/*
 * node:http rather than fetch: the in-process broker never mints a token, so
 * the header the server expects is the literal `Bearer ` — trailing space and
 * all — and fetch trims it away.
 */
const deliver = (port) =>
  new Promise((resolve, reject) => {
    const req = request(
      { host: 'localhost', port, path: '/mdy/mdy-bus', method: 'POST',
        headers: { 'Authorization': 'Bearer ', 'X-Sukkal-Subject': 'a.b',
                   'Content-Length': batch.length } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(batch);
  });

/* The server writes its banner to stderr and its per-build lines to stdout;
 * both matter here, so they are one stream. */
function startDev(root, extra = []) {
  const child = spawn(bin, ['dev', root, '--port', '0', ...extra]);
  let log = '';
  child.stdout.on('data', (b) => { log += b; });
  child.stderr.on('data', (b) => { log += b; });
  return {
    child,
    log: () => log,
    async until(re, ms = 15000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const m = log.match(re);
        if (m) return m;
        if (child.exitCode !== null) throw new Error(`the server exited (${child.exitCode})\n${log}`);
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${re}\n${log}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    },
  };
}

test('a delivery arriving before the first good build is held, not fatal', async () => {
  const root = mkTemp();
  writeFileSync(join(root, 'main.mdy'), BROKEN);

  const dev = startDev(root);
  try {
    await dev.until(/build failed/);
    const [, port] = await dev.until(/http:\/\/localhost:(\d+)/);

    assert.equal(await deliver(port), 500, 'the messages go back to the broker');
    assert.match(dev.log(), /\[hold\][^\n]*a\.b/, 'and the reason is said out loud');
    assert.equal(dev.child.exitCode, null, 'the server is still running');

    /* The half that proves holding was the right answer: fix the site and the
     * same delivery lands. */
    writeFileSync(join(root, 'main.mdy'), WORKING);
    await dev.until(/rendered/);

    assert.equal(await deliver(port), 200);
    await dev.until(/\[deliver\][^\n]*a\.b/);
    assert.equal(dev.child.exitCode, null);

    /*
     * The timestamp on every one of those lines — the one thing in this binary
     * that used to be formatted two ways. `report()` asked for %l, a GNU
     * extension emscripten's strftime does not have: given "%l:%M:%S %p" it
     * returns 0 and writes NOTHING, so the stamp vanishes entirely rather
     * than losing a space. Both callers go through stamp_now.
     *
     * The two assertions are a pair and neither is redundant. The first
     * catches an EMPTY stamp and a space-padded one; it tolerates an ANSI
     * prefix, which also lets it match "09:..." by eating the 0, so the second
     * is what catches zero-padding. Between them: empty, " 9:", "09:" and "9:"
     * are told apart.
     *
     * Half of this is hour-dependent, honestly: %I and a stripped %I agree for
     * hours 10, 11 and 12, so the padding assertion only bites between 1 and
     * 9 o'clock. The emptiness one bites at any hour, and emptiness is the
     * bug. All 24 hours were compared off-line, in the review.
     */
    assert.match(dev.log(), /(^|\n)\x1b?\[?[0-9;]*m?[1-9]\d?:[0-5]\d:[0-5]\d [AP]M /,
                 'the log lines carry an unpadded 12-hour stamp');
    assert.doesNotMatch(dev.log(), /(^|\n)[^\S\n]*0\d:\d\d:\d\d [AP]M /,
                        'and never a zero-padded one');
  } finally {
    dev.child.kill();
  }
});

/*
 * The request buffer's cap. Without one, `recv` appends and the buffer
 * doubles, so a peer that keeps writing makes the server allocate until it
 * dies — and on a 0.0.0.0 bind that peer is anyone on the
 * network. The cap is 16 MiB; this writes past it and expects the connection
 * to be refused and, the part that matters, the SERVER to still be there.
 */
test('a request bigger than the cap is refused, and the server survives', async () => {
  const root = mkTemp();
  writeFileSync(join(root, 'main.mdy'), WORKING);

  const dev = startDev(root);
  try {
    const [, port] = await dev.until(/http:\/\/localhost:(\d+)/);

    const LIMIT = 16 * 1024 * 1024;
    const written = await new Promise((resolve) => {
      let sent = 0;
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(sent); } };
      const sock = connect({ host: '127.0.0.1', port: Number(port) }, () => {
        sock.write('POST /mdy/mdy-bus HTTP/1.1\r\nHost: x\r\n' +
                   'Content-Length: 1073741824\r\n\r\n');
        /* Keep writing until the server hangs up on us. 1 MiB a go. */
        const chunk = Buffer.alloc(1024 * 1024, 0x61);
        const pump = () => {
          while (!done && sent < LIMIT * 4) {
            sent += chunk.length;
            if (!sock.write(chunk)) { sock.once('drain', pump); return; }
          }
          sock.end();
        };
        pump();
      });
      /* Either outcome is the server refusing: a 413 then close, or a reset. */
      sock.on('close', finish);
      sock.on('error', finish);
      setTimeout(() => { sock.destroy(); finish(); }, 20000);
    });

    /*
     * The assertion that makes this a test of the CAP and not of node's
     * buffering: without one the server swallows everything and we get to
     * write all 64 MiB. With one it stops listening near 16, so the write
     * fails well before that.
     */
    assert.ok(written < LIMIT * 2,
              `the server stopped reading near the cap (wrote ${written} bytes)`);
    assert.equal(dev.child.exitCode, null, 'the server did not fall over');

    /*
     * And it still answers — the refusal freed that connection and no other.
     * WORKING emits no page, so a 404 is the right answer to `/`; what is
     * being checked is that an answer arrives at all, on a fresh connection,
     * after a peer tried to make the server allocate a gigabyte.
     */
    const res = await new Promise((resolve, reject) => {
      const req = request({ host: 'localhost', port, path: '/', method: 'GET' },
                          (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
      req.on('error', reject);
      req.end();
    });
    assert.ok(res >= 200 && res < 500, `the server still answers (got ${res})`);

    /* And the endpoint still works, which is the one that was attacked. */
    assert.equal(await deliver(port), 200, 'and deliveries still land');
  } finally {
    dev.child.kill();
  }
});

/*
 * One thread serves everything, so a response must not go out with a blocking
 * send. A client that asks for a page and then stops reading fills
 * the socket buffer, `send` blocks, and the watcher, the rebuilds and every
 * other client stop with it — for as long as that client cares to hold on.
 *
 * So: emit a page far larger than any socket buffer, ask for it, never read a
 * byte, and check the server is still answering. SEND_TIMEOUT_MS is 5s, so
 * this waits longer than that and no longer than it has to.
 */
test('a client that stops reading does not stall the server', async () => {
  const root = mkTemp();
  writeFileSync(join(root, 'main.mdy'),
    '% $.emit("big.html", "x".repeat(16 * 1024 * 1024))\n= big\n');

  const dev = startDev(root);
  try {
    const [, port] = await dev.until(/http:\/\/localhost:(\d+)/);

    /* Ask, then never read. The socket is paused before the response starts. */
    const stuck = connect({ host: '127.0.0.1', port: Number(port) }, () => {
      stuck.pause();
      stuck.write('GET /big.html HTTP/1.1\r\nHost: x\r\n\r\n');
    });
    stuck.on('error', () => {});

    /* Long enough for the kernel buffers to fill and the send to block. */
    await new Promise((r) => setTimeout(r, 1500));

    const started = Date.now();
    const code = await new Promise((resolve, reject) => {
      const req = request({ host: 'localhost', port, path: '/', method: 'GET' },
                          (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
      req.on('error', reject);
      req.setTimeout(20000, () => { req.destroy(new Error('the server stalled')); });
      req.end();
    });
    const waited = Date.now() - started;

    assert.ok(code >= 200 && code < 500, `the server answered (${code})`);
    /* The budget is SEND_TIMEOUT_MS (5s) plus a second of clock granularity;
     * 10 is that with room for a loaded CI box, and still well under the 13.7s
     * this measured when the deadline was per-send instead of per-response. */
    assert.ok(waited < 10000, `and did not wait on the stuck client (${waited}ms)`);
    assert.equal(dev.child.exitCode, null);
    stuck.destroy();
  } finally {
    dev.child.kill();
  }
});

/*
 * Every wait in http.c is bounded. Without that a broker that accepts the
 * connection and then says nothing holds `mdy build --publish`, `mdy dead`
 * and the dev server's registration for as long as it cares to — measured at
 * "still
 * running after 25 seconds", and it would have been forever, because the recv
 * loop's only exit was the peer closing.
 *
 * MDY_HTTP_TIMEOUT_MS moves the budget, which is what makes this testable in
 * two seconds instead of fifteen — and is itself the thing being tested, since
 * a hard limit with no way out is how a fix becomes somebody else's outage.
 */
test('a broker that accepts and never answers does not hang the command', async () => {
  const wedged = createServer(() => { /* say nothing, hold the socket */ });
  await new Promise((r) => wedged.listen(0, '127.0.0.1', r));
  const { port } = wedged.address();
  /* Hold every connection open past the end of the test rather than letting
   * node close them, which would look like a peer close and not a timeout. */
  const held = [];
  wedged.on('connection', (c) => held.push(c));

  try {
    const started = Date.now();
    const { code, err } = await new Promise((resolve, reject) => {
      const child = spawn(bin, ['dead', 'somepage', '--broker', `http://127.0.0.1:${port}`],
                          { env: { ...process.env, MDY_HTTP_TIMEOUT_MS: '2000' } });
      let err = '';
      child.stderr.on('data', (b) => { err += b; });
      child.stdout.on('data', () => {});
      child.on('error', reject);
      child.on('exit', (code) => resolve({ code, err }));
      setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`it hung:\n${err}`)); }, 30000);
    });
    const waited = Date.now() - started;

    assert.notEqual(code, null, 'it exited rather than hanging');
    assert.ok(waited < 15000, `and gave up on its own budget (${waited}ms)`);
    assert.match(err, /did not answer within 2000ms/,
                 'and said that is what happened, not that the answer was malformed');
  } finally {
    for (const c of held) c.destroy();
    wedged.close();
  }
});

/*
 * A broker that refuses. Every test above uses the in-process broker, so this
 * is the only cover the --broker path gets — registration, publish, refusal.
 * A refusal branch that does not free the response is a dev server keeping
 * every refused body for the life of the process: 47,360 bytes after ten
 * rebuilds, against 1,280 when it frees, and that remainder is the dedupe
 * list, which is retained on purpose.
 *
 * A leak is not something node can assert, so what this pins is the path: the
 * refusal is reported, and the server goes on serving. Without the path being
 * exercised at all, the free could be deleted again and nothing would notice.
 */
test('a broker that refuses a publish is reported, and the server goes on', async () => {
  const refusals = [];
  const broker = createServer((req, res) => {
    req.resume();
    if (req.url.startsWith('/health')) { res.writeHead(200); return res.end('ok'); }
    if (req.method === 'PUT')          { res.writeHead(200); return res.end('ok'); }
    if (req.url.startsWith('/pub/'))   {
      refusals.push(req.url);
      res.writeHead(500);
      return res.end('x'.repeat(4096));   /* a body big enough to see if it is kept */
    }
    res.writeHead(404); res.end('no');
  });
  await new Promise((r) => broker.listen(0, '127.0.0.1', r));
  const brokerPort = broker.address().port;

  const root = mkTemp();
  writeFileSync(join(root, 'main.mdy'),
    "% $.publish('handlers.thing', { n: 1 })\n= main\n");
  writeFileSync(join(root, 'thing.mdy'),
    '+++\nmessageName: handlers.thing\n+++\n= handler\n');

  const child = spawn(bin, ['dev', root, '--port', '0', '--broker', `http://127.0.0.1:${brokerPort}`]);
  let log = '';
  child.stdout.on('data', (b) => { log += b; });
  child.stderr.on('data', (b) => { log += b; });
  const until = async (re, ms = 15000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      if (re.test(log)) return;
      if (child.exitCode !== null) throw new Error(`the server exited\n${log}`);
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${re}\n${log}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  try {
    await until(/not sent \(refused\)/);
    assert.ok(refusals.length >= 1, 'the broker saw the publish');
    assert.match(log, /handlers\.thing: not sent \(refused\)/,
                 'and the refusal names the message and why');

    /* Still alive, still rebuilding: a refused publish is not fatal. */
    writeFileSync(join(root, 'main.mdy'),
      "% $.publish('handlers.thing', { n: 2 })\n= main again\n");
    await until(/rendered/);
    assert.equal(child.exitCode, null, 'the server is still running');
  } finally {
    child.kill();
    broker.close();
  }
});

/*
 * The local bus and the remote one must agree about a subject with no page.
 * deliver_batch takes `is_dead` and its `target < 0` branch has to honour it
 * — dev_deliver guards before it calls, dev_drain does not — so
 * in-process the messages were marked DONE and reported as kept, where over
 * HTTP dev_deliver returns 500 and the broker's retry and dead-letter policy
 * has them.
 *
 * Reaching it takes a window: $.publish validates the name at publish time, so
 * a message for a page that does not exist is never made. The window is a
 * message already QUEUED — one whose delivery failed and is waiting on a
 * backoff — when its page disappears. Hence the throwing handler, the backoff,
 * and the deletion in between.
 *
 * Before the fix this same sequence printed
 *   [dead] handlers.a #1 no handlers.a page — kept, see `mdy dead handlers.a`
 */
/*
 * What a rebuild re-publishes, and what it does not.
 *
 * `mdy dev` rebuilds the whole site on every save and every `$.publish` fires
 * again, so something has to decide what reaches the broker. mdy-docs answers
 * that by never publishing from its dev server at all (src/serve.js: "a
 * publish that went out would re-fire on every keystroke"); this one sends, so
 * it keeps a list — and what that list is KEYED ON is the behaviour here.
 *
 * It used to hold every (name, value) it had ever sent, which dropped a value
 * that changed BACK: 1 -> 2 -> 1 sent twice, and a consumer never learned it
 * had returned to 1. One entry per NAME, holding that name's last value,
 * sends on every change in either direction and still sends nothing for a
 * rebuild that changed no message.
 *
 * Both halves are asserted, because either alone is satisfied by a broken
 * implementation: "always send" passes the first, "never send" the second.
 */
test('a rebuild re-publishes a value that changed, and only one that changed', async () => {
  const published = [];
  const broker = createServer((req, res) => {
    req.resume();
    if (req.url.startsWith('/health')) { res.writeHead(200); return res.end('ok'); }
    if (req.method === 'PUT') { res.writeHead(200); return res.end('ok'); }
    if (req.url.startsWith('/pub/')) {
      published.push(req.url);
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(Buffer.from([0]));
    }
    res.writeHead(404); res.end('no');
  });
  await new Promise((r) => broker.listen(0, '127.0.0.1', r));
  const brokerPort = broker.address().port;

  const root = mkTemp();
  let body = 0;
  const write = (n) =>
    writeFileSync(join(root, 'main.mdy'),
      `% $.publish('handlers.thing', { n: ${n} })\n= main ${n} body ${body}\n`);
  writeFileSync(join(root, 'thing.mdy'),
    '+++\nmessageName: handlers.thing\n+++\n= handler\n');
  write(1);

  const child = spawn(bin, ['dev', root, '--port', '0', '--broker', `http://127.0.0.1:${brokerPort}`]);
  let log = '';
  child.stdout.on('data', (b) => { log += b; });
  child.stderr.on('data', (b) => { log += b; });

  /* A save either publishes or it does not, and "does not" cannot be waited
   * for — so a change that SHOULD publish is waited for, and one that should
   * not is given the same budget before the count is read. */
  const settle = async (n, expect) => {
    const before = published.length;
    const rendered = (log.match(/rendered/g) || []).length;
    write(n);
    const started = Date.now();
    const deadline = started + 8000;
    while (Date.now() < deadline) {
      if (expect && published.length > before) break;
      if (child.exitCode !== null) throw new Error(`the server exited\n${log}`);
      await new Promise((r) => setTimeout(r, 100));
      /* Nothing expected: wait for the rebuild the save causes to have
       * happened, and a while after it, before reading the count. */
      const rebuilt = (log.match(/rendered/g) || []).length > rendered;
      if (!expect && rebuilt && Date.now() > started + 1500) break;
    }
    return published.length - before;
  };

  try {
    const deadline = Date.now() + 15000;
    while (published.length === 0 && Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`the server exited\n${log}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(published.length, 1, 'the first build publishes');

    assert.equal(await settle(2, true), 1, 'a changed value is published');
    assert.equal(await settle(1, true), 1,
                 'and one that changed BACK is published — it is a change too');

    body = 1;
    assert.equal(await settle(1, false), 0,
                 'a save that edits the page but not the message publishes nothing');
    body = 2;
    assert.equal(await settle(1, false), 0, '...and still nothing on the next save');

    assert.equal(child.exitCode, null, 'the server is still running');
  } finally {
    child.kill();
    broker.close();
  }
});

test('a queued message whose page has gone is returned, not marked done', async () => {
  const root = mkTemp();
  writeFileSync(join(root, 'main.mdy'), "% $.publish('handlers.a', { n: 1 })\n= main\n");
  writeFileSync(join(root, 'a.mdy'),
    '+++\nmessageName: handlers.a\n+++\n% throw new Error("later")\n= handler\n');

  /* Attempts to spare and a backoff long enough to delete the page inside. */
  const dev = startDev(root, ['--max-attempts', '5', '--backoff', '2000']);
  try {
    await dev.until(/\[refuse\][^\n]*handlers\.a/);

    /* The page goes, and main stops publishing — otherwise $.publish refuses
     * at build time and no new message is made anyway. */
    unlinkSync(join(root, 'a.mdy'));
    writeFileSync(join(root, 'main.mdy'), '= main, no longer publishing\n');

    await dev.until(/\[return\][^\n]*handlers\.a/, 25000);
    assert.match(dev.log(), /\[return\][^\n]*no page of that name here[^\n]*returned/,
                 'it says the messages were returned, and why');
    assert.doesNotMatch(dev.log(), /\[dead\][^\n]*no handlers\.a page/,
                        'and never reports them as kept, which marked them done');
    assert.equal(dev.child.exitCode, null);
  } finally {
    dev.child.kill();
  }
});

/*
 * The other half, and the one a wrong `is_dead` would break: the dead-letter
 * channel itself has no page and must still FINISH rather than be returned,
 * or a message that failed would bounce between the two forever.
 */
test('the dead-letter channel with no page is still kept, not returned', async () => {
  const root = mkTemp();
  writeFileSync(join(root, 'main.mdy'), "% $.publish('handlers.b', { n: 1 })\n= main\n");
  writeFileSync(join(root, 'b.mdy'),
    '+++\nmessageName: handlers.b\n+++\n% throw new Error("nope")\n= handler\n');

  const dev = startDev(root, ['--max-attempts', '1']);
  try {
    await dev.until(/\[dead\][^\n]*handlers\.b\.dead/, 25000);
    assert.match(dev.log(), /\[dead\][^\n]*handlers\.b\.dead[^\n]*kept/,
                 'the .dead channel is finished and kept for `mdy dead`');
    assert.doesNotMatch(dev.log(), /\[return\][^\n]*handlers\.b\.dead/,
                        'not returned, which would bounce it forever');
    assert.equal(dev.child.exitCode, null);
  } finally {
    dev.child.kill();
  }
});

/*
 * An option loop ending in `else root = a` turns an unknown flag, or one
 * whose value is missing, into the site directory: `mdy build --draft` looks
 * for a site called `--draft` and blames the ENTRY SCRIPT for not being in it
 * — a failure, but about the wrong thing. Document mode in this same binary
 * rejects unknown options properly; these are its words, so the four commands
 * answer alike.
 *
 * Native-only like the rest of this file: node's CLI takes `--draft` as the
 * directory too, so there is no shared behaviour to pin in cli.test.js.
 */
function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(bin, args);
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    child.on('exit', (code) => resolve({ code, out }));
  });
}

test('an unknown option is named, rather than taken for the site directory', async () => {
  const root = mkTemp();
  writeFileSync(join(root, 'main.mdy'), '= main\n');

  for (const args of [
    ['build', root, '--draft'],
    ['dev', root, '--prot', '3000'],
    ['dead', 'x', '--nonsense'],
  ]) {
    const { code, out } = await runCli(args);
    assert.equal(code, 1, `${args.join(' ')} should fail`);
    assert.match(out, /Unknown option '--(draft|prot|nonsense)'/,
                 `${args.join(' ')} should name the option`);
    assert.doesNotMatch(out, /entry script not found/,
                        `${args.join(' ')} should not blame the entry script`);
  }
});

test("an option whose value is missing says so", async () => {
  const root = mkTemp();
  writeFileSync(join(root, 'main.mdy'), '= main\n');

  for (const [args, opt] of [
    [['build', root, '--out'], '--out'],
    [['build', root, '--entry'], '--entry'],
    [['dev', root, '--port'], '--port'],
    [['dead', 'x', '--requeue'], '--requeue'],
  ]) {
    const { code, out } = await runCli(args);
    assert.equal(code, 1, `${args.join(' ')} should fail`);
    assert.match(out, new RegExp(`Option '\\${opt}' argument missing`),
                 `${args.join(' ')} should name the option`);
  }
});

test('the build knobs each change what is built, and `--` still escapes', async () => {
  /* The entry branches on the two context flags the build passes as `req`, so
   * each flag has an OBSERVABLE effect — an extra emitted page — rather than
   * just an exit code. --quiet is observable the other way: no summary line. */
  const root = mkTemp();
  writeFileSync(join(root, 'main.mdy'),
    '% $.emit("always.html", "x")\n' +
    '% if (req.drafts ?? false) $.emit("draft.html", "d")\n' +
    '% if (req.future ?? false) $.emit("future.html", "f")\n' +
    '= main\n');

  const build = async (flags) => {
    const out = mkTemp();                 /* a fresh out per case: no carryover */
    const { code, out: text } = await runCli(['build', root, '--out', out, ...flags]);
    assert.equal(code, 0, `build ${flags.join(' ')} should succeed`);
    return { text, files: readdirSync(out) };
  };

  const plain = await build([]);
  assert.deepEqual(plain.files.sort(), ['always.html'],
    'neither draft nor future page without the flags');
  assert.match(plain.text, /built .*page/, 'and the default build says what it did');

  const drafts = await build(['--drafts']);
  assert.ok(drafts.files.includes('draft.html'), '--drafts emits the draft page');
  assert.ok(!drafts.files.includes('future.html'), 'and only that one');

  const future = await build(['--future']);
  assert.ok(future.files.includes('future.html'), '--future emits the future page');
  assert.ok(!future.files.includes('draft.html'), 'and only that one');

  const quiet = await build(['--quiet']);
  assert.ok(quiet.files.includes('always.html'), '--quiet still builds');
  assert.doesNotMatch(quiet.text, /built/, 'but prints no summary');

  const help = await runCli(['build', '--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /mdy build/, '--help prints the usage');

  /* The escape the error message points at: a positional that starts with `-`
   * is reachable after `--`. It fails because no such directory exists, which
   * is a different failure from refusing the argument. */
  const { code, out: text } = await runCli(['build', '--', '--weird']);
  assert.equal(code, 1);
  assert.doesNotMatch(text, /Unknown option/, '`--` makes it a positional');
});

test('dev refuses a port already in use', async () => {
  /* Two servers must not silently share a port — the second one has to say
   * the port is taken and exit, not quietly bind nothing. SO_REUSEADDR lets a
   * port in TIME_WAIT be reused, but not one that is actively listening. */
  const root = mkTemp();
  writeFileSync(join(root, 'main.mdy'), '% $.emit("i.html", "x")\n= main\n');

  const first = startDev(root);
  try {
    const [, port] = await first.until(/http:\/\/localhost:(\d+)/);

    const second = spawn(bin, ['dev', root, '--port', port]);
    let log = '';
    second.stderr.on('data', (b) => { log += b; });
    second.stdout.on('data', (b) => { log += b; });
    const code = await new Promise((resolve) => second.on('exit', resolve));

    assert.equal(code, 1, 'the second server exits non-zero');
    assert.match(log, /EADDRINUSE|address already in use/);
  } finally {
    first.child.kill();
  }
});

/* A GET, read to completion: { status, headers, body }. */
const get = (port, path, method = 'GET') =>
  new Promise((resolve, reject) => {
    const req = request({ host: 'localhost', port, path, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });

/* Just the response head, for an endpoint that KEEPS the connection open (the
 * live-reload stream) and so never ends — resolve on the headers, then drop it. */
const getHead = (port, path) =>
  new Promise((resolve, reject) => {
    const req = request({ host: 'localhost', port, path }, (res) => {
      resolve({ status: res.statusCode, headers: res.headers });
      res.destroy();
      req.destroy();
    });
    req.on('error', reject);
    req.end();
  });

test('dev serves the site, injects live-reload, types static files, and 404s the unknown', async () => {
  const root = mkTemp();
  writeFileSync(join(root, 'main.mdy'),
    '% $.emit("index.html", "<html><body>home</body></html>")\n= x\n');
  mkdirSync(join(root, 'static'), { recursive: true });
  writeFileSync(join(root, 'static', 'style.css'), 'body{color:red}\n');

  const dev = startDev(root);
  try {
    /* The ready banner prints after the first build, so the site is served. */
    const [, port] = await dev.until(/http:\/\/localhost:(\d+)/);

    const home = await get(port, '/');
    assert.equal(home.status, 200, 'the emitted index is served at /');
    assert.match(home.headers['content-type'], /text\/html/);
    assert.match(home.body, /home/);
    assert.match(home.body, /EventSource\("\/__mdy__\/events"\)/,
      'the live-reload client is injected into every page');

    const css = await get(port, '/style.css');
    assert.equal(css.status, 200, 'static/ is served from disk');
    assert.match(css.headers['content-type'], /text\/css/, 'typed by extension');
    assert.match(css.body, /color:red/);
    assert.doesNotMatch(css.body, /EventSource/, 'a non-HTML file is not rewritten');

    const missing = await get(port, '/no-such-page');
    assert.equal(missing.status, 404);
    assert.match(missing.body, /404/);
    assert.match(missing.body, /EventSource/, 'the 404 still carries the reload client');

    /* A NUL inside a path names nothing, and is refused rather than read as
     * the path up to it. */
    const nul = await get(port, '/style.css%00.png');
    assert.equal(nul.status, 400, 'a %00 in the path is a bad request');

    const events = await getHead(port, '/__mdy__/events');
    assert.match(events.headers['content-type'], /text\/event-stream/,
      'the reload endpoint is an event stream');
  } finally {
    dev.child.kill();
  }
});

test("dev serves a site's own 404.html for the unknown, when it has one", async () => {
  const root = mkTemp();
  writeFileSync(join(root, 'main.mdy'),
    '% $.emit("index.html", "<html><body>home</body></html>")\n' +
    '% $.emit("404.html", "<html><body>custom not found</body></html>")\n= x\n');

  const dev = startDev(root);
  try {
    const [, port] = await dev.until(/http:\/\/localhost:(\d+)/);
    const missing = await get(port, '/whatever');
    assert.equal(missing.status, 404);
    assert.match(missing.body, /custom not found/, "the site's own 404 page is used");
    assert.match(missing.body, /EventSource/, 'and it too carries the reload client');
  } finally {
    dev.child.kill();
  }
});

/*
 * Watch mode (findings 7.4). The watcher is a poll: a snapshot of every file
 * under the roots — path, size, mtime — diffed every ~120 ms, and the poll
 * interval IS the debounce (watch.h). The re-render-on-change and error-
 * recovery cases are covered above; these pin the rest — a change noticed on
 * delete, on an atomic save-by-rename, and on a sibling that is not the entry
 * — and that a burst of writes coalesces into far fewer rebuilds than writes.
 *
 * The first build is silent by design (dev_rebuild's `first`), so every count
 * here is of the REBUILDS after the ready banner, which do log `rendered`.
 */
const rebuilds = (log) => (log.match(/\] rendered /g) || []).length;
async function untilRebuilds(dev, atLeast, ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (rebuilds(dev.log()) >= atLeast) return;
    if (dev.child.exitCode !== null) throw new Error(`the server exited\n${dev.log()}`);
    if (Date.now() > deadline) throw new Error(`only ${rebuilds(dev.log())} rebuilds\n${dev.log()}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}

test('the watcher notices a sibling .yaml change and a deletion, not just the entry', async () => {
  const root = mkTemp();
  writeFileSync(join(root, 'main.mdy'), '% $.emit("index.html", "x")\n= x\n');
  writeFileSync(join(root, 'data.yaml'), 'a: 1\n');
  writeFileSync(join(root, 'note.md'), 'first\n');

  const dev = startDev(root);
  try {
    await dev.until(/http:\/\/localhost:(\d+)/);   /* the first build is done */

    /* A file that is not the entry, and not even imported, still counts: the
     * snapshot covers everything under the root. */
    writeFileSync(join(root, 'data.yaml'), 'a: 2\n');
    await untilRebuilds(dev, 1);
    assert.match(dev.log(), /\[change\][^\n]*data\.yaml/, 'and the change names the .yaml');

    /* A deletion is a change too — the file leaves the snapshot. */
    unlinkSync(join(root, 'note.md'));
    await untilRebuilds(dev, 2);
    assert.match(dev.log(), /\[change\][^\n]*note\.md/, 'and names the file that went away');

    assert.equal(dev.child.exitCode, null, 'and the server rides all of it out');
  } finally {
    dev.child.kill();
  }
});

test('an atomic save (write a temp, rename over) is picked up', async () => {
  const root = mkTemp();
  writeFileSync(join(root, 'main.mdy'),
    '% $.emit("index.html", "<html><body>before</body></html>")\n= x\n');

  const dev = startDev(root);
  try {
    const [, port] = await dev.until(/http:\/\/localhost:(\d+)/);
    assert.match((await get(port, '/')).body, /before/);

    /* How every serious editor writes: a new file beside the old, then a
     * rename over it. The watcher follows the directory, so it sees the
     * entry's size and mtime change and rebuilds. */
    const tmp = join(root, 'main.mdy.tmp');
    writeFileSync(tmp, '% $.emit("index.html", "<html><body>after</body></html>")\n= x\n');
    renameSync(tmp, join(root, 'main.mdy'));
    await untilRebuilds(dev, 1);

    assert.match((await get(port, '/')).body, /after/, 'the renamed content is what is served');
  } finally {
    dev.child.kill();
  }
});

test('a burst of writes coalesces into far fewer rebuilds than writes', async () => {
  const root = mkTemp();
  const main = join(root, 'main.mdy');
  writeFileSync(main, '% $.emit("index.html", "x")\n= 0\n');

  const dev = startDev(root);
  try {
    await dev.until(/http:\/\/localhost:(\d+)/);

    /* Ten writes back to back, well inside one poll interval. The poll is the
     * debounce: the snapshot taken after them sees one net change. */
    for (let i = 1; i <= 10; i++) {
      writeFileSync(main, `% $.emit("index.html", "x")\n= ${i}\n`);
    }

    /* Let the watcher settle: several poll intervals with no new writes. */
    await new Promise((r) => setTimeout(r, 800));
    const n = rebuilds(dev.log());

    assert.ok(n >= 1, `the burst did rebuild (${n})`);
    assert.ok(n <= 4, `but the ten writes coalesced, not one-rebuild-each (${n})`);
  } finally {
    dev.child.kill();
  }
});
