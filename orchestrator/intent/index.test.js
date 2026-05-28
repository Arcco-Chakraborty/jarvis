import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from './index.js';

const VOCAB = {
  deviceNames: ['tubelight'],
  groupNames: ['lights'],
};

test('parse delegates to the rule matcher', () => {
  assert.deepEqual(parse('turn off the tubelight', VOCAB), {
    domain: 'switch', action: 'off', target: 'tubelight',
  });
});
test('parse returns null for unmatched input', () => {
  assert.equal(parse('make me a sandwich', VOCAB), null);
});
