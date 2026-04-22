# EmergeHub member portal — user guide

This guide describes the **member** experience at the EmergeHub portal (after you have an account). URLs below are **paths** on your site (for example `https://yoursite.com/help`).

> **In the portal:** open **Knowledge base** from the **Dashboard** banner, the sidebar under **Help**, or go to [`/help`](/help). The **[screenshot checklist](/help/screenshots)** lists images used for printable or external docs.

---

## 1. Account access

### 1.1 Create an account

1. Open **Sign in** (or the registration link your organisation shared).
2. Choose **Create account** (`/auth/register`).
3. Enter your details and a password (at least 8 characters).
4. Submit the form. You may need to **verify your email** before the full portal is available.

**Screenshot:** see `USER_GUIDE_SCREENSHOTS.md` → MEM-001, MEM-002.

### 1.2 Sign in and sign out

- **Sign in:** `/auth/login` — use the email and password you registered with.
- **Sign out:** use **Log out** at the bottom of the sidebar (submits securely and ends your session).

If you are not verified, the app will direct you to the verification flow until your email is confirmed.

**Screenshot:** MEM-003, MEM-004.

### 1.3 Forgot password

1. On the sign-in page, open **Forgot password** (`/auth/forgot-password`).
2. Enter your **email**. If an account exists, you will receive a reset link (check spam).
3. Use the link to set a new password (`/auth/reset-password`).

The same message is shown whether or not the email exists (privacy).

**Screenshot:** MEM-005, MEM-006.

---

## 2. Main navigation (sidebar)

After sign-in, the sidebar includes:

| Item | Purpose |
|------|---------|
| **Dashboard** | Overview and shortcuts. |
| **My Workspace** | Workspace membership, plans, room credits, and related actions. |
| **Book a room** | Search and book meeting rooms. |
| **My room bookings** | List and manage your bookings. |
| **Services** | Browse services and track **your** service requests (badge when updates need attention). |
| **Payments** | Invoices and payment options. |
| **Documents** | Upload and download your files. |
| **Support** | Open and reply to support tickets. |
| **Settings** | Profile, business details, notifications, password, active sessions. |

**Screenshot:** MEM-010 (full sidebar on desktop).

---

## 3. Dashboard

The dashboard summarises your relationship with the hub: activity, quick links, and contextual prompts. Use it as the home base after login.

**Screenshot:** MEM-011.

---

## 4. My Workspace

**My Workspace** (`/workspace`) is where you:

- See your current workspace / plan status.
- **Activate** pending plans when your organisation enables that flow.
- Join **waitlists** or request plans where configured.
- Book **meeting room** time or services that are offered from the workspace, depending on your catalogue.

Exact buttons depend on what your administrator has configured. If something is missing, contact support or your hub contact.

**Screenshot:** MEM-020, MEM-021 (with an active plan if possible).

---

## 5. Meeting rooms

### 5.1 Book a room

1. Open **Book a room** (`/meeting-rooms`).
2. Browse or search for a room, open a room detail page.
3. Pick date, time slot, and duration (as the UI allows).
4. Confirm the booking and note any **price quote** or **discount** shown.

**Screenshot:** MEM-030 (directory), MEM-031 (room detail / calendar).

### 5.2 My room bookings

**My room bookings** (`/meeting-rooms/my-bookings`) lists upcoming and past bookings. You can open a booking for **confirmation** details and, where allowed, **cancel**.

**Screenshot:** MEM-032, MEM-033.

---

## 6. Services

**Services** (`/services`) usually has tabs such as:

- **Your requests** — service requests you already started; open one for status, messages, and documents.
- **Request a service** — catalogue of services you can start.

Starting a service typically collects information and may create an invoice or move you into a workflow managed by staff.

**Screenshot:** MEM-040 (tab “yours”), MEM-041 (browse / request tab), MEM-042 (single service request detail with thread).

---

## 7. Payments

**Payments** (`/billing`) shows:

- **Outstanding invoices** (unpaid / sent / overdue) with amounts and due context.
- Ways to pay: **Pay online** (when Paystack is configured) or **manual / bank transfer** with proof upload if your portal allows it.
- **Receipt** or **print** links where available.

Always keep proof of transfer if you pay manually until the invoice shows as paid.

**Screenshot:** MEM-050 (summary + invoice list), MEM-051 (pay / manual flow — redact account numbers if sensitive).

---

## 8. Documents

**Documents** (`/documents`) lets you upload files your hub needs and download files shared with you. Respect any size/type limits shown on the form.

**Screenshot:** MEM-060.

---

## 9. Support

1. **Support** (`/support`) lists your tickets.
2. **New ticket** (`/support/new`) — subject and message; attach a file if needed.
3. Open a ticket to **reply** or **reopen** when the workflow allows.

**Screenshot:** MEM-070 (list), MEM-071 (new ticket), MEM-072 (ticket thread).

---

## 10. Notifications

Use the **bell** in the header or go to `/notifications` to read portal notifications. Mark individual items read or mark all read.

**Screenshot:** MEM-080.

---

## 11. Settings

**Settings** uses these tabs (URLs like `/settings/profile`, `/settings/business`, `/settings/notifications`, `/settings/security`):

- **Profile** — name, phone, profile photo, and extended profile fields your hub uses.
- **Business** — business name and related fields.
- **Notifications** — email/SMS preferences where offered.
- **Security** — change your password and, when shown, **active sessions** you can revoke.

**Screenshot:** MEM-090 (profile), MEM-091 (notifications), MEM-092 (security), MEM-093 (business — optional).

---

## 12. Email verification & account recovery

- New accounts may need to confirm email via **`/auth/verify`** (link from the message you receive).
- If you are stuck on **verification required**, use **resend** from that screen when the portal offers it.
- Under **Settings → Profile**, changing your **email** can trigger a new verification message; you must confirm before the new address is fully active.

---

## 13. My Workspace — actions reference

| Action | Typical path | What it does |
|--------|----------------|--------------|
| View status & plan | `/workspace` | Shows what you have today, renewals, and next steps. |
| Activate plan | Workspace | Confirms a **pending** plan staff have assigned after payment or approval. |
| Waitlist | Workspace | Join when a **capacity-limited** plan has no free seat. |
| Plan request | Workspace | Tells staff you want a specific plan; they may invoice you or approve manually. |
| Book room / service from workspace | Workspace buttons | Deep-links into **meeting rooms** or **services** where configured. |

**Meeting credits:** some plans include **included minutes**. Your **Dashboard** may summarise **available**, **used**, and **pool expiry**; eligible bookings apply credits or discounts automatically when the system is configured that way.

---

## 14. Services — requesting, blocking rules & threads

1. **Request** (`/services?tab=request`) — pick a service and complete the intake steps (questions, acknowledgements, etc.).
2. **Blocked** — if **business name** (or other required fields) is missing, starting a request at **`/services/request/:serviceId`** shows a **“Business details required”** screen until you complete **Settings → Business / Profile**.
3. **Your requests** (`/services?tab=mine`) — each row opens **`/services/:id`** (the **service request** id, not the catalogue service id) with:
   - current **status**;
   - **messages** between you and staff;
   - **attachments** when used.

**Statuses you may see** include *Submitted*, *Under Review*, *In Progress*, *Completed*, and *Cancelled* — wording is normalised by your hub. If payment is required mid-flow, you may be sent to **Payments** or see an invoice on the request.

---

## 15. Payments — methods & records

| Method | What you do |
|--------|-------------|
| **Pay online (Paystack)** | Start payment from **Payments**; finish in the checkout window; return to the portal. |
| **Bank / manual** | Follow instructions; **upload proof** if the form appears; wait for staff to mark **paid** or **confirmed**. |
| **Print / PDF** | Use **print** on an invoice or open **receipt** links after payment for your files. |

Outstanding amounts and **due dates** are summarised on **`/billing`**; keep transfers references until the invoice status updates.

---

## 16. Meeting rooms — booking lifecycle

- **Directory** (`/meeting-rooms`) — search or browse; each room has **`/meeting-rooms/:roomId`** with calendar or slots.
- **Quote** — duration and tier discounts may appear before you confirm.
- **Book** — submit the booking form; you may land on confirmation or **My room bookings**.
- **My bookings** (`/meeting-rooms/my-bookings`) — **`/meeting-rooms/bookings/:bookingId/confirmation`** for details; **cancel** when the button is available (policy is set by your hub).

---

## 17. Documents, notifications & security details

- **Documents** (`/documents`) — **upload** with **`/documents/upload`**; **download** via **`/documents/download/:id`**. Respect **max size** (often ~10 MB unless your host changed it) and allowed types.
- **Notifications** — **`/notifications`**; mark one read or **mark all**; the header **bell** links here.
- **Security** (`/settings/security`) — new **password**; **session list** with **revoke** for unfamiliar browsers.

---

## 18. FAQ & troubleshooting

| Issue | What to try |
|-------|-------------|
| Cannot sign in | **Forgot password**; confirm email verified; ask staff if **suspended**. |
| Invoice unpaid after Paystack | Wait a few minutes; refresh **Payments**; contact support with invoice id. |
| No services or rooms listed | Administrators control the **catalogue** and **room** visibility. |
| Service request stuck | Reply in the **thread** or open a **Support** ticket referencing the request. |

---

## 19. Getting help

- **Support** (`/support`) — primary channel for account and billing issues.
- **Billing disputes** — include **invoice number** and payment date.
- **This guide** — bookmark [`/help`](/help) or use the sidebar **Knowledge base**.

---

## Screenshot index

- **In the app:** [`/help/screenshots`](/help/screenshots)
- **Repository:** `docs/USER_GUIDE_SCREENSHOTS.md` (IDs **MEM-***)
