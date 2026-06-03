import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeVision } from './vision.js';

test('phone source: captures then describes', async () => {
  const seen = [];
  const phone = async () => ({ ok: true, data: 'IMG', mime: 'image/jpeg' });
  const screen = async () => { throw new Error('should not be called'); };
  const describe = async (q, data, mime) => { seen.push({ q, data, mime }); return 'a mug'; };
  const v = makeVision({ phone, screen, describe });
  const r = await v.look({ source: 'phone', query: 'what is this' });
  assert.equal(r.ok, true);
  assert.equal(r.speak, 'a mug');
  assert.deepEqual(seen, [{ q: 'what is this', data: 'IMG', mime: 'image/jpeg' }]);
});

test('default (no source) uses the phone capturer', async () => {
  let used = '';
  const phone = async () => { used = 'phone'; return { ok: true, data: 'P', mime: 'image/jpeg' }; };
  const screen = async () => { used = 'screen'; return { ok: true, data: 'S', mime: 'image/png' }; };
  const v = makeVision({ phone, screen, describe: async () => 'd' });
  await v.look({ query: 'q' });
  assert.equal(used, 'phone');
});

test('screen source: uses the screen capturer', async () => {
  let used = '';
  const phone = async () => { used = 'phone'; return { ok: true, data: 'P', mime: 'image/jpeg' }; };
  const screen = async () => { used = 'screen'; return { ok: true, data: 'S', mime: 'image/png' }; };
  const v = makeVision({ phone, screen, describe: async () => 'd' });
  await v.look({ source: 'screen', query: 'q' });
  assert.equal(used, 'screen');
});

test('capture failure short-circuits without describing', async () => {
  let described = false;
  const phone = async () => ({ ok: false, speak: "I couldn't reach your phone's camera." });
  const describe = async () => { described = true; return 'x'; };
  const v = makeVision({ phone, screen: phone, describe });
  const r = await v.look({ source: 'phone', query: 'q' });
  assert.equal(r.ok, false);
  assert.match(r.speak, /phone/i);
  assert.equal(described, false);
});
