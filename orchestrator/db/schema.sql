CREATE TABLE IF NOT EXISTS devices (
  id        INTEGER PRIMARY KEY,
  name      TEXT UNIQUE NOT NULL,
  type      TEXT NOT NULL,
  base_url  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS switches (
  name       TEXT PRIMARY KEY,
  device_id  INTEGER NOT NULL REFERENCES devices(id),
  channel    INTEGER NOT NULL,
  group_name TEXT
);

CREATE TABLE IF NOT EXISTS aliases (
  alias      TEXT PRIMARY KEY,
  canonical  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS command_log (
  id         INTEGER PRIMARY KEY,
  ts         TEXT NOT NULL,
  raw_text   TEXT NOT NULL,
  intent     TEXT,
  ok         INTEGER,
  detail     TEXT
);
