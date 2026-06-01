import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeVisionAnswer } from './vision-answer.js';

function fakeFetch(text, { ok = true, status = 200 } = {}) {
  return async () => ({ ok, status, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) });
}

test('describe sends a multimodal body and returns the answer', async () => {
  let body;
  const fetchFn = async (url, opts) => { body = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: "It's a resistor, sir." }] } }] }) }; };
  const va = makeVisionAnswer({ keys: ['k1'], fetchFn });
  const r = await va.describe('what is this', 'BASE64DATA', 'image/jpeg');
  assert.equal(r.ok, true);
  assert.equal(r.speak, "It's a resistor, sir.");
  const parts = body.contents[0].parts;
  assert.equal(parts[0].text, 'what is this');
  assert.deepEqual(parts[1].inlineData, { mimeType: 'image/jpeg', data: 'BASE64DATA' });
  assert.match(body.systemInstruction.parts[0].text, /JARVIS/);
});

test('failure -> graceful in-character fallback, ok:true', async () => {
  const va = makeVisionAnswer({ keys: ['k1'], fetchFn: fakeFetch('x', { ok: false, status: 500 }) });
  const r = await va.describe('q', 'D', 'image/jpeg');
  assert.equal(r.ok, true);
  assert.match(r.speak, /apolog|can't|cannot|trouble/i);
});

test('no keys -> offline line, fetch not called', async () => {
  let called = false;
  const va = makeVisionAnswer({ keys: [], fetchFn: async () => { called = true; return {}; } });
  const r = await va.describe('q', 'D', 'image/jpeg');
  assert.equal(r.ok, true);
  assert.match(r.speak, /offline|can't see|cannot/i);
  assert.equal(called, false);
});
