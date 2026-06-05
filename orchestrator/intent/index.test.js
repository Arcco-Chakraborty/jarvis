import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, parseWithSource, parseLocal } from './index.js';

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

test('parseLocal resolves local intents without calling Gemini', async () => {
  const vocab = { deviceNames: ['tubelight'], groupNames: ['lights'] };
  assert.deepEqual(parseLocal('turn off the tubelight', vocab), { domain: 'switch', action: 'off', target: 'tubelight' });
  assert.deepEqual(parseLocal('find out about mars', vocab), { domain: 'ask', query: 'mars' });
  assert.equal(parseLocal('hmm something vague', vocab), null);
});

test('cascade matches a vision request locally (before ask/gemini)', async () => {
  let geminiCalled = false;
  const { intent, via } = await parseWithSource('look at this', {}, async () => { geminiCalled = true; return null; });
  assert.deepEqual(intent, { domain: 'vision', source: 'phone', query: 'What do you see?' });
  assert.equal(via, 'rules');
  assert.equal(geminiCalled, false);
});

test('cascade passes pcNames so "open x on the desktop" carries a machine', async () => {
  const { intent } = await parseWithSource('open chrome on the desktop', { pcNames: ['desktop'] }, async () => null);
  assert.deepEqual(intent, { domain: 'pc', action: 'open_app', target: 'chrome', machine: 'desktop' });
});

test('implicit vision routes deictic questions before ask', async () => {
  const noGemini = async () => null;
  const r = await parse('how do i connect these', {}, noGemini);
  assert.equal(r.domain, 'vision');
  assert.equal(r.implicit, true);
  assert.equal(r.source, 'phone');
});

test('explicit vision is unaffected (no implicit flag)', async () => {
  const noGemini = async () => null;
  const r = await parse('what is this', {}, noGemini);
  assert.equal(r.domain, 'vision');
  assert.notEqual(r.implicit, true);
});

test('plain knowledge questions still reach ask', async () => {
  const noGemini = async () => null;
  const r = await parse("what's the capital of france", {}, noGemini);
  assert.equal(r.domain, 'ask');
});
