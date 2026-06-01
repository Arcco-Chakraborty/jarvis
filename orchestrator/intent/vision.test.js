import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchVision } from './vision.js';

test('bare "look at this" -> camera with default query', () => {
  assert.deepEqual(matchVision('look at this'), { domain: 'vision', source: 'camera', query: 'What do you see?' });
  assert.deepEqual(matchVision('jarvis, look at that.'), { domain: 'vision', source: 'camera', query: 'What do you see?' });
});

test('camera phrasings carry the trailing question as the query', () => {
  assert.deepEqual(matchVision('look at my desk what is this'),
    { domain: 'vision', source: 'camera', query: 'what is this' });
  assert.deepEqual(matchVision('what am i holding'),
    { domain: 'vision', source: 'camera', query: 'What do you see?' });
  assert.deepEqual(matchVision('what is this'),
    { domain: 'vision', source: 'camera', query: 'What do you see?' });
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
