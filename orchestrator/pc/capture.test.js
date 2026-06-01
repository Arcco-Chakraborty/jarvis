import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCapture } from './capture.js';

test('camera builds the ffmpeg pipeline and returns base64 jpeg', async () => {
  let argv;
  const execFile = async (bin, args) => { argv = { bin, args }; return { stdout: Buffer.from([0xff, 0xd8, 0xff]) }; };
  const cap = makeCapture({ execFile, exists: () => true });
  const r = await cap.camera();
  assert.equal(r.ok, true);
  assert.equal(r.mime, 'image/jpeg');
  assert.equal(r.data, Buffer.from([0xff, 0xd8, 0xff]).toString('base64'));
  assert.equal(argv.bin, 'ffmpeg');
  assert.ok(argv.args.includes('/dev/video0'));
  assert.ok(argv.args.includes('pipe:1'));
});

test('camera reports no device gracefully', async () => {
  const cap = makeCapture({ execFile: async () => { throw new Error('should not run'); }, exists: () => false });
  const r = await cap.camera();
  assert.equal(r.ok, false);
  assert.match(r.speak, /camera/i);
});

test('camera handles ffmpeg failure gracefully', async () => {
  const cap = makeCapture({ execFile: async () => { throw new Error('boom'); }, exists: () => true });
  const r = await cap.camera();
  assert.equal(r.ok, false);
  assert.match(r.speak, /camera|picture/i);
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
