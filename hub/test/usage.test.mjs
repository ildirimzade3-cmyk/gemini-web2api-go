import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUsage, parseResetPhrase } from '../src/ui.mjs';
import { meterState } from '../src/policy.mjs';

// Text of gemini.google.com/usage as read on 18 Oct 2026 (Pro account).
const PAGE = `New chat
Usage limits
PRO

Your plan's limits determine how much you can use Gemini over time. Advanced models and features can take up more usage. Learn more

Updated just now

Current usage
info
28% used
Resets at 10:17 AM
Weekly limit
Resets Oct 20 at 3:17 AM
7% used
Get 5x more usage with AI Ultra
$99.99/month
Upgrade`;

const NOW = Date.parse('2026-10-18T12:23:00Z');

test('the real usage page gives the 5-hour and weekly meters with resets in the page time zone', () => {
  const m = parseUsage(PAGE, NOW, 'America/New_York');
  assert.deepEqual(m, [
    { name: '5h', used_pct: 28, resets_at: Date.parse('2026-10-18T14:17:00Z') },
    { name: 'weekly', used_pct: 7, resets_at: Date.parse('2026-10-20T07:17:00Z') },
  ]);
});

test('reset phrases: relative, dated, time of day, "left" percentages', () => {
  assert.equal(parseResetPhrase('Resets in 2 hr 10 min', 0), 130 * 60_000);
  assert.equal(parseResetPhrase('Resets Jan 2 at 1:05 PM', Date.parse('2026-12-30T12:00:00Z'), 'UTC'), Date.parse('2027-01-02T13:05:00Z'));
  assert.equal(parseResetPhrase('nonsense', NOW), null);
  const m = parseUsage('Current usage\n35% left\nResets in 1 hr', 0);
  assert.equal(m[0].used_pct, 65);
});

test('meterState blocks at 95 % until the reset, and reports a stale reading', () => {
  const acct = (five, weekly, readAgo = 60_000) => ({
    usage: { read_at: NOW - readAgo, meters: [{ name: '5h', used_pct: five, resets_at: NOW + 3_600_000 }, { name: 'weekly', used_pct: weekly, resets_at: NOW + 86_400_000 }] },
  });
  assert.deepEqual(meterState(acct(28, 7), {}, NOW).blockers, []);
  assert.deepEqual(meterState(acct(94, 94), {}, NOW).blockers, []);
  const full = meterState(acct(95, 7), {}, NOW);
  assert.deepEqual(full.blockers, ['usage_5h']);
  assert.equal(full.until, NOW + 3_600_000);
  assert.deepEqual(meterState(acct(10, 96), {}, NOW).blockers, ['usage_weekly']);
  assert.equal(meterState(acct(10, 10, 31 * 60_000), {}, NOW).stale, true);
  assert.equal(meterState(acct(10, 10, 60_000), {}, NOW).stale, false);
  // a full meter stays a blocker even when the reading is old, until its reset time
  assert.deepEqual(meterState(acct(100, 7, 3 * 3_600_000), {}, NOW).blockers, ['usage_5h']);
  assert.deepEqual(meterState({ usage: {} }, {}, NOW).blockers, []);
});
