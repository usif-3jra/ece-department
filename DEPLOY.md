# Deployment Guide — v2 → v3 Upgrade
## Stack: Render · Neon · MailerSend · mirror-logic.com

---

## Before You Start

| What you have | Status |
|---------------|--------|
| Neon database (from v2) | ✅ Already configured — **no changes needed** |
| MailerSend account + verified domain | ✅ Already configured |
| Render account | ✅ Already configured |
| mirror-logic.com domain | ✅ Already configured |

> **Database safety**: The v3 schema is identical to v2. All existing projects, grades, supervisors, and evaluations are kept exactly as-is. You will point v3 at the **same Neon database** — no migration SQL needed.

---

## Step 1 — Push v3 to GitHub

1. In your GitHub repository, replace the current v2 files with the contents of this folder (`FYP-Standalone-NeonRenderMailtrap-v3/`)
2. Commit and push to your main branch
   ```
   git add .
   git commit -m "Upgrade to v3 — landing portal + ECE resources hub"
   git push
   ```
   > If you prefer to keep v2 in a separate branch, push v3 to a new branch and deploy from that branch in Render.

---

## Step 2 — Deploy on Render

### Option A — Update your existing Render service (recommended)

If Render is already connected to the same GitHub repository:

1. Go to your Render service dashboard
2. Under **Settings → Build & Deploy**, confirm:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
3. Render automatically redeploys when you push to GitHub (Step 1 triggers this)
4. Monitor the deploy log — the build completes in ~1–2 minutes
5. **Skip to Step 3**

### Option B — Create a new Render service

Use this if you want v3 as a separate service (keeps v2 running in parallel during testing):

1. Go to [render.com](https://render.com) → **New → Web Service**
2. Connect your GitHub repository and select the v3 branch
3. Configure:

   | Setting | Value |
   |---------|-------|
   | **Environment** | Node |
   | **Build Command** | `npm install` |
   | **Start Command** | `npm start` |
   | **Instance Type** | Free |

4. Add environment variables (see Step 3 below)
5. Click **Create Web Service**

---

## Step 3 — Environment Variables

### If updating an existing service (Option A)
No changes needed — all variables from v2 carry over unchanged, including `DATABASE_URL`.

### If creating a new service (Option B)
Copy these **exactly** from your v2 Render service (Dashboard → Environment):

| Variable | Where to find it | Notes |
|----------|-----------------|-------|
| `DATABASE_URL` | v2 Render → Environment | **Same Neon database** — do not change |
| `SENDER_EMAIL` | v2 Render → Environment | e.g. `noreply@mirror-logic.com` |
| `MAILERSEND_API_KEY` | v2 Render → Environment | Same MailerSend token |
| `APP_URL` | **Update this** | New Render URL e.g. `https://fyp-v3.onrender.com` |
| `PWD_SALT` | v2 Render → Environment | **Must be the same** — changing it invalidates all passwords |

> ⚠️ `PWD_SALT` must be identical to v2. If it changes, every supervisor will need to reset their password.

---

## Step 4 — Do NOT Run schema.sql

The v3 schema is byte-for-byte identical to v2. **Do not run `schema.sql`** on your existing Neon database.

- All `CREATE TABLE IF NOT EXISTS` statements would be no-ops
- All `INSERT ... ON CONFLICT DO NOTHING` seeds would be skipped
- But running it is unnecessary noise — leave the database alone

The only time to run `schema.sql` is on a **brand new empty Neon database**.

---

## Step 5 — Update the Custom Domain

### If you updated the existing service (Option A)
The domain already points to the same Render service — nothing to do.

### If you created a new service (Option B)

**In Render (v3 service):**
1. Go to **Settings → Custom Domains → Add Custom Domain**
2. Enter `mirror-logic.com` (and optionally `www.mirror-logic.com`)
3. Render shows you a CNAME target like `fyp-v3.onrender.com`

**In Cloudflare (DNS):**
1. Log in to Cloudflare → select `mirror-logic.com`
2. Find the existing CNAME record pointing to your v2 Render URL
3. Update it to point to the new v3 Render URL
4. Keep **Proxy status: Proxied** (orange cloud) for the apex record, or **DNS only** (grey) if Render requires it
5. DNS propagation: immediate via Cloudflare, ~5 min globally

---

## Step 6 — Verify After Deploy

Run through this checklist after deployment:

| Check | How |
|-------|-----|
| Landing page loads | Visit `https://mirror-logic.com` — should show the portal with FYP and ECE cards |
| FYP system loads | Click the FYP card or visit `/fyp` — login screen should appear |
| Existing data intact | Log in as `F20170170` — all projects and grades from v2 should be present |
| ECE Resources hub | Click the ECE card or visit `/ece-resources` — 4 program cards in one row |
| EPME program | Visit `/ece-resources/epme` — page loads without 404 |
| CEE program | Visit `/ece-resources/cee` — page loads without 404 |
| CE program | Visit `/ece-resources/ce` — page loads without 404 |
| BME program | Visit `/ece-resources/bme` — page loads without 404 |
| Examiner portal | Visit `/examiner?token=TEST` — should show "Invalid or expired link" |
| Peer eval portal | Visit `/peer` — should show the student ID input form |
| Email delivery | Trigger a password reset or examiner assignment to confirm MailerSend works |

---

## Step 7 — Decommission v2 (Optional)

Once v3 is verified and the domain points to it:

1. In Render, go to your **v2 service**
2. **Settings → Delete Web Service** (this only removes the server — Neon data is unaffected)
3. Keep the v2 GitHub branch for rollback reference

---

## New Routes in v3

v3 adds the following URL paths that did not exist in v2:

| URL | Serves |
|-----|--------|
| `/` | Landing portal (`landing.html`) |
| `/fyp` | FYP system (`index.html`) — was `/` in v2 |
| `/ece-resources` | ECE hub (`ece-resources/index.html`) |
| `/ece-resources/epme` | EPME program page |
| `/ece-resources/cee` | CEE program page |
| `/ece-resources/ce` | CE program page |
| `/ece-resources/bme` | BME program page |

> **Note**: In v2, the FYP system was served at `/`. In v3 it moves to `/fyp`. The root `/` now shows the landing portal. Update any bookmarks or shared links accordingly.

---

## Environment Variables Reference

```
DATABASE_URL=postgresql://neonuser:password@ep-xxxx.neon.tech/neondb?sslmode=require
SENDER_EMAIL=noreply@mirror-logic.com
MAILERSEND_API_KEY=eyJhbGciOiJSUzI1NiJ9...
APP_URL=https://mirror-logic.com
PWD_SALT=<same value used in v2>
```

---

## Specs

| Capability | Detail |
|-----------|--------|
| **Hosting** | Render free Web Service — persistent Node.js/Express |
| **Database** | Neon free tier — 0.5 GB storage, shared with v2 |
| **Email** | MailerSend free tier — 3,000 emails/month |
| **Cold start** | ~30–60 s after 15 min idle — eliminated by UptimeRobot (free) |
| **Custom domain** | mirror-logic.com via Cloudflare CNAME |
| **HTTPS** | Automatic TLS via Render |

**UptimeRobot** (keep running from v2 — update the URL if you changed services):
- URL: `https://mirror-logic.com`
- Interval: every 10 minutes
- Type: HTTP(s)

---

## Admin Accounts

| Role | ID | Initial Password |
|------|----|-----------------|
| Admin | `A20160170` | `fyp2025` (or whatever was set in v2) |
| Dr. Youssef Ajra | `F20170170` | same as v2 |

Passwords are unchanged from v2 — they are stored in Neon and carried over automatically.
