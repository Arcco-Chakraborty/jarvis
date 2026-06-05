import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBrowser } from './browser.js';

function rec() {
  const calls = [];
  const proc = { unref: () => {} };
  return { calls, spawn: (bin, args, opts) => { calls.push({ bin, args, opts }); return proc; } };
}

test('open normalizes a bare domain to https and Start-Process es it', () => {
  const r = rec();
  const res = makeBrowser({ spawn: r.spawn }).actions.open({ url: 'youtube.com' });
  assert.equal(res.ok, true);
  const script = r.calls[0].args.join(' ');
  assert.match(script, /Start-Process/);
  assert.ok(script.includes('https://youtube.com'), 'adds scheme');
});

test('open keeps an explicit scheme', () => {
  const r = rec();
  makeBrowser({ spawn: r.spawn }).actions.open({ url: 'http://example.com/x' });
  assert.ok(r.calls[0].args.join(' ').includes('http://example.com/x'));
});

test('open rejects empty url', () => {
  const res = makeBrowser({ spawn: rec().spawn }).actions.open({ url: '' });
  assert.equal(res.ok, false);
});
