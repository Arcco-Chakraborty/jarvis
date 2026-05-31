import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geminiClassify } from './gemini.js';

const VOCAB = { deviceNames: ['tubelight', 'socket'], groupNames: ['lights'], appNames: ['firefox', 'visual studio code'] };

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
  assert.match(prompt, /"lites"->"lights"/);
});

test('emits a pc open_app for a known app', async () => {
  const r = await geminiClassify('fire up the code editor', VOCAB, {
    apiKey: 'x',
    fetchFn: fakeFetch('{"domain":"pc","action":"open_app","target":"visual studio code"}'),
  });
  assert.deepEqual(r, { domain: 'pc', action: 'open_app', target: 'visual studio code' });
});

test('open_app with an unknown app -> null', async () => {
  const r = await geminiClassify('open photoshop', VOCAB, {
    apiKey: 'x',
    fetchFn: fakeFetch('{"domain":"pc","action":"open_app","target":"photoshop"}'),
  });
  assert.equal(r, null);
});

test('emits play_music with a query', async () => {
  const r = await geminiClassify('put on some daft punk', VOCAB, {
    apiKey: 'x',
    fetchFn: fakeFetch('{"domain":"pc","action":"media","op":"play_music","arg":"daft punk"}'),
  });
  assert.deepEqual(r, { domain: 'pc', action: 'media', op: 'play_music', arg: 'daft punk' });
});

test('emits a web search', async () => {
  const r = await geminiClassify('google the weather', VOCAB, {
    apiKey: 'x',
    fetchFn: fakeFetch('{"domain":"pc","action":"browser","op":"search","arg":"weather"}'),
  });
  assert.deepEqual(r, { domain: 'pc', action: 'browser', op: 'search', arg: 'weather' });
});

test('emits a proposed shell command (free-form)', async () => {
  const r = await geminiClassify('free up some disk space', VOCAB, {
    apiKey: 'x',
    fetchFn: fakeFetch('{"domain":"pc","action":"shell","command":"apt clean"}'),
  });
  assert.deepEqual(r, { domain: 'pc', action: 'shell', command: 'apt clean' });
});

test('emits an ask intent for a question', async () => {
  const r = await geminiClassify('how far away is the moon', VOCAB, {
    apiKey: 'x',
    fetchFn: fakeFetch('{"domain":"ask","query":"how far away is the moon"}'),
  });
  assert.deepEqual(r, { domain: 'ask', query: 'how far away is the moon' });
});

test('prompt lists app names and the action menu', async () => {
  let body;
  await geminiClassify('do something', VOCAB, {
    apiKey: 'x',
    fetchFn: async (url, opts) => { body = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"action":"none"}' }] } }] }) }; },
  });
  const prompt = body.contents[0].parts[0].text;
  assert.match(prompt, /visual studio code/);
  assert.match(prompt, /open_app/);
  assert.match(prompt, /play_music/);
  assert.match(prompt, /shell/);
});

test('rotates to the second key when the first one fails', async () => {
  let n = 0;
  const fetchFn = async () => {
    n++;
    if (n === 1) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"domain":"switch","action":"off","target":"tubelight"}' }] } }] }) };
  };
  const r = await geminiClassify('kill the light', VOCAB, { keys: ['k1', 'k2'], fetchFn });
  assert.deepEqual(r, { domain: 'switch', action: 'off', target: 'tubelight' });
  assert.equal(n, 2);
});
