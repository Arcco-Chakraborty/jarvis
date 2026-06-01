import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextKey, callGemini } from './gemini-client.js';

test('nextKey hands out keys round-robin', () => {
  const keys = ['a', 'b', 'c'];
  const seq = [nextKey(keys), nextKey(keys), nextKey(keys)];
  const i0 = keys.indexOf(seq[0]);
  assert.deepEqual(seq, [keys[i0 % 3], keys[(i0 + 1) % 3], keys[(i0 + 2) % 3]]); // consecutive, wrapping
});

function jsonResp(obj, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => obj };
}

test('callGemini returns data on the first OK response', async () => {
  let n = 0;
  const data = await callGemini({
    model: 'm', body: {}, keys: ['k1', 'k2'],
    fetchFn: async () => { n++; return jsonResp({ hello: 'world' }); },
  });
  assert.deepEqual(data, { hello: 'world' });
  assert.equal(n, 1);
});

test('callGemini rotates to the next key on a non-OK response', async () => {
  let n = 0;
  const data = await callGemini({
    model: 'm', body: {}, keys: ['k1', 'k2'],
    fetchFn: async () => { n++; return n === 1 ? jsonResp({}, { ok: false, status: 503 }) : jsonResp({ ok: 1 }); },
  });
  assert.deepEqual(data, { ok: 1 });
  assert.equal(n, 2); // first key failed, second succeeded
});

test('callGemini rotates on a thrown error', async () => {
  let n = 0;
  const data = await callGemini({
    model: 'm', body: {}, keys: ['k1', 'k2'],
    fetchFn: async () => { n++; if (n === 1) throw new Error('network'); return jsonResp({ done: true }); },
  });
  assert.deepEqual(data, { done: true });
  assert.equal(n, 2);
});

test('callGemini returns null when all keys fail', async () => {
  let n = 0;
  const data = await callGemini({
    model: 'm', body: {}, keys: ['k1', 'k2'],
    fetchFn: async () => { n++; return jsonResp({}, { ok: false, status: 500 }); },
  });
  assert.equal(data, null);
  assert.equal(n, 2); // tried both keys, no more
});

test('callGemini returns null with no keys and does not fetch', async () => {
  let called = false;
  const data = await callGemini({ model: 'm', body: {}, keys: [], fetchFn: async () => { called = true; return jsonResp({}); } });
  assert.equal(data, null);
  assert.equal(called, false);
});

test('callGemini builds the correct URL and appends the key', async () => {
  let url;
  await callGemini({ model: 'gemini-2.5-flash', body: {}, keys: ['mykey'], fetchFn: async (u) => { url = u; return jsonResp({}); } });
  assert.ok(url.includes('/v1beta/models/gemini-2.5-flash:generateContent'), url);
  assert.ok(url.includes('key=mykey'), url);
});
