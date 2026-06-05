import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';

const SCHEMA_PATH = join(import.meta.dirname, 'schema.sql');

// channel -> [name, group]. Names match esp32-switch.js DEFAULT_NAMES (lowercased)
// so the registry is the single source of truth and the two never drift.
const CHANNEL_MAP = [
  ['fan 1', 'fans'],
  ['fan 2', 'fans'],
  ['tubelight', 'lights'],
  ['spotlight', 'lights'],
  ['rgb light', 'lights'],
  ['night light', 'lights'],
  ['socket', 'other'],
  ['spare', 'other'],
];

export function openRegistry({ dbPath = config.dbPath, esp32BaseUrl = config.esp32.baseUrl, pcAgents = config.pcAgents } = {}) {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  seed(db, esp32BaseUrl, pcAgents);

  return {
    getBoard: () =>
      db.prepare("SELECT id, name, type, base_url FROM devices WHERE name = 'smartswitch'").get(),
    getSwitchNamesByChannel: () =>
      db.prepare('SELECT name FROM switches ORDER BY channel').all().map((r) => r.name),
    getGroupNames: () =>
      db
        .prepare("SELECT DISTINCT group_name FROM switches WHERE group_name IS NOT NULL ORDER BY group_name")
        .all()
        .map((r) => r.group_name),
    getSwitchNamesByGroup: (group) =>
      db
        .prepare('SELECT name FROM switches WHERE group_name = ? ORDER BY channel')
        .all(group)
        .map((r) => r.name),
    getPcAgents: () =>
      db.prepare("SELECT name, base_url FROM devices WHERE type = 'pc_agent' ORDER BY name").all(),
    getPcAgent: (name) =>
      db.prepare("SELECT name, base_url FROM devices WHERE type = 'pc_agent' AND name = ?").get(String(name ?? '')),
    logCommand: ({ raw_text, intent, ok, detail }) =>
      db
        .prepare('INSERT INTO command_log (ts, raw_text, intent, ok, detail) VALUES (?, ?, ?, ?, ?)')
        .run(new Date().toISOString(), raw_text, intent == null ? null : JSON.stringify(intent), ok, detail),
    close: () => db.close(),
    _db: db, // exposed for tests/debug only
  };
}

function seed(db, esp32BaseUrl, pcAgents = []) {
  // Devices upsert base_url so config (.env) stays the source of truth across
  // reboots — a plain INSERT OR IGNORE would leave a stale URL in the DB after
  // an .env edit. The WHERE guard avoids clobbering a good URL with an empty one.
  const insertDevice = db.prepare(
    "INSERT INTO devices (name, type, base_url) VALUES ('smartswitch', 'esp32_switch', ?) " +
      "ON CONFLICT(name) DO UPDATE SET base_url = excluded.base_url WHERE excluded.base_url <> ''",
  );
  const insertSwitch = db.prepare(
    'INSERT OR IGNORE INTO switches (name, device_id, channel, group_name) VALUES (?, ?, ?, ?)',
  );
  const insertAgent = db.prepare(
    "INSERT INTO devices (name, type, base_url) VALUES (?, 'pc_agent', ?) " +
      "ON CONFLICT(name) DO UPDATE SET base_url = excluded.base_url WHERE excluded.base_url <> ''",
  );
  const tx = db.transaction((baseUrl) => {
    insertDevice.run(baseUrl ?? '');
    const board = db.prepare("SELECT id FROM devices WHERE name = 'smartswitch'").get();
    CHANNEL_MAP.forEach(([name, group], channel) => {
      insertSwitch.run(name, board.id, channel, group);
    });
    for (const a of pcAgents) insertAgent.run(a.name, a.baseUrl);
  });
  tx(esp32BaseUrl);
}
