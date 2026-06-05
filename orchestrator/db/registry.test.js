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

test('seed reconciles base_url from config on reopen (config is source of truth)', () => {
  const dbPath = join(tmpdir(), `jarvis-test-reconcile-${process.pid}-${Date.now()}.db`);
  try {
    // First boot: original config.
    openRegistry({
      dbPath, esp32BaseUrl: 'http://old-board',
      pcAgents: [{ name: 'laptop', baseUrl: 'http://old:7000' }],
    }).close();
    // Second boot: config changed (e.g., .env was edited). The DB must follow.
    const reg = openRegistry({
      dbPath, esp32BaseUrl: 'http://new-board',
      pcAgents: [{ name: 'laptop', baseUrl: 'http://new:7000' }],
    });
    assert.equal(reg.getPcAgent('laptop').base_url, 'http://new:7000');
    assert.equal(
      reg._db.prepare("SELECT base_url FROM devices WHERE name='smartswitch'").get().base_url,
      'http://new-board',
    );
    // No duplicate rows — upsert, not a second insert.
    assert.equal(reg._db.prepare("SELECT COUNT(*) AS n FROM devices WHERE name='laptop'").get().n, 1);
    reg.close();
  } finally {
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-journal`, { force: true });
  }
});

test('getGroupNames returns the distinct groups', () => {
  const reg = openTestRegistry();
  assert.deepEqual(reg.getGroupNames(), ['fans', 'lights', 'other']);
  reg.close();
});

test('getSwitchNamesByGroup returns members ordered by channel', () => {
  const reg = openTestRegistry();
  assert.deepEqual(reg.getSwitchNamesByGroup('lights'), [
    'tubelight', 'spotlight', 'rgb light', 'night light',
  ]);
  assert.deepEqual(reg.getSwitchNamesByGroup('fans'), ['fan 1', 'fan 2']);
  reg.close();
});

test('registers PC agents and looks them up', () => {
  const reg = openRegistry({
    dbPath: ':memory:', esp32BaseUrl: 'http://e',
    pcAgents: [{ name: 'desktop', baseUrl: 'http://192.168.0.50:7000' }],
  });
  try {
    assert.deepEqual(reg.getPcAgents().map((a) => a.name), ['desktop']);
    assert.equal(reg.getPcAgent('desktop').base_url, 'http://192.168.0.50:7000');
    assert.equal(reg.getPcAgent('nope'), undefined);
  } finally {
    reg.close();
  }
});

test('seed removes pc_agent rows not present in config (rename, not duplicate)', () => {
  const dbPath = join(tmpdir(), `jarvis-test-rename-${process.pid}-${Date.now()}.db`);
  try {
    openRegistry({ dbPath, esp32BaseUrl: 'http://b', pcAgents: [{ name: 'desktop', baseUrl: 'http://x:7000' }] }).close();
    const reg = openRegistry({ dbPath, esp32BaseUrl: 'http://b', pcAgents: [{ name: 'laptop', baseUrl: 'http://x:7000' }] });
    assert.deepEqual(reg.getPcAgents().map((a) => a.name), ['laptop']);
    assert.equal(reg._db.prepare("SELECT COUNT(*) AS n FROM devices WHERE type='pc_agent'").get().n, 1);
    reg.close();
  } finally {
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-journal`, { force: true });
  }
});

test('logCommand inserts a row (intent serialized as JSON, null stays null)', () => {
  const reg = openTestRegistry();
  reg.logCommand({
    raw_text: 'turn off the tubelight',
    intent: { domain: 'switch', action: 'off', target: 'tubelight' },
    ok: 1,
    detail: 'Tubelight is off.',
  });
  reg.logCommand({ raw_text: 'gibberish', intent: null, ok: 0, detail: 'no match' });
  const rows = reg._db.prepare('SELECT raw_text, intent, ok, detail FROM command_log ORDER BY id').all();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    raw_text: 'turn off the tubelight',
    intent: '{"domain":"switch","action":"off","target":"tubelight"}',
    ok: 1,
    detail: 'Tubelight is off.',
  });
  assert.deepEqual(rows[1], { raw_text: 'gibberish', intent: null, ok: 0, detail: 'no match' });
  assert.equal(typeof reg._db.prepare('SELECT ts FROM command_log LIMIT 1').get().ts, 'string');
  reg.close();
});
