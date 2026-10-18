// Account-safety policy: model ids and classes, daily budgets, pacing between
// prompts, the daily rest window, and reading reset times out of limit messages.
//
// Budgets are deliberately about half of what Google advertises for the consumer
// Gemini app on each plan. A limit Google actually shows lowers the budget of that
// (account, model) to 60 % of the count at which it appeared.

import crypto from 'node:crypto';

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Stable API id for a model label from the picker: "3.1 Pro" -> "gemini-3.1-pro". */
export function modelId(label) {
  const s = String(label ?? '')
    .toLowerCase()
    .replace(/^gemini\s*/, '')
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s ? `gemini-${s}` : '';
}

export function modelClass(label) {
  const s = String(label ?? '').toLowerCase();
  if (/\bpro\b|argon|ultra|deep think/.test(s)) return 'pro';
  if (/think|reason/.test(s)) return 'thinking';
  if (/lite/.test(s)) return 'lite';
  return 'flash';
}

export const DEFAULT_BUDGETS = Object.freeze({
  // prompts per account per rolling 24 h
  free: { lite: 60, flash: 40, thinking: 8, pro: 3 },
  paid: { lite: 300, flash: 250, thinking: 120, pro: 50 },
});
export const HOURLY_CAP = Object.freeze({ free: 20, paid: 40 });
export const LEARNED_FRACTION = 0.6;

export function planKey(plan) {
  return plan === 'paid' ? 'paid' : 'free';
}

/** { budget, source } for one (account, model). `limitRow` comes from the limits table. */
export function budgetFor(account, model, limitRow) {
  const base = DEFAULT_BUDGETS[planKey(account.plan)][modelClass(model.label)];
  if (limitRow?.observed_limit != null) {
    const learned = Math.max(0, Math.floor(limitRow.observed_limit * LEARNED_FRACTION));
    if (learned < base) return { budget: learned, source: 'learned' };
  }
  return { budget: base, source: account.plan === 'unknown' ? 'assumed-free' : 'plan' };
}

export function hourlyCap(account) {
  return HOURLY_CAP[planKey(account.plan)];
}

/**
 * Rest after a finished prompt before the account takes the next one: a person reads
 * the answer and writes the next message. 6–16 s plus about a second per 1200
 * characters of answer, at most 40 s in total.
 */
export function restAfterMs(outChars, rnd = Math.random) {
  const base = 6_000 + rnd() * 10_000;
  const reading = Math.min(24_000, (outChars / 1200) * 1000);
  return Math.round(Math.min(40_000, base + reading));
}

/**
 * Default daily rest for the n-th account (0-based): 5 h from 20:00 UTC (the
 * operator's night in Baku, evening on the US east coast where the VPS is),
 * each further account 3 h later so the hub as a whole never sleeps.
 */
export function defaultSleep(index) {
  return { sleep_start_min: (20 * 60 + index * 180) % 1440, sleep_len_min: 5 * 60 };
}

function dayJitterMin(accountId, dayIndex) {
  const h = crypto.createHash('sha256').update(`${accountId}:${dayIndex}`).digest();
  return (h[0] / 255) * 60 - 30; // -30 .. +30 minutes, stable for the day
}

/**
 * Whether the account is inside its daily rest at `now`, and when the rest ends.
 * The window moves by up to ±30 minutes from day to day so the account does not
 * start and stop at the same minute every day.
 */
export function restState(account, now = Date.now()) {
  if (!account.sleep_len_min) return { resting: false, until: 0 };
  for (const dayOffset of [-1, 0]) {
    const day = Math.floor(now / DAY) + dayOffset;
    const start = day * DAY + (account.sleep_start_min + dayJitterMin(account.id, day)) * 60_000;
    const end = start + account.sleep_len_min * 60_000;
    if (now >= start && now < end) return { resting: true, until: Math.round(end) };
  }
  return { resting: false, until: 0 };
}

/**
 * Reset time from a limit message ("...until 4:00 PM", "...resets at 16:30",
 * "...try again tomorrow", "...in 3 hours"). Times without a zone are read in
 * `tz` (the page's time zone). Returns epoch ms or null.
 */
export function parseResetTime(text, now = Date.now(), tz = 'UTC') {
  const s = String(text ?? '');
  let m = /\bin (\d{1,2}) (hour|hr|minute|min)s?\b/i.exec(s);
  if (m) return now + Number(m[1]) * (m[2].toLowerCase().startsWith('h') ? HOUR : 60_000);
  m = /\b(?:until|at|after)\s+(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i.exec(s);
  if (m) {
    let hh = Number(m[1]);
    const mm = Number(m[2] ?? 0);
    const ap = (m[3] ?? '').toLowerCase().replace(/\./g, '');
    if (ap === 'pm' && hh < 12) hh += 12;
    if (ap === 'am' && hh === 12) hh = 0;
    if (hh > 23 || mm > 59) return null;
    const offset = tzOffsetMs(tz, now);
    const localNow = now + offset;
    let t = Math.floor(localNow / DAY) * DAY + hh * HOUR + mm * 60_000 - offset;
    if (/tomorrow/i.test(s) || t <= now) t += DAY;
    return t;
  }
  if (/tomorrow/i.test(s)) {
    const offset = tzOffsetMs(tz, now);
    return Math.floor((now + offset) / DAY + 1) * DAY - offset;
  }
  return null;
}

export function tzOffsetMs(tz, now) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(now));
    const get = (t) => Number(parts.find((p) => p.type === t).value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return asUtc - Math.floor(now / 1000) * 1000;
  } catch {
    return 0;
  }
}

/** When a limit message names no reset time, the model stays off on that account this long. */
export const UNKNOWN_RESET_MS = 12 * HOUR;

/**
 * What Gemini's own usage meter says about an account (read from /usage). Above the
 * stop line the account rests until that window resets. A meter older than
 * METER_FRESH_MS is not trusted, and the prompt-count budget applies instead.
 */
export const METER_FRESH_MS = 2 * HOUR;
export function meterState(account, { stop5h = 80, stopWeekly = 85 } = {}, now = Date.now()) {
  const u = account.usage ?? {};
  const fresh = Boolean(u.read_at) && now - u.read_at < METER_FRESH_MS;
  const get = (name) => (u.meters ?? []).find((m) => m.name === name) ?? null;
  const five = get('5h');
  const weekly = get('weekly');
  const blockers = [];
  let until = 0;
  // A full meter blocks until its reset even when the reading is old (it cannot empty sooner).
  if (five && five.used_pct >= stop5h && (five.resets_at ?? 0) > now) {
    blockers.push('usage_5h');
    until = Math.max(until, five.resets_at);
  }
  if (weekly && weekly.used_pct >= stopWeekly && (weekly.resets_at ?? 0) > now) {
    blockers.push('usage_weekly');
    until = Math.max(until, weekly.resets_at);
  }
  return { fresh, five, weekly, read_at: u.read_at ?? 0, blockers, until };
}
