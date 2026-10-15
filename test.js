'use strict';
// End-to-end test: runs the real server on a temp database and walks through the whole donation flow.
const os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
process.env.DB_FILE = path.join(os.tmpdir(), `annadata-test-${Date.now()}.db`);
process.env.PORT = '0';
process.env.ADMIN_PASSWORD = 'test-admin-pass';
const server = require('./server.js');

(async () => {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const base = `http://localhost:${server.address().port}/api`;
  const call = async (p, method = 'GET', body, token) => {
    const r = await fetch(base + p, { method, body: body && JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) } });
    return { status: r.status, ...(await r.json()) };
  };
  const reg = (role, name, lat, lng) => call('/register', 'POST', { role, name, email: `${name.replace(/\s/g, '')}@x.com`.toLowerCase(),
    password: 'password123', phone: '9999900000', address: `${name} street`, lat, lng });
  let n = 0; const ok = (m) => console.log(`  ✔ ${++n}. ${m}`);

  const rest = await reg('restaurant', 'Hotel Rasoi', 19.8762, 75.3433); assert.equal(rest.status, 200);
  const ngoA = await reg('ngo', 'Seva Trust', 19.88, 75.35);
  const ngoB = await reg('ngo', 'Helping Hands', 19.87, 75.34);
  const far = await reg('ngo', 'Far NGO', 18.52, 73.85); // Pune, ~230 km away
  assert.equal((await reg('ngo', 'Seva Trust', 1, 1)).status, 409); ok('duplicate email rejected');
  assert.equal((await call('/login', 'POST', { email: 'hotelrasoi@x.com', password: 'wrong' })).status, 401); ok('wrong password rejected');

  const deadline = Date.now() + 2 * 36e5;
  const mk = (extra = {}) => call('/listings', 'POST', { title: 'Veg biryani', food_type: 'Cooked meal', quantity: '8 kg', servings: 40, pickup_deadline: deadline, ...extra }, rest.token);
  assert.equal((await mk({ pickup_deadline: Date.now() - 1000 })).status, 400); ok('past deadline rejected');
  assert.equal((await mk({ servings: -5 })).status, 400); ok('invalid servings rejected');
  assert.equal((await call('/listings', 'POST', {}, ngoA.token)).status, 403); ok('NGOs cannot post listings');
  const listing = (await mk()).listing; assert.equal(listing.status, 'AVAILABLE'); ok('restaurant posts listing');

  assert.equal((await call('/listings/available', 'GET', null, ngoA.token)).status, 403); ok('unverified NGO blocked from listings');
  assert.equal((await call(`/listings/${listing.id}/claim`, 'POST', {}, ngoA.token)).status, 403); ok('unverified NGO cannot claim');

  const admin = await call('/login', 'POST', { email: 'admin@annadata.local', password: 'test-admin-pass' });
  assert.equal((await call(`/admin/users/${ngoA.user.id}/verify`, 'POST', {}, ngoA.token)).status, 403); ok('NGO cannot self-verify');
  for (const u of [ngoA, ngoB, far]) await call(`/admin/users/${u.user.id}/verify`, 'POST', {}, admin.token);
  ok('admin verifies NGOs');

  const near = await call('/listings/available?radius=25', 'GET', null, ngoA.token);
  assert.equal(near.listings.length, 1); assert.ok(near.listings[0].distance_km < 5); assert.equal(near.listings[0].provider_phone, undefined);
  assert.equal((await call('/listings/available?radius=25', 'GET', null, far.token)).listings.length, 0); ok('location filter works; phone hidden before claim');

  const [r1, r2] = await Promise.all([ngoA, ngoB].map((u) => call(`/listings/${listing.id}/claim`, 'POST', {}, u.token)));
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]); ok('simultaneous claim: exactly one winner (first-come, first-served)');
  const winner = r1.status === 200 ? ngoA : ngoB, loser = winner === ngoA ? ngoB : ngoA;
  assert.equal(r1.status === 200 ? r1.listing.provider_phone : r2.listing.provider_phone, '9999900000'); ok('winner sees provider phone');
  assert.equal((await call(`/listings/${listing.id}/collect`, 'POST', {}, loser.token)).status, 409); ok('loser cannot touch it');
  assert.equal((await call(`/listings/${listing.id}/cancel`, 'POST', {}, rest.token)).status, 409); ok('accepted listing cannot be cancelled');
  assert.equal((await call(`/listings/${listing.id}/distribute`, 'POST', { people_served: 10 }, winner.token)).status, 409); ok('cannot skip COLLECTED step');

  assert.equal((await call(`/listings/${listing.id}/collect`, 'POST', {}, winner.token)).listing.status, 'COLLECTED'); ok('pickup → COLLECTED');
  const done = await call(`/listings/${listing.id}/distribute`, 'POST', { people_served: 38 }, winner.token);
  assert.equal(done.listing.status, 'DISTRIBUTED'); ok('→ DISTRIBUTED');

  const detail = await call(`/listings/${listing.id}`, 'GET', null, rest.token);
  assert.deepEqual(detail.history.map((h) => h.status), ['AVAILABLE', 'ACCEPTED', 'COLLECTED', 'DISTRIBUTED']); ok('status history recorded');
  const stats = await call('/stats'); assert.equal(stats.meals, 40); assert.equal(stats.donations, 1); ok('public stats updated');

  // release + cancel paths
  const l2 = (await mk()).listing;
  await call(`/listings/${l2.id}/claim`, 'POST', {}, ngoA.token);
  assert.equal((await call(`/listings/${l2.id}/release`, 'POST', {}, ngoA.token)).listing.status, 'AVAILABLE'); ok('NGO can release a claim back to the pool');
  assert.equal((await call(`/listings/${l2.id}/cancel`, 'POST', {}, rest.token)).listing.status, 'CANCELLED'); ok('restaurant can cancel unclaimed listing');
  assert.equal((await call('/me')).status, 401); ok('API requires login');

  console.log(`\nAll ${n} checks passed.`); server.close(); process.exit(0);
})().catch((e) => { console.error('\n✘ FAILED:', e.message); process.exit(1); });
