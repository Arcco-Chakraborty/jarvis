import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchPcCommand } from './pc.js';

test('"open chrome" -> pc.open_app', () => {
  assert.deepEqual(matchPcCommand('open chrome'),
    { domain: 'pc', action: 'open_app', target: 'chrome' });
});

test('"launch firefox" -> pc.open_app', () => {
  assert.deepEqual(matchPcCommand('launch firefox'),
    { domain: 'pc', action: 'open_app', target: 'firefox' });
});

test('"start vs code" -> pc.open_app (multi-word target preserved)', () => {
  assert.deepEqual(matchPcCommand('start vs code'),
    { domain: 'pc', action: 'open_app', target: 'vs code' });
});

test('strips "jarvis," wake prefix and punctuation', () => {
  assert.deepEqual(matchPcCommand('jarvis, open chrome.'),
    { domain: 'pc', action: 'open_app', target: 'chrome' });
});

test('"open the" prefix is dropped from the target', () => {
  assert.deepEqual(matchPcCommand('open the settings'),
    { domain: 'pc', action: 'open_app', target: 'settings' });
});

test('non-open commands return null', () => {
  assert.equal(matchPcCommand('turn off the lights'), null);
  assert.equal(matchPcCommand('lights off'), null);
  assert.equal(matchPcCommand('what is the weather'), null);
  assert.equal(matchPcCommand(''), null);
  assert.equal(matchPcCommand(null), null);
});

test('"open" without a target is null', () => {
  assert.equal(matchPcCommand('open'), null);
  assert.equal(matchPcCommand('launch  '), null);
});
