import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchSwitchCommand, levenshtein } from './rules.js';

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
test('keep one device on and rest off', () => {
  assert.deepEqual(m('keep tubelight on rest off'), {
    domain: 'switch', action: 'keep_only', target: 'tubelight',
  });
});
test('target on rest off shorthand', () => {
  assert.deepEqual(m('tubelight on rest off'), {
    domain: 'switch', action: 'keep_only', target: 'tubelight',
  });
});
test('keep one group on and everything else off', () => {
  assert.deepEqual(m('keep only lights on and everything else off'), {
    domain: 'switch', action: 'keep_only', target: 'lights',
  });
});
test('"all lights off" is the group, not all_off', () => {
  assert.deepEqual(m('all lights off'), { domain: 'switch', action: 'off', target: 'lights' });
});
test('turn off all lights except a device -> all_off_except scoped to the group', () => {
  assert.deepEqual(m('turn off all lights except tubelight'), {
    domain: 'switch', action: 'all_off_except', target: 'tubelight', scope: 'lights',
  });
});
test('turn off all lights except "the" device', () => {
  assert.deepEqual(m('turn off all lights except the spotlight'), {
    domain: 'switch', action: 'all_off_except', target: 'spotlight', scope: 'lights',
  });
});
test('turn off everything except a device -> global all_off_except (no scope)', () => {
  assert.deepEqual(m('turn off everything except the tubelight'), {
    domain: 'switch', action: 'all_off_except', target: 'tubelight',
  });
});
test('all fans off except a fan -> scoped to fans', () => {
  assert.deepEqual(m('turn off all fans except fan 1'), {
    domain: 'switch', action: 'all_off_except', target: 'fan 1', scope: 'fans',
  });
});
test('"keep only X on" (no "rest off") -> keep_only', () => {
  assert.deepEqual(m('keep only the tubelight on'), {
    domain: 'switch', action: 'keep_only', target: 'tubelight',
  });
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

test('levenshtein computes edit distance', () => {
  assert.equal(levenshtein('tublight', 'tubelight'), 1);
  assert.equal(levenshtein('soket', 'socket'), 1);
  assert.equal(levenshtein('spotligt', 'spotlight'), 1);
  assert.equal(levenshtein('lites', 'lights'), 3);
  assert.equal(levenshtein('', 'abc'), 3);
});

test('fuzzy: small device typo with "turn of" -> off', () => {
  assert.deepEqual(m('turn of the tublight'), { domain: 'switch', action: 'off', target: 'tubelight' });
});
test('fuzzy: soket -> socket', () => {
  assert.deepEqual(m('soket on'), { domain: 'switch', action: 'on', target: 'socket' });
});
test('fuzzy: spotligt -> spotlight', () => {
  assert.deepEqual(m('spotligt off'), { domain: 'switch', action: 'off', target: 'spotlight' });
});
test('synonym: kill the lights -> group off', () => {
  assert.deepEqual(m('kill the lights'), { domain: 'switch', action: 'off', target: 'lights' });
});
test('rules miss (beyond threshold) -> null: lites off', () => {
  assert.equal(m('lites off'), null);
});
test('rules miss -> null: toob light on (groups are exact-only)', () => {
  assert.equal(m('toob light on'), null);
});
test('rules miss -> null: ambiguous "turn on fan"', () => {
  assert.equal(m('turn on fan'), null);
});
