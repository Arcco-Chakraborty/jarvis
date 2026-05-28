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
