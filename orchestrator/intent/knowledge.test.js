import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeKnowledge } from './knowledge.js';

function fakeFetch(text, { ok = true, status = 200 } = {}) {
  return async () => ({ ok, status, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) });
}

test('answer returns the spoken text, ok:true', async () => {
  const k = makeKnowledge({ apiKey: 'x', fetchFn: fakeFetch('The Webb telescope observes in infrared.') });
  const r = await k.answer('the webb telescope');
  assert.equal(r.ok, true);
  assert.equal(r.speak, 'The Webb telescope observes in infrared.');
});

test('prompt carries the JARVIS persona + the query', async () => {
  let body;
  const k = makeKnowledge({ apiKey: 'x', fetchFn: async (url, opts) => { body = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) }; } });
  await k.answer('black holes');
  const sys = body.systemInstruction.parts[0].text;
  assert.match(sys, /JARVIS/);
  assert.match(sys, /sir/i);
  assert.equal(body.contents[0].parts[0].text, 'black holes');
});

test('no apiKey -> graceful in-character line, ok:true, fetch not called', async () => {
  let called = false;
  const k = makeKnowledge({ apiKey: '', fetchFn: async () => { called = true; return {}; } });
  const r = await k.answer('x');
  assert.equal(r.ok, true);
  assert.match(r.speak, /knowledge base/i);
  assert.equal(called, false);
});

test('HTTP error / non-JSON / throw -> graceful fallback, ok:true', async () => {
  for (const ff of [
    fakeFetch('x', { ok: false, status: 500 }),
    async () => ({ ok: true, status: 200, json: async () => ({}) }),
    async () => { throw new Error('down'); },
  ]) {
    const r = await makeKnowledge({ apiKey: 'x', fetchFn: ff }).answer('q');
    assert.equal(r.ok, true);
    assert.match(r.speak, /apolog|knowledge base/i);
  }
});

test('rotates to the second key when the first throws', async () => {
  let n = 0;
  const fetchFn = async () => {
    n++;
    if (n === 1) throw new Error('rate limited');
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Mars is the fourth planet.' }] } }] }) };
  };
  const r = await makeKnowledge({ keys: ['k1', 'k2'], fetchFn }).answer('mars');
  assert.equal(r.ok, true);
  assert.equal(r.speak, 'Mars is the fourth planet.');
  assert.equal(n, 2);
});
