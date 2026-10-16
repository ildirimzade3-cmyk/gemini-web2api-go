// Orchestrates one repair run.
//
//   node run.mjs                          bridge mode (needs BRIDGE_URL, BRIDGE_ADMIN_TOKEN)
//   node run.mjs --dry-run --out f.json   anonymous learn, no bridge, writes f.json
//
// Exit codes: 0 adopted by the bridge (or dry run captured), 2 learned but the
// bridge did not validate it, 1 failure.

import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { BridgeClient } from './bridge.mjs';
import { DEFAULT_PROMPT, learn } from './learn.mjs';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_NOT_VALIDATED = 2;

function parseArgs(argv) {
  const args = { dryRun: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--out') args.out = argv[++i] ?? null;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (args.dryRun && !args.out) throw new Error('--dry-run needs --out <file>');
  return args;
}

const defaultLog = (step, fields = {}) => console.error(JSON.stringify({ t: new Date().toISOString(), step, ...fields }));

function learnOptions(env, log) {
  return {
    aiKey: env.GEMINI_REPAIR_API_KEY || '',
    aiModel: env.GEMINI_REPAIR_MODEL || undefined,
    timeoutMs: (Number(env.REPAIR_TIMEOUT_S) || 120) * 1000,
    chromiumPath: env.CHROMIUM_PATH || undefined,
    noSandbox: env.CHROMIUM_NO_SANDBOX === '1',
    log,
  };
}

/** Testable entry point. Returns the process exit code. */
export async function main({ argv = [], env = process.env, learnFn = learn, fetchImpl = fetch, log = defaultLog } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    log('bad_arguments', { error: e.message });
    return EXIT_FAILED;
  }

  if (args.dryRun) {
    try {
      const learned = await learnFn({ ...learnOptions(env, log), prompt: DEFAULT_PROMPT });
      await writeFile(args.out, JSON.stringify(learned, null, 2) + '\n');
      log('dry_run_done', { out: args.out, bl: learned.bl, response_ok: learned.response_ok });
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

  await bridge.postEvent('repair_started', 'self-repair job started');
  const fail = async (stage, e) => {
    log('failed', { stage, code: e.code, error: e.message, diagnostic: e.diagnostic });
    await bridge.postEvent('repair_failed', `${stage}: ${e.message}`);
    return EXIT_FAILED;
  };

  let ctx;
  try {
    ctx = await bridge.getContext();
  } catch (e) {
    return fail('context', e);
  }

  let learned;
  try {
    learned = await learnFn({
      ...learnOptions(env, log),
      cookies: ctx.cookies,
      prompt: ctx.canary_prompt || DEFAULT_PROMPT,
      expect: ctx.canary_expect || 'pong',
    });
  } catch (e) {
    return fail('learn', e);
  }

  let result;
  try {
    result = await bridge.postLearned({ ...learned, account_id: ctx.account_id ?? null });
  } catch (e) {
    return fail('post_learned', e);
  }

  if (result.ok && result.validated) {
    log('adopted', { bl: learned.bl, event_id: result.event_id });
    await bridge.postEvent('repair_adopted', `adopted bl=${learned.bl} method=${learned.method}`);
    return EXIT_OK;
  }
  log('not_validated', { error: result.error, event_id: result.event_id });
  await bridge.postEvent('repair_unvalidated', `bridge did not validate the learned protocol: ${result.error ?? 'no error given'}`);
  return EXIT_NOT_VALIDATED;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main({ argv: process.argv.slice(2) }).then(
    (code) => process.exit(code),
    (e) => {
      defaultLog('crashed', { error: e.message });
      process.exit(EXIT_FAILED);
    },
  );
}
