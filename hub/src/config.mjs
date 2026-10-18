// Runtime configuration from the environment. Everything that can change while the
// hub runs (accounts, apps, budgets) lives in the database instead.

import path from 'node:path';

function list(v, fallback) {
  const s = (v ?? fallback ?? '').trim();
  return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : [];
}

function int(v, fallback) {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env = process.env) {
  const data = env.HUB_DATA || '/data';
  return {
    data,
    dbPath: path.join(data, 'hub.db'),
    profilesDir: path.join(data, 'profiles'),
    diagDir: path.join(data, 'diag'),
    chromePath: env.CHROME_PATH || '/usr/bin/google-chrome-stable',
    // API listeners ("host:port"). Each address is bound separately; a missing one
    // (tailscale not up yet, docker bridge not created yet) is retried.
    apiListen: list(env.HUB_API_LISTEN, '127.0.0.1:18090'),
    // Admin listener: loopback only, enforced in code (any other host is refused).
    adminListen: env.HUB_ADMIN_LISTEN || '127.0.0.1:18091',
    // Network allowlist checked on every connection before anything else.
    allowCidrs: list(env.HUB_ALLOW_CIDRS, '127.0.0.0/8,100.64.0.0/10,172.16.0.0/12'),
    maxWarmBrowsers: int(env.HUB_MAX_WARM, 3),
    idleCloseMs: int(env.HUB_IDLE_CLOSE_MIN, 20) * 60_000,
    dedupeWindowMs: int(env.HUB_DEDUPE_MIN, 10) * 60_000,
    ntfyServer: env.HUB_NTFY_SERVER || 'https://ntfy.sh',
    ntfyTopic: env.HUB_NTFY_TOPIC || '',
    // Official Gemini API key used only to propose new selectors when the site changes.
    repairApiKey: env.HUB_REPAIR_API_KEY || env.GEMINI_REPAIR_API_KEY || '',
    repairModel: env.HUB_REPAIR_MODEL || 'gemini-3.6-flash',
    // Test hook: lets the admin API simulate a changed site on one account (off in normal use).
    chaos: env.HUB_CHAOS === '1',
    displayBase: int(env.HUB_DISPLAY_BASE, 100),
    vncPortBase: int(env.HUB_VNC_PORT_BASE, 15900),
  };
}
