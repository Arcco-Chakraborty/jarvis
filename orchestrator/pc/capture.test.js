import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCapture } from './capture.js';

test('phone fetches the snapshot URL and returns base64 jpeg', async () => {
  let calledUrl;
  const fetchFn = async (url) => {
    calledUrl = url;
    return { ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => Uint8Array.from([0xff, 0xd8, 0xff]).buffer };
  };
  const cap = makeCapture({ fetchFn, phoneUrl: 'http://192.168.0.187:8080/photo.jpg' });
  const r = await cap.phone();
  assert.equal(r.ok, true);
  assert.equal(r.mime, 'image/jpeg');
  assert.equal(r.data, Buffer.from([0xff, 0xd8, 0xff]).toString('base64'));
  assert.equal(calledUrl, 'http://192.168.0.187:8080/photo.jpg');
});

test('phone falls back to image/jpeg when no content-type', async () => {
  const fetchFn = async () => ({ ok: true, headers: { get: () => null }, arrayBuffer: async () => Uint8Array.from([1]).buffer });
  const r = await makeCapture({ fetchFn, phoneUrl: 'http://x/photo.jpg' }).phone();
  assert.equal(r.ok, true);
  assert.equal(r.mime, 'image/jpeg');
});

test('phone strips content-type parameters to a bare MIME (Gemini wants no charset)', async () => {
  const fetchFn = async () => ({ ok: true, headers: { get: () => 'image/jpeg; charset=utf-8' }, arrayBuffer: async () => Uint8Array.from([2]).buffer });
  const r = await makeCapture({ fetchFn, phoneUrl: 'http://x/photo.jpg' }).phone();
  assert.equal(r.mime, 'image/jpeg');
});

test('phone with no URL configured is graceful and does not fetch', async () => {
  let called = false;
  const cap = makeCapture({ fetchFn: async () => { called = true; return {}; }, phoneUrl: '' });
  const r = await cap.phone();
  assert.equal(r.ok, false);
  assert.match(r.speak, /phone camera/i);
  assert.equal(called, false);
});

test('phone reports an unreachable camera gracefully (non-ok and throw)', async () => {
  const notOk = await makeCapture({ fetchFn: async () => ({ ok: false, status: 500 }), phoneUrl: 'http://x' }).phone();
  assert.equal(notOk.ok, false);
  assert.match(notOk.speak, /reach your phone/i);
  const threw = await makeCapture({ fetchFn: async () => { throw new Error('ECONNREFUSED'); }, phoneUrl: 'http://x' }).phone();
  assert.equal(threw.ok, false);
  assert.match(threw.speak, /reach your phone/i);
});

test('screen shells out to gnome-screenshot and returns base64', async () => {
  let argv;
  const execFile = async (bin, args) => { argv = { bin, args }; return { stdout: '' }; };
  const readFile = async () => Buffer.from([1, 2, 3]);
  const unlink = async () => {};
  const cap = makeCapture({ execFile, readFile, unlink });
  const r = await cap.screen();
  assert.equal(r.ok, true);
  assert.equal(r.mime, 'image/png');
  assert.equal(r.data, Buffer.from([1, 2, 3]).toString('base64'));
  assert.equal(argv.bin, 'gnome-screenshot');
  assert.ok(argv.args.includes('-f'));
});

test('screen reports a missing tool gracefully', async () => {
  const err = new Error('not found'); err.code = 'ENOENT';
  const cap = makeCapture({ execFile: async () => { throw err; } });
  const r = await cap.screen();
  assert.equal(r.ok, false);
  assert.match(r.speak, /gnome-screenshot/i);
});
