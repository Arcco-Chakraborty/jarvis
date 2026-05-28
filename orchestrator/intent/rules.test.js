import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchSwitchCommand } from './rules.js';

const VOCAB = {
  deviceNames: ['fan 1', 'fan 2', 'tubelight', 'spotlight', 'rgb light', 'night light', 'socket', 'spare'],
  groupNames: ['lights', 'fans'],
};
const m = (text) => matchSwitchCommand(text, VOCAB);

test('device off', () => {
  assert.deepEqual(m('turn off the tubelight'), { domain: 'switch', action: 'off', target: 'tubelight' });
});
test('device on, multi-word name', () => {
  assert.deepEqual(m('turn on fan 1'), { domain: 'switch', action: 'on', target: 'fan 1' });
});
test('group off', () => {
  assert.deepEqual(m('lights off'), { domain: 'switch', action: 'off', target: 'lights' });
});
test('group on', () => {
  assert.deepEqual(m('fans on'), { domain: 'switch', action: 'on', target: 'fans' });
});
test('"all lights off" is the group, not all_off', () => {
  assert.deepEqual(m('all lights off'), { domain: 'switch', action: 'off', target: 'lights' });
});
test('all_off via everything', () => {
  assert.deepEqual(m('everything off'), { domain: 'switch', action: 'all_off' });
});
test('all_off via all', () => {
  assert.deepEqual(m('all off'), { domain: 'switch', action: 'all_off' });
});
test('multi-word device not confused with group', () => {
  assert.deepEqual(m('turn off the night light'), { domain: 'switch', action: 'off', target: 'night light' });
});
test('status question', () => {
  assert.deepEqual(m('is the tubelight on?'), { domain: 'switch', action: 'status', target: 'tubelight' });
});
test('wake word is stripped', () => {
  assert.deepEqual(m('jarvis, turn off the tubelight'), { domain: 'switch', action: 'off', target: 'tubelight' });
});
test('gibberish is null', () => {
  assert.equal(m('make me a sandwich'), null);
});
test('"everything on" is null (no all_on)', () => {
  assert.equal(m('everything on'), null);
});
