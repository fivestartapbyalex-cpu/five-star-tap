import crypto from 'node:crypto';
import { data, save, id, now } from './store.js';

const SESSION_DAYS = 30;
const COOKIE = 'fs_session';

/* ---------- passwords (scrypt, no native deps) ---------- */

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const attempt = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  if (attempt.length !== expected.length) return false;
  return crypto.timingSafeEqual(attempt, expected);
}

/* ---------- stateless signed-cookie sessions ---------- */

function sign(payload) {
  return crypto.createHmac('sha256', data().secret).update(payload).digest('base64url');
}

function makeToken(userId) {
  const expires = Date.now() + SESSION_DAYS * 864e5;
  const payload = `${userId}.${expires}`;
  return `${payload}.${sign(payload)}`;
}

function readToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, expires, mac] = parts;
  const expected = sign(`${userId}.${expires}`);
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Number(expires) < Date.now()) return null;
  return userId;
}

export function setSession(res, userId) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `${COOKIE}=${makeToken(userId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}

export function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Express middleware: attaches req.user (or null). */
export function attachUser(req, _res, next) {
  const userId = readToken(parseCookies(req.headers.cookie)[COOKIE]);
  req.user = userId ? data().users.find(u => u.id === userId && u.active !== false) || null : null;
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  next();
}

/** Strip the password hash before anything leaves the server. */
export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, name: u.name, email: u.email, role: u.role,
    color: u.color, active: u.active !== false, createdAt: u.createdAt,
  };
}

/* ---------- first-run admin ---------- */

export function ensureAdmin() {
  const db = data();
  if (db.users.some(u => u.role === 'admin')) return null;
  const email = (process.env.ADMIN_EMAIL || 'alex@fivestar.app').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
  db.users.push({
    id: id(),
    name: process.env.ADMIN_NAME || 'Alex',
    email,
    password: hashPassword(password),
    role: 'admin',
    color: '#0071e3',
    active: true,
    createdAt: now(),
  });
  save();
  return { email, password, generated: !process.env.ADMIN_PASSWORD };
}
