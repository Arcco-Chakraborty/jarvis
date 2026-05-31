import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, parseWithSource } from './index.js';

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

test('parseWithSource: rules hit -> via rules', async () => {
  assert.deepEqual(await parseWithSource('turn off the tubelight', VOCAB), {
    intent: { domain: 'switch', action: 'off', target: 'tubelight' }, via: 'rules',
  });
});
test('parseWithSource: rules miss + classify hit -> via gemini', async () => {
  const spy = async () => ({ domain: 'switch', action: 'off', target: 'tubelight' });
  assert.deepEqual(await parseWithSource('lites off', VOCAB, spy), {
    intent: { domain: 'switch', action: 'off', target: 'tubelight' }, via: 'gemini',
  });
});
test('parseWithSource: rules miss + classify null -> via null', async () => {
  const noop = async () => null;
  assert.deepEqual(await parseWithSource('make me a sandwich', VOCAB, noop), { intent: null, via: null });
});

test('cascade matches a knowledge question locally as ask (before Gemini)', async () => {
  let geminiCalled = false;
  const { intent, via } = await parseWithSource('find out about mars', {}, async () => { geminiCalled = true; return null; });
  assert.deepEqual(intent, { domain: 'ask', query: 'mars' });
  assert.equal(via, 'rules');
  assert.equal(geminiCalled, false);
});
