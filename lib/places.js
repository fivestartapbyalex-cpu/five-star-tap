/**
 * Turns whatever a rep pastes -- a Google Maps share link, a g.page review
 * link, a "write a review" link, or just a street address -- into
 * { name, address, lat, lng, placeId, reviewUrl }.
 *
 * No Google API key required. Short links are followed server-side, place
 * details are read out of the resolved URL / page markup, and anything still
 * missing a coordinate is geocoded through OpenStreetMap's Nominatim.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* Nominatim's usage policy caps us at 1 request/second and wants a real
   identifying User-Agent. Both are honored here. */
const NOMINATIM_UA = process.env.NOMINATIM_UA ||
  'FiveStarTap/1.0 (self-hosted NFC review-tag territory map)';
let nominatimChain = Promise.resolve();
let lastNominatim = 0;

function throttleNominatim(fn) {
  const run = async () => {
    const wait = 1100 - (Date.now() - lastNominatim);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastNominatim = Date.now();
    return fn();
  };
  const next = nominatimChain.then(run, run);
  // Keep the chain alive even if this call rejects.
  nominatimChain = next.catch(() => {});
  return next;
}

async function fetchWithTimeout(url, options = {}, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal, redirect: 'follow' });
  } finally {
    clearTimeout(t);
  }
}

const decode = s => {
  try { return decodeURIComponent(String(s).replace(/\+/g, ' ')).trim(); }
  catch { return String(s).replace(/\+/g, ' ').trim(); }
};

/* ---------- pulling structure out of a Google Maps URL ---------- */

function parseMapsUrl(url) {
  const out = {};
  // /maps/place/The+Coffee+Bar/@... -> business name
  const place = url.match(/\/maps\/place\/([^/@?]+)/);
  if (place) {
    const name = decode(place[1]);
    if (name && !/^[\d.,+-]+$/.test(name)) out.name = name;
  }
  // !3d<lat>!4d<lng> inside the data= blob is the *pin* -- more precise than @
  const pin = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (pin) { out.lat = parseFloat(pin[1]); out.lng = parseFloat(pin[2]); }
  // @lat,lng,zoom is the map viewport -- decent fallback
  if (out.lat === undefined) {
    const at = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (at) { out.lat = parseFloat(at[1]); out.lng = parseFloat(at[2]); }
  }
  // ?q=lat,lng / ?query=lat,lng / ?destination=lat,lng (raw or percent-encoded comma)
  if (out.lat === undefined) {
    const q = url.match(/[?&](?:q|query|destination|center)=(-?\d+\.\d+)(?:,|%2C)(-?\d+\.\d+)/i);
    if (q) { out.lat = parseFloat(q[1]); out.lng = parseFloat(q[2]); }
  }
  // Free-text ?q= that is not coordinates is usually the business or address
  if (!out.name) {
    const q = url.match(/[?&](?:q|query)=([^&]+)/);
    if (q) {
      const v = decode(q[1]);
      if (v && !/^-?\d+\.\d+\s*,/.test(v)) out.query = v;
    }
  }
  const pid = url.match(/[?&]place_?id=([^&]+)/i);
  if (pid) out.placeId = decode(pid[1]);
  // Google's internal feature id, e.g. !1s0x89c25a:0x35b1cf...
  const ftid = url.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i);
  if (ftid) out.ftid = ftid[1];
  const cid = url.match(/[?&]cid=(\d+)/);
  if (cid) out.cid = cid[1];
  return out;
}

/* ---------- pulling structure out of the fetched page ---------- */

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&#x27;/gi, "'")
          .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&nbsp;/g, ' ').trim();
}

function parseHtml(html) {
  const out = {};
  const meta = (prop) => {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i');
    const alt = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i');
    const m = html.match(re) || html.match(alt);
    return m ? decodeEntities(m[1]) : null;
  };

  let title = meta('og:title') || meta('twitter:title');
  if (!title) {
    const t = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (t) title = decodeEntities(t[1]);
  }
  if (title) {
    // Strip Google's chrome: "Foo - Google Maps", "Review Foo", "Foo - 123 Main St"
    title = title.replace(/\s*[-–|]\s*Google\s*(Maps|Search)?\s*$/i, '')
                 .replace(/^Google\s*Maps\s*[-–|]\s*/i, '')
                 .replace(/^(Write a review for|Review|Rate)\s+/i, '')
                 .trim();
    const dot = title.split(/\s+·\s+/);
    if (dot.length > 1) {
      out.name = dot[0].trim();
      out.address = dot.slice(1).join(', ').trim();
    } else if (title && !/^google/i.test(title)) {
      out.name = title;
    }
  }

  const desc = meta('og:description') || meta('description');
  if (desc && !out.address) {
    // og:description on a Maps place is often "5.0 stars - 128 reviews - 12 High St"
    const parts = desc.split(/\s+·\s+/).map(s => s.trim());
    const addr = parts.find(p => /\d/.test(p) && !/review|rating|star|photos?$/i.test(p));
    if (addr) out.address = addr;
  }

  const img = meta('og:image');
  if (img) {
    const c = img.match(/[?&](?:center|cb_ll)=(-?\d+\.\d+)(?:,|%2C)(-?\d+\.\d+)/i);
    if (c) { out.lat = parseFloat(c[1]); out.lng = parseFloat(c[2]); }
  }

  if (out.lat === undefined) {
    const pin = html.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    if (pin) { out.lat = parseFloat(pin[1]); out.lng = parseFloat(pin[2]); }
  }
  if (out.lat === undefined) {
    const arr = html.match(/\[null,null,(-?\d{1,2}\.\d{4,}),(-?\d{1,3}\.\d{4,})\]/);
    if (arr) { out.lat = parseFloat(arr[1]); out.lng = parseFloat(arr[2]); }
  }
  if (!out.placeId) {
    const pid = html.match(/"(ChIJ[A-Za-z0-9_-]{10,})"/) ||
                html.match(/place_?id[=:"\s]+(ChIJ[A-Za-z0-9_-]{10,})/i);
    if (pid) out.placeId = pid[1];
  }
  return out;
}

/* ---------- geocoding (OpenStreetMap Nominatim, no key) ---------- */

export async function geocode(query) {
  if (!query) return null;
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1&q='
    + encodeURIComponent(query);
  const res = await throttleNominatim(() =>
    fetchWithTimeout(url, { headers: { 'User-Agent': NOMINATIM_UA, 'Accept-Language': 'en' } }));
  if (!res.ok) return null;
  const hits = await res.json();
  const hit = Array.isArray(hits) ? hits[0] : null;
  if (!hit) return null;
  return { lat: parseFloat(hit.lat), lng: parseFloat(hit.lon), address: hit.display_name };
}

export async function reverseGeocode(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=${lat}&lon=${lng}`;
  const res = await throttleNominatim(() =>
    fetchWithTimeout(url, { headers: { 'User-Agent': NOMINATIM_UA, 'Accept-Language': 'en' } }));
  if (!res.ok) return null;
  const hit = await res.json();
  if (!hit || hit.error) return null;
  const a = hit.address || {};
  const short = [
    [a.house_number, a.road].filter(Boolean).join(' '),
    a.suburb || a.neighbourhood,
    a.city || a.town || a.village || a.hamlet,
    a.postcode,
  ].filter(Boolean).join(', ');
  return { address: short || hit.display_name, name: hit.name || null, full: hit.display_name };
}

/* ---------- the public entry point ---------- */

const isUrl = s => /^https?:\/\//i.test(s.trim());

export async function resolvePlace(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Paste a Google link or an address.');

  const result = {
    name: '', address: '', lat: null, lng: null,
    placeId: null, googleUrl: isUrl(raw) ? raw : '', reviewUrl: null,
    source: isUrl(raw) ? 'google-link' : 'address',
    warnings: [],
  };

  if (isUrl(raw)) {
    let finalUrl = raw;
    let html = '';
    try {
      const res = await fetchWithTimeout(raw, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      });
      finalUrl = res.url || raw;
      const type = res.headers.get('content-type') || '';
      if (type.includes('text/html')) html = (await res.text()).slice(0, 400000);
    } catch {
      result.warnings.push('Could not reach Google to expand that link, so only the URL itself was read.');
    }

    const fromUrl = parseMapsUrl(finalUrl);
    const fromHtml = html ? parseHtml(html) : {};

    result.name = fromUrl.name || fromHtml.name || '';
    result.address = fromHtml.address || '';
    result.lat = fromUrl.lat ?? fromHtml.lat ?? null;
    result.lng = fromUrl.lng ?? fromHtml.lng ?? null;
    result.placeId = fromUrl.placeId || fromHtml.placeId || null;
    result.googleUrl = finalUrl;

    // Nothing but a name/query to go on -- hand it to the geocoder.
    if (result.lat == null) {
      const q = [result.name, fromUrl.query, result.address].filter(Boolean).join(', ');
      if (q) {
        const geo = await geocode(q).catch(() => null);
        if (geo) {
          result.lat = geo.lat; result.lng = geo.lng;
          if (!result.address) result.address = geo.address;
          result.source = 'google-link + geocoded';
        }
      }
    }
    if (!result.name && !result.address && result.lat == null) {
      throw new Error('That link did not contain a business. Use "Share > Copy link" on the Google listing, or type the address instead.');
    }
  } else {
    const geo = await geocode(raw);
    if (!geo) throw new Error(`No match for "${raw}". Try adding the city or ZIP code.`);
    result.lat = geo.lat; result.lng = geo.lng;
    result.address = geo.address;
    result.name = raw.split(',')[0].trim();
  }

  // Fill an address in from the coordinates when Google gave us none.
  if (result.lat != null && !result.address) {
    const rev = await reverseGeocode(result.lat, result.lng).catch(() => null);
    if (rev) {
      result.address = rev.address;
      if (!result.name && rev.name) result.name = rev.name;
    }
  }

  if (!result.name) result.name = (result.address || '').split(',')[0] || 'Untitled location';
  if (result.lat == null) {
    result.warnings.push('No coordinates found -- drag the pin on the map to place it.');
  }

  // A link the rep can hand to the business for collecting reviews.
  if (result.placeId) {
    result.reviewUrl = `https://search.google.com/local/writereview?placeid=${encodeURIComponent(result.placeId)}`;
  } else if (isUrl(raw) && /g\.page|writereview|\/review/i.test(raw)) {
    result.reviewUrl = raw;
  }

  return result;
}
