import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeOpenApp } from './apps.js';

const ALLOWLIST = {
  chrome: 'google-chrome',
  'vs code': 'code --new-window',
  firefox: 'firefox',
};

test('openApp spawns the allow-listed binary detached + unrefs it', () => {
  const calls = [];
  const fakeProc = { unref: () => calls.push('unref') };
  const spawnFn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    return fakeProc;
  };
  const openApp = makeOpenApp({ allowlist: ALLOWLIST, spawn: spawnFn });
  const r = openApp({ name: 'chrome' });
  assert.equal(r.ok, true);
  assert.match(r.speak, /opening chrome/i);
  assert.deepEqual(calls[0], { bin: 'google-chrome', args: [], opts: { detached: true, stdio: 'ignore' } });
  assert.equal(calls[1], 'unref');
});

test('openApp splits multi-word commands into bin + args', () => {
  let captured = null;
  const openApp = makeOpenApp({
    allowlist: ALLOWLIST,
    spawn: (bin, args) => { captured = { bin, args }; return { unref: () => {} }; },
  });
  const r = openApp({ name: 'vs code' });
  assert.equal(r.ok, true);
  assert.equal(captured.bin, 'code');
  assert.deepEqual(captured.args, ['--new-window']);
});

test('openApp normalizes the lookup (lowercase + trim)', () => {
  let bin = null;
  const openApp = makeOpenApp({
    allowlist: ALLOWLIST,
    spawn: (b) => { bin = b; return { unref: () => {} }; },
  });
  const r = openApp({ name: '  CHROME ' });
  assert.equal(r.ok, true);
  assert.equal(bin, 'google-chrome');
});

test('openApp returns ok:false with a friendly speak when the name is not allow-listed', () => {
  let spawned = false;
  const openApp = makeOpenApp({
    allowlist: ALLOWLIST,
    spawn: () => { spawned = true; return { unref: () => {} }; },
  });
  const r = openApp({ name: 'nethack' });
  assert.equal(r.ok, false);
  assert.match(r.speak, /don'?t know how to open nethack/i);
  assert.equal(spawned, false);
});

test('openApp catches spawn errors and returns ok:false', () => {
  const openApp = makeOpenApp({
    allowlist: ALLOWLIST,
    spawn: () => { throw new Error('ENOENT'); },
  });
  const r = openApp({ name: 'chrome' });
  assert.equal(r.ok, false);
  assert.match(r.speak, /couldn'?t open chrome/i);
});

test('openApp tolerates missing name', () => {
  const openApp = makeOpenApp({ allowlist: ALLOWLIST, spawn: () => ({ unref: () => {} }) });
  const r = openApp({});
  assert.equal(r.ok, false);
  assert.match(r.speak, /don'?t know how to open/i);
});
