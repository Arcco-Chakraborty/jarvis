import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeType } from './type.js';

function rec() {
  const calls = [];
  const proc = { unref: () => {} };
  return { calls, spawn: (bin, args, opts) => { calls.push({ bin, args, opts }); return proc; } };
}

test('send types text via SendKeys', () => {
  const r = rec();
  const res = makeType({ spawn: r.spawn }).actions.send({ text: 'hello world' });
  assert.equal(res.ok, true);
  const script = r.calls[0].args.join(' ');
  assert.match(script, /SendKeys/);
  assert.ok(script.includes('hello world'), 'includes the literal text');
});

test('send escapes SendKeys metacharacters', () => {
  const r = rec();
  makeType({ spawn: r.spawn }).actions.send({ text: 'a+b%c' });
  const script = r.calls[0].args.join(' ');
  assert.ok(script.includes('{+}') && script.includes('{%}'), 'escapes + and %');
});

test('send rejects empty text', () => {
  assert.equal(makeType({ spawn: rec().spawn }).actions.send({ text: '' }).ok, false);
});
