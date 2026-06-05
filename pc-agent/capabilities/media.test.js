import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMedia } from './media.js';

function rec() {
  const calls = [];
  const proc = { unref: () => {} };
  return { calls, spawn: (bin, args, opts) => { calls.push({ bin, args, opts }); return proc; } };
}

test('media exposes the transport actions', () => {
  const m = makeMedia({ spawn: rec().spawn });
  assert.equal(m.name, 'media');
  for (const a of ['play_pause', 'next', 'prev', 'volume_up', 'volume_down', 'mute']) {
    assert.equal(typeof m.actions[a], 'function', a);
  }
});

test('each action sends its media virtual-key via powershell keybd_event', () => {
  const vks = { play_pause: '0xB3', next: '0xB0', prev: '0xB1', volume_up: '0xAF', volume_down: '0xAE', mute: '0xAD' };
  for (const [action, vk] of Object.entries(vks)) {
    const r = rec();
    const res = makeMedia({ spawn: r.spawn }).actions[action]();
    assert.equal(res.ok, true);
    assert.equal(r.calls[0].bin, 'powershell');
    const script = r.calls[0].args.join(' ');
    assert.match(script, /keybd_event/);
    assert.ok(script.includes(vk), `${action} should send ${vk}`);
  }
});

test('a spawn error is graceful', () => {
  const res = makeMedia({ spawn: () => { throw new Error('x'); } }).actions.play_pause();
  assert.equal(res.ok, false);
});

test('set_volume floors then steps up ~2%/step via powershell', () => {
  const r = rec();
  const res = makeMedia({ spawn: r.spawn }).actions.set_volume({ level: 30 });
  assert.equal(res.ok, true);
  assert.equal(r.calls[0].bin, 'powershell');
  const script = r.calls[0].args.join(' ');
  assert.match(script, /keybd_event/);
  assert.ok(script.includes('0xAE'), 'sends volume-down');
  assert.ok(script.includes('0xAF'), 'sends volume-up');
  assert.ok(script.includes('1..50'), 'floors to zero with 50 down-steps');
  assert.ok(script.includes('1..15'), 'steps up round(30/2)=15');
});

test('set_volume clamps out-of-range levels', () => {
  const r = rec();
  makeMedia({ spawn: r.spawn }).actions.set_volume({ level: 250 });
  const script = r.calls[0].args.join(' ');
  assert.ok(script.includes('1..50'), 'clamps to 100 -> 50 up-steps');
});

test('set_volume level 0 floors with no up-steps (avoids PowerShell 1..0 descending range)', () => {
  const r = rec();
  const res = makeMedia({ spawn: r.spawn }).actions.set_volume({ level: 0 });
  assert.equal(res.ok, true);
  const script = r.calls[0].args.join(' ');
  assert.ok(script.includes('1..50'), 'still floors with 50 down-steps');
  assert.ok(!script.includes('0xAF'), 'no volume-up steps at level 0');
  assert.ok(!/1\.\.0/.test(script), 'never emits the 1..0 descending range');
});
