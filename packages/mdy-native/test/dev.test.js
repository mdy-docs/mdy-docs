/*
 * The dev server.
 *
 * It had no test of any kind, which is the whole reason B10 sat unnoticed:
 * `mdy dev` goes on serving when the FIRST build fails — there is nothing to
 * fall back to, and a broken save should not take the server down — so the
 * engine is absent, and the first message delivered read documents off it and
 * killed the process.
 *
 * Native only, deliberately. The in-process broker is this binary's (`mdy dev
 * runs its own broker`); node's dev server has no delivery endpoint at all and
 * answers 404, so there is no shared behaviour to pin and test/cli.test.js is
 * the wrong place.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode } from '../../../third_party/nisaba-db/third_party/binjson/js/binjson.js';

const here = dirname(fileURLToPath(import.meta.url));
const bin = process.env.MDY_CLI ?? join(here, '..', 'build', 'mdy');

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
function startDev(root) {
  const child = spawn(bin, ['dev', root, '--port', '0']);
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
  const root = mkdtempSync(join(tmpdir(), 'mdy-dev-'));
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
  } finally {
    dev.child.kill();
  }
});
