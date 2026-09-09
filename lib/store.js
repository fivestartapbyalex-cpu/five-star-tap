import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Tiny JSON-file store. The whole dataset lives in memory and is flushed to
 * disk atomically (write temp -> rename) after every mutation. At this scale
 * -- a handful of reps and a few thousand pins -- that is plenty, and it keeps
 * the app dependency-free and trivially backup-able: data/db.json is the
 * entire database.
 */

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const TMP_FILE = path.join(DATA_DIR, 'db.tmp.json');

const EMPTY = { users: [], locations: [], notes: [], inquiries: [], secret: null };

let db = null;
let flushQueued = false;

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try {
      db = { ...EMPTY, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
    } catch (err) {
      // Never silently start on a blank slate -- that would look like data loss.
      throw new Error(`data/db.json is corrupt and could not be parsed: ${err.message}`);
    }
  } else {
    db = structuredClone(EMPTY);
  }
  if (!db.secret) {
    db.secret = crypto.randomBytes(32).toString('hex');
    flushNow();
  }
  return db;
}

function flushNow() {
  fs.writeFileSync(TMP_FILE, JSON.stringify(db, null, 2));
  fs.renameSync(TMP_FILE, DB_FILE);
  flushQueued = false;
}

/** Coalesce bursts of writes into a single disk hit on the next tick. */
export function save() {
  if (flushQueued) return;
  flushQueued = true;
  queueMicrotask(() => { if (flushQueued) flushNow(); });
}

export function data() {
  if (!db) load();
  return db;
}

export function id() {
  return crypto.randomUUID();
}

export function now() {
  return new Date().toISOString();
}

/** Copy a JSON-backed file to data/backups/ before risky operations. */
export function backup(tag = 'manual') {
  const dir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `db-${stamp}-${tag}.json`);
  fs.writeFileSync(file, JSON.stringify(data(), null, 2));
  return file;
}
