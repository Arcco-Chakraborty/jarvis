import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeShell } from './shell.js';

function rec() {
  const calls = [];
  const proc = { unref: () => {} };
  return { calls, spawn: (bin, args, opts) => { calls.push({ bin, args, opts }); return proc; } };
}

test('shell exposes a run action', () => {
  const s = makeShell({ spawn: rec().spawn });
  assert.equal(s.name, 'shell');
  assert.equal(typeof s.actions.run, 'function');
});

test('run executes the command via powershell -Command', () => {
  const r = rec();
  const res = makeShell({ spawn: r.spawn }).actions.run({ command: 'dir' });
  assert.equal(res.ok, true);
  assert.equal(res.detail, 'Done.');
  assert.equal(r.calls[0].bin, 'powershell');
  assert.deepEqual(r.calls[0].args, ['-NoProfile', '-Command', 'dir']);
});

test('run refuses an empty command', () => {
  assert.equal(makeShell({ spawn: rec().spawn }).actions.run({ command: '' }).ok, false);
});

test('a spawn error is graceful', () => {
  const res = makeShell({ spawn: () => { throw new Error('x'); } }).actions.run({ command: 'dir' });
  assert.equal(res.ok, false);
  assert.match(res.detail, /couldn'?t/i);
});

test('run with no params is refused', () => {
  assert.equal(makeShell({ spawn: rec().spawn }).actions.run({}).ok, false);
});
