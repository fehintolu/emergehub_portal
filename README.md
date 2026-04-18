# EmergeHub Member Portal (`emergehub_portal`)

Isolated member portal and admin application for **https://my.emergehub.com.ng**.

**Source:** [github.com/fehintolu/emergehub_portal](https://github.com/fehintolu/emergehub_portal)

Production deployment on this server includes **systemd**, **nginx** reverse proxy, and **Let’s Encrypt** TLS for `my.emergehub.com.ng`.

## On this server

| Item | Value |
|------|--------|
| **Project directory** | `/apps/emergehub-portal` |
| **App port (localhost)** | `4601` (`HOST=127.0.0.1` in `.env`) |
| **Process manager** | `systemd` unit `emergehub-portal.service` |
| **Nginx site config** | `/etc/nginx/sites-available/emergehub-portal.conf` (symlink in `sites-enabled`) |
| **PostgreSQL database** | `emergehub_website` (shared with marketing site; portal uses **new tables only** for writes) |
| **Upload storage** | `UPLOAD_DIR` in `.env` (default under `data/uploads/` in project if unset) |

## Commands

```bash
# Start / stop / restart
sudo systemctl start emergehub-portal
sudo systemctl stop emergehub-portal
sudo systemctl restart emergehub-portal
sudo systemctl status emergehub-portal

# Logs
journalctl -u emergehub-portal -f

# Database schema (idempotent)
cd /apps/emergehub-portal && npm run setup-db

# Official catalog / room rates / capacity seed (idempotent; safe to re-run)
npm run seed-prices
```

### Meeting rooms (legacy data)

Older **`meeting_room_bookings`** rows (workspace JSON room list) are unchanged. New paid flow uses **`room_bookings`** and **`meeting_rooms`**. Optional migration: recreate bookings manually or with a one-off SQL script; the portal does not auto-migrate legacy rows.

### Background jobs (cron)

In-process jobs run when **`ENABLE_CRON=1`** is set in the environment. Leave it unset in local dev to avoid duplicate schedulers if you run multiple `node server.js` processes. Production: set **`ENABLE_CRON=1`** on a **single** app instance (or use an external scheduler instead).

When enabled, the scheduler also runs:

- **Every 15 minutes:** pending meeting-room booking expiry (releases reserved plan credits) and payment nudges.
- **Daily 08:05:** service-end reminders (existing).
- **1st of month 00:00 (server clock):** meeting credit ledger reset for eligible members.
- **Daily 00:15:** end prior daily-access seat assignments and trigger waitlist offers.
- **Daily 08:30:** reminders for space assignments ending within 7 days.
- **Daily 12:00:** expire stale waitlist offers and notify the next member.

**`PORTAL_TZ`** (default **`Africa/Lagos`**) is used for hub-local date logic in jobs and availability; cron times follow the **server’s system timezone** unless you run a dedicated external scheduler aligned to hub time.

## Paystack

1. Add **public** and **secret** keys in `.env` and/or **Portal admin → Settings** (secret is never sent to the browser).
2. Register the webhook URL in the Paystack dashboard:

   **`https://my.emergehub.com.ng/api/webhooks/paystack`**

3. Card payments: server initializes a transaction and returns Paystack’s `authorization_url`; the member is redirected to Paystack Checkout, then back to the portal. **Always** trust payment state from the webhook after server-side verification, not the browser return alone.

## Email (Resend)

Transactional email (verification, password reset, invoices, payments, service updates, support) uses **[Resend](https://resend.com)** when configured.

1. Create an API key in the [Resend dashboard](https://resend.com/api-keys).
2. **Verify the domain** `emergehub.com.ng` in Resend and add the DNS records they provide.
3. Set in `.env`:
   - **`RESEND_API_KEY`** — your Resend API key (required for sending).
   - **`RESEND_FROM`** (optional) — defaults to **`no-reply@emergehub.com.ng`** (use `Name <no-reply@emergehub.com.ng>` if you want a display name).

Until **emergehub.com.ng** is verified in Resend, API calls will return an error and verification emails will not be delivered. The portal shows a clear message on “Resend verification” when this happens.

If `RESEND_API_KEY` is not set, the app falls back to **`SMTP_*`** (nodemailer) when `SMTP_HOST` and `SMTP_FROM` are configured.

## Default portal admin (seed)

After `npm run setup-db`, sign in at **`/admin/login`**:

- **Username:** `admin`
- **Email:** `admin@emergehub.com.ng`
- **Password:** `Admin1234` (you must change password on first login)

## Environment variables

| Variable | Description |
|----------|-------------|
| `HOST` | Bind address (use `127.0.0.1` behind nginx) |
| `PORT` | Port (default `4601`) |
| `BASE_URL` | Public site URL, e.g. `https://my.emergehub.com.ng` |
| `DATABASE_URL` | Postgres connection string (same DB as `emergehub-website`) |
| `MEMBER_SESSION_SECRET` | Secret for member cookie sessions |
| `ADMIN_SESSION_SECRET` | Secret for admin cookie sessions |
| `COOKIE_SECURE` | Set `1` in production (HTTPS) |
| `TRUST_PROXY` | Set `1` behind nginx |
| `RESEND_API_KEY` | **Resend API key** — primary transport for all portal emails |
| `RESEND_FROM` | Sender address (default `no-reply@emergehub.com.ng`); must be allowed in Resend for your domain |
| `SMTP_*` | Optional **fallback** if Resend is unset: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` |
| `PAYSTACK_PUBLIC_KEY` / `PAYSTACK_SECRET_KEY` | Optional; can be overridden in admin settings |
| `UPLOAD_DIR` | Absolute path for uploaded files (outside nginx root) |
| `MAX_UPLOAD_MB` | Per-file limit (default 10) |
| `ENABLE_CRON` | Set to `1` to run portal maintenance jobs (single instance only) |
| `PORTAL_TZ` | IANA timezone for room availability checks (default `Africa/Lagos`) |

Copy `.env.example` to `.env` and fill in values.

## Stack

- Node **18+**, **Express 5**, **EJS**, **PostgreSQL** (`pg`), **connect-pg-simple** (sessions in `member_sessions` and `portal_admin_sessions`), **bcryptjs**, **Resend** + **nodemailer** (SMTP fallback), **helmet**, **express-rate-limit**, **multer**.

## Isolation

- Does **not** modify marketing CMS tables; reads `service_categories`, `services`, `membership_tiers`, `site_settings`.
- Does **not** use the marketing `session` table; separate session tables and cookies (`portal.member.sid`, `portal.admin.sid`).
