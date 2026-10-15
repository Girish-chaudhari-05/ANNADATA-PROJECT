(() => {
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (ms) => ms ? new Date(ms).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const left = (ms) => { const m = Math.round((ms - Date.now()) / 60000); return m <= 0 ? 'expired' : m < 60 ? `${m} min left` : `${Math.floor(m / 60)}h ${m % 60}m left`; };
const ROLE = window.ROLE, KEY = 'annadata_token_' + ROLE, LABEL = { restaurant: 'Restaurant', ngo: 'NGO & Volunteer', admin: 'Admin' }[ROLE];
let token = localStorage.getItem(KEY), me = null, timer = null;

function toast(msg, bad) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = ''), 3500);
}
async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { if (r.status === 401 && token) logout(); throw new Error(data.error || 'Request failed'); }
  return data;
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };
function logout() { token = null; me = null; localStorage.removeItem(KEY); clearInterval(timer); authView(); }
function setSession(d) { token = d.token; me = d.user; localStorage.setItem(KEY, token); appView(); }
const where = () => new Promise((res, rej) => navigator.geolocation
  ? navigator.geolocation.getCurrentPosition((p) => res(p.coords), () => rej(new Error('Could not get your location. Enter it manually.')))
  : rej(new Error('Location not supported in this browser')));

// ---------- Login / Register ----------
function authView() {
  const reg = ROLE !== 'admin';
  $('#app').innerHTML = `
  <header><a class="brand" href="/">🌾 Annadata</a><span>${LABEL} portal</span></header>
  <div class="wrap narrow"><div class="card">
    <h2>${LABEL} ${reg ? 'access' : 'login'}</h2>
    ${reg ? '<div class="tabs"><button id="t-login">Log in</button><button id="t-reg" class="alt">Register</button></div>' : '<p class="muted">Authorised administrators only.</p>'}
    <form id="login">
      <input type="hidden" name="role" value="${ROLE}">
      <label>Email</label><input name="email" type="email" required autocomplete="username">
      <label>Password</label><input name="password" type="password" required autocomplete="current-password">
      <div class="actions"><button>Log in</button></div>
    </form>
    ${reg ? `<form id="register" hidden>
      <input type="hidden" name="role" value="${ROLE}">
      <label>${ROLE === 'ngo' ? 'NGO / volunteer name' : 'Restaurant / hotel / cafe name'}</label><input name="name" required minlength="2">
      <div class="grid"><div><label>Email</label><input name="email" type="email" required></div>
      <div><label>Password (8+ characters)</label><input name="password" type="password" required minlength="8"></div>
      <div><label>Phone</label><input name="phone" required></div>
      <div><label>Address</label><input name="address" required></div>
      <div><label>Latitude</label><input name="lat" type="number" step="any" required></div>
      <div><label>Longitude</label><input name="lng" type="number" step="any" required></div></div>
      <div class="actions"><button type="button" class="alt" id="geo">📍 Use my current location</button><button>Create account</button></div>
      ${ROLE === 'ngo' ? '<p class="muted">NGOs are verified by an admin before they can claim food.</p>' : ''}
    </form>` : ''}
    <p class="muted"><a href="/">← Back to home</a></p>
  </div></div>`;
  if (reg) {
    const show = (r) => { $('#login').hidden = r; $('#register').hidden = !r; $('#t-login').className = r ? 'alt' : ''; $('#t-reg').className = r ? '' : 'alt'; };
    $('#t-login').onclick = () => show(false); $('#t-reg').onclick = () => show(true);
    $('#register').onsubmit = guard(async (e) => { e.preventDefault(); setSession(await api('/register', 'POST', Object.fromEntries(new FormData(e.target)))); });
    $('#geo').onclick = guard(async () => { const c = await where(); $('#register [name=lat]').value = c.latitude.toFixed(5); $('#register [name=lng]').value = c.longitude.toFixed(5); });
  }
  $('#login').onsubmit = guard(async (e) => { e.preventDefault(); setSession(await api('/login', 'POST', Object.fromEntries(new FormData(e.target)))); });
}
const loadStats = guard(async () => {
  const s = await api('/stats');
  const el = $('#stats'); if (el) el.innerHTML = `<div><b>${s.meals}</b>meals rescued</div><div><b>${s.donations}</b>donations delivered</div><div><b>${s.live}</b>available now</div>`;
});

// ---------- Listing cards ----------
function card(l, actions = '') {
  const contact = [
    l.provider_phone && `📞 ${esc(l.provider_name)}: <a href="tel:${esc(l.provider_phone)}">${esc(l.provider_phone)}</a>`,
    l.ngo_name && `🤝 Accepted by ${esc(l.ngo_name)}${l.ngo_phone ? `: <a href="tel:${esc(l.ngo_phone)}">${esc(l.ngo_phone)}</a>` : ''}`,
  ].filter(Boolean).map((x) => `<p>${x}</p>`).join('');
  return `<article class="card"><div class="row"><h3>${esc(l.title)}</h3><span class="pill ${l.status}">${l.status}</span></div>
    <p class="muted">${esc(l.provider_name)}</p>
    <p>${l.veg ? '🟢 Veg' : '🔴 Non-veg'} · ${esc(l.food_type)} · ${esc(l.quantity)} · ~${l.servings} servings</p>
    <p>📍 ${esc(l.address)}${l.distance_km != null ? ` · <b>${l.distance_km} km</b> away` : ''}
       · <a target="_blank" rel="noopener" href="https://www.google.com/maps?q=${l.lat},${l.lng}">Directions</a></p>
    <p>⏰ Pickup by ${fmt(l.pickup_deadline)}${l.status === 'AVAILABLE' ? ` (${left(l.pickup_deadline)})` : ''}</p>
    ${l.people_served != null ? `<p>🍽️ Served ${l.people_served} people</p>` : ''}
    ${l.notes ? `<p class="muted">${esc(l.notes)}</p>` : ''}${contact}
    ${actions ? `<div class="actions">${actions}</div>` : ''}</article>`;
}
const btn = (act, id, label, cls = '') => `<button class="${cls}" data-act="${act}" data-id="${id}">${label}</button>`;

// ---------- Main app ----------
function appView() {
  $('#app').innerHTML = `<header><a class="brand" href="/">🌾 Annadata</a><span>${esc(me.name)} · ${LABEL}</span><button id="logout">Log out</button></header>
    <div class="stats" id="stats"></div><main id="main"></main>`;
  $('#logout').onclick = logout;
  const main = $('#main');
  if (me.role === 'restaurant') main.innerHTML = restaurantForm() + `<h2>My listings</h2><div id="lists"></div>`;
  else if (me.role === 'ngo') main.innerHTML = `${me.verified ? '' : '<div class="banner">⏳ Your organisation is awaiting admin verification. You will be able to claim food once approved.</div>'}<div id="lists"></div>`;
  else adminShell();
  if (me.role === 'restaurant') wireForm();
  main.onclick = guard(async (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const { act, id } = b.dataset;
    if (act === 'tab') { tab = id; adminShell(); return refresh(); }
    if (act === 'tbl') { tbl = id; return refresh(); }
    if (act === 'export') return exportCsv();
    if (act === 'clear') {
      if (!confirm(id === 'all' ? 'Delete ALL restaurants, NGOs and listings? Admin stays.' : 'Delete ALL listings and status history?')) return;
      if (id === 'all' && prompt('Type DELETE to confirm') !== 'DELETE') return;
      await api('/admin/clear', 'POST', { what: id }); toast('Data cleared'); return refresh();
    }
    if (act === 'distribute') {
      const n = prompt('How many people were served?'); if (n === null) return;
      await api(`/listings/${id}/distribute`, 'POST', { people_served: n });
    } else if (act === 'deluser' || act === 'dellisting') {
      if (!confirm(act === 'deluser' ? 'Delete this account and all its listings? This cannot be undone.' : 'Delete this listing permanently?')) return;
      await api(`/admin/${act === 'deluser' ? 'users' : 'listings'}/${id}/delete`, 'POST');
    } else if (act === 'verify' || act === 'unverify') await api(`/admin/users/${id}/verify`, 'POST', { verified: act === 'verify' });
    else await api(`/listings/${id}/${act}`, 'POST');
    toast('Updated ✔'); refresh();
  });
  refresh(); clearInterval(timer); timer = setInterval(refresh, 15000); // live-ish updates
}

function restaurantForm() {
  const dl = new Date(Date.now() + 3 * 36e5 - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
  return `<form class="card" id="lf"><h2>Post surplus food</h2><div class="grid">
    <div><label>Title</label><input name="title" placeholder="e.g. Veg biryani" required></div>
    <div><label>Food type</label><input name="food_type" placeholder="Cooked meal, bakery, fruits…" required></div>
    <div><label>Quantity</label><input name="quantity" placeholder="e.g. 8 kg or 3 trays" required></div>
    <div><label>Approx. servings</label><input name="servings" type="number" min="1" required></div>
    <div><label>Cooked / prepared at</label><input name="prepared_at" type="datetime-local"></div>
    <div><label>Pickup before</label><input name="pickup_deadline" type="datetime-local" value="${dl}" required></div></div>
    <label>Pickup address</label><input name="address" value="${esc(me.address)}" required>
    <label>Notes (allergens, packaging…)</label><textarea name="notes" rows="2" maxlength="300"></textarea>
    <label><input type="checkbox" name="veg" checked style="width:auto"> Vegetarian</label>
    <div class="actions"><button>Publish listing</button></div></form>`;
}
function wireForm() {
  $('#lf').onsubmit = guard(async (e) => {
    e.preventDefault();
    const f = e.target, ms = (v) => (v ? new Date(v).getTime() : null);
    await api('/listings', 'POST', {
      title: f.title.value, food_type: f.food_type.value, quantity: f.quantity.value, servings: f.servings.value,
      address: f.address.value, notes: f.notes.value, veg: f.veg.checked,
      prepared_at: ms(f.prepared_at.value), pickup_deadline: ms(f.pickup_deadline.value),
    });
    f.title.value = f.food_type.value = f.quantity.value = f.servings.value = f.notes.value = '';
    toast('Listing published – nearby NGOs can see it now'); refresh();
  });
}

const refresh = guard(async () => {
  if (!me) return;
  loadStats();
  const box = $('#lists'); if (!box) return;
  if (me.role === 'ngo' && !me.verified) { // pick up admin approval without a manual refresh
    const u = (await api('/me')).user;
    if (u.verified) { me = u; return appView(); }
  }
  if (me.role === 'restaurant') {
    const { listings } = await api('/listings/mine');
    box.innerHTML = listings.map((l) => card(l,
      l.status === 'AVAILABLE' ? btn('cancel', l.id, 'Cancel listing', 'danger') :
      l.status === 'ACCEPTED' ? btn('collect', l.id, 'Mark as collected') : '')).join('') || '<p class="muted">No listings yet.</p>';
  } else if (me.role === 'ngo') {
    const mine = (await api('/listings/mine')).listings;
    const active = mine.filter((l) => ['ACCEPTED', 'COLLECTED'].includes(l.status));
    let html = '';
    if (active.length) html += `<h2>My pickups</h2>` + active.map((l) => card(l,
      l.status === 'ACCEPTED' ? btn('collect', l.id, 'Picked up') + btn('release', l.id, 'Release', 'alt') : btn('distribute', l.id, 'Mark distributed'))).join('');
    if (me.verified) {
      const radius = $('#radius')?.value || 10;
      const { listings, farther, nearest_far_km } = await api(`/listings/available?radius=${radius}`);
      html += `<div class="row"><h2>Available near you</h2><select id="radius" style="width:auto">${[5, 10, 25, 50, 100, 200].map((r) => `<option ${r == radius ? 'selected' : ''} value="${r}">within ${r} km</option>`).join('')}</select></div>`;
      html += listings.map((l) => card(l, btn('claim', l.id, 'Claim this food'))).join('') || (farther ? `<div class="banner">${farther} food listing(s) are available, but farther than ${radius} km (nearest: ${nearest_far_km} km). Choose a bigger distance above, or check that your NGO location (latitude/longitude) is correct.</div>` : '<p class="muted">No food is listed right now. This page refreshes automatically.</p>');
    }
    const done = mine.filter((l) => l.status === 'DISTRIBUTED');
    if (done.length) html += `<h2>Completed</h2>` + done.map((l) => card(l)).join('');
    box.innerHTML = html;
    const r = $('#radius'); if (r) r.onchange = refresh;
  } else await adminRender();
});

// ---------- Admin dashboard ----------
let tab = 'overview', tbl = 'users';
const TABS = { overview: 'Overview', orgs: 'Organisations', listings: 'Listings', database: 'Database' };
function adminShell() {
  $('#main').innerHTML = `<div class="tabs">${Object.entries(TABS).map(([k, v]) => btn('tab', k, v, k === tab ? '' : 'alt')).join('')}</div>
    ${tab === 'overview' ? '' : '<input id="q" placeholder="Search…" style="margin-bottom:.8rem">'}<div id="lists"></div>`;
  if ($('#q')) $('#q').oninput = () => refresh();
}
const cell = (k, v) => v == null ? '' : /(_at|deadline)$|^at$/.test(k) ? fmt(v) : esc(v);
async function adminRender() {
  const term = ($('#q')?.value || '').toLowerCase(), has = (o) => JSON.stringify(Object.values(o)).toLowerCase().includes(term), box = $('#lists');
  if (tab === 'overview') {
    const o = await api('/admin/overview');
    box.innerHTML = (o.pending ? `<div class="banner">⏳ ${o.pending} NGO(s) waiting for verification. Open <b>Organisations</b>.</div>` : '') +
      `<div class="steps">${[['Restaurants', o.restaurants], ['NGOs', o.ngos], ['Awaiting verification', o.pending], ['Available now', o.AVAILABLE], ['Accepted', o.ACCEPTED], ['Collected', o.COLLECTED], ['Distributed', o.DISTRIBUTED], ['Meals rescued', o.meals]]
        .map(([k, n]) => `<div class="card center"><b class="big">${n}</b><span class="muted">${k}</span></div>`).join('')}</div>`;
  } else if (tab === 'orgs') {
    const { users } = await api('/admin/users');
    box.innerHTML = users.filter(has).map((u) => `<div class="card row"><div><b>${esc(u.name)}</b> <span class="pill">${u.role}${u.role === 'ngo' ? (u.verified ? ' · verified' : ' · pending') : ''}</span><p class="muted">${esc(u.email)} · ${esc(u.phone)} · ${esc(u.address)}</p></div>
      <div class="actions">${u.role === 'ngo' ? (u.verified ? btn('unverify', u.id, 'Revoke', 'alt') : btn('verify', u.id, 'Verify ✔')) : ''}${btn('deluser', u.id, 'Delete', 'danger')}</div></div>`).join('') || '<p class="muted">Nothing found.</p>';
  } else if (tab === 'listings') {
    const { listings } = await api('/admin/listings');
    box.innerHTML = listings.filter(has).map((l) => card(l, btn('dellisting', l.id, 'Delete listing', 'danger'))).join('') || '<p class="muted">Nothing found.</p>';
  } else {
    const { rows, total } = await api('/admin/table/' + tbl), shown = rows.filter(has), cols = rows[0] ? Object.keys(rows[0]) : [];
    box.innerHTML = `<div class="tabs">${['users', 'listings', 'status_log'].map((t) => btn('tbl', t, t, t === tbl ? '' : 'alt')).join('')}</div>
      <div class="row"><p class="muted">${total} rows in <b>${tbl}</b> (showing ${shown.length})</p>${btn('export', tbl, '⬇ Export CSV', 'alt')}</div>
      <div class="tablewrap"><table><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr>${shown.map((r) => `<tr>${cols.map((c) => `<td>${cell(c, r[c])}</td>`).join('')}</tr>`).join('')}</table></div>
      <div class="card" style="margin-top:1rem"><h3>Danger zone</h3><p class="muted">Admin account is always kept.</p>
      <div class="actions">${btn('clear', 'listings', 'Delete all listings', 'danger')}${btn('clear', 'all', 'Delete all data', 'danger')}</div></div>`;
  }
}
async function exportCsv() {
  const { rows } = await api('/admin/table/' + tbl); if (!rows.length) return toast('Table is empty', true);
  const cols = Object.keys(rows[0]), c = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...rows.map((r) => cols.map((k) => c(r[k])).join(','))].join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `annadata-${tbl}.csv`; a.click();
}

(async () => {
  if (!token) return authView();
  try { me = (await api('/me')).user; if (me.role !== ROLE) throw 0; appView(); } catch { authView(); }
})();
})();
