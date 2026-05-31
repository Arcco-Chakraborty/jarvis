import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBrowser } from './browser.js';

function recorder() {
  const calls = [];
  const proc = { unref: () => {} };
  const spawn = (bin, args, opts) => { calls.push({ bin, args, opts }); return proc; };
  return { calls, spawn };
}

test('search() launches the default browser (google-chrome) with a URL-encoded google query', () => {
  const r = recorder();
  const b = makeBrowser({ spawn: r.spawn });
  const res = b.search({ query: 'RISC-V instruction set' });
  assert.equal(res.ok, true);
  assert.equal(r.calls[0].bin, 'google-chrome');
  assert.equal(r.calls[0].args[0], 'https://www.google.com/search?q=RISC-V%20instruction%20set');
  assert.match(res.speak, /searching the web for risc-v instruction set/i);
});

test('search() honours a custom browserCmd', () => {
  const r = recorder();
  const b = makeBrowser({ spawn: r.spawn, browserCmd: 'firefox' });
  b.search({ query: 'cats' });
  assert.equal(r.calls[0].bin, 'firefox');
});

test('search() refuses an empty query', () => {
  const b = makeBrowser({ spawn: () => ({ unref: () => {} }) });
  assert.equal(b.search({ query: '' }).ok, false);
  assert.equal(b.search({}).ok, false);
});

test('search() catches spawn errors', () => {
  const b = makeBrowser({ spawn: () => { throw new Error('ENOENT'); } });
  const r = b.search({ query: 'cats' });
  assert.equal(r.ok, false);
  assert.match(r.speak, /couldn'?t/i);
});
