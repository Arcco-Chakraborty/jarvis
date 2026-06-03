import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePcAgentClient } from './pc-agent-client.js';

test('run posts to <baseUrl>/run with bearer + body and returns the detail', async () => {
  let seen;
  const fetchFn = async (url, opts) => { seen = { url, opts }; return { ok: true, json: async () => ({ ok: true, detail: 'Opening steam.' }) }; };
  const c = makePcAgentClient({ fetchFn, token: 'secret' });
  const r = await c.run('http://x:7000', { capability: 'apps', action: 'open', params: { name: 'steam' } });
  assert.deepEqual(r, { ok: true, detail: 'Opening steam.' });
  assert.equal(seen.url, 'http://x:7000/run');
  assert.equal(seen.opts.headers.authorization, 'Bearer secret');
  assert.deepEqual(JSON.parse(seen.opts.body), { capability: 'apps', action: 'open', params: { name: 'steam' } });
});

test('non-ok HTTP -> unreachable', async () => {
  const c = makePcAgentClient({ fetchFn: async () => ({ ok: false, status: 500 }), token: 't' });
  assert.deepEqual(await c.run('http://x', {}), { ok: false, detail: 'unreachable' });
});

test('a thrown fetch -> unreachable', async () => {
  const c = makePcAgentClient({ fetchFn: async () => { throw new Error('ECONNREFUSED'); }, token: 't' });
  assert.deepEqual(await c.run('http://x', {}), { ok: false, detail: 'unreachable' });
});
