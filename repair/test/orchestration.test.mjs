// Decisions of systemd/check-and-repair.sh, with curl, docker and flock replaced by
// stubs on PATH (no network, no Docker). Skipped when bash or a working python3 /
// python is missing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const fwd = (p) => p.replace(/\\/g, '/');
const SCRIPT = fwd(new URL('../systemd/check-and-repair.sh', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const works = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return !r.error && r.status === 0;
};
const python = ['python3', 'python'].find((p) => works(p, ['-c', 'print(1)']));
const skip = !works('bash', ['-c', 'true']) ? 'bash not available' : !python ? 'no python3' : false;

const TOKEN = 'tok-secret-123';
const FUTURE = 4102444800; // year 2100: always newer than "now"
const canary = (c) => JSON.stringify({ status: 'ok', last_canary: c });
const FAILING = canary({ ok: false, at: FUTURE, error_class: 'upstream_protocol_changed' });
const FAILING_OLD = canary({ ok: false, at: 1000, error_class: 'upstream_protocol_changed' });
const OK = canary({ ok: true, at: FUTURE });

const STUBS = {
  curl: `#!/usr/bin/env bash
url=""
for a in "$@"; do case "$a" in http*) url="$a";; esac; done
echo "curl $*" >> "$STUB_DIR/calls.log"
case "$url" in
  */healthz)
    seq="$STUB_DIR/healthz.seq"
    [ -s "$seq" ] || exit 7
    line="$(head -n1 "$seq")"
    if [ "$(wc -l < "$seq")" -gt 1 ]; then tail -n +2 "$seq" > "$seq.tmp"; mv "$seq.tmp" "$seq"; fi
    printf '%s' "$line" ;;
  */admin/api/events)
    cat >> "$STUB_DIR/events.log"; echo >> "$STUB_DIR/events.log" ;;
esac
`,
  docker: `#!/usr/bin/env bash
echo "docker $*" >> "$STUB_DIR/calls.log"
case " $* " in
  *" ps "*) [ -f "$STUB_DIR/browser.running" ] && echo container123; exit 0 ;;
  *" up "*) [ -f "$STUB_DIR/up.fail" ] && exit 1; touch "$STUB_DIR/browser.running"; exit 0 ;;
  *" stop "*) rm -f "$STUB_DIR/browser.running"; exit 0 ;;
  *" run "*) exit "$(cat "$STUB_DIR/learn.rc" 2>/dev/null || echo 0)" ;;
esac
`,
  flock: `#!/usr/bin/env bash
[ -f "$STUB_DIR/locked" ] && exit 1
exit 0
`,
};

/** Sets up a stub dir, runs the script once, returns what it did. */
async function scenario({ healthz = [], browserRunning = false, upFails = false, locked = false, learnRc, lastRunAgoS, env = {} }) {
  const dir = await mkdtemp(join(tmpdir(), 'orch-'));
  const stubDir = fwd(dir);
  for (const [name, body] of Object.entries(STUBS)) {
    await writeFile(join(dir, name), body);
    await chmod(join(dir, name), 0o755);
  }
  if (healthz.length) await writeFile(join(dir, 'healthz.seq'), healthz.join('\n') + '\n');
  if (browserRunning) await writeFile(join(dir, 'browser.running'), '');
  if (upFails) await writeFile(join(dir, 'up.fail'), '');
  if (locked) await writeFile(join(dir, 'locked'), '');
  if (learnRc !== undefined) await writeFile(join(dir, 'learn.rc'), String(learnRc));
  const stateDir = `${stubDir}/state`;
  if (lastRunAgoS !== undefined) {
    spawnSync('bash', ['-c', `mkdir -p "${stateDir}" && echo $(( $(date +%s) - ${lastRunAgoS} )) > "${stateDir}/last-run"`]);
  }
  const r = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      PATH: `${dir}${delimiter}${process.env.PATH}`,
      STUB_DIR: stubDir,
      STATE_DIR: stateDir,
      PYTHON: python,
      BRIDGE_URL: 'http://bridge.test:18083/',
      BRIDGE_ADMIN_TOKEN: TOKEN,
      COMPOSE_FILE: '/srv/gemini-web/docker-compose.yml',
      RECHECK_WAIT_S: '5',
      RECHECK_POLL_S: '0',
      ...env,
    },
  });
  const read = (f) => readFile(join(dir, f), 'utf8').catch(() => '');
  const calls = (await read('calls.log')).split('\n').filter(Boolean);
  const events = (await read('events.log'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const out = {
    status: r.status,
    stderr: r.stderr,
    calls,
    docker: calls.filter((c) => c.startsWith('docker')),
    events,
    kinds: events.map((e) => e.kind),
    browserRunning: await access(join(dir, 'browser.running')).then(() => true, () => false),
    stamp: await read('state/last-run'),
    allText: calls.join('\n') + (await read('events.log')) + r.stderr,
  };
  await rm(dir, { recursive: true, force: true });
  return out;
}

const COMPOSE = 'docker compose -f /srv/gemini-web/docker-compose.yml';
const has = (docker, fragment) => docker.some((c) => c.includes(fragment));

test('bridge unreachable: nothing to do, no docker, no events', { skip }, async () => {
  const r = await scenario({ healthz: [] });
  assert.equal(r.status, 0);
  assert.deepEqual(r.docker, []);
  assert.deepEqual(r.events, []);
  assert.match(r.stderr, /unreachable/);
});

test('canary ok and browser not running: does nothing', { skip }, async () => {
  const r = await scenario({ healthz: [OK] });
  assert.equal(r.status, 0);
  assert.ok(!has(r.docker, ' run '), 'no learn');
  assert.ok(!has(r.docker, ' up '), 'no browser');
  assert.ok(!has(r.docker, ' stop '));
  assert.deepEqual(r.events, []);
});

test('no canary result yet, or a body without last_canary: does nothing', { skip }, async () => {
  for (const body of ['{"status":"ok"}', canary(null), 'not json', canary({ ok: 'maybe' })]) {
    const r = await scenario({ healthz: [body] });
    assert.equal(r.status, 0, body);
    assert.deepEqual(r.docker.filter((c) => !c.includes(' ps ')), [], body);
    assert.deepEqual(r.events, [], body);
  }
});

test('canary ok again while the browser transport runs: stops it and records the event', { skip }, async () => {
  const r = await scenario({ healthz: [OK], browserRunning: true });
  assert.equal(r.status, 0);
  assert.ok(has(r.docker, `${COMPOSE} --profile browser stop gemini-web-browser`));
  assert.deepEqual(r.kinds, ['browser_fallback_stopped']);
  assert.equal(r.browserRunning, false);
});

test('canary failing, no recent repair: runs learn, and when the canary recovers neither starts the browser nor leaves events missing', { skip }, async () => {
  const r = await scenario({ healthz: [FAILING, FAILING_OLD, OK] });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(has(r.docker, `${COMPOSE} --profile repair run --rm -T gemini-web-repair learn`));
  assert.ok(!has(r.docker, ' up '));
  assert.deepEqual(r.kinds, ['repair_trigger', 'repair_recovered']);
  assert.match(r.events[0].detail, /class=upstream_protocol_changed/);
  assert.match(r.stamp, /^\d+\s*$/);
});

test('canary still failing after the bridge re-checked: starts the browser transport', { skip }, async () => {
  const r = await scenario({ healthz: [FAILING, FAILING] });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(has(r.docker, `${COMPOSE} --profile repair run --rm -T gemini-web-repair learn`));
  assert.ok(has(r.docker, `${COMPOSE} --profile browser up -d gemini-web-browser`));
  assert.deepEqual(r.kinds, ['repair_trigger', 'repair_not_recovered', 'browser_fallback_started']);
  assert.equal(r.browserRunning, true);
});

test('learn exit code does not matter, an ISO or millisecond canary time works, and a stale canary waits for the deadline', { skip }, async () => {
  const iso = canary({ ok: false, at: '2100-01-01T00:00:00Z', error_class: 'x y/z' });
  const ms = canary({ ok: false, at: FUTURE * 1000 });
  for (const body of [iso, ms]) {
    const r = await scenario({ healthz: [FAILING, body], learnRc: 2 });
    assert.deepEqual(r.kinds, ['repair_trigger', 'repair_not_recovered', 'browser_fallback_started'], body);
    assert.match(r.events[1].detail, /exit 2/);
  }
  // Only a stale failure (older than the learn run): waits RECHECK_WAIT_S, then falls back.
  const started = Date.now();
  const r = await scenario({ healthz: [FAILING, FAILING_OLD], learnRc: 1, env: { RECHECK_WAIT_S: '1' } });
  assert.ok(Date.now() - started >= 900, 'waited for the recheck deadline');
  assert.deepEqual(r.kinds, ['repair_trigger', 'repair_not_recovered', 'browser_fallback_started']);
});

test('error class is sanitised before it goes into an event', { skip }, async () => {
  const r = await scenario({ healthz: [canary({ ok: false, at: FUTURE, error_class: 'bad class"; rm -rf /' }), FAILING] });
  assert.match(r.events[0].detail, /class=badclassrm-rf\)/);
  assert.ok(!r.events[0].detail.includes('"'));
});

test('learn is throttled by the cooldown, but a failing canary still brings the browser up', { skip }, async () => {
  const r = await scenario({ healthz: [FAILING], lastRunAgoS: 60 });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!has(r.docker, ' run '), 'no learn during the cooldown');
  assert.ok(has(r.docker, `${COMPOSE} --profile browser up -d gemini-web-browser`));
  assert.deepEqual(r.kinds, ['browser_fallback_started']);
  assert.match(r.stderr, /cooldown/);
});

test('during the cooldown with the browser already running: nothing happens', { skip }, async () => {
  const r = await scenario({ healthz: [FAILING], lastRunAgoS: 60, browserRunning: true });
  assert.equal(r.status, 0);
  assert.ok(!has(r.docker, ' run '));
  assert.ok(!has(r.docker, ' up '));
  assert.deepEqual(r.events, []);
});

test('cooldown over: learn runs again (COOLDOWN_S)', { skip }, async () => {
  const r = await scenario({ healthz: [FAILING, OK], lastRunAgoS: 4000 });
  assert.ok(has(r.docker, ' run '));
  assert.deepEqual(r.kinds, ['repair_trigger', 'repair_recovered']);
  const r2 = await scenario({ healthz: [FAILING, OK], lastRunAgoS: 4000, env: { COOLDOWN_S: '5000' } });
  assert.ok(!has(r2.docker, ' run '), 'a longer cooldown applies');
});

test('recovery after learn also stops a browser transport that was running', { skip }, async () => {
  const r = await scenario({ healthz: [FAILING, OK], browserRunning: true });
  assert.deepEqual(r.kinds, ['repair_trigger', 'repair_recovered', 'browser_fallback_stopped']);
});

test('browser start failure: exit 1 and a browser_fallback_failed event', { skip }, async () => {
  const r = await scenario({ healthz: [FAILING, FAILING], upFails: true });
  assert.equal(r.status, 1);
  assert.deepEqual(r.kinds, ['repair_trigger', 'repair_not_recovered', 'browser_fallback_failed']);
});

test('another run holds the lock: exits 0 without touching anything', { skip }, async () => {
  const r = await scenario({ healthz: [FAILING], locked: true });
  assert.equal(r.status, 0);
  assert.deepEqual(r.calls, []);
  assert.match(r.stderr, /holds the lock/);
});

test('the admin token never appears on a command line, in events or in logs', { skip }, async () => {
  const r = await scenario({ healthz: [FAILING, FAILING] });
  assert.ok(!r.allText.includes(TOKEN));
});

test('required environment is enforced', { skip }, () => {
  const r = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /BRIDGE_URL is required/);
});
