import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMusic } from './music.js';

function rec() {
  const calls = [];
  const proc = { unref: () => {} };
  const spawn = (bin, args) => { calls.push({ bin, args }); return proc; };
  return { calls, spawn };
}

test('play resolves the top result and opens the YouTube watch page in the browser', async () => {
  const r = rec();
  const m = makeMusic({ spawn: r.spawn, resolve: async () => 'abc123', browserCmd: 'google-chrome' });
  const res = await m.play({ query: 'daft punk one more time' });
  assert.equal(res.ok, true);
  assert.equal(r.calls[0].bin, 'google-chrome');
  assert.equal(r.calls[0].args[0], 'https://www.youtube.com/watch?v=abc123');
  assert.match(res.speak, /playing daft punk one more time/i);
});

test('play falls back to a YouTube search page when resolve yields nothing', async () => {
  const r = rec();
  const m = makeMusic({ spawn: r.spawn, resolve: async () => null, browserCmd: 'google-chrome' });
  const res = await m.play({ query: 'obscure thing' });
  assert.equal(res.ok, true);
  assert.equal(r.calls[0].args[0], 'https://www.youtube.com/results?search_query=obscure%20thing');
});

test('play refuses an empty query (and does not resolve)', async () => {
  let resolved = false;
  const m = makeMusic({ spawn: rec().spawn, resolve: async () => { resolved = true; return 'x'; } });
  assert.equal((await m.play({ query: '  ' })).ok, false);
  assert.equal(resolved, false);
});

test('pause/stop drive playerctl when available', () => {
  const r = rec();
  const m = makeMusic({ spawn: r.spawn, hasPlayerctl: true });
  assert.equal(m.pauseResume().ok, true);
  assert.deepEqual(r.calls[0], { bin: 'playerctl', args: ['play-pause'] });
  assert.equal(m.stop().ok, true);
  assert.deepEqual(r.calls[1], { bin: 'playerctl', args: ['stop'] });
});

test('pause/stop degrade gracefully without playerctl', () => {
  const m = makeMusic({ spawn: rec().spawn, hasPlayerctl: false });
  const r = m.pauseResume();
  assert.equal(r.ok, false);
  assert.match(r.speak, /playerctl/i);
  assert.equal(m.stop().ok, false);
});
