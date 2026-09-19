# Five Star Tap

Two things in one small app:

- **A public website** at `/` that sells the tags and collects inquiries.
- **A private territory map** at `/map` where the sales team works.

Paste a Google listing link and the business lands on the map — named,
geocoded, colour-coded to whoever added it, and carrying notes the whole team
can read and edit.

| Path | Who | What |
| --- | --- | --- |
| `/` | Everyone | The marketing site |
| `/signin` | The team | Sign in |
| `/map` | Reps + Alex | The territory map |
| `/team` | Alex only | Accounts and rep colours |
| `/leads` | Alex only | Inquiries from the website form |

---

## Running it

Runs on **Cloudflare Workers + D1** — free tier, no cold starts, nothing to
maintain. One Worker serves the public site, the tool and the API; D1 (managed
SQLite) holds the data.

```bash
npm install
npm run dev          # wrangler dev — the real Workers runtime
```

If `wrangler dev` crashes on startup (workerd segfaults on some Windows
machines, independent of this project), use the Node harness instead. It runs
the identical Hono app with a D1 shim over `node:sqlite` — the same engine D1
uses, so the SQL is genuinely exercised:

```bash
npm run dev:node     # http://localhost:8787
```

Create the first admin (works against either database):

```bash
npm run create-admin -- --local "Alex" you@example.com "a-long-password"
```

---

## How it works day to day

**Alex (admin)**

- **Team** page: create a login for each rep, give each one a colour, reset
  passwords, disable someone who leaves.
- Reassign a location to a different rep — the only field reps cannot touch.
- Delete any location or note.

**A rep**

- **Add location** → paste a Google link → **Import**. Name, address and pin
  are pulled in; correct anything before saving.
- No link? Switch to **Name & address**, or use **Drop a pin instead** and
  click the map.
- Mark coverage: Prospect → Visited → Installed (or Declined).
- Add notes. Notes open read-only; the pencil turns one into an editor.
  Anyone on the team can edit any note; only the author (or Alex) can delete one.
- The crosshair button shows live location, so it is usable while walking a street.

Anyone can rename a location, fix its address or change its status. The rep it
is filed under is set automatically from who is signed in, and only Alex can
change it afterwards.

### Keyboard

`/` focuses search · `N` opens Add location · `Esc` closes the panel or modal.

---

## What the Google link importer accepts

| Pasted | What happens |
| --- | --- |
| `maps.app.goo.gl/…` short link | Followed server-side, then read |
| `google.com/maps/place/Name/@lat,lng…` | Name and pin read straight from the URL |
| `g.page/r/…/review` | Page fetched, business name and pin extracted |
| `search.google.com/local/writereview?placeid=…` | Place id kept, used for the review link |
| A plain address | Geocoded directly |

Anything still missing a coordinate is geocoded through OpenStreetMap's
Nominatim, and a missing address is filled in by reverse geocoding the pin.
**No Google API key is needed.**

Nominatim is called at most once a second, as its usage policy requires. For a
small team that is well inside fair use; a much larger roll-out should move to
a paid geocoder.

---

## Editing the public site

Everything on the site is in `public/index.html`. There is no CMS and no build
step — open it, change the words, save, refresh.

**Live details currently on the page:**

| Where | Value |
| --- | --- |
| Pricing | $40 one tag · $60 for two · "Let's talk" for three or more |
| Email | fivestartapbyalex@gmail.com |
| Phone | (715) 505-5838 |
| Area covered | Westchester, Fairfield and the Hudson Valley |

The prices sit in the three `.tier` blocks around `index.html:255-300`; the
contact details are in the `.contact-aside` list around `index.html:375-390`.

**Deliberately not included:** there are no customer testimonials and no
statistics about review counts or revenue. Invented social proof on a real
business site is worse than none — add a testimonials block once you have
quotes you can attribute to a named customer who agreed to it.

The claims that *are* on the page ("no app", "works on iPhone and Android",
"no power or wifi") are true of NFC tags generally. The FAQ answer about not
filtering reviews is there on purpose: review gating breaks Google's policies
and is a real risk to a client's listing, so the site says plainly that you do
not do it.

### Where inquiries go

The contact form posts to the app and lands in **/leads**, visible to Alex
only, with the sender's email and phone as one-tap links. There is a honeypot
field and a cap of five submissions per IP per hour, so ordinary bot spam does
not reach the inbox.

Inquiries are stored in D1 alongside everything else. If you would rather they
also arrive by email, that is a small addition — the write happens in one
place, `POST /api/inquiry` in `src/index.js`.

---

## Configuration

Set in `wrangler.jsonc` under `vars` (or as secrets for anything sensitive).

| Variable | Default | Purpose |
| --- | --- | --- |
| `BRAND_NAME` | `Five Star Tap` | Name reported to the client |
| `MAP_LAT` / `MAP_LNG` | `41.20` / `-73.70` | Where the map opens before any pins exist |
| `MAP_ZOOM` | `10` | Opening zoom level |

Basemap URLs and zoom ceilings live in `TILES` at the top of `src/index.js`.

### Where the map opens

With no pins yet, the map opens over Westchester / Fairfield / the lower
Hudson Valley. Once there are locations it fits itself to them instead. To move
the starting view, set `MAP_LAT`, `MAP_LNG` and `MAP_ZOOM`.

### Swapping the basemap

The default is Esri's grey canvas: no key, quiet enough that the rep colors
carry the map. Its tiles stop at zoom 16, which is why `maxNativeZoom` is 16 —
past that Leaflet upscales rather than requesting tiles the provider does not
have.

To use standard OpenStreetMap instead, edit `TILES` in `src/index.js`:

```js
const TILES = {
  light: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  dark:  'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 19,
  maxNativeZoom: 19,
};
```

---

## Data

Everything is in D1: users, locations, notes and website inquiries. The schema
is `schema.sql` — five tables plus a throttle table for login and spam limits.

Deleting a rep never deletes their work: their pins and notes stay and simply
become unassigned, and the API reports how many were affected so the UI can say
so.

---

## Getting the domain

**We cannot buy this for you** — a domain has to be registered in Alex's own
name, with his card and his contact details, or he does not really own it.
Below is the shortlist and exactly what to do with it.

### The domain

**getfivestartap.com** — confirmed available.

`fivestartap.com` was the first choice but it was registered in April 2026 and
is running an untouched default WordPress install. It is owned, not parked for
sale, so it would take an unsolicited offer to the owner and probably an
inflated price.

Also free, if you change your mind: `fivestartaps.com` (plural),
`fivestartapbyalex.com` (matches the email exactly), `fivestartapco.com`,
`fivestarbyalex.com`.

Already taken: `fivestartap.com`, `thefivestartap.com`, `fivestarnfc.com`,
`getfivestar.com`, `fivestarreviews.com`, `reviewtag.com`.

### Buying it

Any of Cloudflare Registrar, Porkbun or Namecheap is fine. Cloudflare sells at
cost with no first-year discount that jumps later, which is usually the
cheapest over time. Expect roughly $10–15 a year for a `.com`.

Two things worth doing at checkout:

- **Turn on WHOIS privacy.** Free at all three. Without it Alex's home address
  is published.
- **Turn on auto-renew.** A lapsed domain is bought within minutes by
  squatters, and the site and every tag pointing at it stop working.

### Pointing it at the app

Once the app is deployed and the host has given you a hostname, add these two
DNS records at the registrar:

| Type | Name | Value |
| --- | --- | --- |
| `CNAME` | `www` | the hostname your host gave you |
| `ALIAS` / `ANAME` / `CNAME flattening` | `@` | the same hostname |

The root record has a different name at each registrar — Cloudflare calls it
CNAME flattening and does it automatically, Porkbun calls it `ALIAS`. If your
host gives you an IP address instead of a hostname, use an `A` record at `@`
and point `www` at the root.

Then, in the host's dashboard, add `getfivestartap.com` as a custom domain and
let it issue the TLS certificate — every platform in the list below does this
for free with Let's Encrypt. DNS usually takes minutes, occasionally a few
hours.

### Email on the domain

Domain registration does not include email, so `alex@getfivestartap.com` needs
a mailbox somewhere — Google Workspace or Microsoft 365 (both paid per user),
or a cheaper option like Fastmail or the registrar's own forwarding, which
simply redirects to an existing inbox. Forwarding is the cheapest way to get a
professional address on the site without a new mailbox to check.

---

## Deploying

One-time setup:

```bash
npx wrangler login                     # opens the browser to authorize
npm run db:create                      # prints a database_id
```

Paste that `database_id` into `wrangler.jsonc`, then:

```bash
npm run db:init:remote                 # create the tables on live D1
npm run deploy                         # publish the Worker
npm run create-admin -- --remote "Alex" you@example.com "a-long-password"
```

That gives you a working `*.workers.dev` URL. To put it on the real domain, add
the custom domain in the Cloudflare dashboard (Workers & Pages → your worker →
Settings → Domains & Routes → Add custom domain). If the domain is registered
at Cloudflare, DNS and the TLS certificate are handled automatically — there
are no records to add by hand.

### Previewing before you go live

Nothing has to reach the live domain untested:

```bash
npx wrangler versions upload      # prints a Version Preview URL
```

That publishes the version to a private URL and leaves `getfivestartap.com`
alone. Look at it, then promote the exact version you looked at:

```bash
npx wrangler versions deploy <version-id>@100 --yes
```

`wrangler deploy` still works and still goes straight to production — use it
only when you mean to skip the preview.

Two things to know:

- Previews share the **live database**, so a test through the contact form
  lands in the real inbox.
- Edge propagation takes a few seconds after promoting. If a check says the
  old version is still up, wait and look again before assuming it failed.

`workers_dev` is on because Cloudflare only serves preview URLs when it is.
The Worker redirects the bare workers.dev host to the custom domain, but
static assets are served at the edge before the Worker runs, so that redirect
never fires for the homepage — the `<link rel="canonical">` tag in
`index.html` is what actually keeps the duplicate hosts out of search results.

---

### Costs

| | |
| --- | --- |
| Workers | Free — 100,000 requests/day |
| D1 | Free — 5 GB, 5M row reads and 100k row writes/day |
| Static assets | Free, unlimited |
| Domain | ~$10–15/year, the only bill |

A local business site and a few reps use a rounding error of those limits.

### Backups

D1 keeps point-in-time recovery automatically. For your own copy:

```bash
npx wrangler d1 export fivestartap --remote --output backup.sql
```

---

## Security notes

- Passwords are hashed with PBKDF2-HMAC-SHA256 at 210,000 iterations and a
  per-user salt; the hash never leaves the server. (The Workers runtime has no
  scrypt, which the earlier Node build used.)
- Sessions are HMAC-signed cookies (HttpOnly, Secure, SameSite=Lax, 30 days),
  signed with a secret generated on first use and kept in the `meta` table.
  Deleting that row signs everyone out.
- Failed sign-ins are throttled to 8 per email/IP per 15 minutes, and the
  contact form to 5 per IP per hour. Both counters live in D1, because a
  Worker isolate is too short-lived to count anything on its own.
- Every permission rule is enforced on the server, not just hidden in the UI:
  the rep field rejects non-admin writes, the Team page rejects non-admins, and
  the last remaining admin cannot demote, disable or delete themselves.

---

## Layout

```
wrangler.jsonc          Worker config: assets, D1 binding, map defaults
schema.sql              D1 tables
src/index.js            Every route and permission check (Hono)
src/db.js               D1 queries and row -> JSON mappers
src/auth.js             PBKDF2 passwords, HMAC-signed session cookies
src/places.js           Google link parsing, geocoding, reverse geocoding
scripts/create-admin.mjs   Makes the first admin (hash computed locally)
scripts/dev-node.mjs       Dev harness: same app, D1 shim over node:sqlite
public/
  index.html            The public marketing site
  signin.html           Sign in
  app.html              The territory map
  team.html             Accounts and rep colors (admin)
  leads.html            Website inquiries (admin)
  app.css               Design tokens and every app component
  site.css              Marketing-only styles, layered on app.css
  js/core.js            fetch wrapper, DOM helpers, theme, icons
  js/site.js            Nav, scroll reveal, contact form
  js/signin.js          Sign in
  js/app.js             Map, rail, detail drawer, add-location flow
  js/team.js            Account management
  js/leads.js           Inquiry inbox
  vendor/leaflet.*      Vendored so the map works on a weak connection
```

The browser code is untouched by the move to Cloudflare — the API returns the
same JSON shapes it always did.
