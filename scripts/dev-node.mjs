/**
 * Local dev harness.
 *
 * `wrangler dev` is the real thing and should be preferred, but its bundled
 * workerd binary segfaults on some Windows machines (access violation on
 * startup, independent of config). This runs the exact same Hono app under
 * Node instead, with:
 *
 *   - a D1 shim over node:sqlite — the same engine D1 uses, so the SQL is
 *     genuinely exercised, not mocked;
 *   - an ASSETS shim serving ./public off disk.
 *
 * It is a development aid only. Nothing here ships to Cloudflare.
 *
 *   node scripts/dev-node.mjs [port]
 */

import { DatabaseSync } from 'node:sqlite';
import { serve } from '@hono/node-server';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import app from '../src/index.js';

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const PORT = Number(process.argv[2] || 8787);
const DB_FILE = process.env.DEV_DB || path.join(root, '.dev-data', 'local.sqlite');

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const sqlite = new DatabaseSync(DB_FILE);
sqlite.exec(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'));

/* ---------- D1 shim ---------- */

/** Undefined is not bindable in SQLite; D1 treats it as NULL. */
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

function prepare(sql) {
  let params = [];
  const api = {
    bind(...args) { params = args.map(norm); return api; },
    first() {
      const row = sqlite.prepare(sql).get(...params);
      return row === undefined ? null : { ...row };
    },
    all() {
      return { results: sqlite.prepare(sql).all(...params).map(r => ({ ...r })), success: true };
    },
    run() {
      const r = sqlite.prepare(sql).run(...params);
      return { success: true, meta: { changes: Number(r.changes ?? 0) } };
    },
    _exec() { return api.run(); },
  };
  return api;
}

const DB = {
  prepare,
  async batch(statements) {
    sqlite.exec('BEGIN');
    try {
      const out = statements.map(s => s._exec());
      sqlite.exec('COMMIT');
      return out;
    } catch (err) {
      sqlite.exec('ROLLBACK');
      throw err;
    }
  },
};

/* ---------- ASSETS shim ---------- */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveAsset(pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(root, 'public', rel);
  // Never serve outside public/.
  if (!file.startsWith(path.join(root, 'public'))) return null;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return new Response(fs.readFileSync(file), {
    headers: { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' },
  });
}

const ASSETS = { fetch: async (req) => serveAsset(new URL(req.url).pathname) || new Response('Not found', { status: 404 }) };

/* ---------- server ---------- */

const env = {
  DB,
  ASSETS,
  BRAND_NAME: 'Five Star Tap',
  MAP_LAT: '41.20',
  MAP_LNG: '-73.70',
  MAP_ZOOM: '10',
};

serve({
  port: PORT,
  fetch: async (request) => {
    // Cloudflare serves matching static files before the Worker sees them.
    const url = new URL(request.url);
    if (request.method === 'GET' && !url.pathname.startsWith('/api/')) {
      const hit = serveAsset(url.pathname);
      if (hit) return hit;
    }
    return app.fetch(request, env, { waitUntil() {}, passThroughOnException() {} });
  },
}, () => {
  console.log(`\n  Five Star Tap (node harness)  ->  http://localhost:${PORT}`);
  console.log(`  database: ${DB_FILE}\n`);
});
