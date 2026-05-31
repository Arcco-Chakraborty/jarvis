import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchAsk } from './ask.js';

test('knowledge triggers -> ask intent with the query', () => {
  assert.deepEqual(matchAsk('find out about the james webb telescope'),
    { domain: 'ask', query: 'the james webb telescope' });
  assert.deepEqual(matchAsk('tell me about quantum computing'),
    { domain: 'ask', query: 'quantum computing' });
  assert.deepEqual(matchAsk('what is a black hole'),
    { domain: 'ask', query: 'a black hole' });
  assert.deepEqual(matchAsk('who is ada lovelace'),
    { domain: 'ask', query: 'ada lovelace' });
  assert.deepEqual(matchAsk("what's the speed of light"),
    { domain: 'ask', query: 'the speed of light' });
});

test('strips a leading "jarvis," and trailing punctuation', () => {
  assert.deepEqual(matchAsk('jarvis, find out about mars?'),
    { domain: 'ask', query: 'mars' });
});

test('control commands and bare triggers do NOT match', () => {
  assert.equal(matchAsk('turn off the tubelight'), null);
  assert.equal(matchAsk('play daft punk'), null);
  assert.equal(matchAsk('search for cats'), null);
  assert.equal(matchAsk('what is'), null);   // no topic
  assert.equal(matchAsk(''), null);
});
