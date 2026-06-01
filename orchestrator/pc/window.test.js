import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWindow, resolve } from './window.js';

const WINS = [
  { id: 11, wm_class: 'Google-chrome', focus: false, in_current_workspace: true },
  { id: 22, wm_class: 'Code', focus: true, in_current_workspace: true },
  { id: 33, wm_class: 'firefox', focus: false, in_current_workspace: false },
];

function harness({ wins = WINS, listThrows = false, actionThrows = false } = {}) {
  const calls = [];
  const gdbus = async (method, ...args) => {
    calls.push({ method, args });
    if (method === 'List') {
      if (listThrows) throw new Error('no such interface');
      return `('${JSON.stringify(wins)}',)\n`;
    }
    if (actionThrows) throw new Error('window vanished'); // TOCTOU: gone between List and action
    return '()\n';
  };
  const getWorkArea = () => ({ left: [0, 37, 960, 1043], right: [960, 37, 960, 1043] });
  return { calls, w: makeWindow({ gdbus, getWorkArea }) };
}

test('resolve matches a spoken name against wm_class (normalized, substring)', () => {
  assert.equal(resolve('chrome', WINS), 11);
  assert.equal(resolve('code', WINS), 22);
  assert.equal(resolve('firefox', WINS), 33);
  assert.equal(resolve('spotify', WINS), null);
});

test('focus activates the matched window', async () => {
  const h = harness();
  const r = await h.w.focus({ name: 'chrome' });
  assert.equal(r.ok, true);
  assert.deepEqual(h.calls.find((c) => c.method === 'Activate'), { method: 'Activate', args: ['11'] });
  assert.match(r.speak, /chrome/i);
});

test('focus on an unknown window is graceful', async () => {
  const r = await harness().w.focus({ name: 'spotify' });
  assert.equal(r.ok, false);
  assert.match(r.speak, /don'?t see a window/i);
});

test('snap left moves the focused window to the left half', async () => {
  const h = harness();
  const r = await h.w.snap({ dir: 'left' });
  assert.equal(r.ok, true);
  assert.deepEqual(h.calls.find((c) => c.method === 'MoveResize'),
    { method: 'MoveResize', args: ['22', '0', '37', '960', '1043'] });
});

test('splitWith positions A left and B right', async () => {
  const h = harness();
  const r = await h.w.splitWith({ a: 'chrome', b: 'code' }, {});
  assert.equal(r.ok, true);
  const mrs = h.calls.filter((c) => c.method === 'MoveResize');
  assert.deepEqual(mrs[0], { method: 'MoveResize', args: ['11', '0', '37', '960', '1043'] });
  assert.deepEqual(mrs[1], { method: 'MoveResize', args: ['22', '960', '37', '960', '1043'] });
  assert.match(r.speak, /chrome.*left.*code.*right/i);
});

test('minimize and close target the focused window', async () => {
  const h = harness();
  await h.w.minimize();
  await h.w.close();
  assert.deepEqual(h.calls.find((c) => c.method === 'Minimize'), { method: 'Minimize', args: ['22'] });
  assert.deepEqual(h.calls.find((c) => c.method === 'Close'), { method: 'Close', args: ['22'] });
});

test('list speaks the open window names in the current workspace', async () => {
  const r = await harness().w.list();
  assert.equal(r.ok, true);
  assert.match(r.speak, /chrome/i);
  assert.match(r.speak, /code/i);
  assert.doesNotMatch(r.speak, /firefox/i);
});

test('a missing extension degrades gracefully', async () => {
  const r = await harness({ listThrows: true }).w.focus({ name: 'chrome' });
  assert.equal(r.ok, false);
  assert.match(r.speak, /window calls|extension/i);
});

test('an action that throws after List (window vanished) never throws — returns ok:false', async () => {
  const h = harness({ actionThrows: true });
  for (const r of [await h.w.focus({ name: 'chrome' }), await h.w.snap({ dir: 'left' }), await h.w.minimize(), await h.w.close()]) {
    assert.equal(r.ok, false);
    assert.equal(typeof r.speak, 'string');
  }
});
