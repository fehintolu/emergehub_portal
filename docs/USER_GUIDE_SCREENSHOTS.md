# User guide screenshots — capture list

Use this document when producing visuals for **`MEMBER_USER_GUIDE.md`** and **`ADMIN_USER_GUIDE.md`**. Each row is one deliverable image.

**View inside the portal (rendered Markdown):** members signed in → [`/help/screenshots`](/help/screenshots) · staff signed in → [`/admin/help/screenshots`](/admin/help/screenshots).

## Conventions

| Field | Guidance |
|--------|-----------|
| **Suggested filename** | Use as-is or prefix with `emergehub-` for asset libraries. |
| **Viewport** | **Desktop 1440×900** (or 1280×800) for main UI; optionally add **mobile 390×844** only where noted for auth pages. |
| **Data** | Staging/sandbox only. **Redact** emails, phones, bank details, and real names unless you have consent. |
| **Browser** | Clean window, no extensions clutter; single tab. |
| **Format** | PNG or WebP; 2× retina optional for crisp docs. |

---

## Member portal (`MEM-`)

| ID | Suggested filename | Page / URL | What to show | Notes |
|----|-------------------|------------|--------------|-------|
| MEM-001 | `member-register-form.png` | `/auth/register` | Empty registration form with labels visible | Include “Create account” context. |
| MEM-002 | `member-verify-required.png` | `/auth/verify-required` (or post-register state) | Message explaining email verification | Use query variants if needed (`?mail=sent`). |
| MEM-003 | `member-login.png` | `/auth/login` | Sign-in form (email + password) | Show “Forgot password” link. |
| MEM-004 | `member-logout-context.png` | Any member page with sidebar footer | Sidebar bottom with **Log out** | Small crop acceptable; show avatar/initials area. |
| MEM-005 | `member-forgot-password.png` | `/auth/forgot-password` | Email field + submit | Before submit state. |
| MEM-006 | `member-forgot-success.png` | `/auth/forgot-password` after POST | Success copy (“If an account exists…”) | Same page, `sent` state. |
| MEM-007 | `member-reset-password.png` | `/auth/reset-password?token=…` | New password + confirm | Use a **burned** test token in staging. |
| MEM-008 | `member-reset-success.png` | After successful reset | “Password updated” / sign-in prompt | From `auth/message` view. |
| MEM-010 | `member-sidebar-full.png` | e.g. `/dashboard` | **Full left sidebar** all sections visible | Desktop height scroll if needed; capture full nav labels. |
| MEM-011 | `member-dashboard.png` | `/dashboard` | Typical dashboard with cards/widgets | Prefer realistic but anonymised activity. |
| MEM-020 | `member-workspace-overview.png` | `/workspace` | Workspace landing with status/cards | Include CTA area (activate / waitlist) if present. |
| MEM-021 | `member-workspace-plan-active.png` | `/workspace` | State with **active** plan or credits | Optional second shot if layout differs a lot. |
| MEM-030 | `member-meeting-rooms-directory.png` | `/meeting-rooms` | Room cards or list | Show search/filters if visible. |
| MEM-031 | `member-meeting-room-detail.png` | `/meeting-rooms/:roomId` | Room page with **calendar** or slot picker | One visible week or day. |
| MEM-032 | `member-my-bookings-list.png` | `/meeting-rooms/my-bookings` | Table/list of bookings | Mix upcoming + past if possible. |
| MEM-033 | `member-booking-confirmation.png` | `/meeting-rooms/bookings/:id/confirmation` | Confirmation summary | Redact location if sensitive. |
| MEM-040 | `member-services-tab-mine.png` | `/services?tab=mine` (or default “yours”) | List of **my** service requests | Show badge on nav if >0. |
| MEM-041 | `member-services-tab-request.png` | `/services?tab=request` | Browse / request catalogue | At least one service card. |
| MEM-042 | `member-service-request-detail.png` | `/services/:id` | Detail with **breadcrumb**, status, message thread | Header variant `service-detail`; scroll to show messages. |
| MEM-050 | `member-billing-overview.png` | `/billing` | Summary strip + invoice list | Show unpaid + paid rows; mask amounts if needed. |
| MEM-051 | `member-billing-pay-or-manual.png` | `/billing` (invoice expanded or pay flow) | **Pay** button or **manual proof** upload UI | Do not expose live bank secrets; blur if necessary. |
| MEM-052 | `member-invoice-print.png` | `/billing/invoices/:id/print` | Printable invoice layout | Optional; PDF export equivalent OK. |
| MEM-060 | `member-documents.png` | `/documents` | Upload zone + file list | Generic filenames only. |
| MEM-070 | `member-support-list.png` | `/support` | Ticket list with statuses | |
| MEM-071 | `member-support-new.png` | `/support/new` | New ticket form | |
| MEM-072 | `member-support-ticket.png` | `/support/:id` | Thread + reply box | |
| MEM-080 | `member-notifications.png` | `/notifications` | Notification list | Show read/unread styling. |
| MEM-090 | `member-settings-profile.png` | `/settings/profile` | Profile tab | |
| MEM-091 | `member-settings-notifications.png` | `/settings/notifications` | Notification toggles | |
| MEM-092 | `member-settings-security.png` | `/settings/security` | Password change + **sessions** list (if present) | Single tab may cover both. |
| MEM-093 | `member-settings-business.png` | `/settings/business` | Business details form | Optional if space-constrained; can merge into MEM-090 doc as second crop. |
| MEM-099 | `member-mobile-auth-optional.png` | `/auth/login` | **Mobile** stacked layout | Optional; only if you publish mobile-specific docs. |

---

## Admin portal (`ADM-`)

| ID | Suggested filename | Page / URL | What to show | Notes |
|----|-------------------|------------|--------------|-------|
| ADM-001 | `admin-sidebar-super.png` | `/admin` (or long page) | **Full sidebar** — all groups (Finance, Meeting rooms, etc.) | Super admin account. |
| ADM-002 | `admin-sidebar-consultant.png` | `/admin/service-requests` | **Minimal** nav — only Service requests | Consultant role. |
| ADM-010 | `admin-login.png` | `/admin/login` | Username + password | Include **Forgot password?** link. |
| ADM-011 | `admin-forgot-password.png` | `/admin/forgot-password` | Username/email field | |
| ADM-012 | `admin-forgot-success.png` | After POST forgot | Generic success message | Anti-enumeration copy. |
| ADM-013 | `admin-change-password.png` | `/admin/change-password` | New / confirm password | Logged-in state. |
| ADM-014 | `admin-reset-password.png` | `/admin/reset-password?token=…` | Reset form | Staging token only. |
| ADM-020 | `admin-sidebar-annotated-optional.png` | Same as ADM-001 | Optional: same shot with **numbered callouts** for PDF guides | Designer deliverable. |
| ADM-030 | `admin-dashboard.png` | `/admin` | Dashboard metrics + queue tables | Top of page + one queue. |
| ADM-040 | `admin-members-list.png` | `/admin/members` | Search/table of members | Blur PII columns if needed. |
| ADM-041 | `admin-member-detail.png` | `/admin/members/:id` | Profile + actions sidebar/tabs | Heavy redaction for public use. |
| ADM-050 | `admin-catalog-services.png` | `/admin/catalog` | Service list | |
| ADM-051 | `admin-catalog-plan-edit.png` | `/admin/catalog/:serviceId/plans/:planId/edit` | Plan form (price, duration, capacity flags) | Scroll to show key fields. |
| ADM-060 | `admin-space-utilization.png` | `/admin/space-utilization` | Overview/dashboard | |
| ADM-061 | `admin-capacity-profile.png` | `/admin/capacity/profiles/:id` | Profile detail + units | |
| ADM-070 | `admin-service-requests-list.png` | `/admin/service-requests` | Filtered list | Show status column + assignee. |
| ADM-071 | `admin-service-request-detail.png` | `/admin/service-requests/:id` | Status controls, assign, messages, attachments | |
| ADM-080 | `admin-invoices-list.png` | `/admin/invoices` | Invoice table | |
| ADM-081 | `admin-invoice-detail.png` | `/admin/invoices/:id` | Line items + payment actions | |
| ADM-090 | `admin-meeting-rooms-list.png` | `/admin/meeting-rooms/rooms` | Rooms admin list | |
| ADM-091 | `admin-meeting-rooms-calendar.png` | `/admin/meeting-rooms/calendar` | Month/week view with events | |
| ADM-092 | `admin-meeting-bookings.png` | `/admin/meeting-rooms/bookings` | Bookings table + pending highlight | |
| ADM-093 | `admin-meeting-discount-tiers.png` | `/admin/meeting-rooms/discount-tiers` | Tier list/form | |
| ADM-094 | `admin-meeting-legacy-requests.png` | `/admin/rooms/legacy` | Legacy queue | If still used in prod. |
| ADM-100 | `admin-documents.png` | `/admin/documents` | Document library table | |
| ADM-110 | `admin-support-list.png` | `/admin/support` | Tickets list | |
| ADM-111 | `admin-support-detail.png` | `/admin/support/:id` | Staff reply + status | |
| ADM-120 | `admin-notifications-broadcast.png` | `/admin/notifications` | Compose/send UI | |
| ADM-130 | `admin-users-super.png` | `/admin/users` | Admin table + **expanded “Change…”** password row | No passwords in shot; demo users only. |
| ADM-140 | `admin-settings-general.png` | `/admin/settings` | General / portal settings form | Mask API keys if shown. |
| ADM-141 | `admin-settings-test-data.png` | `/admin/settings?tab=test-data` | Test members + purge (super admin) | **Staging only** recommended. |

---

## Coverage gaps (optional future shots)

Capture these only if you document advanced flows:

- **Member:** Paystack redirect / success return URL (browser mid-flow).
- **Member:** Service **request** wizard mid-step (multi-page intake).
- **Admin:** **New invoice** wizard (`/admin/invoices/new`) with line items.
- **Admin:** **New member** form (`/admin/members/new`).
- **Admin:** Meeting room **edit** with **blackout** blocks.
- **Both:** Error states (validation messages, 403 for wrong role) — for troubleshooting appendix.

---

## Totals

- **Member:** 28 core IDs (MEM-001–MEM-093 range; includes optional MEM-099).
- **Admin:** 27 core IDs (ADM-001–ADM-141 range).

Replace filenames and IDs in the Markdown guides with actual asset paths once images are exported (for example `../assets/guides/MEM-010.png`).
