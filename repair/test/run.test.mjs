import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXIT_FAILED, EXIT_NOT_VALIDATED, EXIT_OK, main } from '../run.mjs';
import { BridgeClient, BridgeError } from '../bridge.mjs';
import { COOKIE_VALUE, PROMPT, makeCapture } from './helpers.mjs';
import { buildLearned } from '../protocol.mjs';

const TOKEN = 'admin-token-for-tests';
const quiet = () => {};

/** Local fake of the bridge's repair endpoints. `opts.learnedReply` / `opts.contextStatus` steer it. */
async function fakeBridge(opts = {}) {
  const seen = { events: [], learned: [], auth: [], contextCalls: 0 };
  const server = http.createServer(async (req, res) => {
    seen.auth.push(req.headers.authorization);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    const send = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(obj === undefined ? 'not json' : JSON.stringify(obj));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' });
    if (req.method === 'GET' && req.url === '/admin/api/repair/context') {
      seen.contextCalls++;
      if (opts.contextStatus) return send(opts.contextStatus, { error: 'nope' });
      return send(200, {
        cookies: [{ name: 'SID', value: COOKIE_VALUE, domain: '.google.com', path: '/', secure: true, httpOnly: true }],
        account_id: 'acc-7',
        canary_prompt: PROMPT,
      });
    }
    if (req.method === 'POST' && req.url === '/admin/api/repair/learned') {
      seen.learned.push(body);
      const [status, payload] = opts.learnedReply ?? [200, { ok: true, validated: true, event_id: 11 }];
      return send(status, payload);
    }
    if (req.method === 'POST' && req.url === '/admin/api/events') {
      seen.events.push(body);
      return send(200, { ok: true });
    }
    return send(404, { error: 'not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { seen, url, close: () => new Promise((r) => server.close(r)) };
}

const learnedFixture = () =>
  buildLearned({ capture: makeCapture(), prompt: PROMPT, ui: { input: 'i', send: 's', method: 'selectors' }, userAgent: 'UA' });

const kinds = (seen) => seen.events.map((e) => e.kind);

async function run(bridge, learnFn, env = {}) {
  return main({
    argv: [],
    env: { BRIDGE_URL: bridge.url, BRIDGE_ADMIN_TOKEN: TOKEN, ...env },
    learnFn,
    log: quiet,
  });
}

test('adopted: exit 0, context cookies reach learn, learned gets account_id, no cookie value leaves the job', async () => {
  const bridge = await fakeBridge();
  let learnArgs;
  const code = await run(bridge, async (o) => ((learnArgs = o), learnedFixture()));
  await bridge.close();
  assert.equal(code, EXIT_OK);
  assert.equal(learnArgs.cookies[0].value, COOKIE_VALUE);
  assert.equal(learnArgs.prompt, PROMPT);
  assert.equal(bridge.seen.learned[0].account_id, 'acc-7');
  assert.deepEqual(kinds(bridge.seen), ['repair_started', 'repair_adopted']);
  assert.ok(bridge.seen.auth.every((a) => a === `Bearer ${TOKEN}`));
  assert.ok(!JSON.stringify([bridge.seen.learned, bridge.seen.events]).includes(COOKIE_VALUE));
});

test('learned but not validated: exit 2 (ok:false and validated:false)', async () => {
  for (const reply of [
    [200, { ok: true, validated: false, event_id: 3, error: 'canary failed with learned template' }],
    [422, { ok: false, validated: false, error: 'template rejected' }],
  ]) {
    const bridge = await fakeBridge({ learnedReply: reply });
    const code = await run(bridge, async () => learnedFixture());
    await bridge.close();
    assert.equal(code, EXIT_NOT_VALIDATED);
    assert.deepEqual(kinds(bridge.seen), ['repair_started', 'repair_unvalidated']);
    assert.match(bridge.seen.events[1].detail, /rejected|canary failed/);
  }
});

test('learn failure: exit 1 and a repair_failed event with the reason', async () => {
  const bridge = await fakeBridge();
  const code = await run(bridge, async () => {
    throw Object.assign(new Error('default selectors failed'), { code: 'no_input' });
  });
  await bridge.close();
  assert.equal(code, EXIT_FAILED);
  assert.deepEqual(kinds(bridge.seen), ['repair_started', 'repair_failed']);
  assert.match(bridge.seen.events[1].detail, /learn: default selectors failed/);
  assert.equal(bridge.seen.learned.length, 0);
});

test('context refused: exit 1 without running the browser', async () => {
  const bridge = await fakeBridge({ contextStatus: 503 });
  let learned = false;
  const code = await run(bridge, async () => ((learned = true), learnedFixture()));
  await bridge.close();
  assert.equal(code, EXIT_FAILED);
  assert.equal(learned, false);
  assert.deepEqual(kinds(bridge.seen), ['repair_started', 'repair_failed']);
});

test('bridge answers the learned post with a non-JSON 500: exit 1', async () => {
  const bridge = await fakeBridge({ learnedReply: [500, undefined] });
  const code = await run(bridge, async () => learnedFixture());
  await bridge.close();
  assert.equal(code, EXIT_FAILED);
  assert.deepEqual(kinds(bridge.seen), ['repair_started', 'repair_failed']);
});

test('wrong admin token: exit 1', async () => {
  const bridge = await fakeBridge();
  const code = await run(bridge, async () => learnedFixture(), { BRIDGE_ADMIN_TOKEN: 'wrong' });
  await bridge.close();
  assert.equal(code, EXIT_FAILED);
});

test('unreachable bridge or missing config: exit 1', async () => {
  assert.equal(await main({ argv: [], env: { BRIDGE_URL: 'http://127.0.0.1:1', BRIDGE_ADMIN_TOKEN: TOKEN }, learnFn: async () => learnedFixture(), log: quiet }), EXIT_FAILED);
  assert.equal(await main({ argv: [], env: {}, learnFn: async () => learnedFixture(), log: quiet }), EXIT_FAILED);
});

test('dry run writes the learned JSON and never touches a bridge', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'repair-'));
  const out = join(dir, 'learned.json');
  let args;
  const code = await main({
    argv: ['--dry-run', '--out', out],
    env: { BRIDGE_URL: 'http://127.0.0.1:1', BRIDGE_ADMIN_TOKEN: TOKEN },
    learnFn: async (o) => ((args = o), learnedFixture()),
    log: quiet,
  });
  const written = JSON.parse(await readFile(out, 'utf8'));
  await rm(dir, { recursive: true });
  assert.equal(code, EXIT_OK);
  assert.equal(args.cookies, undefined);
  assert.equal(written.source, 'browser');
  assert.equal(written.inner_template[0][0], '__PROMPT__');
});

test('dry run failure and bad arguments exit 1', async () => {
  const failing = async () => {
    throw new Error('blocked');
  };
  assert.equal(await main({ argv: ['--dry-run', '--out', join(tmpdir(), 'x.json')], learnFn: failing, env: {}, log: quiet }), EXIT_FAILED);
  assert.equal(await main({ argv: ['--dry-run'], env: {}, log: quiet }), EXIT_FAILED);
  assert.equal(await main({ argv: ['--nope'], env: {}, log: quiet }), EXIT_FAILED);
});

test('AI settings and chromium path come from the environment', async () => {
  const bridge = await fakeBridge();
  let args;
  await run(bridge, async (o) => ((args = o), learnedFixture()), {
    GEMINI_REPAIR_API_KEY: 'k-123456789',
    GEMINI_REPAIR_MODEL: 'gemini-test',
    CHROMIUM_NO_SANDBOX: '1',
    REPAIR_TIMEOUT_S: '30',
  });
  await bridge.close();
  assert.equal(args.aiKey, 'k-123456789');
  assert.equal(args.aiModel, 'gemini-test');
  assert.equal(args.noSandbox, true);
  assert.equal(args.timeoutMs, 30000);
});

test('BridgeClient: event posting is best effort and long details are truncated', async () => {
  const bridge = await fakeBridge();
  const client = new BridgeClient({ baseUrl: bridge.url + '/', token: TOKEN });
  assert.equal(await client.postEvent('repair_started', 'x'.repeat(900)), true);
  assert.equal(bridge.seen.events[0].detail.length, 500);
  await bridge.close();
  assert.equal(await client.postEvent('repair_started', 'down'), false);
  assert.throws(() => new BridgeClient({ baseUrl: '', token: 't' }), BridgeError);
});
