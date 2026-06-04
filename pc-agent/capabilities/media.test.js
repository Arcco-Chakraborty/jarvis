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
