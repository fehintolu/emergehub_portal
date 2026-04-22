# EmergeHub admin portal — user guide

This guide is for **staff** using the EmergeHub **admin** portal. The sign-in page is separate from the member portal (username-based, not member email login).

> **In the portal:** open **Knowledge base** from the **Dashboard** banner, the sidebar (all roles, including consultants), or go to [`/admin/help`](/admin/help). **[Screenshot checklist](/admin/help/screenshots)** lists assets for external docs.

---

## 1. Roles and what you see

Your **role** controls menus and actions:

| Role | Typical access |
|------|----------------|
| **Super admin** | Full menu including destructive/archive actions, **Admin users**, test-data tools in **Settings**. |
| **Manager** | Broad operational access; some super-admin-only actions hidden. |
| **Viewer** | Read-only: can browse but not change data. |
| **Consultant** | Narrow menu: **Service requests** only, usually filtered to requests **assigned to you**. |

If something is missing from your sidebar, your organisation’s super admin can adjust your role on **Admin users**.

**Screenshot:** ADM-001 (sidebar — super admin), ADM-002 (sidebar — consultant).

---

## 2. Signing in and account security

### 2.1 Sign in

1. Open `/admin/login`.
2. Enter **username** and **password** (not your member email, unless your username happens to match).
3. After login you land on the **Dashboard** (consultants may land on **Service requests**).

**Screenshot:** ADM-010.

### 2.2 Forgot password (email reset)

1. On the admin login page, use **Forgot password?** (`/admin/forgot-password`).
2. Enter your **username** or the **email** on your admin profile.
3. Use the link in email within about **one hour** (`/admin/reset-password`).

**Screenshot:** ADM-011, ADM-012.

### 2.3 Change password while logged in

If you are required to change password or want to rotate it: use **Change password** when your workflow exposes it (typically `/admin/change-password`), or ask a super admin to set a temporary password from **Admin users**.

**Screenshot:** ADM-013.

### 2.4 Sign out

Use **Log out** in the sidebar footer.

---

## 3. Main navigation (non-consultant)

| Section | Items | Purpose |
|---------|--------|---------|
| Core | **Dashboard** | Counts and queues (members, plans, service requests, invoices, tickets, rooms). |
| | **Members** | Search, create, open profiles; suspend, notes, plans, workspace actions. |
| | **Workspace services** | Service catalogue and **plans**; pricing, capacity flags, ordering. |
| | **Space utilization** | Capacity profiles, units, assignments. |
| | **Service requests** | Operational pipeline; status, assignment, messages, invoices. |
| Finance | **Invoices** | Create, send, mark paid, bank confirmation. |
| Meeting rooms | **Hub**, **Rooms**, **Calendar**, **Bookings**, **Discount tiers**, **Legacy requests** | Configure rooms, see occupancy, manage bookings and discounts. |
| Operations | **Documents**, **Support**, **Notifications** | Cross-member documents, tickets, broadcast-style notifications. |
| Admin | **Admin users** | Super admin: create admins, roles, **set passwords** for other admins. |
| | **Settings** | Portal configuration; super-admin **test data** tab when enabled. |

**Screenshot:** ADM-020 (full sidebar expanded).

---

## 4. Dashboard

Use the dashboard for **at-a-glance** workload: recent service requests, invoices awaiting action, support tickets, room bookings, and similar queues. Follow links into the relevant module.

**Screenshot:** ADM-030.

---

## 5. Members

- **List** (`/admin/members`) — find members, create new accounts if permitted.
- **Member detail** — profile fields, internal notes, **suspend/reactivate**, notifications, **plans**, workspace plan activation, **meeting credits** (super admin), linked service requests and history depending on layout.

Always follow your organisation’s data-handling policy when exporting or copying member data.

**Screenshot:** ADM-040 (list), ADM-041 (detail — redact PII for public docs).

---

## 6. Workspace services (catalogue)

- **Services** — create/edit/archive (permissions vary).
- **Plans** under each service — duration, pricing, **capacity-limited** plans tie into **Space utilization**.

Use **archived** catalogue views to restore or audit retired items (super admin).

**Screenshot:** ADM-050 (service list), ADM-051 (plan edit form).

---

## 7. Space utilization

Manage **capacity profiles**, **units**, and **assignments** so limited plans (desks, offices, etc.) stay accurate. This connects to member workspace visibility and waitlists.

**Screenshot:** ADM-060 (overview), ADM-061 (profile or assignment detail).

---

## 8. Service requests

- Filter and open a request to update **status**, **assign** staff, add **internal** or **member-visible** messages, attach documents, and **generate invoices** when the workflow allows.
- **Consultants** work here on assigned requests only.

**Screenshot:** ADM-070 (list), ADM-071 (detail with timeline/messages).

---

## 9. Invoices

- List and create invoices (`/admin/invoices/new`).
- Open an invoice to record **payment** (Paystack completion or **manual** confirmation), send or adjust as your permissions allow.

**Screenshot:** ADM-080 (list), ADM-081 (invoice detail).

---

## 10. Meeting rooms (admin)

- **Hub** — entry to the meeting-room admin area.
- **Rooms** — create/edit rooms, blocks/blackouts.
- **Calendar** — visual schedule.
- **Bookings** — approve or manage **pending** bookings; manual booking if offered.
- **Discount tiers** — pricing rules.
- **Legacy requests** — older approval flow if still in use.

**Screenshot:** ADM-090 (rooms list), ADM-091 (calendar), ADM-092 (bookings table).

---

## 11. Documents

**Documents** (`/admin/documents`) — operational document store; super admin may delete some records. Use for files that are not tied to a single service-request thread when that applies.

**Screenshot:** ADM-100.

---

## 12. Support (admin)

Handle member **support tickets**: reply, change status, assign. Align with your internal SLA.

**Screenshot:** ADM-110 (list), ADM-111 (ticket detail).

---

## 13. Notifications (admin)

Send or manage **portal notifications** to members as configured (broadcasts, announcements). Follow on-screen fields and test in staging when possible.

**Screenshot:** ADM-120.

---

## 14. Admin users (super admin)

**Admin users** (`/admin/users`):

- Create users with **username**, **email**, initial **password**, and **role**.
- Expand **Change…** on a row to **set password** for another admin (optional **require change on next login**).

Keep the list of super admins minimal.

**Screenshot:** ADM-130 (table + expanded password form — no real passwords visible).

---

## 15. Settings

**Settings** (`/admin/settings`) — portal-wide options (bank details, Paystack, defaults). A **test data** tab may appear for **super admin** (test members, purge tools). Treat production with care.

**Screenshot:** ADM-140 (general tab), ADM-141 (test data tab — optional, staging preferred).

---

## 16. Members module — operations

| Task | Path / action | Notes |
|------|----------------|-------|
| Search & open | `/admin/members`, `/admin/members/:id` | Profile, plans, workspace, meeting credits. |
| Create member | `/admin/members/new` | If permitted; sets initial password / verification flow. |
| Edit profile | Member detail → profile form | May trigger member email verification if email changes. |
| Internal notes | Member detail | Staff-only notes. |
| Suspend / reactivate | POST actions on detail | Blocks member sign-in when suspended. |
| Assign plan / workspace | Member detail | Links to **member_plans** and workspace activation. |
| Meeting credits | Super admin grant | Manual **minute** grants for room pools. |
| Notify member | Member detail | Sends portal notification when configured. |

Treat **PII** per your organisation’s policy.

---

## 17. Workspace services (catalogue) — deeper

- **New service** (`/admin/catalog/new`) and **edit** — name, category, portal visibility, **booking mode** (e.g. plan-linked services may redirect members to workspace).
- **Plans** — per-service **`/admin/catalog/:serviceId/plans`**: pricing, **duration**, **capacity-limited** flag (ties to **Space utilization**), ordering.
- **Sort** — catalogue sort POST to reorder services in the member-facing catalogue.
- **Archive / restore** — super-admin for destructive lifecycle; archived lists under **`/admin/catalog/archived`** and plan archives.

---

## 18. Space utilization & capacity

- **`/admin/space-utilization`** — overview of profiles and occupancy.
- **Profiles** (`/admin/capacity/profiles/:id`) — **total units**, plan linkage.
- **Units** — create/update **space units** and statuses.
- **Assignments** — assign member to unit; **end assignment** when they leave a limited plan.
- Unassigned members may appear on the **dashboard queue** when a paid capacity plan lacks a seat.

---

## 19. Service requests — pipeline

| Action | Purpose |
|--------|---------|
| Filters / list | `/admin/service-requests` — consultants see **only assigned** rows. |
| Status updates | Move workflow (*Submitted* → *Under Review* → *In Progress* → *Completed*, etc.). |
| Assign | Attach a **consultant** or owner. |
| Messages | Staff ↔ member thread; **attachments** on messages when enabled. |
| Generate invoice | Creates billing linked to the request (permissions required). |
| Internal notes | Staff-only context on the detail page. |

Coordinate statuses with finance so **invoices** and **requests** stay aligned.

---

## 20. Invoices & payments

- **List / create** — `/admin/invoices`, `/admin/invoices/new` (line items, member, due date).
- **Detail** — `/admin/invoices/:id`: record **Paystack-paid**, **manual paid**, or **confirm bank** when status is **awaiting_confirmation**.
- **Dashboard queues** — **awaiting_confirmation** and unpaid totals surface for ops follow-up.

---

## 21. Meeting rooms (admin) — operations

- **Rooms** — capacity, pricing hooks, **blackout** blocks.
- **Calendar** — visual load across rooms.
- **Bookings** — **pending** approval flows, **manual** booking entry if enabled.
- **Discount tiers** — rules consumed by member quotes.
- **Legacy requests** — `/admin/rooms/legacy` **approve/reject** older pending bookings if still in use.

---

## 22. Documents, support & notifications

- **Documents** — global file list; **super admin** may **delete** (`/admin/documents`).
- **Support** — reply, **status**, **assign** staff (`/admin/support/:id`).
- **Notifications** — compose **broadcast** / member notifications (`/admin/notifications`); test copy in staging first.

---

## 23. Admin users & security (super admin)

- **`/admin/users`** — roles: **super_admin**, **manager**, **viewer**, **consultant**.
- **Set password** on another row — optional **require change on next login**; clears pending **email reset** tokens.
- **Forgot password** — member-style flow at `/admin/forgot-password` (username or email).

Minimise **super_admin** count; use **viewer** for auditors.

---

## 24. Settings & integrations

- **General** — bank instructions, **Paystack** keys (mask in screenshots), portal defaults.
- **Test data** tab (super admin) — create **test members**, flag accounts, **purge** sandbox data — **never** demo purge on production in training materials.

---

## 25. FAQ (staff)

| Question | Answer |
|----------|--------|
| Why can’t a consultant see a request? | Assign it to them or raise their role. |
| Member says they paid | Check **invoice** status and **payment** records; use **confirm bank**. |
| Capacity plan sold but no seat | Use **Space utilization** to assign or free a **unit**. |
| Archive vs delete | Archive hides from default lists; **super admin** restores from archived views. |

---

## Screenshot index

- **In the app:** [`/admin/help/screenshots`](/admin/help/screenshots)
- **Repository:** `docs/USER_GUIDE_SCREENSHOTS.md` (IDs **ADM-***)
