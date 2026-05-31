import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phrase } from './persona.js';

test('switch on/off get a witty line', () => {
  assert.equal(phrase({ domain:'switch', action:'off', target:'tubelight' }), 'Tubelight powered down.');
  assert.equal(phrase({ domain:'switch', action:'on', target:'rgb light' }), 'Rgb light online.');
});

test('all_off / all_on get signature lines', () => {
  assert.equal(phrase({ domain:'switch', action:'all_off' }), 'Powering down. Good night, sir.');
  assert.equal(phrase({ domain:'switch', action:'all_on' }), 'Everything is online.');
});

test('play_music gets a quip', () => {
  assert.equal(phrase({ domain:'pc', action:'media', op:'play_music', arg:'x' }), 'Spinning it up.');
});

test('intents without a quip return null', () => {
  assert.equal(phrase({ domain:'switch', action:'status', target:'tubelight' }), null);
  assert.equal(phrase({ domain:'pc', action:'open_app', target:'firefox' }), null);
  assert.equal(phrase(null), null);
  assert.equal(phrase({ domain:'ask', query:'x' }), null);
});
