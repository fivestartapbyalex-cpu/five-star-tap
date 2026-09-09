-- Five Star Tap — D1 schema
-- Applied with:  npx wrangler d1 execute fivestartap --file schema.sql

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  email                TEXT NOT NULL UNIQUE,
  password             TEXT NOT NULL,
  role                 TEXT NOT NULL DEFAULT 'rep',
  color                TEXT NOT NULL DEFAULT '#0071e3',
  active               INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  last_login_at        TEXT
);

CREATE TABLE IF NOT EXISTS locations (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  address    TEXT NOT NULL DEFAULT '',
  lat        REAL NOT NULL,
  lng        REAL NOT NULL,
  google_url TEXT NOT NULL DEFAULT '',
  review_url TEXT NOT NULL DEFAULT '',
  place_id   TEXT,
  status     TEXT NOT NULL DEFAULT 'prospect',
  rep_id     TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,
  location_id TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  author_id   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inquiries (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  business   TEXT NOT NULL DEFAULT '',
  phone      TEXT NOT NULL DEFAULT '',
  message    TEXT NOT NULL,
  handled    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Brute-force and spam throttling. A Worker isolate is short-lived and shared
-- by nobody in particular, so counters have to live in the database to mean
-- anything.
CREATE TABLE IF NOT EXISTS throttle (
  key       TEXT PRIMARY KEY,
  count     INTEGER NOT NULL DEFAULT 0,
  window_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_location ON notes(location_id);
CREATE INDEX IF NOT EXISTS idx_locations_rep  ON locations(rep_id);
CREATE INDEX IF NOT EXISTS idx_inquiries_time ON inquiries(created_at);
