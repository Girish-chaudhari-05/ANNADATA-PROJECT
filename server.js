'use strict';
// Annadata backend: plain Node 22 (http + built-in SQLite). No npm install needed.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT !== undefined ? Number(process.env.PORT) : 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'annadata.db');
const PUBLIC = path.join(__dirname, 'public');
const MAX_ACTIVE_CLAIMS = 5; // stops one NGO from hoarding listings

// ---------- Database ----------
const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK(role IN ('restaurant','ngo','admin')),
  name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  pw_hash TEXT NOT NULL, pw_salt TEXT NOT NULL,
  phone TEXT, address TEXT, lat REAL, lng REAL,
  verified INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS listings(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL, food_type TEXT NOT NULL, veg INTEGER NOT NULL DEFAULT 1,
  quantity TEXT NOT NULL, servings INTEGER NOT NULL,
  prepared_at INTEGER, pickup_deadline INTEGER NOT NULL,
  address TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, notes TEXT,
  status TEXT NOT NULL DEFAULT 'AVAILABLE'
    CHECK(status IN ('AVAILABLE','ACCEPTED','COLLECTED','DISTRIBUTED','CANCELLED','EXPIRED')),
  claimed_by INTEGER REFERENCES users(id), claimed_at INTEGER,
  collected_at INTEGER, distributed_at INTEGER, people_served INTEGER,
  created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status, pickup_deadline);
CREATE TABLE IF NOT EXISTS status_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  status TEXT NOT NULL, user_id INTEGER, at INTEGER NOT NULL);
`);

const q = (sql, ...p) => db.prepare(sql).all(...p);
const q1 = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);

// Signing secret: from env, else generated once and kept in the DB.
let SECRET = process.env.SECRET || q1("SELECT value FROM meta WHERE key='secret'")?.value;
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  run("INSERT INTO meta(key,value) VALUES('secret',?)", SECRET);
}

// ---------- Helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);

const text = (v, field, min, max) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < min || s.length > max) throw bad(`${field} must be ${min}-${max} characters`);
  return s;
};
const int = (v, field, min, max) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${field} must be a whole number from ${min} to ${max}`);
  return n;
};
const coord = (lat, lng) => {
  const a = Number(lat), b = Number(lng);
  if (lat === '' || lat == null || lng === '' || lng == null || !(a >= -90 && a <= 90) || !(b >= -180 && b <= 180))
    throw bad('A valid location (latitude and longitude) is required');
  return [a, b];
};

function haversineKm(lat1, lng1, lat2, lng2) {
  const r = (d) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 +
    Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

function hashPw(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function checkPw(password, salt, hash) {
  const a = Buffer.from(hashPw(password, salt).hash, 'hex'), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const b64 = (s) => Buffer.from(s).toString('base64url');
const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function makeToken(uid) {
  const body = b64(JSON.stringify({ uid, exp: Date.now() + 7 * 864e5 }));
  return `${body}.${sign(body)}`;
}
function authUser(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  const [body, sig] = (m?.[1] || '').split('.');
  if (!body || !sig || sign(body) !== sig) throw new HttpError(401, 'Please log in');
  let p; try { p = JSON.parse(Buffer.from(body, 'base64url')); } catch { throw new HttpError(401, 'Please log in'); }
  const u = p.exp > Date.now() && q1('SELECT * FROM users WHERE id=?', p.uid);
  if (!u) throw new HttpError(401, 'Session expired, please log in again');
  return u;
}
const publicUser = (u) => ({
  id: u.id, role: u.role, name: u.name, email: u.email, phone: u.phone,
  address: u.address, lat: u.lat, lng: u.lng, verified: !!u.verified,
});

// Simple in-memory limiter for login/register (per IP, 20 tries / 10 min)
const attempts = new Map();
function limit(req) {
  const ip = req.socket.remoteAddress, now = Date.now();
  const a = (attempts.get(ip) || []).filter((t) => now - t < 600000);
  if (a.length >= 20) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  a.push(now); attempts.set(ip, a);
}

// ---------- Listing logic ----------
function expireOld() {
  const now = Date.now();
  const rows = q("SELECT id FROM listings WHERE status='AVAILABLE' AND pickup_deadline < ?", now);
  for (const r of rows) {
    run("UPDATE listings SET status='EXPIRED' WHERE id=? AND status='AVAILABLE'", r.id);
    run("INSERT INTO status_log(listing_id,status,user_id,at) VALUES(?, 'EXPIRED', NULL, ?)", r.id, now);
  }
}

const LISTING_SQL = `
  SELECT l.*, p.name AS provider_name, p.phone AS provider_phone,
         n.name AS ngo_name, n.phone AS ngo_phone
  FROM listings l JOIN users p ON p.id = l.provider_id
  LEFT JOIN users n ON n.id = l.claimed_by`;

// Phone numbers are only shared between the two parties once a claim exists.
function shape(l, viewer) {
  const involved = viewer.role === 'admin' || viewer.id === l.provider_id || viewer.id === l.claimed_by;
  const out = {
    id: l.id, title: l.title, food_type: l.food_type, veg: !!l.veg, quantity: l.quantity,
    servings: l.servings, prepared_at: l.prepared_at, pickup_deadline: l.pickup_deadline,
    address: l.address, lat: l.lat, lng: l.lng, notes: l.notes, status: l.status,
    provider_name: l.provider_name, claimed_at: l.claimed_at, collected_at: l.collected_at,
    distributed_at: l.distributed_at, people_served: l.people_served, created_at: l.created_at,
  };
  if (involved && l.claimed_by) { out.ngo_name = l.ngo_name; out.ngo_phone = l.ngo_phone; }
  if (involved && l.status !== 'AVAILABLE') out.provider_phone = l.provider_phone;
  return out;
}

function log(id, status, uid) {
  run('INSERT INTO status_log(listing_id,status,user_id,at) VALUES(?,?,?,?)', id, status, uid, Date.now());
}

// One atomic UPDATE decides every transition, so two NGOs can never both win a claim.
function transition(id, from, to, guardSql, guardArgs, setSql = '', setArgs = []) {
  const r = run(`UPDATE listings SET status=?${setSql} WHERE id=? AND status=? AND (${guardSql})`,
    to, ...setArgs, id, from, ...guardArgs);
  return r.changes === 1;
}
function getListing(id) {
  const l = q1(`${LISTING_SQL} WHERE l.id=?`, id);
  if (!l) throw new HttpError(404, 'Listing not found');
  return l;
}
const requireVerifiedNgo = (u) => {
  if (u.role !== 'ngo') throw new HttpError(403, 'Only NGOs and volunteers can do this');
  if (!u.verified) throw new HttpError(403, 'Your organisation is awaiting admin verification');
};

// ---------- Routes ----------
const routes = [];
const route = (method, re, roles, fn) => routes.push({ method, re, roles, fn });

route('POST', /^\/api\/register$/, null, (req, { body }) => {
  limit(req);
  const role = body.role;
  if (!['restaurant', 'ngo'].includes(role)) throw bad('Role must be restaurant or ngo');
  const name = text(body.name, 'Name', 2, 80);
  const email = text(body.email, 'Email', 5, 120).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Enter a valid email');
  const password = text(body.password, 'Password', 8, 100);
  const phone = text(body.phone, 'Phone', 7, 20);
  const address = text(body.address, 'Address', 3, 200);
  const [lat, lng] = coord(body.lat, body.lng);
  if (q1('SELECT id FROM users WHERE email=?', email)) throw new HttpError(409, 'That email is already registered');
  const { salt, hash } = hashPw(password);
  // Restaurants can post immediately; NGOs/volunteers wait for admin verification (per the project report).
  const r = run(`INSERT INTO users(role,name,email,pw_hash,pw_salt,phone,address,lat,lng,verified,created_at)
                 VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    role, name, email, hash, salt, phone, address, lat, lng, role === 'restaurant' ? 1 : 0, Date.now());
  const user = q1('SELECT * FROM users WHERE id=?', Number(r.lastInsertRowid));
  return { token: makeToken(user.id), user: publicUser(user) };
});

route('POST', /^\/api\/login$/, null, (req, { body }) => {
  limit(req);
  const u = q1('SELECT * FROM users WHERE email=?', String(body.email || '').trim().toLowerCase());
  if (!u || !checkPw(String(body.password || ''), u.pw_salt, u.pw_hash)) throw new HttpError(401, 'Wrong email or password');
  if (body.role && body.role !== u.role) throw new HttpError(403, `This account is registered as ${u.role}. Please use the ${u.role} login page.`);
  return { token: makeToken(u.id), user: publicUser(u) };
});

route('GET', /^\/api\/me$/, 'any', (req, { user }) => ({ user: publicUser(user) }));

route('GET', /^\/api\/stats$/, null, () => {
  const d = q1(`SELECT COUNT(*) AS donations, COALESCE(SUM(servings),0) AS meals FROM listings WHERE status='DISTRIBUTED'`);
  const live = q1(`SELECT COUNT(*) AS n FROM listings WHERE status='AVAILABLE' AND pickup_deadline > ?`, Date.now());
  return { donations: d.donations, meals: d.meals, live: live.n };
});

// Restaurant: create a listing
route('POST', /^\/api\/listings$/, ['restaurant'], (req, { user, body }) => {
  const now = Date.now();
  const deadline = Number(body.pickup_deadline);
  if (!(deadline > now)) throw bad('Pickup deadline must be in the future');
  if (deadline > now + 48 * 36e5) throw bad('Pickup deadline can be at most 48 hours away (food safety)');
  const prepared = body.prepared_at ? Number(body.prepared_at) : null;
  if (prepared !== null && (!(prepared > 0) || prepared > now + 300000)) throw bad('Preparation time cannot be in the future');
  const [lat, lng] = coord(body.lat ?? user.lat, body.lng ?? user.lng);
  const r = run(`INSERT INTO listings(provider_id,title,food_type,veg,quantity,servings,prepared_at,pickup_deadline,
                 address,lat,lng,notes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    user.id, text(body.title, 'Title', 2, 80), text(body.food_type, 'Food type', 2, 40), body.veg === false ? 0 : 1,
    text(body.quantity, 'Quantity', 1, 40), int(body.servings, 'Servings', 1, 10000), prepared, deadline,
    text(body.address || user.address, 'Address', 3, 200), lat, lng,
    body.notes ? text(body.notes, 'Notes', 0, 300) : null, now);
  const id = Number(r.lastInsertRowid);
  log(id, 'AVAILABLE', user.id);
  return { listing: shape(getListing(id), user) };
});

// NGO: nearby available listings, nearest first
route('GET', /^\/api\/listings\/available$/, ['ngo'], (req, { user, url }) => {
  requireVerifiedNgo(user);
  expireOld();
  const lat = url.searchParams.has('lat') ? Number(url.searchParams.get('lat')) : user.lat;
  const lng = url.searchParams.has('lng') ? Number(url.searchParams.get('lng')) : user.lng;
  const radius = Math.min(Math.max(Number(url.searchParams.get('radius')) || 10, 1), 200);
  const rows = q(`${LISTING_SQL} WHERE l.status='AVAILABLE' AND l.pickup_deadline > ?`, Date.now());
  const all = rows.map((l) => ({ ...shape(l, user), distance_km: Math.round(haversineKm(lat, lng, l.lat, l.lng) * 10) / 10 }));
  const listings = all.filter((l) => l.distance_km <= radius)
    .sort((a, b) => a.distance_km - b.distance_km || a.pickup_deadline - b.pickup_deadline);
  const farther = all.filter((l) => l.distance_km > radius).map((l) => l.distance_km).sort((a, b) => a - b);
  return { listings, radius, farther: farther.length, nearest_far_km: farther[0] ?? null };
});

// My listings (restaurant: ones I posted; NGO: ones I claimed)
route('GET', /^\/api\/listings\/mine$/, ['restaurant', 'ngo'], (req, { user }) => {
  expireOld();
  const col = user.role === 'restaurant' ? 'l.provider_id' : 'l.claimed_by';
  const rows = q(`${LISTING_SQL} WHERE ${col}=? ORDER BY l.created_at DESC LIMIT 100`, user.id);
  return { listings: rows.map((l) => shape(l, user)) };
});

route('GET', /^\/api\/listings\/(\d+)$/, 'any', (req, { user, m }) => {
  const l = getListing(Number(m[1]));
  if (user.role !== 'admin' && l.provider_id !== user.id && l.claimed_by !== user.id &&
      !(user.role === 'ngo' && user.verified && l.status === 'AVAILABLE')) throw new HttpError(403, 'Not allowed');
  const history = q('SELECT status, at FROM status_log WHERE listing_id=? ORDER BY id', l.id);
  return { listing: shape(l, user), history };
});

route('POST', /^\/api\/listings\/(\d+)\/claim$/, ['ngo'], (req, { user, m }) => {
  requireVerifiedNgo(user);
  const id = Number(m[1]);
  const active = q1("SELECT COUNT(*) AS n FROM listings WHERE claimed_by=? AND status IN ('ACCEPTED','COLLECTED')", user.id).n;
  if (active >= MAX_ACTIVE_CLAIMS) throw new HttpError(409, `You already have ${MAX_ACTIVE_CLAIMS} active pickups. Finish those first.`);
  const now = Date.now();
  const ok = transition(id, 'AVAILABLE', 'ACCEPTED', 'pickup_deadline > ?', [now], ', claimed_by=?, claimed_at=?', [user.id, now]);
  if (!ok) { getListing(id); throw new HttpError(409, 'Sorry, someone else got this one first (or it expired).'); }
  log(id, 'ACCEPTED', user.id);
  return { listing: shape(getListing(id), user) };
});

route('POST', /^\/api\/listings\/(\d+)\/release$/, ['ngo'], (req, { user, m }) => {
  const id = Number(m[1]);
  const ok = transition(id, 'ACCEPTED', 'AVAILABLE', 'claimed_by = ?', [user.id], ', claimed_by=NULL, claimed_at=NULL');
  if (!ok) throw new HttpError(409, 'You can only release a pickup you accepted and have not collected');
  log(id, 'AVAILABLE', user.id);
  return { listing: shape(getListing(id), user) };
});

route('POST', /^\/api\/listings\/(\d+)\/collect$/, ['restaurant', 'ngo'], (req, { user, m }) => {
  const id = Number(m[1]);
  const ok = transition(id, 'ACCEPTED', 'COLLECTED', 'claimed_by = ? OR provider_id = ?', [user.id, user.id], ', collected_at=?', [Date.now()]);
  if (!ok) throw new HttpError(409, 'This pickup cannot be marked collected right now');
  log(id, 'COLLECTED', user.id);
  return { listing: shape(getListing(id), user) };
});

route('POST', /^\/api\/listings\/(\d+)\/distribute$/, ['ngo'], (req, { user, m, body }) => {
  const id = Number(m[1]);
  const served = int(body.people_served, 'People served', 0, 100000);
  const ok = transition(id, 'COLLECTED', 'DISTRIBUTED', 'claimed_by = ?', [user.id], ', distributed_at=?, people_served=?', [Date.now(), served]);
  if (!ok) throw new HttpError(409, 'Only food you have collected can be marked distributed');
  log(id, 'DISTRIBUTED', user.id);
  return { listing: shape(getListing(id), user) };
});

route('POST', /^\/api\/listings\/(\d+)\/cancel$/, ['restaurant'], (req, { user, m }) => {
  const id = Number(m[1]);
  if (!transition(id, 'AVAILABLE', 'CANCELLED', 'provider_id = ?', [user.id]))
    throw new HttpError(409, 'Only listings nobody has accepted yet can be cancelled');
  log(id, 'CANCELLED', user.id);
  return { listing: shape(getListing(id), user) };
});

// Admin: verify organisations
route('GET', /^\/api\/admin\/users$/, ['admin'], () => ({
  users: q("SELECT * FROM users WHERE role != 'admin' ORDER BY verified, created_at DESC").map(publicUser),
}));
route('POST', /^\/api\/admin\/users\/(\d+)\/verify$/, ['admin'], (req, { m, body }) => {
  const r = run("UPDATE users SET verified=? WHERE id=? AND role != 'admin'", body.verified === false ? 0 : 1, Number(m[1]));
  if (!r.changes) throw new HttpError(404, 'User not found');
  return { ok: true };
});

route('GET', /^\/api\/admin\/listings$/, ['admin'], (req, { user }) => {
  expireOld();
  return { listings: q(`${LISTING_SQL} ORDER BY l.created_at DESC LIMIT 200`).map((l) => shape(l, user)) };
});
const deleteListings = (where, ...args) => {
  run(`DELETE FROM status_log WHERE listing_id IN (SELECT id FROM listings WHERE ${where})`, ...args);
  run(`DELETE FROM listings WHERE ${where}`, ...args);
};
route('POST', /^\/api\/admin\/listings\/(\d+)\/delete$/, ['admin'], (req, { m }) => {
  getListing(Number(m[1]));
  deleteListings('id = ?', Number(m[1]));
  return { ok: true };
});
// Deleting a user removes their own listings; listings they only claimed go back to the pool (or lose the link if finished).
route('POST', /^\/api\/admin\/users\/(\d+)\/delete$/, ['admin'], (req, { m }) => {
  const id = Number(m[1]);
  const u = q1('SELECT * FROM users WHERE id=?', id);
  if (!u || u.role === 'admin') throw new HttpError(404, 'User not found');
  db.exec('BEGIN');
  try {
    deleteListings('provider_id = ?', id);
    run("UPDATE listings SET status='AVAILABLE', claimed_by=NULL, claimed_at=NULL WHERE claimed_by=? AND status IN ('ACCEPTED','COLLECTED')", id);
    run('UPDATE listings SET claimed_by=NULL WHERE claimed_by=?', id);
    run('DELETE FROM users WHERE id=?', id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { ok: true };
});

route('GET', /^\/api\/admin\/overview$/, ['admin'], () => {
  expireOld();
  const n = (sql) => q1(sql).n, o = {
    restaurants: n("SELECT COUNT(*) n FROM users WHERE role='restaurant'"),
    ngos: n("SELECT COUNT(*) n FROM users WHERE role='ngo'"),
    pending: n("SELECT COUNT(*) n FROM users WHERE role='ngo' AND verified=0"),
    meals: q1("SELECT COALESCE(SUM(servings),0) n FROM listings WHERE status='DISTRIBUTED'").n,
  };
  for (const s of ['AVAILABLE', 'ACCEPTED', 'COLLECTED', 'DISTRIBUTED', 'CANCELLED', 'EXPIRED'])
    o[s] = n(`SELECT COUNT(*) n FROM listings WHERE status='${s}'`);
  return o;
});
const TABLES = {
  users: 'SELECT id,role,name,email,phone,address,lat,lng,verified,created_at FROM users',
  listings: 'SELECT id,provider_id,title,food_type,veg,quantity,servings,address,status,claimed_by,people_served,pickup_deadline,created_at FROM listings',
  status_log: 'SELECT id,listing_id,status,user_id,at FROM status_log',
};
route('GET', /^\/api\/admin\/table\/(\w+)$/, ['admin'], (req, { m }) => {
  if (!TABLES[m[1]]) throw new HttpError(404, 'Unknown table');
  return { rows: q(`${TABLES[m[1]]} ORDER BY id DESC LIMIT 1000`), total: q1(`SELECT COUNT(*) n FROM ${m[1]}`).n };
});
route('POST', /^\/api\/admin\/clear$/, ['admin'], (req, { body }) => {
  if (!['listings', 'all'].includes(body.what)) throw bad('what must be listings or all');
  db.exec('BEGIN');
  try {
    run('DELETE FROM status_log'); run('DELETE FROM listings');
    if (body.what === 'all') run("DELETE FROM users WHERE role != 'admin'");
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { ok: true };
});

// ---------- HTTP server ----------
function send(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 100000) { reject(new HttpError(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const b = JSON.parse(Buffer.concat(chunks)); resolve(b && typeof b === 'object' ? b : {}); }
      catch { reject(bad('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, decodeURIComponent(url.pathname));
    const body = req.method === 'POST' ? await readBody(req) : {};
    let pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== req.method) continue;
      let user = null;
      if (r.roles) {
        user = authUser(req);
        if (r.roles !== 'any' && !r.roles.includes(user.role)) throw new HttpError(403, 'Not allowed for your account type');
      }
      return send(res, 200, r.fn(req, { user, body, m, url }));
    }
    throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Method not allowed' : 'Not found');
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    send(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'Something went wrong on our side' });
  }
});

// Create the admin account on first run
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@annadata.local').toLowerCase();
if (!q1("SELECT id FROM users WHERE role='admin'")) {
  const pw = process.env.ADMIN_PASSWORD || 'admin12345';
  const { salt, hash } = hashPw(pw);
  run(`INSERT INTO users(role,name,email,pw_hash,pw_salt,verified,created_at) VALUES('admin','Annadata Admin',?,?,?,1,?)`,
    ADMIN_EMAIL, hash, salt, Date.now());
  console.log(`Admin created: ${ADMIN_EMAIL}` + (process.env.ADMIN_PASSWORD ? '' : ' / admin12345  (change this: set ADMIN_PASSWORD before first run)'));
}

server.listen(PORT, () => console.log(`Annadata running at http://localhost:${server.address().port}`));
module.exports = server;
