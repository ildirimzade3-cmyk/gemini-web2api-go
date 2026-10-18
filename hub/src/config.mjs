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
    // Public ingress: loopback only; the host's Caddy terminates TLS for HUB_PUBLIC_URL and
    // forwards here. Requests must carry an app's secret path (/p/<secret>/...) and its key.
    publicListen: env.HUB_PUBLIC_LISTEN || '',
    publicUrl: (env.HUB_PUBLIC_URL || '').replace(/\/+$/, ''),
    // Admin listeners: loopback and, optionally, the tailnet address. Never a public one:
    // only loopback and tailnet (100.64.0.0/10) addresses are accepted, enforced in admin.mjs.
    adminListen: list(env.HUB_ADMIN_LISTEN, '127.0.0.1:18091'),
    // Network allowlist checked on every connection before anything else.
    allowCidrs: list(env.HUB_ALLOW_CIDRS, '127.0.0.0/8,100.64.0.0/10,172.16.0.0/12'),
    // Gemini usage meter stop lines (percent used): the account rests until the window resets.
    usageStop: { stop5h: int(env.HUB_USAGE_STOP_5H, 95), stopWeekly: int(env.HUB_USAGE_STOP_WEEKLY, 95) },
    maxWarmBrowsers: int(env.HUB_MAX_WARM, 3),
    // A browser with no work for this long is closed to free memory. Short enough for RAM,
    // long enough that a burst of requests reuses one open browser instead of reloading Gemini.
    idleCloseMs: int(env.HUB_IDLE_CLOSE_MIN, 3) * 60_000,
    // Thinking level when a request names none (Gemini's own default is Low); set explicitly every time.
    defaultThinking: ['low', 'medium', 'high'].includes(env.HUB_DEFAULT_THINKING) ? env.HUB_DEFAULT_THINKING : 'low',
    // At most this many requests wait in the queue; one more is refused at once ("queue full").
    maxQueue: int(env.HUB_MAX_QUEUE, 4),
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
