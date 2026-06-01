import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeVision } from './vision.js';

test('camera source: captures then describes', async () => {
  const seen = [];
  const camera = async () => ({ ok: true, data: 'IMG', mime: 'image/jpeg' });
  const screen = async () => { throw new Error('should not be called'); };
  const describe = async (q, data, mime) => { seen.push({ q, data, mime }); return 'a mug'; };
  const v = makeVision({ camera, screen, describe });
  const r = await v.look({ source: 'camera', query: 'what is this' });
  assert.equal(r.ok, true);
  assert.equal(r.speak, 'a mug');
  assert.deepEqual(seen, [{ q: 'what is this', data: 'IMG', mime: 'image/jpeg' }]);
});

test('screen source: uses the screen capturer', async () => {
  let used = '';
  const camera = async () => { used = 'camera'; return { ok: true, data: 'C', mime: 'image/jpeg' }; };
  const screen = async () => { used = 'screen'; return { ok: true, data: 'S', mime: 'image/png' }; };
  const describe = async () => 'desc';
  const v = makeVision({ camera, screen, describe });
  await v.look({ source: 'screen', query: 'q' });
  assert.equal(used, 'screen');
});

test('capture failure short-circuits without describing', async () => {
  let described = false;
  const camera = async () => ({ ok: false, speak: "I don't see a camera connected, sir." });
  const describe = async () => { described = true; return 'x'; };
  const v = makeVision({ camera, screen: camera, describe });
  const r = await v.look({ source: 'camera', query: 'q' });
  assert.equal(r.ok, false);
  assert.match(r.speak, /camera/i);
  assert.equal(described, false);
});
