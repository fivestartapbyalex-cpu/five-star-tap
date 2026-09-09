/**
 * D1 access. Column names are snake_case in SQLite and camelCase over the
 * wire, so every read goes through a mapper — the browser code is unchanged
 * from the Express build and expects the old shapes exactly.
 */

export const now = () => new Date().toISOString();
export const id = () => crypto.randomUUID();

/* ---------- mappers ---------- */

export function toUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    password: row.password,
    role: row.role,
    color: row.color,
    active: row.active === 1,
    mustChangePassword: row.must_change_password === 1,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

/** Never let the hash out of the server. */
export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, name: u.name, email: u.email, role: u.role,
    color: u.color, active: u.active !== false, createdAt: u.createdAt,
  };
}

export function toLocation(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    lat: row.lat,
    lng: row.lng,
    googleUrl: row.google_url,
    reviewUrl: row.review_url,
    placeId: row.place_id,
    status: row.status,
    repId: row.rep_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    noteCount: row.note_count ?? 0,
    lastNoteAt: row.last_note_at ?? '',
  };
}

export function toNote(row, nameOf) {
  if (!row) return null;
  return {
    id: row.id,
    locationId: row.location_id,
    title: row.title,
    body: row.body,
    authorId: row.author_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    authorName: nameOf(row.author_id) || 'Unknown',
    updatedByName: nameOf(row.updated_by),
  };
}

export function toInquiry(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    business: row.business,
    phone: row.phone,
    message: row.message,
    handled: row.handled === 1,
    createdAt: row.created_at,
  };
}

/* ---------- meta ---------- */

export async function getMeta(db, key) {
  const row = await db.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}

export async function setMeta(db, key, value) {
  await db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).bind(key, String(value)).run();
}

/**
 * The cookie-signing secret is generated once and kept in the database, so it
 * survives deploys. Rotating it (deleting the row) signs everyone out.
 */
export async function sessionSecret(db) {
  let secret = await getMeta(db, 'session_secret');
  if (!secret) {
    secret = [...crypto.getRandomValues(new Uint8Array(32))]
      .map(b => b.toString(16).padStart(2, '0')).join('');
    await setMeta(db, 'session_secret', secret);
  }
  return secret;
}

/* ---------- users ---------- */

export async function userById(db, userId) {
  if (!userId) return null;
  return toUser(await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first());
}

export async function userByEmail(db, email) {
  return toUser(await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first());
}

export async function allUsers(db) {
  const { results } = await db.prepare('SELECT * FROM users ORDER BY created_at').all();
  return (results || []).map(toUser);
}

/* ---------- locations ---------- */

const LOCATION_SELECT = `
  SELECT l.*,
         (SELECT COUNT(*) FROM notes n WHERE n.location_id = l.id) AS note_count,
         (SELECT MAX(n.updated_at) FROM notes n WHERE n.location_id = l.id) AS last_note_at
  FROM locations l`;

export async function allLocations(db) {
  const { results } = await db.prepare(`${LOCATION_SELECT} ORDER BY l.updated_at DESC`).all();
  return (results || []).map(toLocation);
}

export async function locationById(db, locId) {
  return toLocation(await db.prepare(`${LOCATION_SELECT} WHERE l.id = ?`).bind(locId).first());
}

/* ---------- throttling ---------- */

/**
 * Fixed-window counter kept in D1 so it actually holds across isolates.
 * Returns true when the caller is over the limit.
 */
export async function throttled(db, key, limit, windowMs) {
  const nowMs = Date.now();
  const row = await db.prepare('SELECT count, window_at FROM throttle WHERE key = ?').bind(key).first();

  if (!row || nowMs - row.window_at > windowMs) {
    await db.prepare(
      `INSERT INTO throttle (key, count, window_at) VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET count = 1, window_at = excluded.window_at`,
    ).bind(key, nowMs).run();
    return false;
  }
  if (row.count >= limit) return true;

  await db.prepare('UPDATE throttle SET count = count + 1 WHERE key = ?').bind(key).run();
  return false;
}

export async function clearThrottle(db, key) {
  await db.prepare('DELETE FROM throttle WHERE key = ?').bind(key).run();
}
