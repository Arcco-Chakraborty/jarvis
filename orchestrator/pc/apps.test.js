import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeOpenApp, buildAppCatalog } from './apps.js';

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
  const openApp = makeOpenApp({
    allowlist: ALLOWLIST,
    spawn: () => { throw new Error('ENOENT'); },
  });
  const r = openApp({ name: 'nethack' });
  assert.equal(r.ok, false);
  assert.match(r.speak, /don'?t know how to open nethack/i);
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

test('buildAppCatalog merges discovered apps + aliases (aliases point to canonical entries)', async () => {
  const discover = async () => ({ 'google chrome': 'google-chrome', 'firefox': 'firefox' });
  const aliases  = { 'chrome': 'google chrome', 'browser': 'google chrome', 'editor': 'code-missing' };
  const cat = await buildAppCatalog({ discover, aliases });
  assert.equal(cat['google chrome'], 'google-chrome');     // discovered as-is
  assert.equal(cat['firefox'], 'firefox');                 // discovered as-is
  assert.equal(cat['chrome'], 'google-chrome');            // alias resolved
  assert.equal(cat['browser'], 'google-chrome');           // alias resolved
  assert.equal(cat['editor'], undefined);                  // alias target missing -> dropped
});

test('openApp falls back to PATH for single-token unknown names', () => {
  const calls = [];
  const proc = { unref: () => {} };
  const spawn = (bin, args, opts) => { calls.push({ bin, args, opts }); return proc; };
  const openApp = makeOpenApp({ allowlist: { chrome: 'google-chrome' }, spawn });
  const r = openApp({ name: 'htop' });
  assert.equal(r.ok, true);
  assert.equal(calls[0].bin, 'htop');
  assert.deepEqual(calls[0].args, []);
});

test('openApp does NOT PATH-fall-back for multi-word names (would be ambiguous)', () => {
  const openApp = makeOpenApp({
    allowlist: { chrome: 'google-chrome' },
    spawn: () => { throw new Error('should not spawn'); },
  });
  const r = openApp({ name: 'random app' });
  assert.equal(r.ok, false);
  assert.match(r.speak, /don'?t know/i);
});

test('openApp reports PATH-fallback spawn errors as ok:false', () => {
  const openApp = makeOpenApp({
    allowlist: {},
    spawn: () => { throw new Error('ENOENT'); },
  });
  const r = openApp({ name: 'noprogram' });
  assert.equal(r.ok, false);
  assert.match(r.speak, /don'?t know/i);
});
