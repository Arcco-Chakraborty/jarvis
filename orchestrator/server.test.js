import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from './server.js';

function stubEsp32(snapshot, online = true) {
  return { snapshot: () => snapshot, online };
}

async function withServer(esp32, fn) {
  const server = buildApp({ esp32 }).listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test('GET /health returns {ok:true}', async () => {
  await withServer(stubEsp32({}), async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test('GET /state returns the board snapshot and online flag', async () => {
  await withServer(stubEsp32({ tubelight: true, 'fan 1': false }, true), async (base) => {
    const res = await fetch(`${base}/state`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      smartswitch: { tubelight: true, 'fan 1': false },
      online: true,
    });
  });
});

test('POST /command returns the onCommand result as JSON', async () => {
  const onCommand = async (text) => ({
    ok: true,
    speak: `got: ${text}`,
    intent: { domain: 'switch', action: 'off', target: 'tubelight' },
  });
  const server = buildApp({ esp32: stubEsp32({}), onCommand }).listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'turn off the tubelight' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      speak: 'got: turn off the tubelight',
      intent: { domain: 'switch', action: 'off', target: 'tubelight' },
    });
  } finally {
    server.close();
  }
});

test('POST /command with missing text returns 400', async () => {
  const onCommand = async () => {
    throw new Error('onCommand should not be called for missing text');
  };
  const server = buildApp({ esp32: stubEsp32({}), onCommand }).listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { ok: false, speak: "Sorry, I didn't catch that.", intent: null });
  } finally {
    server.close();
  }
});

test('POST /switch returns the onSwitch result as JSON', async () => {
  const onSwitch = async (body) => ({
    ok: true,
    speak: `did: ${body.action} ${body.target}`,
    intent: { domain: 'switch', action: body.action, target: body.target },
  });
  const server = buildApp({ esp32: stubEsp32({}), onSwitch }).listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/switch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'tubelight', action: 'off' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      speak: 'did: off tubelight',
      intent: { domain: 'switch', action: 'off', target: 'tubelight' },
    });
  } finally {
    server.close();
  }
});

test('POST /switch with invalid action returns 400', async () => {
  const onSwitch = async () => {
    throw new Error('onSwitch should not be called for invalid action');
  };
  const server = buildApp({ esp32: stubEsp32({}), onSwitch }).listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/switch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'tubelight', action: 'explode' }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { ok: false, speak: 'Bad request.', intent: null });
  } finally {
    server.close();
  }
});
