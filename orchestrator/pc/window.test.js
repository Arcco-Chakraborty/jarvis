import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWindow } from './window.js';

function recorder() {
  const calls = [];
  const proc = { unref: () => {} };
  const spawn = (bin, args, opts) => { calls.push({ bin, args, opts }); return proc; };
  return { calls, spawn };
}

test('focus uses wmctrl -a with the substring match', () => {
  const r = recorder();
  const w = makeWindow({ spawn: r.spawn });
  const res = w.focus({ name: 'chrome' });
  assert.equal(res.ok, true);
  assert.deepEqual(r.calls[0], { bin: 'wmctrl', args: ['-a', 'chrome'], opts: { detached: true, stdio: 'ignore' } });
  assert.match(res.speak, /focusing chrome/i);
});

test('focus refuses an empty name', () => {
  const w = makeWindow({ spawn: () => ({ unref: () => {} }) });
  assert.equal(w.focus({}).ok, false);
  assert.equal(w.focus({ name: '' }).ok, false);
});

test('snap left/right sends super+Left/Right via xdotool', () => {
  const r = recorder();
  const w = makeWindow({ spawn: r.spawn });
  w.snap({ dir: 'left' });
  w.snap({ dir: 'right' });
  assert.deepEqual(r.calls[0], { bin: 'xdotool', args: ['key', 'super+Left'],  opts: { detached: true, stdio: 'ignore' } });
  assert.deepEqual(r.calls[1], { bin: 'xdotool', args: ['key', 'super+Right'], opts: { detached: true, stdio: 'ignore' } });
});

test('snap with an unknown direction is ok:false', () => {
  const w = makeWindow({ spawn: () => ({ unref: () => {} }) });
  assert.equal(w.snap({ dir: 'sideways' }).ok, false);
});

test('minimize / close use xdotool on the active window', () => {
  const r = recorder();
  const w = makeWindow({ spawn: r.spawn });
  w.minimize();
  w.close();
  assert.deepEqual(r.calls[0].args, ['getactivewindow', 'windowminimize']);
  assert.deepEqual(r.calls[1].args, ['getactivewindow', 'windowkill']);
});

test('catches spawn errors and reports ok:false', () => {
  const w = makeWindow({ spawn: () => { throw new Error('ENOENT'); } });
  const r = w.minimize();
  assert.equal(r.ok, false);
  assert.match(r.speak, /couldn'?t/i);
});
