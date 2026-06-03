import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApps } from './apps.js';

function rec() {
  const calls = [];
  const proc = { unref: () => {} };
  return { calls, spawn: (bin, args, opts) => { calls.push({ bin, args, opts }); return proc; } };
}

test('apps capability exposes name + open action', () => {
  const a = makeApps({ spawn: rec().spawn });
  assert.equal(a.name, 'apps');
  assert.equal(typeof a.actions.open, 'function');
});

test('open launches via Windows start and resolves the name', () => {
  const r = rec();
  const res = makeApps({ spawn: r.spawn }).actions.open({ name: 'steam' });
  assert.equal(res.ok, true);
  assert.match(res.detail, /opening steam/i);
  assert.deepEqual(r.calls[0].args, ['/c', 'start', '', 'steam']);
  assert.equal(r.calls[0].bin, 'cmd');
});

test('open refuses an empty name', () => {
  const res = makeApps({ spawn: rec().spawn }).actions.open({ name: '' });
  assert.equal(res.ok, false);
});

test('open catches spawn errors', () => {
  const res = makeApps({ spawn: () => { throw new Error('nope'); } }).actions.open({ name: 'x' });
  assert.equal(res.ok, false);
  assert.match(res.detail, /couldn'?t/i);
});
