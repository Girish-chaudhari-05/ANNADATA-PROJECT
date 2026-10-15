# Annadata

Connects restaurants, hotels, cafes and canteens that have surplus food with verified NGOs and volunteers.
Status flow (from the project report): **AVAILABLE → ACCEPTED → COLLECTED → DISTRIBUTED**.

## Run it
Requires **Node.js 22.13 or newer**. No `npm install` needed (no dependencies).

    npm start            # http://localhost:3000
    npm test             # 23 end-to-end checks on a throwaway database

First run creates the admin: `admin@annadata.local` / `admin12345`.
Change it: `ADMIN_EMAIL=you@x.com ADMIN_PASSWORD=strongpass npm start` (before first run).

## Pages
| URL | Who |
|---|---|
| `/` | Landing page with links to every portal |
| `/restaurant.html` | Restaurant login / register, post and track listings |
| `/ngo.html` | NGO and volunteer login / register, claim and distribute food |
| `/admin.html` | Admin login only (no public registration), verify NGOs |

Each login page only accepts accounts of its own type. Portals open in new tabs from the home page, and each role stays logged in separately (browser localStorage).

Admin dashboard tabs: Overview (live counts), Organisations (verify / revoke / delete), Listings (delete), Database (browse users, listings, status_log, export CSV, clear data).

## Try the full flow
1. Register a **restaurant** (use "Use my current location" for lat/lng) and post a listing.
2. In a private window, register an **NGO**. It is unverified, so log in as admin and click **Verify**.
3. The NGO sees listings within its chosen radius (nearest first) and clicks **Claim**.
4. Then: Picked up → Mark distributed (enter people served). The restaurant sees each status change.

## How it works
| Feature | Where |
|---|---|
| Separate logins (restaurant / NGO / admin), scrypt-hashed passwords, signed 7-day tokens | `server.js` auth section |
| Listings: type, quantity, servings, prepared time, pickup deadline, address, lat/lng | `listings` table |
| Location-based availability: haversine distance, radius filter, nearest first | `GET /api/listings/available` |
| First-come-first-served claiming: one atomic SQL `UPDATE ... WHERE status='AVAILABLE'` | `transition()` |
| Pickup status tracking + history (`status_log`) | `/collect`, `/distribute`, `/release`, `/cancel` |
| NGO verification by admin | `/api/admin/*` |
| Auto-expiry of listings past their deadline | `expireOld()` |
| Contact numbers shared only after a claim | `shape()` |
| Safety limits: max 48h deadline, max 5 active pickups per NGO, login rate-limit | `server.js` |

## API summary
`POST /api/register` · `POST /api/login` · `GET /api/me` · `GET /api/stats`
`POST /api/listings` (restaurant) · `GET /api/listings/mine` · `GET /api/listings/available?radius=10` (verified NGO)
`POST /api/listings/:id/{claim,release,collect,distribute,cancel}` · `GET /api/listings/:id`
`GET /api/admin/users` · `POST /api/admin/users/:id/verify`

## Before real-world launch
- Serve over **HTTPS** (put Nginx/Caddy in front, or deploy to Render/Railway/a VPS with a persistent disk for `annadata.db`).
- Set `SECRET` env var to a long random string; change the admin password.
- Verify NGOs properly (registration certificate, FSSAI details) before clicking Verify.
- Add food-safety guidance and a disclaimer: the platform coordinates, it does not certify food safety.
- Next features: push/SMS/WhatsApp notifications, map view, photos, ratings, Hindi/Marathi UI, a mobile app (the JSON API is ready for it).

## Testing several users at once
Each browser tab keeps its own login (sessionStorage), so you can open the restaurant, NGO and admin in
separate tabs of the same browser. Closing a tab logs that tab out.
