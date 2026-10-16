// Entry point.
//
//   node run.mjs learn                          bridge mode (needs BRIDGE_URL, BRIDGE_ADMIN_TOKEN)
//   node run.mjs learn --dry-run --out f.json   anonymous, no bridge, writes the page facts to f.json
//   node run.mjs serve                          browser transport on :9000 (needs BROWSER_TOKEN and the bridge)
//   node run.mjs serve --anonymous              same without a bridge / cookies (local tests)
//
// learn exit codes: 0 adopted by the bridge (or dry run captured), 2 learned but
// the bridge did not validate it, 1 failure. serve exits 0 on idle exit or
// SIGTERM, 1 when it cannot start.

import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { BridgeClient } from './bridge.mjs';
import { DEFAULT_EXPECT, DEFAULT_PROMPT, learn } from './learn.mjs';
import { createBrowserServer } from './serve.mjs';
import { BrowserSession, DEFAULT_CEILING_MS } from './session.mjs';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_NOT_VALIDATED = 2;

const MODES = ['learn', 'serve'];

export function parseArgs(argv) {
  const [mode, ...rest] = argv;
  if (!MODES.includes(mode)) throw new Error(`usage: run.mjs <${MODES.join('|')}> [options]`);
  const args = { mode, dryRun: false, out: null, anonymous: false };
  for (let i = 0; i < rest.length; i++) {
    if (mode === 'learn' && rest[i] === '--dry-run') args.dryRun = true;
    else if (mode === 'learn' && rest[i] === '--out') args.out = rest[++i] ?? null;
    else if (mode === 'serve' && rest[i] === '--anonymous') args.anonymous = true;
    else throw new Error(`unknown argument for ${mode}: ${rest[i]}`);
  }
  if (args.dryRun && !args.out) throw new Error('--dry-run needs --out <file>');
  return args;
}

const defaultLog = (step, fields = {}) => console.error(JSON.stringify({ t: new Date().toISOString(), step, ...fields }));

function browserOptions(env, log) {
  return {
    aiKey: env.GEMINI_REPAIR_API_KEY || '',
    aiModel: env.GEMINI_REPAIR_MODEL || undefined,
    chromiumPath: env.CHROMIUM_PATH || undefined,
    noSandbox: env.CHROMIUM_NO_SANDBOX === '1',
    log,
  };
}

async function runLearn(args, { env, learnFn, fetchImpl, log }) {
  const options = { ...browserOptions(env, log), timeoutMs: (Number(env.REPAIR_TIMEOUT_S) || 120) * 1000 };

  if (args.dryRun) {
    try {
      const facts = await learnFn({ ...options, prompt: DEFAULT_PROMPT, expect: DEFAULT_EXPECT });
      await writeFile(args.out, JSON.stringify(facts, null, 2) + '\n');
      log('dry_run_done', { out: args.out, bl: facts.bl, signed_in: facts.signed_in, models: facts.models.length, ui_ok: facts.ui_ok });
      return EXIT_OK;
    } catch (e) {
      log('dry_run_failed', { code: e.code, error: e.message, diagnostic: e.diagnostic });
      return EXIT_FAILED;
    }
  }

  let bridge;
  try {
    bridge = new BridgeClient({ baseUrl: env.BRIDGE_URL, token: env.BRIDGE_ADMIN_TOKEN, fetchImpl });
  } catch (e) {
    log('bad_config', { error: e.message });
    return EXIT_FAILED;
  }

  await bridge.postEvent('repair_started', 'learn started');
  const fail = async (stage, e) => {
    log('failed', { stage, code: e.code, error: e.message, diagnostic: e.diagnostic });
    await bridge.postEvent('repair_failed', `${stage}: ${e.code ? `${e.code}: ` : ''}${e.message}`);
    return EXIT_FAILED;
  };

  let ctx;
  try {
    ctx = await bridge.getContext();
  } catch (e) {
    return fail('context', e);
  }

  let facts;
  try {
    facts = await learnFn({
      ...options,
      cookies: ctx.cookies,
      prompt: ctx.canary_prompt || DEFAULT_PROMPT,
      expect: ctx.canary_expect || DEFAULT_EXPECT,
    });
  } catch (e) {
    return fail('learn', e);
  }
  if (facts.ui_selectors_learned) await bridge.postEvent('browser_selectors_learned', JSON.stringify(facts.ui_selectors_learned));

  let result;
  try {
    result = await bridge.postLearned({ ...facts, account_id: ctx.account_id ?? null });
  } catch (e) {
    return fail('post_learned', e);
  }

  const summary = `bl=${facts.bl} signed_in=${facts.signed_in} models=${facts.models.length} ui_ok=${facts.ui_ok}`;
  if (result.ok && result.validated) {
    log('adopted', { bl: facts.bl, ui_ok: facts.ui_ok, event_id: result.event_id });
    await bridge.postEvent('repair_adopted', `adopted ${summary}`);
    return EXIT_OK;
  }
  log('not_validated', { error: result.error, event_id: result.event_id });
  await bridge.postEvent('repair_unvalidated', `bridge did not validate the page facts (${summary}): ${result.error ?? 'no error given'}`);
  return EXIT_NOT_VALIDATED;
}

// Only a broken page or browser marks the transport not ready (healthz ok:false); a usage
// limit or a request-specific problem (unknown / locked model) does not.
const READY_LOSING_CODES = new Set(['upstream_unavailable', 'upstream_protocol_changed']);

async function runServe(args, { env, sessionFactory, fetchImpl, log, signal }) {
  const token = env.BROWSER_TOKEN;
  if (!token) {
    log('bad_config', { error: 'BROWSER_TOKEN is not set' });
    return EXIT_FAILED;
  }

  let bridge = null;
  let cookies = [];
  if (!args.anonymous) {
    try {
      bridge = new BridgeClient({ baseUrl: env.BRIDGE_URL, token: env.BRIDGE_ADMIN_TOKEN, fetchImpl });
      cookies = (await bridge.getContext()).cookies;
    } catch (e) {
      log('failed', { stage: 'context', error: e.message });
      return EXIT_FAILED;
    }
  }

  const session = sessionFactory({
    ...browserOptions(env, log),
    cookies,
    fetchImpl,
    onSelectorsLearned: (selectors) => bridge?.postEvent('browser_selectors_learned', JSON.stringify(selectors)),
  });

  let ready = false;
  const warm = (async () => {
    try {
      const page = await session.openChat();
      await session.readFacts(page);
      await page.close().catch(() => {});
      ready = true;
      log('warm', { signed_in: session.signedIn, anonymous: session.anonymous });
      await bridge?.postEvent('browser_started', `signed_in=${session.signedIn} anonymous=${session.anonymous}`);
    } catch (e) {
      log('warm_failed', { code: e.code, error: String(e.message).split('\n')[0] });
    }
  })();
  const adapter = {
    status: () => ({ ready, signed_in: session.signedIn === true }),
    ask: async (request) => {
      await warm;
      try {
        const out = await session.ask(request);
        ready = true;
        return out;
      } catch (e) {
        if (READY_LOSING_CODES.has(e.code)) ready = false;
        throw e;
      }
    },
  };

  let finish;
  const finished = new Promise((r) => (finish = r));
  const idleExitMs = (Number(env.BROWSER_IDLE_EXIT_MIN) || 30) * 60_000;
  const srv = createBrowserServer({
    session: adapter,
    token,
    idleExitMs,
    onIdle: async () => {
      log('idle_exit', { minutes: idleExitMs / 60_000 });
      await bridge?.postEvent('browser_idle_exit', `no request for ${idleExitMs / 60_000} min`);
      finish();
    },
    ceilingMs: (Number(env.BROWSER_CEILING_S) || DEFAULT_CEILING_MS / 1000) * 1000,
    log,
  });
  try {
    const port = await srv.listen(env.BROWSER_PORT === undefined ? 9000 : Number(env.BROWSER_PORT), env.BROWSER_HOST || '0.0.0.0');
    log('listening', { port, idle_exit_min: idleExitMs / 60_000 });
  } catch (e) {
    log('failed', { stage: 'listen', error: e.message });
    await session.close();
    return EXIT_FAILED;
  }
  signal?.addEventListener('abort', () => finish(), { once: true });

  await finished;
  await srv.close();
  await warm;
  await session.close();
  return EXIT_OK;
}

/** Testable entry point. Returns the process exit code. */
export async function main({
  argv = [],
  env = process.env,
  learnFn = learn,
  sessionFactory = (o) => new BrowserSession(o),
  fetchImpl = fetch,
  log = defaultLog,
  signal,
} = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    log('bad_arguments', { error: e.message });
    return EXIT_FAILED;
  }
  const deps = { env, learnFn, sessionFactory, fetchImpl, log, signal };
  return args.mode === 'learn' ? runLearn(args, deps) : runServe(args, deps);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stop = new AbortController();
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => stop.abort());
  main({ argv: process.argv.slice(2), signal: stop.signal }).then(
    (code) => process.exit(code),
    (e) => {
      defaultLog('crashed', { error: e.message });
      process.exit(EXIT_FAILED);
    },
  );
}
