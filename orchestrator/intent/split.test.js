import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitUtterance } from './split.js';

test('splits on sequencing connectors', () => {
  assert.deepEqual(splitUtterance('turn off the light and then play music'), ['turn off the light', 'play music']);
  assert.deepEqual(splitUtterance('open chrome then play jazz'), ['open chrome', 'play jazz']);
  assert.deepEqual(splitUtterance('turn on the fan and turn off the light'), ['turn on the fan', 'turn off the light']);
  assert.deepEqual(splitUtterance('a and then b then c'), ['a', 'b', 'c']);
});

test('a plain command stays a single piece', () => {
  assert.deepEqual(splitUtterance('turn off the tubelight'), ['turn off the tubelight']);
  assert.deepEqual(splitUtterance(''), []);
});
