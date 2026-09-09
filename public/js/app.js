import {
  api, $, $$, el, esc, toast, initials, inkOn, timeAgo,
  currentTheme, nextTheme, ICON,
} from './core.js';

/* ==========================================================================
   State
   ========================================================================== */

const STATUS = {
  prospect:  { label: 'Prospect',  color: '#86868b' },
  visited:   { label: 'Visited',   color: '#b25000' },
  installed: { label: 'Installed', color: '#1d8a4e' },
  declined:  { label: 'Declined',  color: '#d13438' },
};

const state = {
  me: null,
  users: [],
  locations: [],
  selectedId: null,
  query: '',
  reps: new Set(),      // empty = all
  statuses: new Set(),  // empty = all
  placing: false,       // "click the map to drop a pin" mode
};

/* Safari and Chrome support contenteditable="plaintext-only"; older Firefox
   does not, and silently renders the element uneditable. Detect once. */
const PLAINTEXT_EDIT = (() => {
  const probe = document.createElement('div');
  probe.setAttribute('contenteditable', 'plaintext-only');
  return probe.contentEditable === 'plaintext-only';
})();

const markers = new Map();
let map, tileLayer, meMarker, meCircle, watchId = null;

const userById = id => state.users.find(u => u.id === id) || null;
const repColor = id => userById(id)?.color || '#86868b';
const repName  = id => userById(id)?.name || 'Unassigned';
const isAdmin  = () => state.me?.role === 'admin';

function visibleLocations() {
  const q = state.query.toLowerCase();
  return state.locations
    .filter(l => !q || l.name.toLowerCase().includes(q) || (l.address || '').toLowerCase().includes(q))
    .filter(l => !state.reps.size || state.reps.has(l.repId || 'none'))
    .filter(l => !state.statuses.size || state.statuses.has(l.status))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

/* ==========================================================================
   Map
   ========================================================================== */

/* Basemap comes from the server so it can be swapped per deployment
   (see TILE_LIGHT / TILE_DARK in the README) without a rebuild. */
let tiles = {
  light: 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  dark:  'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  attribution: 'Tiles &copy; Esri',
  maxZoom: 19,
  maxNativeZoom: 16,
};

/* Overridden by /api/config; see MAP_LAT / MAP_LNG / MAP_ZOOM. */
let home = { lat: 41.20, lng: -73.70, zoom: 10 };

const prefersDark = () => matchMedia('(prefers-color-scheme: dark)').matches;
const isDark = () => {
  const t = currentTheme();
  return t === 'dark' || (t === 'system' && prefersDark());
};

function initMap() {
  map = L.map('map', {
    zoomControl: true,
    attributionControl: true,
    worldCopyJump: true,
  }).setView([home.lat, home.lng], home.zoom);

  L.control.zoom({ position: 'bottomright' });
  map.zoomControl.setPosition('bottomright');

  tileLayer = L.tileLayer(isDark() ? tiles.dark : tiles.light, {
    attribution: tiles.attribution,
    maxZoom: tiles.maxZoom,
    // Above maxNativeZoom Leaflet upscales the deepest real tile instead of
    // requesting one the provider does not have. detectRetina is deliberately
    // off: it adds a zoom offset to every request, which would push us past
    // that ceiling again and bring back "Map data not yet available".
    maxNativeZoom: tiles.maxNativeZoom,
  }).addTo(map);

  map.on('click', (event) => {
    if (!state.placing) return;
    setPlacing(false);
    openAddModal({ lat: event.latlng.lat, lng: event.latlng.lng, fromMap: true });
  });
}

function refreshTiles() {
  if (tileLayer) tileLayer.setUrl(isDark() ? tiles.dark : tiles.light);
}

function markerIcon(loc, active) {
  return L.divIcon({
    className: '',
    html: `<span class="pin st-${esc(loc.status)}${active ? ' is-active' : ''}" style="--rep:${esc(repColor(loc.repId))}"><i></i></span>`,
    iconSize: [20, 20],
    iconAnchor: [10, 26],
    popupAnchor: [0, -24],
  });
}

function syncMarkers() {
  const shown = new Set(visibleLocations().map(l => l.id));

  for (const [id, marker] of markers) {
    if (!shown.has(id)) { map.removeLayer(marker); markers.delete(id); }
  }

  for (const loc of visibleLocations()) {
    if (loc.lat == null || loc.lng == null) continue;
    const active = loc.id === state.selectedId;
    let marker = markers.get(loc.id);
    if (!marker) {
      marker = L.marker([loc.lat, loc.lng], {
        icon: markerIcon(loc, active),
        title: loc.name,
        riseOnHover: true,
        keyboard: true,
        alt: `${loc.name} — ${STATUS[loc.status]?.label ?? loc.status}`,
      }).addTo(map);
      marker.on('click', () => select(loc.id, { pan: false }));
      markers.set(loc.id, marker);
    } else {
      marker.setLatLng([loc.lat, loc.lng]);
      marker.setIcon(markerIcon(loc, active));
    }
  }
}

function fitAll(animate = true) {
  const pts = visibleLocations().filter(l => l.lat != null).map(l => [l.lat, l.lng]);
  if (!pts.length) return;
  map.invalidateSize();
  // A background or hidden tab reports a zero-sized container, and fitting
  // against that lands on a world-level zoom. Wait for a real size instead.
  if (map.getSize().x < 50) {
    map.once('resize', () => fitAll(false));
    return;
  }
  if (pts.length === 1) return map.setView(pts[0], 16, { animate });
  map.fitBounds(L.latLngBounds(pts).pad(0.16), { animate, maxZoom: 16 });
}

function setPlacing(on) {
  state.placing = on;
  const hint = $('#hint');
  hint.hidden = !on;
  $('#hint-text').textContent = 'Click anywhere on the map to drop the pin.';
  $('#map').style.cursor = on ? 'crosshair' : '';
}

/* ---------- geolocation ---------- */

function toggleLocate() {
  const btn = $('#locate-btn');
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
    if (meMarker) { map.removeLayer(meMarker); meMarker = null; }
    if (meCircle) { map.removeLayer(meCircle); meCircle = null; }
    btn.setAttribute('aria-pressed', 'false');
    return;
  }
  if (!navigator.geolocation) return toast('This browser cannot share a location.', 'err');

  btn.setAttribute('aria-pressed', 'true');
  let first = true;

  watchId = navigator.geolocation.watchPosition(
    ({ coords }) => {
      const point = [coords.latitude, coords.longitude];
      if (!meMarker) {
        meMarker = L.marker(point, {
          icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
          interactive: false,
          zIndexOffset: 1000,
        }).addTo(map);
        meCircle = L.circle(point, {
          radius: coords.accuracy, weight: 1,
          color: '#0071e3', fillColor: '#0071e3', fillOpacity: 0.07, interactive: false,
        }).addTo(map);
      } else {
        meMarker.setLatLng(point);
        meCircle.setLatLng(point).setRadius(coords.accuracy);
      }
      if (first) { map.setView(point, Math.max(map.getZoom(), 15)); first = false; }
    },
    (err) => {
      btn.setAttribute('aria-pressed', 'false');
      watchId = null;
      toast(err.code === err.PERMISSION_DENIED
        ? 'Location access was blocked. Allow it in your browser settings.'
        : 'Could not get your location.', 'err');
    },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 },
  );
}

/* ==========================================================================
   Rail
   ========================================================================== */

function renderStats() {
  const all = state.locations;
  const counts = {
    all: all.length,
    installed: all.filter(l => l.status === 'installed').length,
    visited: all.filter(l => l.status === 'visited').length,
    mine: all.filter(l => l.repId === state.me.id).length,
  };
  $('#stats').replaceChildren(
    ...[
      ['Total', counts.all],
      ['Installed', counts.installed],
      ['Visited', counts.visited],
      ['Mine', counts.mine],
    ].map(([k, v]) => el('div', { class: 'stat' },
      el('div', { class: 'v' }, String(v)),
      el('div', { class: 'k' }, k),
    )),
  );
}

function renderFilters() {
  const host = $('#filters');
  const nodes = [];

  for (const [key, meta] of Object.entries(STATUS)) {
    const n = state.locations.filter(l => l.status === key).length;
    nodes.push(el('button', {
      class: 'chip',
      type: 'button',
      'aria-pressed': String(state.statuses.has(key)),
      onclick: () => { toggle(state.statuses, key); render(); },
    },
      el('span', { class: 'dot', style: { background: meta.color } }),
      meta.label,
      el('span', { class: 'n' }, String(n)),
    ));
  }

  const reps = state.users.filter(u => state.locations.some(l => l.repId === u.id) || u.active);
  for (const user of reps) {
    const n = state.locations.filter(l => l.repId === user.id).length;
    nodes.push(el('button', {
      class: 'chip',
      type: 'button',
      'aria-pressed': String(state.reps.has(user.id)),
      onclick: () => { toggle(state.reps, user.id); render(); },
    },
      el('span', { class: 'dot', style: { background: user.color } }),
      user.id === state.me.id ? 'Me' : user.name.split(' ')[0],
      el('span', { class: 'n' }, String(n)),
    ));
  }

  const orphans = state.locations.filter(l => !l.repId).length;
  if (orphans) {
    nodes.push(el('button', {
      class: 'chip', type: 'button',
      'aria-pressed': String(state.reps.has('none')),
      onclick: () => { toggle(state.reps, 'none'); render(); },
    },
      el('span', { class: 'dot', style: { background: 'var(--line-2)' } }),
      'Unassigned',
      el('span', { class: 'n' }, String(orphans)),
    ));
  }

  host.replaceChildren(...nodes);
}

function toggle(set, key) {
  set.has(key) ? set.delete(key) : set.add(key);
}

function renderList() {
  const host = $('#list');
  const items = visibleLocations();

  if (!items.length) {
    const blank = !state.locations.length;
    host.replaceChildren(el('div', { class: 'empty' },
      el('div', { html: ICON.pin }),
      el('div', { class: 't' }, blank ? 'No locations yet' : 'Nothing matches'),
      el('div', { class: 'd' }, blank
        ? 'Paste a Google listing link to put your first business on the map.'
        : 'Try clearing the search or the filters above.'),
    ));
    return;
  }

  host.replaceChildren(...items.map(loc => el('button', {
    class: 'loc',
    type: 'button',
    'aria-current': String(loc.id === state.selectedId),
    style: { '--rep': repColor(loc.repId) },
    onclick: () => select(loc.id),
  },
    el('div', { class: 'r1' },
      el('span', { class: 'nm' }, loc.name),
      el('span', { class: `pill pill-${loc.status}` }, STATUS[loc.status]?.label ?? loc.status),
    ),
    loc.address && el('div', { class: 'ad' }, loc.address),
    el('div', { class: 'r2' },
      el('span', { class: 'rep' },
        el('span', { class: 'dot', style: { background: repColor(loc.repId) } }),
        repName(loc.repId),
      ),
      loc.noteCount > 0 && el('span', { class: 'rep' },
        `${loc.noteCount} note${loc.noteCount === 1 ? '' : 's'}`),
    ),
  )));
}

/* ==========================================================================
   Drawer
   ========================================================================== */

async function select(id, { pan = true } = {}) {
  state.selectedId = id;
  render();

  const loc = state.locations.find(l => l.id === id);
  if (!loc) return closeDrawer();
  if (pan && loc.lat != null) {
    map.setView([loc.lat, loc.lng], Math.max(map.getZoom(), 16), { animate: true });
  }
  await openDrawer(loc);
}

function closeDrawer() {
  const drawer = $('#drawer');
  drawer.classList.remove('open');
  state.selectedId = null;
  setTimeout(() => { if (!state.selectedId) drawer.hidden = true; }, 320);
  renderList();
  syncMarkers();
}

async function openDrawer(loc) {
  const drawer = $('#drawer');
  drawer.hidden = false;
  requestAnimationFrame(() => drawer.classList.add('open'));
  drawer.replaceChildren(...drawerContent(loc));

  // Notes load after the shell so the panel opens instantly.
  try {
    const { notes } = await api(`/api/locations/${loc.id}/notes`);
    if (state.selectedId !== loc.id) return;
    renderNotes(loc, notes);
  } catch (e) {
    toast(e.message, 'err');
  }
}

function drawerContent(loc) {
  const head = el('div', { class: 'drawer-head' },
    el('div', { class: 'top' },
      el('h2', {
        class: 'drawer-title',
        // plaintext-only keeps pasted rich text out; browsers without it fall
        // back to a plain editable box (we read textContent either way).
        contenteditable: PLAINTEXT_EDIT ? 'plaintext-only' : 'true',
        spellcheck: 'false',
        role: 'textbox',
        'aria-label': 'Location name — anyone can edit',
        onblur: (ev) => renameLocation(loc, ev.target),
        onpaste: PLAINTEXT_EDIT ? null : (ev) => {
          ev.preventDefault();
          const text = (ev.clipboardData || window.clipboardData).getData('text');
          document.execCommand('insertText', false, text.replace(/\s+/g, ' '));
        },
        onkeydown: (ev) => {
          if (ev.key === 'Enter') { ev.preventDefault(); ev.target.blur(); }
          if (ev.key === 'Escape') { ev.target.textContent = loc.name; ev.target.blur(); }
        },
      }, loc.name),
      el('button', {
        class: 'icon-btn', type: 'button', 'aria-label': 'Close', html: ICON.close,
        onclick: closeDrawer,
      }),
    ),
    el('p', { class: 'drawer-sub' }, loc.address || 'No address on file'),
  );

  const body = el('div', { class: 'drawer-body scroll' },
    statusSection(loc),
    repSection(loc),
    detailSection(loc),
    el('div', { class: 'sect', id: 'notes-sect' },
      el('div', { class: 'sect-title' },
        el('span', {}, 'Notes'),
        el('button', {
          class: 'btn btn-sm', type: 'button',
          onclick: () => addNoteEditor(loc),
        }, 'Add note'),
      ),
      el('div', { id: 'notes-host' },
        el('div', { class: 'empty', style: { padding: '18px 0' } }, 'Loading…')),
    ),
    dangerSection(loc),
  );

  return [head, body];
}

function statusSection(loc) {
  return el('div', { class: 'sect' },
    el('div', { class: 'sect-title' }, el('span', {}, 'Coverage')),
    el('div', { class: 'status-grid' },
      ...Object.entries(STATUS).map(([key, meta]) => el('button', {
        class: 'status-opt', type: 'button',
        'aria-pressed': String(loc.status === key),
        onclick: () => patchLocation(loc, { status: key }),
      },
        el('span', { class: 'dot', style: { background: meta.color } }),
        meta.label,
      )),
    ),
  );
}

function repSection(loc) {
  const body = isAdmin()
    ? el('select', {
        'aria-label': 'Sales rep',
        onchange: (ev) => patchLocation(loc, { repId: ev.target.value || null }),
      },
        el('option', { value: '', selected: !loc.repId }, 'Unassigned'),
        ...state.users.map(u => el('option',
          { value: u.id, selected: loc.repId === u.id },
          `${u.name}${u.active === false ? ' (inactive)' : ''}`)),
      )
    : el('div', { style: { display: 'flex', alignItems: 'center', gap: '9px' } },
        el('span', { class: 'dot', style: {
          width: '10px', height: '10px', borderRadius: '1px', background: repColor(loc.repId),
        } }),
        el('span', { style: { fontSize: '13.5px', fontWeight: '500' } }, repName(loc.repId)),
      );

  return el('div', { class: 'sect' },
    el('div', { class: 'sect-title' },
      el('span', {}, 'Covered by'),
      !isAdmin() && el('span', { class: 'locked' },
        el('span', { html: ICON.lock }), 'Alex only'),
    ),
    body,
  );
}

function detailSection(loc) {
  const rows = [];
  if (loc.googleUrl) {
    rows.push(el('dt', {}, 'Google'),
      el('dd', {}, el('a', { href: loc.googleUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Open listing')));
  }
  if (loc.reviewUrl) {
    rows.push(el('dt', {}, 'Review link'),
      el('dd', {}, el('a', { href: loc.reviewUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Write-a-review page')));
  }
  rows.push(el('dt', {}, 'Added'),
    el('dd', {}, `${timeAgo(loc.createdAt)} by ${repName(loc.createdBy)}`));
  rows.push(el('dt', {}, 'Updated'), el('dd', {}, timeAgo(loc.updatedAt)));
  if (loc.lat != null) {
    rows.push(el('dt', {}, 'Position'),
      el('dd', {}, `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}`));
  }

  return el('div', { class: 'sect' },
    el('div', { class: 'sect-title' },
      el('span', {}, 'Details'),
      el('button', {
        class: 'btn btn-sm', type: 'button',
        onclick: () => editAddress(loc),
      }, 'Edit address'),
    ),
    el('dl', { class: 'kv' }, ...rows),
  );
}

function dangerSection(loc) {
  const mayDelete = isAdmin() || loc.createdBy === state.me.id;
  if (!mayDelete) return null;
  return el('div', { class: 'sect' },
    el('button', {
      class: 'btn btn-danger btn-block', type: 'button',
      onclick: async () => {
        if (!confirm(`Delete "${loc.name}" and all of its notes? This cannot be undone.`)) return;
        try {
          await api(`/api/locations/${loc.id}`, { method: 'DELETE' });
          state.locations = state.locations.filter(l => l.id !== loc.id);
          closeDrawer();
          render();
          toast('Location deleted');
        } catch (e) { toast(e.message, 'err'); }
      },
    }, 'Delete location'),
  );
}

/* ---------- notes ---------- */

function renderNotes(loc, notes) {
  const host = $('#notes-host');
  if (!host) return;
  if (!notes.length) {
    host.replaceChildren(el('div', { class: 'empty', style: { padding: '14px 0' } },
      el('div', { class: 'd' }, 'No notes yet. Anyone on the team can add one.')));
    return;
  }
  host.replaceChildren(...notes.map(note => noteCard(loc, note)));
}

/** Notes open read-only; the Edit button swaps in an editor in place. */
function noteCard(loc, note) {
  const card = el('div', { class: 'note' },
    el('div', { class: 'note-head' },
      el('div', { class: 'note-title' }, note.title),
      el('div', { class: 'note-actions' },
        el('button', {
          class: 'icon-btn', type: 'button', title: 'Edit note',
          'aria-label': `Edit note "${note.title}"`, html: ICON.pencil,
          onclick: () => card.replaceWith(noteEditor(loc, note)),
        }),
        (isAdmin() || note.authorId === state.me.id) && el('button', {
          class: 'icon-btn', type: 'button', title: 'Delete note',
          'aria-label': `Delete note "${note.title}"`, html: ICON.trash,
          onclick: async () => {
            if (!confirm('Delete this note?')) return;
            try {
              await api(`/api/notes/${note.id}`, { method: 'DELETE' });
              card.remove();
              bumpNoteCount(loc, -1);
              if (!$('#notes-host').children.length) renderNotes(loc, []);
            } catch (e) { toast(e.message, 'err'); }
          },
        }),
      ),
    ),
    el('div', { class: 'note-body' }, note.body),
    el('div', { class: 'note-meta' },
      note.updatedByName && note.updatedAt !== note.createdAt
        ? `${note.authorName} · edited by ${note.updatedByName} ${timeAgo(note.updatedAt)}`
        : `${note.authorName} · ${timeAgo(note.createdAt)}`),
  );
  return card;
}

function noteEditor(loc, note) {
  const title = el('input', { type: 'text', value: note?.title ?? '', placeholder: 'Note title', maxlength: '120' });
  const body = el('textarea', { placeholder: 'What happened on this visit?', maxlength: '20000' }, note?.body ?? '');
  const msg = el('div', { class: 'msg msg-error', hidden: true });

  const wrap = el('div', { class: 'note note-edit' }, msg, title, body,
    el('div', { class: 'row' },
      el('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: save }, 'Save'),
      el('button', {
        class: 'btn btn-sm', type: 'button',
        onclick: () => {
          if (note) wrap.replaceWith(noteCard(loc, note));
          else { wrap.remove(); if (!$('#notes-host').children.length) renderNotes(loc, []); }
        },
      }, 'Cancel'),
    ),
  );

  async function save() {
    const payload = { title: title.value.trim(), body: body.value.trim() };
    if (!payload.body) {
      msg.textContent = 'Write something first.'; msg.hidden = false; return;
    }
    try {
      const saved = note
        ? (await api(`/api/notes/${note.id}`, { method: 'PATCH', body: payload })).note
        : (await api(`/api/locations/${loc.id}/notes`, { method: 'POST', body: payload })).note;
      wrap.replaceWith(noteCard(loc, saved));
      if (!note) bumpNoteCount(loc, 1);
      toast(note ? 'Note updated' : 'Note added');
    } catch (e) {
      msg.textContent = e.message; msg.hidden = false;
    }
  }

  setTimeout(() => (note ? body : title).focus(), 0);
  return wrap;
}

function addNoteEditor(loc) {
  const host = $('#notes-host');
  if (host.querySelector('.empty')) host.replaceChildren();
  host.prepend(noteEditor(loc, null));
}

function bumpNoteCount(loc, delta) {
  loc.noteCount = Math.max(0, (loc.noteCount || 0) + delta);
  renderList();
}

/* ---------- mutations ---------- */

async function patchLocation(loc, body) {
  try {
    const { location } = await api(`/api/locations/${loc.id}`, { method: 'PATCH', body });
    Object.assign(loc, location);
    const idx = state.locations.findIndex(l => l.id === loc.id);
    if (idx > -1) state.locations[idx] = loc;
    render();
    await openDrawer(loc);
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function renameLocation(loc, node) {
  const name = node.textContent.trim();
  if (!name) { node.textContent = loc.name; return; }
  if (name === loc.name) return;
  try {
    const { location } = await api(`/api/locations/${loc.id}`, { method: 'PATCH', body: { name } });
    Object.assign(loc, location);
    render();
    toast('Renamed');
  } catch (e) {
    node.textContent = loc.name;
    toast(e.message, 'err');
  }
}

async function editAddress(loc) {
  const next = prompt('Address for this location:', loc.address || '');
  if (next === null) return;
  await patchLocation(loc, { address: next.trim() });
}

/* ==========================================================================
   Add location
   ========================================================================== */

function openAddModal(seed = {}) {
  let mode = seed.fromMap ? 'manual' : 'link';
  let place = null;

  const overlay = $('#overlay');
  const msg = el('div', { class: 'msg msg-error', hidden: true });
  const preview = el('div');

  const linkInput = el('input', {
    type: 'url', placeholder: 'https://maps.app.goo.gl/…',
    autocomplete: 'off', spellcheck: 'false',
  });
  const nameInput = el('input', { type: 'text', placeholder: 'Business name', maxlength: '160', value: seed.name || '' });
  const addrInput = el('input', { type: 'text', placeholder: 'Street, city, ZIP', maxlength: '300', value: seed.address || '' });
  const noteInput = el('textarea', { placeholder: 'Optional first note — who you spoke to, what they said…' });
  const statusSel = el('select', {},
    ...Object.entries(STATUS).map(([k, m]) => el('option', { value: k, selected: k === 'prospect' }, m.label)));

  let lat = seed.lat ?? null, lng = seed.lng ?? null;

  const importBtn = el('button', { class: 'btn btn-primary', type: 'button', onclick: doImport }, 'Import');
  const saveBtn = el('button', { class: 'btn btn-primary', type: 'button', onclick: doSave }, 'Add to map');

  const linkPane = el('div', {},
    el('label', { class: 'field' },
      el('span', { class: 'label' }, 'Google link'),
      el('div', { style: { display: 'flex', gap: '6px' } }, linkInput, importBtn),
      el('span', { class: 'hint' },
        'Paste a Maps share link, a g.page review link, or a “write a review” URL. ' +
        'The name, address and pin are pulled in automatically.'),
    ),
  );

  const manualPane = el('div', { hidden: true },
    el('label', { class: 'field' },
      el('span', { class: 'label' }, 'Business name'), nameInput),
    el('label', { class: 'field' },
      el('span', { class: 'label' }, 'Address'),
      el('div', { style: { display: 'flex', gap: '6px' } }, addrInput,
        el('button', { class: 'btn', type: 'button', onclick: doGeocode }, 'Find')),
      el('span', { class: 'hint' }, seed.fromMap
        ? 'Pin position is taken from where you clicked. Add an address if you have one.'
        : 'We look the address up to place the pin.'),
    ),
  );

  const tabs = el('div', { class: 'tabs', role: 'tablist' },
    el('button', {
      class: 'tab', role: 'tab', type: 'button', 'aria-selected': String(mode === 'link'),
      onclick: () => setMode('link'),
    }, 'Google link'),
    el('button', {
      class: 'tab', role: 'tab', type: 'button', 'aria-selected': String(mode === 'manual'),
      onclick: () => setMode('manual'),
    }, 'Name & address'),
  );

  function setMode(next) {
    mode = next;
    $$('.tab', tabs).forEach((t, i) =>
      t.setAttribute('aria-selected', String((i === 0) === (next === 'link'))));
    linkPane.hidden = next !== 'link';
    manualPane.hidden = next === 'link';
    setTimeout(() => (next === 'link' ? linkInput : nameInput).focus(), 0);
  }

  function showPreview() {
    if (lat == null && !nameInput.value) { preview.replaceChildren(); return; }
    preview.replaceChildren(el('div', { class: 'preview' },
      el('div', { class: 'nm' }, nameInput.value || 'Untitled location'),
      addrInput.value && el('div', { class: 'ad' }, addrInput.value),
      lat != null
        ? el('div', { class: 'co' }, `${lat.toFixed(5)}, ${lng.toFixed(5)}`)
        : el('div', { class: 'co' }, 'No position yet'),
    ));
  }

  function busy(btn, on, label) {
    btn.disabled = on;
    btn.replaceChildren(on ? el('span', { class: 'spin' }) : document.createTextNode(label));
  }

  async function doImport() {
    const input = linkInput.value.trim();
    if (!input) { msg.textContent = 'Paste a link first.'; msg.hidden = false; return; }
    msg.hidden = true;
    busy(importBtn, true, 'Import');
    try {
      place = (await api('/api/resolve', { method: 'POST', body: { input } })).place;
      nameInput.value = place.name || '';
      addrInput.value = place.address || '';
      lat = place.lat; lng = place.lng;
      showPreview();
      setMode('manual');
      if (place.warnings?.length) {
        msg.className = 'msg msg-warn';
        msg.textContent = place.warnings.join(' ');
        msg.hidden = false;
      }
    } catch (e) {
      msg.className = 'msg msg-error';
      msg.textContent = e.message;
      msg.hidden = false;
    } finally {
      busy(importBtn, false, 'Import');
    }
  }

  async function doGeocode() {
    const query = [nameInput.value, addrInput.value].filter(Boolean).join(', ');
    if (!query) { msg.textContent = 'Enter a name or address first.'; msg.hidden = false; return; }
    msg.hidden = true;
    try {
      const found = (await api('/api/resolve', { method: 'POST', body: { input: query } })).place;
      lat = found.lat; lng = found.lng;
      if (!addrInput.value) addrInput.value = found.address || '';
      showPreview();
    } catch (e) {
      msg.className = 'msg msg-error';
      msg.textContent = e.message;
      msg.hidden = false;
    }
  }

  async function doSave() {
    const name = nameInput.value.trim();
    if (!name) { setMode('manual'); msg.className = 'msg msg-error'; msg.textContent = 'Give the location a name.'; msg.hidden = false; return; }
    if (lat == null) {
      msg.className = 'msg msg-error';
      msg.textContent = 'No map position yet — press Find, or close this and click the map to drop a pin.';
      msg.hidden = false;
      return;
    }
    busy(saveBtn, true, 'Add to map');
    try {
      const { location } = await api('/api/locations', {
        method: 'POST',
        body: {
          name, address: addrInput.value.trim(), lat, lng,
          googleUrl: place?.googleUrl || '', reviewUrl: place?.reviewUrl || '',
          placeId: place?.placeId || null,
          status: statusSel.value,
          note: noteInput.value.trim(),
        },
      });
      state.locations.push(location);
      close();
      render();
      await select(location.id);
      toast('Added to the map');
    } catch (e) {
      msg.className = 'msg msg-error';
      msg.textContent = e.message;
      msg.hidden = false;
      busy(saveBtn, false, 'Add to map');
    }
  }

  function close() {
    overlay.hidden = true;
    overlay.replaceChildren();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(ev) { if (ev.key === 'Escape') close(); }

  linkInput.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); doImport(); } });
  addrInput.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); doGeocode(); } });
  nameInput.addEventListener('input', showPreview);
  addrInput.addEventListener('input', showPreview);

  const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Add location' },
    el('div', { class: 'modal-head' },
      el('h2', {}, 'Add a location'),
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', html: ICON.close, onclick: close }),
    ),
    el('div', { class: 'modal-body' },
      tabs, msg, linkPane, manualPane, preview,
      el('label', { class: 'field', style: { marginTop: '16px' } },
        el('span', { class: 'label' }, 'Status'), statusSel),
      el('label', { class: 'field' },
        el('span', { class: 'label' }, 'First note'), noteInput),
      el('div', { class: 'hint', style: { fontSize: '12px', color: 'var(--muted)' } },
        `This will be filed under ${state.me.name}.` +
        (isAdmin() ? ' You can reassign it afterwards.' : '')),
    ),
    el('div', { class: 'modal-foot' },
      el('button', {
        class: 'btn', type: 'button',
        onclick: () => { close(); setPlacing(true); },
      }, 'Drop a pin instead'),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'),
      saveBtn,
    ),
  );

  overlay.replaceChildren(modal);
  overlay.hidden = false;
  overlay.onclick = (ev) => { if (ev.target === overlay) close(); };
  document.addEventListener('keydown', onKey);
  setMode(mode);
  showPreview();

  // A pin dropped on the map already has coordinates -- offer its address.
  if (seed.fromMap) {
    api('/api/reverse', { method: 'POST', body: { lat, lng } })
      .then(({ place: rev }) => {
        if (!rev) return;
        if (!addrInput.value) addrInput.value = rev.address || '';
        if (!nameInput.value && rev.name) nameInput.value = rev.name;
        showPreview();
      })
      .catch(() => { /* address stays blank; not worth a toast */ });
  }
}

/* ==========================================================================
   Account menu
   ========================================================================== */

function buildUserMenu() {
  const btn = $('#user-btn');
  btn.textContent = initials(state.me.name);
  btn.style.background = state.me.color;
  btn.style.color = inkOn(state.me.color);

  const menu = $('#user-menu');
  menu.replaceChildren(
    el('div', { class: 'menu-head' },
      el('div', { class: 'n' }, state.me.name),
      el('div', { class: 'e' }, state.me.email),
    ),
    isAdmin() && el('a', { class: 'menu-item', href: '/team' },
      el('span', { html: ICON.users }), 'Team & colors'),
    isAdmin() && el('a', { class: 'menu-item', href: '/leads' },
      el('span', { html: ICON.inbox }), 'Website inquiries'),
    el('a', { class: 'menu-item', href: '/', target: '_blank', rel: 'noopener' },
      el('span', { html: ICON.link }), 'View public site'),
    el('button', {
      class: 'menu-item', type: 'button',
      onclick: () => { menu.hidden = true; openPasswordModal(); },
    }, el('span', { html: ICON.key }), 'Change password'),
    el('button', {
      class: 'menu-item', type: 'button',
      onclick: (ev) => {
        const mode = nextTheme();
        refreshTiles();
        ev.currentTarget.lastChild.textContent =
          `Theme: ${mode[0].toUpperCase()}${mode.slice(1)}`;
      },
    }, el('span', { html: ICON.theme }),
       el('span', {}, `Theme: ${currentTheme()[0].toUpperCase()}${currentTheme().slice(1)}`)),
    el('div', { class: 'menu-sep' }),
    el('button', {
      class: 'menu-item', type: 'button',
      onclick: async () => { await api('/api/logout', { method: 'POST' }); location.href = '/signin'; },
    }, el('span', { html: ICON.out }), 'Sign out'),
  );

  btn.onclick = (ev) => {
    ev.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  };
  document.addEventListener('click', () => {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  });
  menu.addEventListener('click', ev => ev.stopPropagation());
}

function openPasswordModal() {
  const overlay = $('#overlay');
  const msg = el('div', { class: 'msg msg-error', hidden: true });
  const current = el('input', { type: 'password', autocomplete: 'current-password' });
  const next = el('input', { type: 'password', autocomplete: 'new-password' });
  const save = el('button', { class: 'btn btn-primary', type: 'button', onclick: submit }, 'Update password');

  function close() { overlay.hidden = true; overlay.replaceChildren(); }

  async function submit() {
    msg.hidden = true;
    if (next.value.length < 8) {
      msg.textContent = 'Use at least 8 characters.'; msg.hidden = false; return;
    }
    save.disabled = true;
    try {
      await api('/api/password', { method: 'POST', body: { current: current.value, next: next.value } });
      close();
      toast('Password updated');
    } catch (e) {
      msg.textContent = e.message; msg.hidden = false; save.disabled = false;
    }
  }

  overlay.replaceChildren(el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', style: { maxWidth: '380px' } },
    el('div', { class: 'modal-head' },
      el('h2', {}, 'Change password'),
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', html: ICON.close, onclick: close })),
    el('div', { class: 'modal-body' }, msg,
      el('label', { class: 'field' }, el('span', { class: 'label' }, 'Current password'), current),
      el('label', { class: 'field' }, el('span', { class: 'label' }, 'New password'), next)),
    el('div', { class: 'modal-foot' },
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), save),
  ));
  overlay.hidden = false;
  overlay.onclick = ev => { if (ev.target === overlay) close(); };
  setTimeout(() => current.focus(), 0);
}

/* ==========================================================================
   Boot
   ========================================================================== */

function render() {
  renderStats();
  renderFilters();
  renderList();
  syncMarkers();
}

async function boot() {
  $('#locate-btn').innerHTML = ICON.locate;
  $('#fit-btn').innerHTML = ICON.fit;
  $('#theme-btn').innerHTML = ICON.theme;
  $('.searchbox').insertAdjacentHTML('afterbegin', ICON.search);
  $('#rail-toggle').innerHTML = ICON.menu;

  const { user } = await api('/api/me');
  if (!user) { location.href = '/signin'; return; }
  state.me = user;

  try {
    const config = await api('/api/config');
    if (config?.tiles?.light) tiles = config.tiles;
    if (Number.isFinite(config?.home?.lat)) home = config.home;
  } catch { /* the built-in default basemap is fine */ }

  initMap();
  buildUserMenu();

  const [{ users }, { locations }] = await Promise.all([
    api('/api/users'),
    api('/api/locations'),
  ]);
  state.users = users;
  state.locations = locations;

  render();
  fitAll(false);

  $('#add-btn').onclick = () => openAddModal();
  $('#fit-btn').onclick = () => fitAll();
  $('#locate-btn').onclick = toggleLocate;
  $('#theme-btn').onclick = () => { nextTheme(); refreshTiles(); };
  $('#hint-cancel').onclick = () => setPlacing(false);

  $('#search').addEventListener('input', (ev) => {
    state.query = ev.target.value.trim();
    renderList();
    syncMarkers();
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      if (state.placing) return setPlacing(false);
      if (state.selectedId && $('#overlay').hidden) closeDrawer();
    }
    const typing = /^(INPUT|TEXTAREA)$/.test(ev.target.tagName) || ev.target.isContentEditable;
    if (!typing && ev.key === '/') { ev.preventDefault(); $('#search').focus(); }
    if (!typing && (ev.key === 'n' || ev.key === 'N') && !ev.metaKey && !ev.ctrlKey) openAddModal();
  });

  // Small screens: the rail becomes a drawer of its own.
  const mq = matchMedia('(max-width: 820px)');
  const syncRail = () => {
    $('#rail-toggle').hidden = !mq.matches;
    if (!mq.matches) $('#rail').classList.remove('open');
  };
  mq.addEventListener('change', syncRail);
  syncRail();
  $('#rail-toggle').onclick = () => $('#rail').classList.toggle('open');
  $('#list').addEventListener('click', () => { if (mq.matches) $('#rail').classList.remove('open'); });

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', refreshTiles);
  addEventListener('resize', () => map.invalidateSize());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) map.invalidateSize();
  });
}

boot().catch((err) => {
  console.error(err);
  document.body.replaceChildren(el('div', { class: 'empty', style: { paddingTop: '80px' } },
    el('div', { class: 't' }, 'Could not load the map'),
    el('div', { class: 'd' }, err.message)));
});
