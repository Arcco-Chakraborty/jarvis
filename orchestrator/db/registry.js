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

export function openRegistry({ dbPath = config.dbPath, esp32BaseUrl = config.esp32.baseUrl } = {}) {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  seed(db, esp32BaseUrl);

  return {
    getBoard: () =>
      db.prepare("SELECT id, name, type, base_url FROM devices WHERE name = 'smartswitch'").get(),
    getSwitchNamesByChannel: () =>
      db.prepare('SELECT name FROM switches ORDER BY channel').all().map((r) => r.name),
    close: () => db.close(),
    _db: db, // exposed for tests/debug only
  };
}

function seed(db, esp32BaseUrl) {
  const insertDevice = db.prepare(
    "INSERT OR IGNORE INTO devices (name, type, base_url) VALUES ('smartswitch', 'esp32_switch', ?)",
  );
  const insertSwitch = db.prepare(
    'INSERT OR IGNORE INTO switches (name, device_id, channel, group_name) VALUES (?, ?, ?, ?)',
  );
  const tx = db.transaction((baseUrl) => {
    insertDevice.run(baseUrl ?? '');
    const board = db.prepare("SELECT id FROM devices WHERE name = 'smartswitch'").get();
    CHANNEL_MAP.forEach(([name, group], channel) => {
      insertSwitch.run(name, board.id, channel, group);
    });
  });
  tx(esp32BaseUrl);
}
