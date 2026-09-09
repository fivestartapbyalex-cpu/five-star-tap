import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { data, save, id, now, backup } from './lib/store.js';
import {
  hashPassword, verifyPassword, setSession, clearSession,
  attachUser, requireAuth, requireAdmin, publicUser, ensureAdmin,
} from './lib/auth.js';
import { resolvePlace, reverseGeocode } from './lib/places.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

export const STATUSES = ['prospect', 'visited', 'installed', 'declined'];

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));
app.use(attachUser);

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

const clean = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const HEX = /^#[0-9a-f]{6}$/i;

function findUser(userId) {
  return data().users.find(u => u.id === userId) || null;
}

/** Everything the client needs to render a pin. */
function shapeLocation(loc) {
  const notes = data().notes.filter(n => n.locationId === loc.id);
  return {
    ...loc,
    noteCount: notes.length,
    lastNoteAt: notes.reduce((a, n) => (n.updatedAt > a ? n.updatedAt : a), ''),
  };
}

function shapeNote(n) {
  return {
    ...n,
    authorName: findUser(n.authorId)?.name || 'Unknown',
    updatedByName: findUser(n.updatedBy)?.name || null,
  };
}

/** Wrap an async route so a rejection becomes a 500 instead of a hang. */
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------------------------------------------------ *
 * client config
 *
 * Basemaps are swappable without touching code. The default is Esri's grey
 * canvas: no API key, and a quiet palette that lets the rep pins carry the
 * color. Set TILE_LIGHT / TILE_DARK / TILE_ATTRIB to move to OpenStreetMap
 * or a keyed provider (MapTiler, Stadia, Thunderforest) if volume grows.
 * ------------------------------------------------------------------ */

const TILES = {
  light: process.env.TILE_LIGHT ||
    'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  dark: process.env.TILE_DARK ||
    'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  attribution: process.env.TILE_ATTRIB ||
    'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &middot; ' +
    'Places &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  // Esri's canvas basemaps stop at z16 and serve a "Map data not yet
  // available" placeholder above it. maxNativeZoom lets Leaflet upscale the
  // z16 tile instead, so deeper zooms stay usable.
  maxZoom: Number(process.env.TILE_MAX_ZOOM || 19),
  maxNativeZoom: Number(process.env.TILE_MAX_NATIVE_ZOOM || 16),
};

/* Where the map opens before there are any pins to fit. */
const MAP_HOME = {
  lat: Number(process.env.MAP_LAT || 41.20),    // Westchester / Fairfield /
  lng: Number(process.env.MAP_LNG || -73.70),   // lower Hudson Valley
  zoom: Number(process.env.MAP_ZOOM || 10),
};

app.get('/api/config', requireAuth, (req, res) => {
  res.json({
    tiles: TILES,
    home: MAP_HOME,
    brand: process.env.BRAND_NAME || 'Five Star Tap',
  });
});

/* ------------------------------------------------------------------ *
 * auth
 * ------------------------------------------------------------------ */

// Small in-memory throttle so a stolen rep email cannot be brute-forced.
const attempts = new Map();
function throttled(key) {
  const rec = attempts.get(key);
  if (!rec) return false;
  if (Date.now() - rec.at > 15 * 60_000) { attempts.delete(key); return false; }
  return rec.n >= 8;
}
function noteAttempt(key, ok) {
  if (ok) return attempts.delete(key);
  const rec = attempts.get(key) || { n: 0, at: Date.now() };
  rec.n++; rec.at = Date.now();
  attempts.set(key, rec);
}

app.post('/api/login', (req, res) => {
  const email = clean(req.body?.email, 200).toLowerCase();
  const password = String(req.body?.password || '');
  const key = `${req.ip}|${email}`;

  if (throttled(key)) {
    return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes and try again.' });
  }
  const user = data().users.find(u => u.email === email);
  if (!user || user.active === false || !verifyPassword(password, user.password)) {
    noteAttempt(key, false);
    return res.status(401).json({ error: 'That email and password do not match.' });
  }
  noteAttempt(key, true);
  user.lastLoginAt = now();
  save();
  setSession(res, user.id);
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.post('/api/password', requireAuth, (req, res) => {
  const current = String(req.body?.current || '');
  const next = String(req.body?.next || '');
  if (next.length < 8) return res.status(400).json({ error: 'Use at least 8 characters.' });
  if (!verifyPassword(current, req.user.password)) {
    return res.status(400).json({ error: 'Current password is wrong.' });
  }
  req.user.password = hashPassword(next);
  req.user.mustChangePassword = false;
  save();
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * users  (create/edit is admin-only; the roster is readable by all so
 *          reps can see who owns which pin)
 * ------------------------------------------------------------------ */

app.get('/api/users', requireAuth, (req, res) => {
  res.json({ users: data().users.map(publicUser) });
});

app.post('/api/users', requireAdmin, (req, res) => {
  const db = data();
  const name = clean(req.body?.name, 80);
  const email = clean(req.body?.email, 200).toLowerCase();
  const password = String(req.body?.password || '');
  const color = HEX.test(req.body?.color || '') ? req.body.color : '#0071e3';
  const role = req.body?.role === 'admin' ? 'admin' : 'rep';

  if (!name) return res.status(400).json({ error: 'Name is required.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (db.users.some(u => u.email === email)) return res.status(409).json({ error: 'That email is already in use.' });

  const user = {
    id: id(), name, email, password: hashPassword(password),
    role, color, active: true, mustChangePassword: true, createdAt: now(),
  };
  db.users.push(user);
  save();
  res.status(201).json({ user: publicUser(user) });
});

app.patch('/api/users/:id', requireAdmin, (req, res) => {
  const user = findUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'No such user.' });
  const b = req.body || {};

  if (b.name !== undefined) {
    const name = clean(b.name, 80);
    if (!name) return res.status(400).json({ error: 'Name cannot be empty.' });
    user.name = name;
  }
  if (b.email !== undefined) {
    const email = clean(b.email, 200).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });
    if (data().users.some(u => u.email === email && u.id !== user.id)) {
      return res.status(409).json({ error: 'That email is already in use.' });
    }
    user.email = email;
  }
  if (b.color !== undefined) {
    if (!HEX.test(b.color)) return res.status(400).json({ error: 'Color must be a hex value like #0071e3.' });
    user.color = b.color;
  }
  if (b.password) {
    if (String(b.password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    user.password = hashPassword(String(b.password));
    user.mustChangePassword = true;
  }
  if (b.role !== undefined || b.active !== undefined) {
    const nextRole = b.role !== undefined ? (b.role === 'admin' ? 'admin' : 'rep') : user.role;
    const nextActive = b.active !== undefined ? !!b.active : user.active !== false;
    const others = data().users.filter(u => u.id !== user.id && u.role === 'admin' && u.active !== false);
    if (others.length === 0 && (nextRole !== 'admin' || !nextActive)) {
      return res.status(400).json({ error: 'This is the only active admin -- promote someone else first.' });
    }
    user.role = nextRole;
    user.active = nextActive;
  }
  save();
  res.json({ user: publicUser(user) });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const db = data();
  const user = findUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'No such user.' });
  if (user.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
  const admins = db.users.filter(u => u.id !== user.id && u.role === 'admin' && u.active !== false);
  if (user.role === 'admin' && admins.length === 0) {
    return res.status(400).json({ error: 'That is the only admin account.' });
  }

  // Deleting a rep must never delete their territory. Pins and notes are kept
  // and simply become unassigned, so the history survives.
  backup(`before-delete-${user.email}`);
  for (const loc of db.locations) if (loc.repId === user.id) loc.repId = null;
  db.users = db.users.filter(u => u.id !== user.id);
  save();
  res.json({ ok: true, unassigned: db.locations.filter(l => l.repId === null).length });
});

/* ------------------------------------------------------------------ *
 * place lookup
 * ------------------------------------------------------------------ */

app.post('/api/resolve', requireAuth, wrap(async (req, res) => {
  try {
    res.json({ place: await resolvePlace(req.body?.input) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.post('/api/reverse', requireAuth, wrap(async (req, res) => {
  const lat = Number(req.body?.lat), lng = Number(req.body?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: 'Need a lat and lng.' });
  }
  res.json({ place: await reverseGeocode(lat, lng).catch(() => null) });
}));

/* ------------------------------------------------------------------ *
 * locations
 * ------------------------------------------------------------------ */

app.get('/api/locations', requireAuth, (req, res) => {
  res.json({ locations: data().locations.map(shapeLocation) });
});

app.post('/api/locations', requireAuth, (req, res) => {
  const db = data();
  const b = req.body || {};
  const name = clean(b.name, 160);
  const lat = Number(b.lat), lng = Number(b.lng);

  if (!name) return res.status(400).json({ error: 'Give the location a name.' });
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: 'This location has no map position yet.' });
  }
  const status = STATUSES.includes(b.status) ? b.status : 'prospect';

  // The rep is whoever is signed in. Only an admin may file a pin under
  // someone else, which is what the optional repId is for.
  let repId = req.user.id;
  if (b.repId && req.user.role === 'admin') {
    repId = findUser(b.repId) ? b.repId : req.user.id;
  }

  const loc = {
    id: id(),
    name,
    address: clean(b.address, 300),
    lat, lng,
    googleUrl: clean(b.googleUrl, 1000),
    reviewUrl: clean(b.reviewUrl, 1000),
    placeId: clean(b.placeId, 200) || null,
    status,
    repId,
    createdBy: req.user.id,
    createdAt: now(),
    updatedAt: now(),
    updatedBy: req.user.id,
  };
  db.locations.push(loc);

  const firstNote = clean(b.note, 5000);
  if (firstNote) {
    db.notes.push({
      id: id(), locationId: loc.id, title: 'First visit', body: firstNote,
      authorId: req.user.id, createdAt: now(), updatedAt: now(), updatedBy: req.user.id,
    });
  }
  save();
  res.status(201).json({ location: shapeLocation(loc) });
});

app.patch('/api/locations/:id', requireAuth, (req, res) => {
  const loc = data().locations.find(l => l.id === req.params.id);
  if (!loc) return res.status(404).json({ error: 'No such location.' });
  const b = req.body || {};

  // Anyone signed in may rename, re-status or re-position a pin -- the team
  // shares one map.
  if (b.name !== undefined) {
    const name = clean(b.name, 160);
    if (!name) return res.status(400).json({ error: 'Name cannot be empty.' });
    loc.name = name;
  }
  if (b.address !== undefined) loc.address = clean(b.address, 300);
  if (b.googleUrl !== undefined) loc.googleUrl = clean(b.googleUrl, 1000);
  if (b.reviewUrl !== undefined) loc.reviewUrl = clean(b.reviewUrl, 1000);
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) return res.status(400).json({ error: 'Unknown status.' });
    loc.status = b.status;
  }
  if (b.lat !== undefined && b.lng !== undefined) {
    const lat = Number(b.lat), lng = Number(b.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'Bad coordinates.' });
    }
    loc.lat = lat; loc.lng = lng;
  }

  // Reassigning a pin to a different rep is Alex's call alone.
  if (b.repId !== undefined) {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only an admin can change which rep covers a location.' });
    }
    if (b.repId === null || b.repId === '') loc.repId = null;
    else if (findUser(b.repId)) loc.repId = b.repId;
    else return res.status(400).json({ error: 'No such rep.' });
  }

  loc.updatedAt = now();
  loc.updatedBy = req.user.id;
  save();
  res.json({ location: shapeLocation(loc) });
});

app.delete('/api/locations/:id', requireAuth, (req, res) => {
  const db = data();
  const loc = db.locations.find(l => l.id === req.params.id);
  if (!loc) return res.status(404).json({ error: 'No such location.' });
  // A rep can clean up their own mistakes; an admin can remove anything.
  if (req.user.role !== 'admin' && loc.createdBy !== req.user.id) {
    return res.status(403).json({ error: 'You can only delete locations you added.' });
  }
  db.locations = db.locations.filter(l => l.id !== loc.id);
  db.notes = db.notes.filter(n => n.locationId !== loc.id);
  save();
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * notes  -- read-only on open, editable by anyone on the team
 * ------------------------------------------------------------------ */

app.get('/api/locations/:id/notes', requireAuth, (req, res) => {
  const notes = data().notes
    .filter(n => n.locationId === req.params.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(shapeNote);
  res.json({ notes });
});

app.post('/api/locations/:id/notes', requireAuth, (req, res) => {
  const db = data();
  if (!db.locations.some(l => l.id === req.params.id)) {
    return res.status(404).json({ error: 'No such location.' });
  }
  const body = clean(req.body?.body, 20000);
  if (!body) return res.status(400).json({ error: 'The note is empty.' });
  const note = {
    id: id(),
    locationId: req.params.id,
    title: clean(req.body?.title, 120) || 'Note',
    body,
    authorId: req.user.id,
    createdAt: now(),
    updatedAt: now(),
    updatedBy: req.user.id,
  };
  db.notes.push(note);
  save();
  res.status(201).json({ note: shapeNote(note) });
});

app.patch('/api/notes/:id', requireAuth, (req, res) => {
  const note = data().notes.find(n => n.id === req.params.id);
  if (!note) return res.status(404).json({ error: 'No such note.' });
  if (req.body?.title !== undefined) note.title = clean(req.body.title, 120) || 'Note';
  if (req.body?.body !== undefined) {
    const body = clean(req.body.body, 20000);
    if (!body) return res.status(400).json({ error: 'The note is empty.' });
    note.body = body;
  }
  note.updatedAt = now();
  note.updatedBy = req.user.id;
  save();
  res.json({ note: shapeNote(note) });
});

app.delete('/api/notes/:id', requireAuth, (req, res) => {
  const db = data();
  const note = db.notes.find(n => n.id === req.params.id);
  if (!note) return res.status(404).json({ error: 'No such note.' });
  if (req.user.role !== 'admin' && note.authorId !== req.user.id) {
    return res.status(403).json({ error: 'You can only delete notes you wrote.' });
  }
  db.notes = db.notes.filter(n => n.id !== note.id);
  save();
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * inquiries  -- the public contact form. Open to the world, so it is
 *               throttled and validated tightly; only admins can read it.
 * ------------------------------------------------------------------ */

const inquiryHits = new Map();
function inquiryThrottled(ip) {
  const now = Date.now();
  const hits = (inquiryHits.get(ip) || []).filter(t => now - t < 3600_000);
  hits.push(now);
  inquiryHits.set(ip, hits);
  if (inquiryHits.size > 5000) inquiryHits.clear();  // crude cap on memory
  return hits.length > 5;
}

app.post('/api/inquiry', (req, res) => {
  const b = req.body || {};

  // Honeypot: a real person never fills a field they cannot see.
  if (clean(b.website, 200)) return res.json({ ok: true });

  const name = clean(b.name, 80);
  const email = clean(b.email, 200).toLowerCase();
  const message = clean(b.message, 4000);

  if (!name) return res.status(400).json({ error: 'Please add your name.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Please add a valid email so we can reply.' });
  }
  if (!message) return res.status(400).json({ error: 'Tell us a little about your business.' });

  if (inquiryThrottled(req.ip)) {
    return res.status(429).json({ error: 'That is a few too many messages. Email us directly instead.' });
  }

  const db = data();
  db.inquiries = db.inquiries || [];
  db.inquiries.push({
    id: id(),
    name,
    email,
    business: clean(b.business, 120),
    phone: clean(b.phone, 40),
    message,
    handled: false,
    createdAt: now(),
  });
  save();
  res.status(201).json({ ok: true });
});

app.get('/api/inquiries', requireAdmin, (req, res) => {
  const list = (data().inquiries || [])
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ inquiries: list });
});

app.patch('/api/inquiries/:id', requireAdmin, (req, res) => {
  const row = (data().inquiries || []).find(e => e.id === req.params.id);
  if (!row) return res.status(404).json({ error: 'No such inquiry.' });
  if (req.body?.handled !== undefined) row.handled = !!req.body.handled;
  save();
  res.json({ inquiry: row });
});

app.delete('/api/inquiries/:id', requireAdmin, (req, res) => {
  const db = data();
  db.inquiries = (db.inquiries || []).filter(e => e.id !== req.params.id);
  save();
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * pages + static
 * ------------------------------------------------------------------ */

const page = file => (req, res) => res.sendFile(path.join(__dirname, 'public', file));

const requirePage = (file, adminOnly = false) => (req, res) => {
  if (!req.user) return res.redirect('/signin');
  if (adminOnly && req.user.role !== 'admin') return res.redirect('/map');
  page(file)(req, res);
};

// The public site is the front door; the tool lives behind /map.
app.get('/', page('index.html'));
app.get('/signin', (req, res) => (req.user ? res.redirect('/map') : page('signin.html')(req, res)));
app.get('/map', requirePage('app.html'));
app.get('/team', requirePage('team.html', true));
app.get('/leads', requirePage('leads.html', true));

app.use(express.static(path.join(__dirname, 'public'), { index: false, extensions: [] }));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Unknown endpoint.' });
  res.redirect('/');
});

app.use((err, req, res, _next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

/* ------------------------------------------------------------------ */

const seeded = ensureAdmin();
app.listen(PORT, () => {
  console.log(`\n  Five Star Tap  ->  http://localhost:${PORT}\n`);
  if (seeded) {
    console.log('  First run: an admin account was created.');
    console.log(`    email    ${seeded.email}`);
    console.log(`    password ${seeded.password}`);
    if (seeded.generated) console.log('  This password is shown once. Change it after signing in.\n');
    else console.log('');
  }
});
