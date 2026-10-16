import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXIT_FAILED, EXIT_NOT_VALIDATED, EXIT_OK, main, parseArgs } from '../run.mjs';
import { BridgeClient, BridgeError } from '../bridge.mjs';
import { UiError } from '../session.mjs';

const TOKEN = 'admin-token-for-tests';
const COOKIE_VALUE = 'g.a000SECRETCOOKIEVALUE_abcdefghijklmnop';
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
        canary_prompt: 'Reply with exactly one word: pong',
        canary_expect: 'pong',
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

const factsFixture = (over = {}) => ({
  kind: 'page_facts',
  bl: 'boq_gemini-web-uiserver_20261015.13_p0',
  xsrf_present: true,
  signed_in: true,
  models: [{ id: 'cf41b0e0dd7d53e5', label: '3.5 Flash-Lite', description: 'Fastest answers', selected: true }],
  models_locked: [],
  models_source: 'picker',
  picker_label: 'Flash-Lite',
  ui_ok: true,
  ui_method: 'selectors',
  anonymous: false,
  user_agent: 'UA',
  captured_at: '2026-10-17T00:00:00.000Z',
  ...over,
});

const kinds = (seen) => seen.events.map((e) => e.kind);

async function runLearn(bridge, learnFn, env = {}) {
  return main({
    argv: ['learn'],
    env: { BRIDGE_URL: bridge.url, BRIDGE_ADMIN_TOKEN: TOKEN, ...env },
    learnFn,
    log: quiet,
  });
}

test('parseArgs: mode is required, options belong to their mode', () => {
  assert.deepEqual(parseArgs(['learn']), { mode: 'learn', dryRun: false, out: null, anonymous: false });
  assert.deepEqual(parseArgs(['learn', '--dry-run', '--out', 'f.json']), { mode: 'learn', dryRun: true, out: 'f.json', anonymous: false });
  assert.equal(parseArgs(['serve', '--anonymous']).anonymous, true);
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(['--dry-run', '--out', 'f']), /usage/);
  assert.throws(() => parseArgs(['repair']), /usage/);
  assert.throws(() => parseArgs(['learn', '--dry-run']), /--out/);
  assert.throws(() => parseArgs(['learn', '--anonymous']), /unknown argument/);
  assert.throws(() => parseArgs(['serve', '--dry-run']), /unknown argument/);
});

test('mode dispatch: learn runs learnFn, serve does not; bad mode exits 1', async () => {
  const bridge = await fakeBridge();
  let learnCalls = 0;
  const learnFn = async () => (learnCalls++, factsFixture());
  assert.equal(await main({ argv: ['learn'], env: { BRIDGE_URL: bridge.url, BRIDGE_ADMIN_TOKEN: TOKEN }, learnFn, log: quiet }), EXIT_OK);
  assert.equal(learnCalls, 1);
  // serve without a token refuses to start and never runs learn
  assert.equal(await main({ argv: ['serve', '--anonymous'], env: {}, learnFn, log: quiet }), EXIT_FAILED);
  assert.equal(learnCalls, 1);
  assert.equal(await main({ argv: ['bogus'], env: {}, learnFn, log: quiet }), EXIT_FAILED);
  assert.equal(await main({ argv: [], env: {}, learnFn, log: quiet }), EXIT_FAILED);
  await bridge.close();
});

test('learn adopted: exit 0, cookies reach learn, page facts get account_id, no cookie value leaves the job', async () => {
  const bridge = await fakeBridge();
  let learnArgs;
  const code = await runLearn(bridge, async (o) => ((learnArgs = o), factsFixture()));
  await bridge.close();
  assert.equal(code, EXIT_OK);
  assert.equal(learnArgs.cookies[0].value, COOKIE_VALUE);
  assert.equal(learnArgs.prompt, 'Reply with exactly one word: pong');
  assert.equal(learnArgs.expect, 'pong');
  const posted = bridge.seen.learned[0];
  assert.equal(posted.kind, 'page_facts');
  assert.equal(posted.account_id, 'acc-7');
  assert.equal(posted.bl, 'boq_gemini-web-uiserver_20261015.13_p0');
  assert.deepEqual(kinds(bridge.seen), ['repair_started', 'repair_adopted']);
  assert.match(bridge.seen.events[1].detail, /bl=boq_gemini-web-uiserver_20261015\.13_p0 signed_in=true models=1 ui_ok=true/);
  assert.ok(bridge.seen.auth.every((a) => a === `Bearer ${TOKEN}`));
  assert.ok(!JSON.stringify([bridge.seen.learned, bridge.seen.events]).includes(COOKIE_VALUE));
});

test('learn: a failing UI canary is still reported to the bridge (ui_ok false) and learned selectors become an event', async () => {
  const bridge = await fakeBridge();
  const code = await runLearn(bridge, async () =>
    factsFixture({ ui_ok: false, ui_error: 'upstream_protocol_changed', ui_selectors_learned: { input: ['div.new-input'] } }),
  );
  await bridge.close();
  assert.equal(code, EXIT_OK);
  assert.equal(bridge.seen.learned[0].ui_ok, false);
  assert.equal(bridge.seen.learned[0].ui_error, 'upstream_protocol_changed');
  assert.deepEqual(kinds(bridge.seen), ['repair_started', 'browser_selectors_learned', 'repair_adopted']);
  assert.deepEqual(JSON.parse(bridge.seen.events[1].detail), { input: ['div.new-input'] });
});

test('learned but not validated: exit 2 (ok:false and validated:false)', async () => {
  for (const reply of [
    [200, { ok: true, validated: false, event_id: 3, error: 'canary failed with the learned bl' }],
    [422, { ok: false, validated: false, error: 'page facts rejected' }],
  ]) {
    const bridge = await fakeBridge({ learnedReply: reply });
    const code = await runLearn(bridge, async () => factsFixture());
    await bridge.close();
    assert.equal(code, EXIT_NOT_VALIDATED);
    assert.deepEqual(kinds(bridge.seen), ['repair_started', 'repair_unvalidated']);
    assert.match(bridge.seen.events[1].detail, /rejected|canary failed/);
  }
});

test('learn failure: exit 1 and a repair_failed event with the code and reason', async () => {
  const bridge = await fakeBridge();
  const code = await runLearn(bridge, async () => {
    throw new UiError('upstream_protocol_changed', 'build label (cfb2h) not found in the page');
  });
  await bridge.close();
  assert.equal(code, EXIT_FAILED);
  assert.deepEqual(kinds(bridge.seen), ['repair_started', 'repair_failed']);
  assert.match(bridge.seen.events[1].detail, /learn: upstream_protocol_changed: build label/);
  assert.equal(bridge.seen.learned.length, 0);
});

test('context refused: exit 1 without running the browser', async () => {
  const bridge = await fakeBridge({ contextStatus: 503 });
  let ran = false;
  const code = await runLearn(bridge, async () => ((ran = true), factsFixture()));
  await bridge.close();
  assert.equal(code, EXIT_FAILED);
  assert.equal(ran, false);
  assert.deepEqual(kinds(bridge.seen), ['repair_started', 'repair_failed']);
});

test('bridge answers the learned post with a non-JSON 500: exit 1', async () => {
  const bridge = await fakeBridge({ learnedReply: [500, undefined] });
  const code = await runLearn(bridge, async () => factsFixture());
  await bridge.close();
  assert.equal(code, EXIT_FAILED);
  assert.deepEqual(kinds(bridge.seen), ['repair_started', 'repair_failed']);
});

test('wrong admin token, unreachable bridge or missing config: exit 1', async () => {
  const bridge = await fakeBridge();
  assert.equal(await runLearn(bridge, async () => factsFixture(), { BRIDGE_ADMIN_TOKEN: 'wrong' }), EXIT_FAILED);
  await bridge.close();
  const learnFn = async () => factsFixture();
  assert.equal(await main({ argv: ['learn'], env: { BRIDGE_URL: 'http://127.0.0.1:1', BRIDGE_ADMIN_TOKEN: TOKEN }, learnFn, log: quiet }), EXIT_FAILED);
  assert.equal(await main({ argv: ['learn'], env: {}, learnFn, log: quiet }), EXIT_FAILED);
});

test('dry run writes the page facts and never touches a bridge', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'repair-'));
  const out = join(dir, 'facts.json');
  let args;
  const code = await main({
    argv: ['learn', '--dry-run', '--out', out],
    env: { BRIDGE_URL: 'http://127.0.0.1:1', BRIDGE_ADMIN_TOKEN: TOKEN },
    learnFn: async (o) => ((args = o), factsFixture({ anonymous: true, signed_in: false })),
    log: quiet,
  });
  const written = JSON.parse(await readFile(out, 'utf8'));
  await rm(dir, { recursive: true });
  assert.equal(code, EXIT_OK);
  assert.equal(args.cookies, undefined);
  assert.equal(written.kind, 'page_facts');
  assert.equal(written.anonymous, true);
});

test('dry run failure and bad arguments exit 1', async () => {
  const failing = async () => {
    throw new Error('blocked');
  };
  assert.equal(await main({ argv: ['learn', '--dry-run', '--out', join(tmpdir(), 'x.json')], learnFn: failing, env: {}, log: quiet }), EXIT_FAILED);
  assert.equal(await main({ argv: ['learn', '--dry-run'], env: {}, log: quiet }), EXIT_FAILED);
  assert.equal(await main({ argv: ['learn', '--nope'], env: {}, log: quiet }), EXIT_FAILED);
});

test('AI settings and chromium path come from the environment', async () => {
  const bridge = await fakeBridge();
  let args;
  await runLearn(bridge, async (o) => ((args = o), factsFixture()), {
    GEMINI_REPAIR_API_KEY: 'k-123456789',
    GEMINI_REPAIR_MODEL: 'gemini-test',
    CHROMIUM_NO_SANDBOX: '1',
    CHROMIUM_PATH: '/opt/chromium',
    REPAIR_TIMEOUT_S: '30',
  });
  await bridge.close();
  assert.equal(args.aiKey, 'k-123456789');
  assert.equal(args.aiModel, 'gemini-test');
  assert.equal(args.noSandbox, true);
  assert.equal(args.chromiumPath, '/opt/chromium');
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

// --- serve mode wiring (fake session, no browser) ---------------------------

function fakeSession({ failAsk } = {}) {
  const calls = { ask: [], closed: 0, pagesClosed: 0 };
  return {
    calls,
    anonymous: false,
    signedIn: true,
    openChat: async () => ({ close: async () => calls.pagesClosed++ }),
    readFacts: async () => ({ signed_in: true }),
    ask: async (req) => {
      calls.ask.push(req);
      if (failAsk) throw failAsk;
      return { text: 'pong', model_label_seen: 'Flash-Lite' };
    },
    close: async () => calls.closed++,
  };
}

/** Starts `serve` with a fake session; resolves once it listens. `exited` resolves with the exit code. */
async function startServe({ bridge, session, env = {}, argv = ['serve'] }) {
  let port;
  let gotPort;
  const listening = new Promise((r) => (gotPort = r));
  const abort = new AbortController();
  const exited = main({
    argv,
    env: { BROWSER_TOKEN: 'browser-token-1', BROWSER_PORT: '0', BROWSER_HOST: '127.0.0.1', ...(bridge ? { BRIDGE_URL: bridge.url, BRIDGE_ADMIN_TOKEN: TOKEN } : {}), ...env },
    sessionFactory: (opts) => Object.assign(session, { factoryOpts: opts }),
    log: (step, f) => step === 'listening' && gotPort(f.port),
    signal: abort.signal,
  });
  port = await Promise.race([listening, exited.then((c) => Promise.reject(new Error(`serve exited early with ${c}`)))]);
  return { port, exited, stop: () => abort.abort() };
}

/** healthz body once the transport is ready (the warm-up page load runs right after listening). */
async function waitReady(port) {
  for (let i = 0; i < 100; i++) {
    const h = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    if (h.ok) return h;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('serve never became ready');
}

const post = (port, body, token = 'browser-token-1') =>
  fetch(`http://127.0.0.1:${port}/generate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('serve: takes cookies from the bridge context, answers /generate, stops on abort with exit 0', async () => {
  const bridge = await fakeBridge();
  const session = fakeSession();
  const s = await startServe({ bridge, session });
  assert.equal(session.factoryOpts.cookies[0].value, COOKIE_VALUE);
  assert.deepEqual(await waitReady(s.port), { ok: true, signed_in: true, queue: 0 });
  const res = await post(s.port, { prompt: 'hello', model_label: '3.5 Flash-Lite', json: true });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).text, 'pong');
  assert.equal(session.calls.ask[0].modelLabel, '3.5 Flash-Lite');
  assert.equal(session.calls.ask[0].ceilingMs, 600000);
  s.stop();
  assert.equal(await s.exited, EXIT_OK);
  assert.equal(session.calls.closed, 1);
  assert.ok(kinds(bridge.seen).includes('browser_started'));
  assert.ok(!JSON.stringify(bridge.seen.events).includes(COOKIE_VALUE));
  await bridge.close();
});

test('serve: learned selectors are reported to the bridge as selectors only', async () => {
  const bridge = await fakeBridge();
  const session = fakeSession();
  const s = await startServe({ bridge, session });
  session.factoryOpts.onSelectorsLearned({ input: ['div.x'], answer: ['my-answer'] });
  await new Promise((r) => setTimeout(r, 100));
  s.stop();
  await s.exited;
  const ev = bridge.seen.events.find((e) => e.kind === 'browser_selectors_learned');
  assert.deepEqual(JSON.parse(ev.detail), { input: ['div.x'], answer: ['my-answer'] });
  await bridge.close();
});

test('serve: healthz ok turns false after a UI failure, but not after a usage limit or a locked model', async () => {
  const session = fakeSession();
  const s = await startServe({ session, argv: ['serve', '--anonymous'] });
  const health = async () => (await (await fetch(`http://127.0.0.1:${s.port}/healthz`)).json()).ok;
  await waitReady(s.port);
  for (const [code, okAfter] of [['upstream_rate_limited', true], ['no_valid_account', true], ['upstream_protocol_changed', false]]) {
    session.ask = async () => {
      throw new UiError(code, 'x');
    };
    await post(s.port, { prompt: 'p' });
    assert.equal(await health(), okAfter, code);
  }
  session.ask = async () => ({ text: 'back', model_label_seen: '' });
  assert.equal((await post(s.port, { prompt: 'p' })).status, 200);
  assert.equal(await health(), true, 'a successful request makes it ready again');
  s.stop();
  await s.exited;
});

test('serve: idle exit ends the process with exit 0 after BROWSER_IDLE_EXIT_MIN without requests', async () => {
  const bridge = await fakeBridge();
  const session = fakeSession();
  const s = await startServe({ bridge, session, env: { BROWSER_IDLE_EXIT_MIN: '0.002' } }); // 120 ms
  assert.equal(await s.exited, EXIT_OK);
  assert.equal(session.calls.closed, 1);
  assert.ok(kinds(bridge.seen).includes('browser_idle_exit'));
  await bridge.close();
});

test('serve: needs a token and (unless --anonymous) a reachable bridge context', async () => {
  const session = fakeSession();
  assert.equal(await main({ argv: ['serve', '--anonymous'], env: {}, sessionFactory: () => session, log: quiet }), EXIT_FAILED);
  assert.equal(await main({ argv: ['serve'], env: { BROWSER_TOKEN: 't' }, sessionFactory: () => session, log: quiet }), EXIT_FAILED);
  const bridge = await fakeBridge({ contextStatus: 503 });
  assert.equal(
    await main({ argv: ['serve'], env: { BROWSER_TOKEN: 't', BRIDGE_URL: bridge.url, BRIDGE_ADMIN_TOKEN: TOKEN }, sessionFactory: () => session, log: quiet }),
    EXIT_FAILED,
  );
  await bridge.close();
});
