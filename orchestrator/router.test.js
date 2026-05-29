import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRegistry } from './db/registry.js';
import { route } from './router.js';

function reg() {
  return openRegistry({ dbPath: ':memory:', esp32BaseUrl: 'http://test' });
}

function fakeBoard({ states = {}, throwOnSet = false } = {}) {
  return {
    calls: [],
    allOffCalled: false,
    async set(name, on) {
      if (throwOnSet) throw new Error('unreachable');
      this.calls.push([name, on]);
    },
    async allOff() {
      this.allOffCalled = true;
    },
    isOn(name) {
      return states[name];
    },
  };
}

test('device off calls set(false) and speaks', async () => {
  const board = fakeBoard();
  const registry = reg();
  const res = await route({ domain: 'switch', action: 'off', target: 'tubelight' }, { board, registry });
  assert.deepEqual(board.calls, [['tubelight', false]]);
  assert.deepEqual(res, { ok: true, speak: 'Tubelight is off.' });
  registry.close();
});

test('device on calls set(true) and speaks', async () => {
  const board = fakeBoard();
  const registry = reg();
  const res = await route({ domain: 'switch', action: 'on', target: 'fan 1' }, { board, registry });
  assert.deepEqual(board.calls, [['fan 1', true]]);
  assert.deepEqual(res, { ok: true, speak: 'Fan 1 is on.' });
  registry.close();
});

test('group off expands to all members ordered by channel', async () => {
  const board = fakeBoard();
  const registry = reg();
  const res = await route({ domain: 'switch', action: 'off', target: 'lights' }, { board, registry });
  assert.deepEqual(board.calls, [
    ['tubelight', false], ['spotlight', false], ['rgb light', false], ['night light', false],
  ]);
  assert.deepEqual(res, { ok: true, speak: 'Lights are off.' });
  registry.close();
});

test('keep_only device turns target on and all other switches off', async () => {
  const board = fakeBoard();
  const registry = reg();
  const res = await route({ domain: 'switch', action: 'keep_only', target: 'tubelight' }, { board, registry });
  assert.deepEqual(board.calls, [
    ['fan 1', false],
    ['fan 2', false],
    ['tubelight', true],
    ['spotlight', false],
    ['rgb light', false],
    ['night light', false],
    ['socket', false],
    ['spare', false],
  ]);
  assert.deepEqual(res, { ok: true, speak: 'Only Tubelight is on.' });
  registry.close();
});

test('keep_only group turns group members on and all other switches off', async () => {
  const board = fakeBoard();
  const registry = reg();
  const res = await route({ domain: 'switch', action: 'keep_only', target: 'lights' }, { board, registry });
  assert.deepEqual(board.calls, [
    ['fan 1', false],
    ['fan 2', false],
    ['tubelight', true],
    ['spotlight', true],
    ['rgb light', true],
    ['night light', true],
    ['socket', false],
    ['spare', false],
  ]);
  assert.deepEqual(res, { ok: true, speak: 'Only Lights are on.' });
  registry.close();
});

test('all_off_except scoped to a group: turns off other group members, leaves target and non-group untouched', async () => {
  const board = fakeBoard();
  const registry = reg();
  const res = await route(
    { domain: 'switch', action: 'all_off_except', target: 'tubelight', scope: 'lights' },
    { board, registry },
  );
  // Only the OTHER lights are turned off; tubelight (the kept one) and fans/socket are untouched.
  assert.deepEqual(board.calls, [
    ['spotlight', false], ['rgb light', false], ['night light', false],
  ]);
  assert.deepEqual(res, { ok: true, speak: 'Lights off, except Tubelight.' });
  registry.close();
});

test('all_off_except global (no scope): turns off everything but the target', async () => {
  const board = fakeBoard();
  const registry = reg();
  const res = await route(
    { domain: 'switch', action: 'all_off_except', target: 'tubelight' },
    { board, registry },
  );
  assert.deepEqual(board.calls, [
    ['fan 1', false], ['fan 2', false],
    ['spotlight', false], ['rgb light', false], ['night light', false],
    ['socket', false], ['spare', false],
  ]);
  assert.deepEqual(res, { ok: true, speak: 'Everything off, except Tubelight.' });
  registry.close();
});

test('all_off calls board.allOff', async () => {
  const board = fakeBoard();
  const registry = reg();
  const res = await route({ domain: 'switch', action: 'all_off' }, { board, registry });
  assert.equal(board.allOffCalled, true);
  assert.deepEqual(res, { ok: true, speak: 'Everything is off.' });
  registry.close();
});

test('status reflects cached state', async () => {
  const registry = reg();
  const on = await route({ domain: 'switch', action: 'status', target: 'tubelight' }, { board: fakeBoard({ states: { tubelight: true } }), registry });
  assert.deepEqual(on, { ok: true, speak: 'The tubelight is on.' });
  const off = await route({ domain: 'switch', action: 'status', target: 'tubelight' }, { board: fakeBoard({ states: { tubelight: false } }), registry });
  assert.deepEqual(off, { ok: true, speak: 'The tubelight is off.' });
  registry.close();
});

test('status before first poll is graceful', async () => {
  const registry = reg();
  const res = await route({ domain: 'switch', action: 'status', target: 'tubelight' }, { board: fakeBoard({ states: {} }), registry });
  assert.deepEqual(res, { ok: true, speak: "I haven't reached the smart switch yet." });
  registry.close();
});

test('unreachable board yields the error sentence', async () => {
  const registry = reg();
  const res = await route({ domain: 'switch', action: 'off', target: 'tubelight' }, { board: fakeBoard({ throwOnSet: true }), registry });
  assert.deepEqual(res, { ok: false, speak: "I couldn't reach the smart switch." });
  registry.close();
});
