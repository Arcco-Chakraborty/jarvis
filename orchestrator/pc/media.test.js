import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMedia } from './media.js';

function recorder() {
  const calls = [];
  const proc = { unref: () => calls.push('unref') };
  const spawn = (bin, args, opts) => { calls.push({ bin, args, opts }); return proc; };
  return { calls, spawn };
}

test('play/pause toggles via playerctl', () => {
  const r = recorder();
  const m = makeMedia({ spawn: r.spawn });
  const res = m.playPause();
  assert.equal(res.ok, true);
  assert.deepEqual(r.calls[0], { bin: 'playerctl', args: ['play-pause'], opts: { detached: true, stdio: 'ignore' } });
});

test('next + previous via playerctl', () => {
  const r = recorder();
  const m = makeMedia({ spawn: r.spawn });
  m.next();
  m.prev();
  assert.equal(r.calls[0].args[0], 'next');
  assert.equal(r.calls[2].args[0], 'previous');
});

test('volume up/down via pactl with ±5%', () => {
  const r = recorder();
  const m = makeMedia({ spawn: r.spawn });
  m.volumeUp();
  m.volumeDown();
  assert.deepEqual(r.calls[0].args, ['set-sink-volume', '@DEFAULT_SINK@', '+5%']);
  assert.deepEqual(r.calls[2].args, ['set-sink-volume', '@DEFAULT_SINK@', '-5%']);
});

test('mute toggles via pactl', () => {
  const r = recorder();
  const m = makeMedia({ spawn: r.spawn });
  m.mute();
  assert.deepEqual(r.calls[0].args, ['set-sink-mute', '@DEFAULT_SINK@', 'toggle']);
});

test('setVolume clamps to 0..100 and sends a percentage', () => {
  const r = recorder();
  const m = makeMedia({ spawn: r.spawn });
  m.setVolume(50);
  assert.deepEqual(r.calls[0].args, ['set-sink-volume', '@DEFAULT_SINK@', '50%']);
  m.setVolume(150);
  assert.equal(r.calls[2].args[2], '100%');
  m.setVolume(-10);
  assert.equal(r.calls[4].args[2], '0%');
});

test('catches spawn errors and reports ok:false', () => {
  const m = makeMedia({ spawn: () => { throw new Error('ENOENT'); } });
  const res = m.playPause();
  assert.equal(res.ok, false);
  assert.match(res.speak, /couldn'?t/i);
});

