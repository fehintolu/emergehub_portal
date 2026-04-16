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
```

## Paystack

1. Add **public** and **secret** keys in `.env` and/or **Portal admin → Settings** (secret is never sent to the browser).
2. Register the webhook URL in the Paystack dashboard:

   **`https://my.emergehub.com.ng/api/webhooks/paystack`**

3. Card payments: server initializes a transaction and returns Paystack’s `authorization_url`; the member is redirected to Paystack Checkout, then back to the portal. **Always** trust payment state from the webhook after server-side verification, not the browser return alone.

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
| `SMTP_*` | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` for nodemailer |
| `PAYSTACK_PUBLIC_KEY` / `PAYSTACK_SECRET_KEY` | Optional; can be overridden in admin settings |
| `UPLOAD_DIR` | Absolute path for uploaded files (outside nginx root) |
| `MAX_UPLOAD_MB` | Per-file limit (default 10) |

Copy `.env.example` to `.env` and fill in values.

## Stack

- Node **18+**, **Express 5**, **EJS**, **PostgreSQL** (`pg`), **connect-pg-simple** (sessions in `member_sessions` and `portal_admin_sessions`), **bcryptjs**, **nodemailer**, **helmet**, **express-rate-limit**, **multer**.

## Isolation

- Does **not** modify marketing CMS tables; reads `service_categories`, `services`, `membership_tiers`, `site_settings`.
- Does **not** use the marketing `session` table; separate session tables and cookies (`portal.member.sid`, `portal.admin.sid`).
