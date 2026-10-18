import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BUDGETS, budgetFor, modelClass, modelId, parseResetTime, restAfterMs, restState } from '../src/policy.mjs';

const HOUR = 3_600_000;
const DAY = 86_400_000;

test('modelId', () => {
  assert.equal(modelId('3.1 Pro'), 'gemini-3.1-pro');
  assert.equal(modelId('Gemini 3 Flash'), 'gemini-3-flash');
  assert.equal(modelId('  2.5 Flash-Lite! '), 'gemini-2.5-flash-lite');
  assert.equal(modelId(''), '');
  assert.equal(modelId(null), '');
  assert.equal(modelId('Gemini'), '');
});

test('modelClass', () => {
  assert.equal(modelClass('3.1 Pro'), 'pro');
  assert.equal(modelClass('Deep Think'), 'pro');
  assert.equal(modelClass('Ultra'), 'pro');
  assert.equal(modelClass('Flash Thinking'), 'thinking');
  assert.equal(modelClass('Flash-Lite'), 'lite');
  assert.equal(modelClass('3 Flash'), 'flash');
  assert.equal(modelClass(undefined), 'flash');
});

test('budgetFor: plan defaults, learned lowers, never raises', () => {
  const pro = { label: '3.1 Pro' };
  assert.deepEqual(budgetFor({ plan: 'free' }, pro, null), { budget: DEFAULT_BUDGETS.free.pro, source: 'plan' });
  assert.deepEqual(budgetFor({ plan: 'paid' }, pro, null), { budget: DEFAULT_BUDGETS.paid.pro, source: 'plan' });
  assert.deepEqual(budgetFor({ plan: 'unknown' }, pro, null), { budget: DEFAULT_BUDGETS.free.pro, source: 'assumed-free' });
  // 60 % of 40 = 24 < 50
  assert.deepEqual(budgetFor({ plan: 'paid' }, pro, { observed_limit: 40 }), { budget: 24, source: 'learned' });
  assert.deepEqual(budgetFor({ plan: 'paid' }, pro, { observed_limit: 0 }), { budget: 0, source: 'learned' });
  // 60 % of 1000 would raise the budget: ignored
  assert.deepEqual(budgetFor({ plan: 'paid' }, pro, { observed_limit: 1000 }), { budget: 50, source: 'plan' });
  assert.deepEqual(budgetFor({ plan: 'free' }, pro, { observed_limit: null }), { budget: 3, source: 'plan' });
});

test('restAfterMs bounds with injected rnd', () => {
  assert.equal(restAfterMs(0, () => 0), 6000);
  assert.equal(restAfterMs(0, () => 1), 16000);
  assert.equal(restAfterMs(1200, () => 0), 7000);
  assert.equal(restAfterMs(10 ** 7, () => 1), 40000);
  for (let i = 0; i < 100; i++) {
    const v = restAfterMs(Math.random() * 5000);
    assert.ok(v >= 6000 && v <= 40000, String(v));
  }
});

test('restState: inside/outside window, never when length is 0', () => {
  const day0 = 20_000 * DAY;
  // Window starts at 12:00 +-30 min and lasts 2 h, so it ends between 13:30 and 14:30.
  const acct = { id: 'a1', sleep_start_min: 12 * 60, sleep_len_min: 120 };
  const t = day0 + 12 * HOUR + 35 * 60_000;
  const inside = restState(acct, t);
  assert.equal(inside.resting, true);
  assert.ok(inside.until > t);
  assert.ok(inside.until <= day0 + 14.5 * HOUR);
  assert.deepEqual(restState(acct, day0 + 9 * HOUR), { resting: false, until: 0 });
  assert.deepEqual(restState(acct, day0 + 16 * HOUR), { resting: false, until: 0 });
  assert.deepEqual(restState({ ...acct, sleep_len_min: 0 }, t), { resting: false, until: 0 });
});

test('restState: window crossing midnight UTC', () => {
  const day0 = 20_000 * DAY;
  // 23:30 +-30 min, 6 h: ends between 05:00 and 06:00 next day
  const acct = { id: 'a2', sleep_start_min: 23 * 60 + 30, sleep_len_min: 6 * 60 };
  const early = restState(acct, day0 + DAY + 30 * 60_000);
  assert.equal(early.resting, true);
  const after = restState(acct, day0 + DAY + 2 * HOUR);
  assert.equal(after.resting, true);
  assert.ok(after.until > day0 + DAY + 2 * HOUR);
  assert.equal(restState(acct, day0 + DAY + 8 * HOUR).resting, false);
  assert.equal(restState(acct, day0 + 12 * HOUR).resting, false);
});

test('restState is stable within a day', () => {
  const day0 = 20_000 * DAY;
  const acct = { id: 'a1', sleep_start_min: 0, sleep_len_min: 300 };
  const a = restState(acct, day0 + 2 * HOUR);
  const b = restState(acct, day0 + 2 * HOUR + 1000);
  assert.equal(a.resting, true);
  assert.equal(a.until, b.until);
});

test('parseResetTime', () => {
  const now = Date.UTC(2026, 9, 18, 12, 0, 0);
  assert.equal(parseResetTime('Try again in 3 hours', now), now + 3 * HOUR);
  assert.equal(parseResetTime('resets in 45 minutes', now), now + 45 * 60_000);
  assert.equal(parseResetTime('in 2 hr', now), now + 2 * HOUR);

  // 12:00 UTC = 14:00 Berlin (CEST, UTC+2); "until 4:00 PM" Berlin = 14:00 UTC
  assert.equal(parseResetTime('Limit reached, until 4:00 PM', now, 'Europe/Berlin'), Date.UTC(2026, 9, 18, 14, 0, 0));
  assert.equal(parseResetTime('resets at 16:30', now, 'UTC'), Date.UTC(2026, 9, 18, 16, 30, 0));
  assert.equal(parseResetTime('at 12 AM', now, 'UTC'), Date.UTC(2026, 9, 19, 0, 0, 0));
  // already passed today -> tomorrow
  assert.equal(parseResetTime('until 9:00 AM', now, 'UTC'), Date.UTC(2026, 9, 19, 9, 0, 0));
  assert.equal(parseResetTime('until 4:00 PM tomorrow', now, 'UTC'), Date.UTC(2026, 9, 19, 16, 0, 0));
  // plain tomorrow = next local midnight
  assert.equal(parseResetTime('try again tomorrow', now, 'UTC'), Date.UTC(2026, 9, 19, 0, 0, 0));
  assert.equal(parseResetTime('try again tomorrow', now, 'Europe/Berlin'), Date.UTC(2026, 9, 18, 22, 0, 0));
  // garbage
  assert.equal(parseResetTime('no idea when', now), null);
  assert.equal(parseResetTime('', now), null);
  assert.equal(parseResetTime(null, now), null);
  assert.equal(parseResetTime('until 25:00', now), null);
});
