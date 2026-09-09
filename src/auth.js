/**
 * Passwords and sessions on the Workers runtime.
 *
 * The Node build used scrypt; WebCrypto does not offer it, so passwords are
 * PBKDF2-HMAC-SHA256 at 210,000 iterations (the OWASP figure for SHA-256).
 * Sessions stay the same shape as before: an HMAC-signed cookie, no server
 * state to keep.
 */

const ITERATIONS = 210_000;
const SESSION_DAYS = 30;
const COOKIE = 'fs_session';

const enc = new TextEncoder();

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

const b64url = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Constant-time comparison; WebCrypto gives us no timingSafeEqual. */
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* ---------- passwords ---------- */

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 1000) return false;
  try {
    const attempt = await pbkdf2(password, unb64(parts[2]), iterations);
    return sameBytes(attempt, unb64(parts[3]));
  } catch {
    return false;
  }
}

/* ---------- sessions ---------- */

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
}

async function sign(payload, secret) {
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload));
  return b64url(mac);
}

export async function makeToken(userId, secret) {
  const expires = Date.now() + SESSION_DAYS * 864e5;
  const payload = `${userId}.${expires}`;
  return `${payload}.${await sign(payload, secret)}`;
}

export async function readToken(token, secret) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, expires, mac] = parts;
  const expected = await sign(`${userId}.${expires}`, secret);
  if (!sameBytes(enc.encode(mac), enc.encode(expected))) return null;
  if (Number(expires) < Date.now()) return null;
  return userId;
}

export function sessionCookie(token, secure = true) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`
    + (secure ? '; Secure' : '');
}

export function clearCookie(secure = true) {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` + (secure ? '; Secure' : '');
}

export function readCookie(header = '') {
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return null;
}
