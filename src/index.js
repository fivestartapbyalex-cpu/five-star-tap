import { Hono } from 'hono';
import {
  hashPassword, verifyPassword, makeToken, readToken,
  sessionCookie, clearCookie, readCookie,
} from './auth.js';
import {
  now, id, publicUser, toNote, toInquiry,
  sessionSecret, userById, userByEmail, allUsers,
  allLocations, locationById, throttled, clearThrottle,
} from './db.js';
import { resolvePlace, reverseGeocode } from './places.js';

const app = new Hono();

export const STATUSES = ['prospect', 'visited', 'installed', 'declined'];

const clean = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const HEX = /^#[0-9a-f]{6}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const clientIp = (c) => c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'local';

/* Local `wrangler dev` is plain http, where a Secure cookie would be dropped. */
const isSecure = (c) => new URL(c.req.url).protocol === 'https:';

/* ------------------------------------------------------------------ *
 * session
 * ------------------------------------------------------------------ */

app.use('*', async (c, next) => {
  c.set('db', c.env.DB);
  const token = readCookie(c.req.header('cookie'));
  if (token) {
    const secret = await sessionSecret(c.env.DB);
    const userId = await readToken(token, secret);
    const user = userId ? await userById(c.env.DB, userId) : null;
    c.set('user', user && user.active !== false ? user : null);
  } else {
    c.set('user', null);
  }
  await next();
});

const requireAuth = async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'Not signed in' }, 401);
  await next();
};

const requireAdmin = async (c, next) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Not signed in' }, 401);
  if (user.role !== 'admin') return c.json({ error: 'Admins only' }, 403);
  await next();
};

/* ------------------------------------------------------------------ *
 * config
 * ------------------------------------------------------------------ */

const TILES = {
  light: 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  dark: 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  attribution: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &middot; '
    + 'Places &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  // Esri's canvas stops at z16 and serves a placeholder above it; Leaflet
  // upscales past maxNativeZoom instead of asking for tiles that do not exist.
  maxZoom: 19,
  maxNativeZoom: 16,
};

app.get('/api/config', requireAuth, (c) => c.json({
  tiles: TILES,
  home: {
    lat: Number(c.env.MAP_LAT ?? 41.20),
    lng: Number(c.env.MAP_LNG ?? -73.70),
    zoom: Number(c.env.MAP_ZOOM ?? 10),
  },
  brand: c.env.BRAND_NAME || 'Five Star Tap',
}));

/* ------------------------------------------------------------------ *
 * auth
 * ------------------------------------------------------------------ */

app.post('/api/login', async (c) => {
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));
  const email = clean(body.email, 200).toLowerCase();
  const password = String(body.password || '');
  const key = `login:${clientIp(c)}:${email}`;

  if (await throttled(db, key, 8, 15 * 60_000)) {
    return c.json({ error: 'Too many attempts. Wait 15 minutes and try again.' }, 429);
  }

  const user = await userByEmail(db, email);
  if (!user || user.active === false || !(await verifyPassword(password, user.password))) {
    return c.json({ error: 'That email and password do not match.' }, 401);
  }
  await clearThrottle(db, key);
  await db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(now(), user.id).run();

  const token = await makeToken(user.id, await sessionSecret(db));
  c.header('Set-Cookie', sessionCookie(token, isSecure(c)));
  return c.json({ user: publicUser(user) });
});

app.post('/api/logout', (c) => {
  c.header('Set-Cookie', clearCookie(isSecure(c)));
  return c.json({ ok: true });
});

app.get('/api/me', (c) => c.json({ user: publicUser(c.get('user')) }));

app.post('/api/password', requireAuth, async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const next = String(body.next || '');
  if (next.length < 8) return c.json({ error: 'Use at least 8 characters.' }, 400);
  if (!(await verifyPassword(String(body.current || ''), user.password))) {
    return c.json({ error: 'Current password is wrong.' }, 400);
  }
  await c.env.DB.prepare('UPDATE users SET password = ?, must_change_password = 0 WHERE id = ?')
    .bind(await hashPassword(next), user.id).run();
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * users
 * ------------------------------------------------------------------ */

app.get('/api/users', requireAuth, async (c) =>
  c.json({ users: (await allUsers(c.env.DB)).map(publicUser) }));

app.post('/api/users', requireAdmin, async (c) => {
  const db = c.env.DB;
  const b = await c.req.json().catch(() => ({}));
  const name = clean(b.name, 80);
  const email = clean(b.email, 200).toLowerCase();
  const password = String(b.password || '');
  const color = HEX.test(b.color || '') ? b.color : '#0071e3';
  const role = b.role === 'admin' ? 'admin' : 'rep';

  if (!name) return c.json({ error: 'Name is required.' }, 400);
  if (!EMAIL.test(email)) return c.json({ error: 'Enter a valid email.' }, 400);
  if (password.length < 8) return c.json({ error: 'Password must be at least 8 characters.' }, 400);
  if (await userByEmail(db, email)) return c.json({ error: 'That email is already in use.' }, 409);

  const user = {
    id: id(), name, email, role, color,
    password: await hashPassword(password), createdAt: now(),
  };
  await db.prepare(
    `INSERT INTO users (id, name, email, password, role, color, active, must_change_password, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)`,
  ).bind(user.id, name, email, user.password, role, color, user.createdAt).run();

  return c.json({ user: publicUser({ ...user, active: true }) }, 201);
});

app.patch('/api/users/:id', requireAdmin, async (c) => {
  const db = c.env.DB;
  const target = await userById(db, c.req.param('id'));
  if (!target) return c.json({ error: 'No such user.' }, 404);
  const b = await c.req.json().catch(() => ({}));

  const sets = [], vals = [];
  const set = (col, val) => { sets.push(`${col} = ?`); vals.push(val); };

  if (b.name !== undefined) {
    const name = clean(b.name, 80);
    if (!name) return c.json({ error: 'Name cannot be empty.' }, 400);
    set('name', name);
  }
  if (b.email !== undefined) {
    const email = clean(b.email, 200).toLowerCase();
    if (!EMAIL.test(email)) return c.json({ error: 'Enter a valid email.' }, 400);
    const clash = await userByEmail(db, email);
    if (clash && clash.id !== target.id) return c.json({ error: 'That email is already in use.' }, 409);
    set('email', email);
  }
  if (b.color !== undefined) {
    if (!HEX.test(b.color)) return c.json({ error: 'Color must be a hex value like #0071e3.' }, 400);
    set('color', b.color);
  }
  if (b.password) {
    if (String(b.password).length < 8) return c.json({ error: 'Password must be at least 8 characters.' }, 400);
    set('password', await hashPassword(String(b.password)));
    set('must_change_password', 1);
  }
  if (b.role !== undefined || b.active !== undefined) {
    const nextRole = b.role !== undefined ? (b.role === 'admin' ? 'admin' : 'rep') : target.role;
    const nextActive = b.active !== undefined ? !!b.active : target.active !== false;
    const others = (await allUsers(db))
      .filter(u => u.id !== target.id && u.role === 'admin' && u.active !== false);
    if (others.length === 0 && (nextRole !== 'admin' || !nextActive)) {
      return c.json({ error: 'This is the only active admin -- promote someone else first.' }, 400);
    }
    set('role', nextRole);
    set('active', nextActive ? 1 : 0);
  }

  if (sets.length) {
    vals.push(target.id);
    await db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  }
  return c.json({ user: publicUser(await userById(db, target.id)) });
});

app.delete('/api/users/:id', requireAdmin, async (c) => {
  const db = c.env.DB;
  const me = c.get('user');
  const target = await userById(db, c.req.param('id'));
  if (!target) return c.json({ error: 'No such user.' }, 404);
  if (target.id === me.id) return c.json({ error: 'You cannot delete your own account.' }, 400);

  const admins = (await allUsers(db))
    .filter(u => u.id !== target.id && u.role === 'admin' && u.active !== false);
  if (target.role === 'admin' && admins.length === 0) {
    return c.json({ error: 'That is the only admin account.' }, 400);
  }

  // Removing a rep must never remove their territory: the pins and notes stay
  // and simply become unassigned.
  const { meta } = await db.prepare('UPDATE locations SET rep_id = NULL WHERE rep_id = ?')
    .bind(target.id).run();
  await db.prepare('DELETE FROM users WHERE id = ?').bind(target.id).run();

  return c.json({ ok: true, unassigned: meta?.changes ?? 0 });
});

/* ------------------------------------------------------------------ *
 * place lookup
 * ------------------------------------------------------------------ */

app.post('/api/resolve', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json({ place: await resolvePlace(body.input, c.env.DB) });
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }
});

app.post('/api/reverse', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const lat = Number(body.lat), lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return c.json({ error: 'Need a lat and lng.' }, 400);
  }
  const place = await reverseGeocode(lat, lng, c.env.DB).catch(() => null);
  return c.json({ place });
});

/* ------------------------------------------------------------------ *
 * locations
 * ------------------------------------------------------------------ */

app.get('/api/locations', requireAuth, async (c) =>
  c.json({ locations: await allLocations(c.env.DB) }));

app.post('/api/locations', requireAuth, async (c) => {
  const db = c.env.DB;
  const me = c.get('user');
  const b = await c.req.json().catch(() => ({}));

  const name = clean(b.name, 160);
  const lat = Number(b.lat), lng = Number(b.lng);
  if (!name) return c.json({ error: 'Give the location a name.' }, 400);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return c.json({ error: 'This location has no map position yet.' }, 400);
  }
  const status = STATUSES.includes(b.status) ? b.status : 'prospect';

  // The rep is whoever is signed in. Only an admin may file a pin under
  // someone else.
  let repId = me.id;
  if (b.repId && me.role === 'admin' && await userById(db, b.repId)) repId = b.repId;

  const locId = id();
  const stamp = now();
  const statements = [
    db.prepare(
      `INSERT INTO locations
         (id, name, address, lat, lng, google_url, review_url, place_id,
          status, rep_id, created_by, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      locId, name, clean(b.address, 300), lat, lng,
      clean(b.googleUrl, 1000), clean(b.reviewUrl, 1000), clean(b.placeId, 200) || null,
      status, repId, me.id, stamp, stamp, me.id,
    ),
  ];

  const firstNote = clean(b.note, 5000);
  if (firstNote) {
    statements.push(db.prepare(
      `INSERT INTO notes (id, location_id, title, body, author_id, created_at, updated_at, updated_by)
       VALUES (?, ?, 'First visit', ?, ?, ?, ?, ?)`,
    ).bind(id(), locId, firstNote, me.id, stamp, stamp, me.id));
  }
  await db.batch(statements);

  return c.json({ location: await locationById(db, locId) }, 201);
});

app.patch('/api/locations/:id', requireAuth, async (c) => {
  const db = c.env.DB;
  const me = c.get('user');
  const loc = await locationById(db, c.req.param('id'));
  if (!loc) return c.json({ error: 'No such location.' }, 404);
  const b = await c.req.json().catch(() => ({}));

  const sets = [], vals = [];
  const set = (col, val) => { sets.push(`${col} = ?`); vals.push(val); };

  // The team shares one map: anyone signed in may rename, re-status or
  // reposition a pin.
  if (b.name !== undefined) {
    const name = clean(b.name, 160);
    if (!name) return c.json({ error: 'Name cannot be empty.' }, 400);
    set('name', name);
  }
  if (b.address !== undefined) set('address', clean(b.address, 300));
  if (b.googleUrl !== undefined) set('google_url', clean(b.googleUrl, 1000));
  if (b.reviewUrl !== undefined) set('review_url', clean(b.reviewUrl, 1000));
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) return c.json({ error: 'Unknown status.' }, 400);
    set('status', b.status);
  }
  if (b.lat !== undefined && b.lng !== undefined) {
    const lat = Number(b.lat), lng = Number(b.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return c.json({ error: 'Bad coordinates.' }, 400);
    }
    set('lat', lat); set('lng', lng);
  }

  // Reassigning a pin to a different rep is the admin's call alone.
  if (b.repId !== undefined) {
    if (me.role !== 'admin') {
      return c.json({ error: 'Only an admin can change which rep covers a location.' }, 403);
    }
    if (b.repId === null || b.repId === '') set('rep_id', null);
    else if (await userById(db, b.repId)) set('rep_id', b.repId);
    else return c.json({ error: 'No such rep.' }, 400);
  }

  set('updated_at', now());
  set('updated_by', me.id);
  vals.push(loc.id);
  await db.prepare(`UPDATE locations SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();

  return c.json({ location: await locationById(db, loc.id) });
});

app.delete('/api/locations/:id', requireAuth, async (c) => {
  const db = c.env.DB;
  const me = c.get('user');
  const loc = await locationById(db, c.req.param('id'));
  if (!loc) return c.json({ error: 'No such location.' }, 404);
  // A rep can clean up their own mistakes; an admin can remove anything.
  if (me.role !== 'admin' && loc.createdBy !== me.id) {
    return c.json({ error: 'You can only delete locations you added.' }, 403);
  }
  await db.batch([
    db.prepare('DELETE FROM notes WHERE location_id = ?').bind(loc.id),
    db.prepare('DELETE FROM locations WHERE id = ?').bind(loc.id),
  ]);
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * notes — read-only on open, editable by anyone on the team
 * ------------------------------------------------------------------ */

async function nameLookup(db) {
  const users = await allUsers(db);
  return (userId) => users.find(u => u.id === userId)?.name || null;
}

app.get('/api/locations/:id/notes', requireAuth, async (c) => {
  const db = c.env.DB;
  const { results } = await db.prepare(
    'SELECT * FROM notes WHERE location_id = ? ORDER BY updated_at DESC',
  ).bind(c.req.param('id')).all();
  const nameOf = await nameLookup(db);
  return c.json({ notes: (results || []).map(r => toNote(r, nameOf)) });
});

app.post('/api/locations/:id/notes', requireAuth, async (c) => {
  const db = c.env.DB;
  const me = c.get('user');
  const locId = c.req.param('id');
  if (!(await locationById(db, locId))) return c.json({ error: 'No such location.' }, 404);

  const b = await c.req.json().catch(() => ({}));
  const body = clean(b.body, 20000);
  if (!body) return c.json({ error: 'The note is empty.' }, 400);

  const noteId = id();
  const stamp = now();
  await db.prepare(
    `INSERT INTO notes (id, location_id, title, body, author_id, created_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(noteId, locId, clean(b.title, 120) || 'Note', body, me.id, stamp, stamp, me.id).run();

  const row = await db.prepare('SELECT * FROM notes WHERE id = ?').bind(noteId).first();
  return c.json({ note: toNote(row, await nameLookup(db)) }, 201);
});

app.patch('/api/notes/:id', requireAuth, async (c) => {
  const db = c.env.DB;
  const me = c.get('user');
  const noteId = c.req.param('id');
  const existing = await db.prepare('SELECT * FROM notes WHERE id = ?').bind(noteId).first();
  if (!existing) return c.json({ error: 'No such note.' }, 404);

  const b = await c.req.json().catch(() => ({}));
  const sets = [], vals = [];
  if (b.title !== undefined) { sets.push('title = ?'); vals.push(clean(b.title, 120) || 'Note'); }
  if (b.body !== undefined) {
    const body = clean(b.body, 20000);
    if (!body) return c.json({ error: 'The note is empty.' }, 400);
    sets.push('body = ?'); vals.push(body);
  }
  sets.push('updated_at = ?'); vals.push(now());
  sets.push('updated_by = ?'); vals.push(me.id);
  vals.push(noteId);
  await db.prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();

  const row = await db.prepare('SELECT * FROM notes WHERE id = ?').bind(noteId).first();
  return c.json({ note: toNote(row, await nameLookup(db)) });
});

app.delete('/api/notes/:id', requireAuth, async (c) => {
  const db = c.env.DB;
  const me = c.get('user');
  const row = await db.prepare('SELECT * FROM notes WHERE id = ?').bind(c.req.param('id')).first();
  if (!row) return c.json({ error: 'No such note.' }, 404);
  if (me.role !== 'admin' && row.author_id !== me.id) {
    return c.json({ error: 'You can only delete notes you wrote.' }, 403);
  }
  await db.prepare('DELETE FROM notes WHERE id = ?').bind(row.id).run();
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * inquiries — the public contact form
 * ------------------------------------------------------------------ */

app.post('/api/inquiry', async (c) => {
  const db = c.env.DB;
  const b = await c.req.json().catch(() => ({}));

  // Honeypot: a real person never fills a field they cannot see.
  if (clean(b.website, 200)) return c.json({ ok: true });

  const name = clean(b.name, 80);
  const email = clean(b.email, 200).toLowerCase();
  const message = clean(b.message, 4000);

  if (!name) return c.json({ error: 'Please add your name.' }, 400);
  if (!EMAIL.test(email)) return c.json({ error: 'Please add a valid email so we can reply.' }, 400);
  if (!message) return c.json({ error: 'Tell us a little about your business.' }, 400);

  if (await throttled(db, `inquiry:${clientIp(c)}`, 5, 3600_000)) {
    return c.json({ error: 'That is a few too many messages. Email us directly instead.' }, 429);
  }

  await db.prepare(
    `INSERT INTO inquiries (id, name, email, business, phone, message, handled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
  ).bind(id(), name, email, clean(b.business, 120), clean(b.phone, 40), message, now()).run();

  return c.json({ ok: true }, 201);
});

app.get('/api/inquiries', requireAdmin, async (c) => {
  const { results } = await c.env.DB
    .prepare('SELECT * FROM inquiries ORDER BY created_at DESC').all();
  return c.json({ inquiries: (results || []).map(toInquiry) });
});

app.patch('/api/inquiries/:id', requireAdmin, async (c) => {
  const db = c.env.DB;
  const b = await c.req.json().catch(() => ({}));
  const row = await db.prepare('SELECT * FROM inquiries WHERE id = ?').bind(c.req.param('id')).first();
  if (!row) return c.json({ error: 'No such inquiry.' }, 404);
  if (b.handled !== undefined) {
    await db.prepare('UPDATE inquiries SET handled = ? WHERE id = ?')
      .bind(b.handled ? 1 : 0, row.id).run();
  }
  const fresh = await db.prepare('SELECT * FROM inquiries WHERE id = ?').bind(row.id).first();
  return c.json({ inquiry: toInquiry(fresh) });
});

app.delete('/api/inquiries/:id', requireAdmin, async (c) => {
  await c.env.DB.prepare('DELETE FROM inquiries WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * pages
 * ------------------------------------------------------------------ */

const asset = (c, file) =>
  c.env.ASSETS.fetch(new Request(new URL(file, c.req.url), { headers: c.req.raw.headers }));

app.get('/signin', async (c) =>
  (c.get('user') ? c.redirect('/map') : asset(c, '/signin.html')));

app.get('/map', async (c) =>
  (c.get('user') ? asset(c, '/app.html') : c.redirect('/signin')));

const adminPage = (file) => async (c) => {
  const user = c.get('user');
  if (!user) return c.redirect('/signin');
  if (user.role !== 'admin') return c.redirect('/map');
  return asset(c, file);
};
app.get('/team', adminPage('/team.html'));
app.get('/leads', adminPage('/leads.html'));

app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) return c.json({ error: 'Unknown endpoint.' }, 404);
  return c.redirect('/');
});

app.onError((err, c) => {
  console.error('[error]', err.stack || err);
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: 'Something went wrong on the server.' }, 500);
  }
  return c.text('Something went wrong.', 500);
});

export default app;
