const test = require('node:test');
const assert = require('node:assert/strict');
const { splitQuoteWithCredits } = require('../lib/meetingCredits');

test('splitQuoteWithCredits applies minutes up to duration and caps payable', () => {
  const r = splitQuoteWithCredits(10_000, 120, 60, true);
  assert.equal(r.credit_minutes_used, 60);
  assert.equal(r.credit_value_cents, 5000);
  assert.equal(r.payable_cents, 5000);
});

test('splitQuoteWithCredits no credits when disabled', () => {
  const r = splitQuoteWithCredits(8000, 60, 120, false);
  assert.equal(r.credit_minutes_used, 0);
  assert.equal(r.payable_cents, 8000);
});
