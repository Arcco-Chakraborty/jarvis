import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchVision, matchImplicitVision } from './vision.js';

test('bare "look at this" -> phone with default query', () => {
  assert.deepEqual(matchVision('look at this'), { domain: 'vision', source: 'phone', query: 'What do you see?' });
  assert.deepEqual(matchVision('jarvis, look at that.'), { domain: 'vision', source: 'phone', query: 'What do you see?' });
});

test('physical phrasings carry the trailing question and use the phone', () => {
  assert.deepEqual(matchVision('look at this what is this'),
    { domain: 'vision', source: 'phone', query: 'what is this' });
  assert.deepEqual(matchVision('what am i holding'),
    { domain: 'vision', source: 'phone', query: 'What do you see?' });
  assert.deepEqual(matchVision('what is this'),
    { domain: 'vision', source: 'phone', query: 'What do you see?' });
});

test('phone-explicit phrasings -> phone', () => {
  assert.deepEqual(matchVision('look through my phone what is this'),
    { domain: 'vision', source: 'phone', query: 'what is this' });
  assert.deepEqual(matchVision('look at my phone'),
    { domain: 'vision', source: 'phone', query: 'What do you see?' });
  assert.deepEqual(matchVision('what am i doing'),
    { domain: 'vision', source: 'phone', query: 'What do you see?' });
});

test('screen phrasings -> screen source', () => {
  assert.deepEqual(matchVision('look at my screen'),
    { domain: 'vision', source: 'screen', query: 'What do you see?' });
  assert.deepEqual(matchVision("what's on my screen"),
    { domain: 'vision', source: 'screen', query: 'What do you see?' });
  assert.deepEqual(matchVision('look at the screen what does this say'),
    { domain: 'vision', source: 'screen', query: 'what does this say' });
});

test('non-vision commands return null', () => {
  assert.equal(matchVision('turn off the tubelight'), null);
  assert.equal(matchVision('play daft punk'), null);
  assert.equal(matchVision('find out about mars'), null);
  assert.equal(matchVision(''), null);
});

test('matchImplicitVision fires on demonstratives and bare help-verbs', () => {
  for (const t of [
    'how do i connect these',
    "what's wrong with this",
    'fix this',
    'fix the wiring',
    'what does this button do',
    'is this plugged in right',
  ]) {
    const r = matchImplicitVision(t);
    assert.ok(r, `should fire: ${t}`);
    assert.equal(r.domain, 'vision');
    assert.equal(r.source, 'phone');
    assert.equal(r.implicit, true);
    assert.equal(typeof r.query, 'string');
  }
});

test('matchImplicitVision stays out of plain knowledge questions', () => {
  for (const t of ['how do i make pasta', "what's the capital of france", 'who is ada lovelace']) {
    assert.equal(matchImplicitVision(t), null, `should not fire: ${t}`);
  }
});
