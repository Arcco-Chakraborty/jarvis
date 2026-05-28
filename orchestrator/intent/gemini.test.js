import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geminiClassify } from './gemini.js';

const VOCAB = { deviceNames: ['tubelight', 'socket'], groupNames: ['lights'] };

function fakeFetch(text, { ok = true, status = 200 } = {}) {
  return async () => ({
    ok,
    status,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
  });
}

test('valid JSON -> validated intent', async () => {
  const r = await geminiClassify('kill the big light', VOCAB, {
    apiKey: 'x',
    fetchFn: fakeFetch('{"domain":"switch","action":"off","target":"tubelight"}'),
  });
  assert.deepEqual(r, { domain: 'switch', action: 'off', target: 'tubelight' });
});

test('all_off drops any target', async () => {
  const r = await geminiClassify('shut everything', VOCAB, {
    apiKey: 'x',
    fetchFn: fakeFetch('{"action":"all_off","target":"lights"}'),
  });
  assert.deepEqual(r, { domain: 'switch', action: 'all_off' });
});

test('action "none" -> null', async () => {
  const r = await geminiClassify('hello', VOCAB, {
    apiKey: 'x',
    fetchFn: fakeFetch('{"action":"none"}'),
  });
  assert.equal(r, null);
});

test('hallucinated target -> null', async () => {
  const r = await geminiClassify('x', VOCAB, {
    apiKey: 'x',
    fetchFn: fakeFetch('{"domain":"switch","action":"on","target":"chandelier"}'),
  });
  assert.equal(r, null);
});

test('status on a group -> null (status is device-only)', async () => {
  const r = await geminiClassify('x', VOCAB, {
    apiKey: 'x',
    fetchFn: fakeFetch('{"domain":"switch","action":"status","target":"lights"}'),
  });
  assert.equal(r, null);
});

test('keep_only allows a device or group target', async () => {
  const r = await geminiClassify('keep the big light on and rest off', VOCAB, {
    apiKey: 'x',
    fetchFn: fakeFetch('{"domain":"switch","action":"keep_only","target":"tubelight"}'),
  });
  assert.deepEqual(r, { domain: 'switch', action: 'keep_only', target: 'tubelight' });
});

test('non-200 -> null', async () => {
  const r = await geminiClassify('x', VOCAB, {
    apiKey: 'x',
    fetchFn: fakeFetch('{"action":"off","target":"socket"}', { ok: false, status: 503 }),
  });
  assert.equal(r, null);
});

test('non-JSON text -> null', async () => {
  const r = await geminiClassify('x', VOCAB, {
    apiKey: 'x',
    fetchFn: fakeFetch('sorry, I cannot'),
  });
  assert.equal(r, null);
});

test('fetch throws -> null', async () => {
  const r = await geminiClassify('x', VOCAB, {
    apiKey: 'x',
    fetchFn: async () => {
      throw new Error('network down');
    },
  });
  assert.equal(r, null);
});

test('no apiKey -> null and fetch not called', async () => {
  let called = false;
  const r = await geminiClassify('x', VOCAB, {
    apiKey: '',
    fetchFn: async () => {
      called = true;
      return {};
    },
  });
  assert.equal(r, null);
  assert.equal(called, false);
});

test('prompt asks Gemini to recover obvious STT slips', async () => {
  let body;
  await geminiClassify('switch off the lites', VOCAB, {
    apiKey: 'x',
    fetchFn: async (url, opts) => {
      body = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: '{"action":"none"}' }] } }] }),
      };
    },
  });
  const prompt = body.contents[0].parts[0].text;
  assert.match(prompt, /spelling mistakes/);
  assert.match(prompt, /"lites" means "lights"/);
});
