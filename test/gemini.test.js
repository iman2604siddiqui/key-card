import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySensitive } from '../lib/classification.js';
import { geminiAnswer } from '../lib/gemini.js';

const rows = [{ title: 'HR handbook', content: 'Working hours are 9:00 AM to 5:00 PM.', score: 0.2 }];

test('returns a grounded Gemini answer for an in-policy question', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Working hours are 9:00 AM to 5:00 PM.' }] } }] }) };
  };
  try {
    const result = await geminiAnswer('What are the working hours?', rows, 'test-key');
    assert.equal(result.answer, 'Working hours are 9:00 AM to 5:00 PM.');
    assert.match(request.url, /gemini-2\.5-flash/);
    assert.match(request.options.body, /Working hours are 9:00 AM to 5:00 PM/);
  } finally { globalThis.fetch = originalFetch; }
});

test('sensitive questions are escalated before Gemini is called', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('Gemini must not be called'); };
  try {
    const decision = classifySensitive('How much is my compensation?');
    assert.equal(decision.escalate, true);
    const result = decision ? null : await geminiAnswer('How much is my compensation?', rows, 'test-key');
    assert.equal(result, null);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});
