/**
 * Creates (or resets) an admin account.
 *
 *   node scripts/create-admin.mjs --local  "Alex" alex@example.com "a-long-password"
 *   node scripts/create-admin.mjs --remote "Alex" alex@example.com "a-long-password"
 *
 * The hash is computed here with Node's PBKDF2 using exactly the parameters
 * the Worker uses, so the two agree. Nothing but the finished hash is sent to
 * the database — the password never leaves this machine in the clear.
 */

import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const ITERATIONS = 210_000;

const args = process.argv.slice(2);
const remote = args.includes('--remote');
const rest = args.filter(a => a !== '--local' && a !== '--remote');
const [name, email, password] = rest;

if (!name || !email || !password) {
  console.error(`
Usage:
  node scripts/create-admin.mjs --local  "Name" email@example.com "password"
  node scripts/create-admin.mjs --remote "Name" email@example.com "password"

  --local   the database wrangler dev uses on this machine
  --remote  the live D1 database
`);
  process.exit(1);
}
if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

const salt = crypto.randomBytes(16);
const hash = crypto.pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
const stored = `pbkdf2$${ITERATIONS}$${salt.toString('base64')}$${hash.toString('base64')}`;

const esc = s => String(s).replace(/'/g, "''");
const sql = `
INSERT INTO users (id, name, email, password, role, color, active, must_change_password, created_at)
VALUES ('${randomUUID()}', '${esc(name)}', '${esc(email.toLowerCase())}', '${stored}',
        'admin', '#0071e3', 1, 0, '${new Date().toISOString()}')
ON CONFLICT(email) DO UPDATE SET
  password = excluded.password,
  role     = 'admin',
  active   = 1;
`.trim();

const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['wrangler', 'd1', 'execute', 'fivestartap', remote ? '--remote' : '--local', '--command', sql],
  { stdio: 'inherit' },
);

if (result.status === 0) {
  console.log(`\n  Admin ready on the ${remote ? 'live' : 'local'} database.`);
  console.log(`    email    ${email.toLowerCase()}`);
  console.log('    password (the one you just typed)\n');
} else {
  process.exit(result.status ?? 1);
}
