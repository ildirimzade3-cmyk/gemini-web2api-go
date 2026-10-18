// Account policy: model ids, pacing between prompts, Gemini's own usage meter and
// reading reset times out of Google's messages.
//
// Whether an account can take work is decided by what Google says, never by local
// guesses: the usage page (gemini.google.com/usage: the rolling 5-hour allowance and
// the weekly cap, each with its reset time) and the limit / error messages it shows.

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

/**
 * Rest after a finished prompt before the account takes the next one: a person
 * reads the answer and writes the next message. 2-8 s plus about a second per 2000
 * characters of answer, at most 18 s.
 */
export function restAfterMs(outChars, rnd = Math.random) {
  const base = 2_000 + rnd() * 6_000;
  const reading = Math.min(10_000, (outChars / 2000) * 1000);
  return Math.round(Math.min(18_000, base + reading));
}

/** Pause after Google answered HTTP 429 three times in 10 minutes: 5 min, 15 min when it happens again within a day. */
export function cooldownMs(previousUntil, now = Date.now()) {
  return previousUntil && now - previousUntil < DAY ? 15 * 60_000 : 5 * 60_000;
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

/**
 * When a model's limit message names no reset time (and the usage page does not
 * explain it), that model is tried again on the account after this long.
 */
export const UNKNOWN_RESET_MS = HOUR;

/** A meter reading older than this is refreshed from the usage page before the account is used. */
export const METER_STALE_MS = 30 * 60_000;

/**
 * What Gemini's usage meter says about an account. At or above the stop line
 * (95 % by default) the account waits for that window's reset time.
 */
export function meterState(account, { stop5h = 95, stopWeekly = 95 } = {}, now = Date.now()) {
  const u = account.usage ?? {};
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
  const stale = !u.read_at || now - u.read_at > METER_STALE_MS;
  return { stale, five, weekly, read_at: u.read_at ?? 0, blockers, until };
}
