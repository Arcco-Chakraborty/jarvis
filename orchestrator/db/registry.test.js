import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { openRegistry } from './registry.js';

function openTestRegistry() {
  return openRegistry({ dbPath: ':memory:', esp32BaseUrl: 'http://test.local' });
}

test('schema creates the four tables', () => {
  const reg = openTestRegistry();
  const tables = reg._db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.deepEqual(tables, ['aliases', 'command_log', 'devices', 'switches']);
  reg.close();
});

test('seed inserts the smartswitch device with its base_url', () => {
  const reg = openTestRegistry();
  const board = reg.getBoard();
  assert.equal(board.name, 'smartswitch');
  assert.equal(board.type, 'esp32_switch');
  assert.equal(board.base_url, 'http://test.local');
  reg.close();
});

test('seed inserts the 8-channel map with correct names, channels, and groups', () => {
  const reg = openTestRegistry();
  const rows = reg._db
    .prepare('SELECT name, channel, group_name FROM switches ORDER BY channel')
    .all();
  assert.deepEqual(rows, [
    { name: 'fan 1', channel: 0, group_name: 'fans' },
    { name: 'fan 2', channel: 1, group_name: 'fans' },
    { name: 'tubelight', channel: 2, group_name: 'lights' },
    { name: 'spotlight', channel: 3, group_name: 'lights' },
    { name: 'rgb light', channel: 4, group_name: 'lights' },
    { name: 'night light', channel: 5, group_name: 'lights' },
    { name: 'socket', channel: 6, group_name: 'other' },
    { name: 'spare', channel: 7, group_name: 'other' },
  ]);
  reg.close();
});

test('getSwitchNamesByChannel returns the 8 names ordered 0..7', () => {
  const reg = openTestRegistry();
  assert.deepEqual(reg.getSwitchNamesByChannel(), [
    'fan 1', 'fan 2', 'tubelight', 'spotlight',
    'rgb light', 'night light', 'socket', 'spare',
  ]);
  reg.close();
});

test('seeding is idempotent across reopens (1 device, 8 switches)', () => {
  const dbPath = join(tmpdir(), `jarvis-test-${process.pid}-${Date.now()}.db`);
  try {
    openRegistry({ dbPath, esp32BaseUrl: 'http://test.local' }).close();
    const reg = openRegistry({ dbPath, esp32BaseUrl: 'http://test.local' });
    assert.equal(reg._db.prepare('SELECT COUNT(*) AS n FROM devices').get().n, 1);
    assert.equal(reg._db.prepare('SELECT COUNT(*) AS n FROM switches').get().n, 8);
    reg.close();
  } finally {
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-journal`, { force: true });
  }
});
