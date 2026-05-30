import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from './server.js';
import { createTelemetry } from './telemetry.js';

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

test('GET / serves the dashboard HTML', async () => {
  const server = buildApp({ esp32: stubEsp32({}) }).listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /JARVIS/);
  } finally {
    server.close();
  }
});

test('POST /voice/event records into telemetry; GET /voice reflects it', async () => {
  const telemetry = createTelemetry();
  const server = buildApp({ esp32: stubEsp32({}), telemetry }).listen(0);
  try {
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = await fetch(`${base}/voice/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'transcript', text: 'lights on' }),
    });
    assert.equal(post.status, 200);
    assert.deepEqual(await post.json(), { ok: true });
    const snap = await (await fetch(`${base}/voice`)).json();
    assert.equal(snap.status, 'transcribing');
    assert.equal(snap.lastTranscript, 'lights on');
  } finally {
    server.close();
  }
});

test('GET /log returns recent commands from telemetry', async () => {
  const telemetry = createTelemetry();
  telemetry.recordCommand({ text: 'soket on', intent: { domain: 'switch', action: 'on', target: 'socket' }, via: 'gemini', ok: true, speak: 'Socket is on.' });
  const server = buildApp({ esp32: stubEsp32({}), telemetry }).listen(0);
  try {
    await new Promise((r) => server.once('listening', r));
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/log`)).json();
    assert.equal(body.commands.length, 1);
    assert.equal(body.commands[0].via, 'gemini');
  } finally {
    server.close();
  }
});

test('voice routes tolerate missing telemetry', async () => {
  const server = buildApp({ esp32: stubEsp32({}) }).listen(0);
  try {
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/voice/event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 200);
    assert.deepEqual(await (await fetch(`${base}/voice`)).json(), {});
    assert.deepEqual(await (await fetch(`${base}/log`)).json(), { commands: [] });
  } finally {
    server.close();
  }
});

test('GET /system returns OS vitals as numbers', async () => {
  await withServer(stubEsp32({}), async (base) => {
    const res = await fetch(`${base}/system`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ok, true);
    assert.equal(typeof j.cpu, 'number');
    assert.equal(typeof j.mem, 'number');
    assert.equal(typeof j.uptime, 'number');
    assert.equal(typeof j.cores, 'number');
    assert.ok(j.cpu >= 0 && j.cpu <= 100, 'cpu in [0,100]');
    assert.ok(j.mem >= 0 && j.mem <= 100, 'mem in [0,100]');
  });
});

test('GET /weather returns parsed Open-Meteo current via injected fetcher', async () => {
  let urlSeen = '';
  const weatherFetch = async (url) => {
    urlSeen = url;
    return {
      ok: true,
      json: async () => ({
        current: { temperature_2m: 28.4, relative_humidity_2m: 51, wind_speed_10m: 11, weather_code: 0 },
      }),
    };
  };
  const server = buildApp({ esp32: stubEsp32({}), weatherFetch }).listen(0);
  try {
    await new Promise((r) => server.once('listening', r));
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/weather`)).json();
    assert.equal(body.ok, true);
    assert.equal(body.temp, 28.4);
    assert.equal(body.humid, 51);
    assert.equal(body.wind, 11);
    assert.equal(body.cond, 'CLEAR');
    assert.ok(urlSeen.includes('open-meteo.com'), 'used open-meteo');
  } finally {
    server.close();
  }
});

test('GET /weather caches and only calls upstream once within TTL', async () => {
  let calls = 0;
  const weatherFetch = async () => {
    calls++;
    return { ok: true, json: async () => ({ current: { temperature_2m: 30, weather_code: 2 } }) };
  };
  const server = buildApp({ esp32: stubEsp32({}), weatherFetch }).listen(0);
  try {
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    await (await fetch(`${base}/weather`)).json();
    await (await fetch(`${base}/weather`)).json();
    await (await fetch(`${base}/weather`)).json();
    assert.equal(calls, 1);
  } finally {
    server.close();
  }
});

test('GET /weather surfaces upstream errors as 502', async () => {
  const weatherFetch = async () => { throw new Error('network down'); };
  const server = buildApp({ esp32: stubEsp32({}), weatherFetch }).listen(0);
  try {
    await new Promise((r) => server.once('listening', r));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/weather`);
    assert.equal(res.status, 502);
  } finally {
    server.close();
  }
});

test('GET /vocab returns the injected vocab', async () => {
  const vocab = { deviceNames: ['tubelight', 'fan 1'], groupNames: ['lights', 'fans'] };
  const server = buildApp({ esp32: stubEsp32({}), vocab }).listen(0);
  try {
    await new Promise((r) => server.once('listening', r));
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/vocab`)).json();
    assert.deepEqual(body, vocab);
  } finally {
    server.close();
  }
});

test('GET /vocab tolerates missing vocab', async () => {
  const server = buildApp({ esp32: stubEsp32({}) }).listen(0);
  try {
    await new Promise((r) => server.once('listening', r));
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${server.address().port}/vocab`)).json(), {
      deviceNames: [], groupNames: [],
    });
  } finally {
    server.close();
  }
});
