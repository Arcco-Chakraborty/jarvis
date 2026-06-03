import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAgent } from './server.js';

function call(agent, { method = 'POST', url = '/run', auth, body } = {}) {
  const chunks = body == null ? [] : [Buffer.from(body)];
  const req = {
    method, url,
    headers: auth ? { authorization: auth } : {},
    on(ev, cb) { if (ev === 'data') chunks.forEach(cb); if (ev === 'end') cb(); return req; },
  };
  let status = 0; let payload = '';
  const res = { writeHead(s) { status = s; }, end(p) { payload = p || ''; } };
  return agent(req, res).then(() => ({ status, json: payload ? JSON.parse(payload) : null }));
}

const apps = { name: 'apps', actions: { open: ({ name }) => ({ ok: true, detail: `Opening ${name}.` }) } };

test('GET /health lists capabilities', async () => {
  const agent = makeAgent({ capabilities: [apps], token: 't' });
  const { status, json } = await call(agent, { method: 'GET', url: '/health' });
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, capabilities: ['apps'] });
});

test('POST /run with a valid token dispatches to the capability action', async () => {
  const agent = makeAgent({ capabilities: [apps], token: 't' });
  const { status, json } = await call(agent, { auth: 'Bearer t', body: JSON.stringify({ capability: 'apps', action: 'open', params: { name: 'steam' } }) });
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, detail: 'Opening steam.' });
});

test('POST /run without a valid token is 401', async () => {
  const agent = makeAgent({ capabilities: [apps], token: 't' });
  assert.equal((await call(agent, { auth: 'Bearer wrong', body: '{}' })).status, 401);
  assert.equal((await call(agent, { body: '{}' })).status, 401);
});

test('unknown capability/action -> ok:false', async () => {
  const agent = makeAgent({ capabilities: [apps], token: 't' });
  const { json } = await call(agent, { auth: 'Bearer t', body: JSON.stringify({ capability: 'nope', action: 'x' }) });
  assert.equal(json.ok, false);
});

test('a throwing action -> 500 ok:false (never crashes)', async () => {
  const boom = { name: 'boom', actions: { go: () => { throw new Error('x'); } } };
  const agent = makeAgent({ capabilities: [boom], token: 't' });
  const { status, json } = await call(agent, { auth: 'Bearer t', body: JSON.stringify({ capability: 'boom', action: 'go' }) });
  assert.equal(status, 500);
  assert.equal(json.ok, false);
});
