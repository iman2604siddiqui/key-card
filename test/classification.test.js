import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySensitive } from '../lib/classification.js';

test('escalates compensation questions', () => {
  const result = classifySensitive('How much is my salary during probation?');
  assert.equal(result.escalate, true);
  assert.match(result.reason, /compensation/);
});

test('escalates immigration questions', () => {
  const result = classifySensitive('Can the company sponsor my visa?');
  assert.equal(result.category, 'sensitive');
  assert.match(result.reason, /immigration/);
});

test('allows routine onboarding questions through', () => {
  assert.equal(classifySensitive('Where do I find the VPN setup guide?'), null);
});
