import test from 'node:test';
import assert from 'node:assert/strict';
import { cooldownMs, modelClass, modelId, parseResetTime, restAfterMs } from '../src/policy.mjs';

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

test('restAfterMs bounds with injected rnd', () => {
  assert.equal(restAfterMs(0, () => 0), 2000);
  assert.equal(restAfterMs(0, () => 1), 8000);
  assert.equal(restAfterMs(2000, () => 0), 3000);
  assert.equal(restAfterMs(10 ** 7, () => 1), 18000);
  for (let i = 0; i < 100; i++) {
    const v = restAfterMs(Math.random() * 5000);
    assert.ok(v >= 2000 && v <= 18000, String(v));
  }
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

test('cooldownMs: 5 min, 15 min when Google rate-limits again within a day', () => {
  const now = 10 * DAY;
  assert.equal(cooldownMs(0, now), 5 * 60_000);
  assert.equal(cooldownMs(now - HOUR, now), 15 * 60_000);
  assert.equal(cooldownMs(now - 2 * DAY, now), 5 * 60_000);
});
