import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMusic } from './music.js';

function harness({ exists = () => true } = {}) {
  const calls = { spawn: [], writes: [] };
  const proc = { unref: () => {}, kill: () => calls.spawn.push('kill') };
  const spawn = (bin, args, opts) => { calls.spawn.push({ bin, args, opts }); return proc; };
  const sock = { on: () => {}, write: (d) => calls.writes.push(d), end: () => {} };
  const connect = () => sock;
  const m = makeMusic({ spawn, connect, exists, socket: '/tmp/test-mpv.sock' });
  return { m, calls };
}

test('play spawns mpv with a ytsearch1 url and the ipc socket', () => {
  const { m, calls } = harness();
  const res = m.play({ query: 'daft punk' });
  assert.equal(res.ok, true);
  const c = calls.spawn.find((x) => x.bin === 'mpv');
  assert.ok(c, 'mpv spawned');
  assert.ok(c.args.includes('--input-ipc-server=/tmp/test-mpv.sock'));
  assert.ok(c.args.includes('ytdl://ytsearch1:daft punk'));
  assert.match(res.speak, /playing daft punk/i);
});

test('play refuses an empty query', () => {
  const { m } = harness();
  assert.equal(m.play({ query: '   ' }).ok, false);
  assert.equal(m.play({}).ok, false);
});

test('pauseResume writes a cycle-pause command to the socket', () => {
  const { m, calls } = harness();
  const res = m.pauseResume();
  assert.equal(res.ok, true);
  assert.equal(calls.writes[0].trim(), JSON.stringify({ command: ['cycle', 'pause'] }));
});

test('stop writes a quit command', () => {
  const { m, calls } = harness();
  const res = m.stop();
  assert.equal(res.ok, true);
  assert.equal(calls.writes[0].trim(), JSON.stringify({ command: ['quit'] }));
});

test('control fails soft when nothing is playing (no socket)', () => {
  const { m } = harness({ exists: () => false });
  const r = m.pauseResume();
  assert.equal(r.ok, false);
  assert.match(r.speak, /nothing is playing/i);
  assert.equal(m.stop().ok, false);
});

test('play catches spawn errors', () => {
  const m = makeMusic({ spawn: () => { throw new Error('ENOENT'); }, connect: () => ({}), exists: () => true });
  const r = m.play({ query: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.speak, /couldn'?t/i);
});
