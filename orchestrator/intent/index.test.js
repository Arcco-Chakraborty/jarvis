import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from './index.js';

const VOCAB = { deviceNames: ['tubelight'], groupNames: ['lights'] };

test('parse delegates to the rule matcher (rules hit)', async () => {
  assert.deepEqual(await parse('turn off the tubelight', VOCAB), {
    domain: 'switch', action: 'off', target: 'tubelight',
  });
});

test('parse returns null when rules miss and fallback declines', async () => {
  const noop = async () => null;
  assert.equal(await parse('make me a sandwich', VOCAB, noop), null);
});

test('rules hit -> fallback NOT called', async () => {
  let called = false;
  const spy = async () => {
    called = true;
    return null;
  };
  await parse('turn off the tubelight', VOCAB, spy);
  assert.equal(called, false);
});

test('rules miss -> fallback called and its result returned', async () => {
  let called = false;
  const spy = async () => {
    called = true;
    return { domain: 'switch', action: 'off', target: 'tubelight' };
  };
  const r = await parse('lites off', VOCAB, spy);
  assert.equal(called, true);
  assert.deepEqual(r, { domain: 'switch', action: 'off', target: 'tubelight' });
});
