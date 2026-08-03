# Invitation System

## 1. Overview

Enable streamlined team onboarding via email invitations: a company admin invites a
new member by email + role, the recipient establishes their account, and they join the
company with that role.

> **Descoped — referrals.** An earlier draft of this spec also proposed user-to-user
> **referral links** (shareable codes that let outsiders create their own companies as
> an owner, for viral growth). That half is **out of scope** and unbuilt — no referral
> tables, functions, routes, or UI exist. It is not on the roadmap; the referral-specific
> prose below has been removed. This module is now team invitations only.

### Problem Statement

- No mechanism to invite new users to the platform
- Company admins cannot onboard team members without manually creating accounts

### Solution

**Team Invitations:** Company admins send email invites for team members with a specific
role. The recipient opens the emailed link, sets their name/password, and joins the
existing company with the assigned role.

### Role Model

The `user_company_access.role` CHECK constraint allows exactly **three** roles (there is
**no `owner` role** — the first company creator is simply an `admin`):

```
admin, user, operator
```

Invitations target the same three roles (`invitations_role_check` = `admin | user | operator`):

| Invitation Role | Maps to DB Role | Notes |
|----------------|-----------------|-------|
| `admin` | `admin` | Full company access, incl. team management |
| `user` | `user` | Can use all modules but cannot manage team/settings |
| `operator` | `operator` | Shop floor access only |

### Reconciliation with Existing Team Edge Function

The current team management system (`supabase/functions/team/index.ts`) creates team members by directly providing email + password. The invitation system is a **parallel path** — both will coexist:

| Method | Use Case | How It Works |
|--------|----------|--------------|
| Direct creation (existing) | Operators who don't have personal email, quick admin setup | Admin provides email + password via Edge Function |
| Invitation (new) | Standard onboarding for knowledge workers | Admin sends email invite, recipient creates own account |

The team management UI (`/dashboard/[companyId]/team`) shows a unified view of all team members regardless of how they were added. The Team page exposes per-role "Invite {Role}" buttons alongside the direct "Add Member" flow.

> **Note:** Both the existing team Edge Function and `team-invites` validate roles against `['admin', 'user', 'operator']`, matching the `user_company_access_role_check` and `invitations_role_check` constraints. There is no `owner` role to reconcile.

---

## 2. User Stories

### Company Admin

- Invite team members by email with a specific role (`admin`, `user`, or `operator`)
- View pending, accepted, and expired invitations
- Resend invitation emails
- Revoke pending invitations

### Invited User (New)

- Receive email with invitation link
- Open the link (via `/auth/confirm`) and land on the accept-invite page showing company name and assigned role
- Set first name, last name, and a password
- Automatically join the company with the specified role
- Can enter Demo Mode from Settings to explore features

### Invited User (Existing Account)

- Receive email with invitation link
- Open the link, recognized as an existing user with a session
- Automatically join the company — no signup needed
- Redirected to the new company's dashboard

---

## 3. Feature Specifications

### 3.1 Invitation Types

| Type | Initiator | Outcome |
|------|-----------|---------|
| Team Invite | Company Admin | Recipient joins existing company with specified role |

### 3.2 Limits & Expiry

| Parameter | Value |
|-----------|-------|
| Team invite expiry | 7 days |
| Pending invites per email per company | 1 (prevent duplicates) |

> **Rate limiting is deferred** — see §8. The `team-invites` Edge Function currently
> enforces no per-company rate limit.

### 3.3 Role-Based Permissions

Only `admin` can send, list, resend, or revoke invitations. `user` and `operator` have no
invitation permissions. (There is no `owner` role.) The `team-invites` Edge Function
enforces this via `verifyAdmin` (`role IN ('admin')`); the UI additionally gates the Team
page behind `AdminGuard`.

| Role | Can Invite | Can View Invitations |
|------|-----------|----------------------|
| Admin | Yes | All |
| User | No | No |
| Operator | No | No |

---

## 4. Database Schema

### 4.1 `invitations` Table

```sql
CREATE TABLE invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL,
    token VARCHAR(64) UNIQUE NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    invited_by UUID NOT NULL REFERENCES auth.users(id),
    accepted_by UUID REFERENCES auth.users(id),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    accepted_at TIMESTAMPTZ,
    CONSTRAINT invitations_role_check CHECK (
        role IN ('admin', 'user', 'operator')
    ),
    CONSTRAINT invitations_status_check CHECK (
        status IN ('pending', 'accepted', 'expired', 'revoked')
    )
);

-- Indexes
CREATE INDEX idx_invitations_token ON invitations(token);
CREATE INDEX idx_invitations_company_id ON invitations(company_id);
CREATE INDEX idx_invitations_email ON invitations(email);
CREATE UNIQUE INDEX idx_invitations_pending_email_company
    ON invitations(email, company_id) WHERE status = 'pending';

-- RLS
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Company admins can manage invitations"
    ON invitations FOR ALL
    USING (is_company_admin(company_id));
```

> **Referrals descoped:** the earlier draft added `referral_links` and
> `referral_redemptions` tables (with a `referred_by_company_id` chain column for
> referral analytics). Neither table exists in the schema and neither is planned —
> referrals are out of scope for this module.

---

## 5. Invitation Identifier

Invitations are identified by their primary-key **`id`** (a `uuid`). There is **no token
column** and no separate referral code — the earlier `token`/`ref-code` design was never
built.

- The accept link is keyed by `id`: the emailed `/auth/confirm` link resolves to
  `/accept-invite/[invitationId]`.
- The `invitations` table has no `token` column (confirm: columns are
  `id, company_id, email, role, status, invited_by, accepted_by, expires_at, created_at, accepted_at`).
- Row creation and the `id` are handled by the `team-invites` Edge Function insert (§11);
  no application-side token/code generation exists.

---

## 6. Database Functions

The only invitation-related DB function that exists is `accept_invitation()`. The
draft's `validate_invitation_token()`, `validate_referral_code()`, and `redeem_referral()`
were **never built** (the first assumed a nonexistent `token` column; the latter two are
part of the descoped referral system). Validation of an invitation's status/expiry/email
happens in the accept-invite page and the Edge Function's list handler, not a dedicated DB
function.

### 6.1 `accept_invitation()` (shipped)

The deployed function is `accept_invitation(p_invitation_id UUID, p_user_id UUID)` — it
looks the row up by **`id`** (there is no token), inserts a `user_company_access` row with
`name = ''` (the accept-invite page collects the real name separately), and marks the
invitation `accepted`. Source of truth: `supabase/migrations/20260527151536_baseline.sql`.

```sql
CREATE OR REPLACE FUNCTION public.accept_invitation(p_invitation_id UUID, p_user_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_inv RECORD;
BEGIN
    -- Lock the invitation row to prevent concurrent acceptance
    SELECT * INTO v_inv FROM invitations
    WHERE id = p_invitation_id AND status = 'pending' AND expires_at > NOW()
    FOR UPDATE;

    IF v_inv IS NULL THEN
        RAISE EXCEPTION 'Invalid or expired invitation';
    END IF;

    -- Create user_company_access if not exists
    -- Name is empty — the accept-invite page prompts the user for their name
    INSERT INTO user_company_access (user_id, company_id, role, name)
    SELECT p_user_id, v_inv.company_id, v_inv.role, ''
    WHERE NOT EXISTS (
        SELECT 1 FROM user_company_access
        WHERE user_id = p_user_id AND company_id = v_inv.company_id
    );

    -- Mark invitation as accepted
    UPDATE invitations
    SET status = 'accepted', accepted_by = p_user_id, accepted_at = NOW()
    WHERE id = v_inv.id;

    RETURN v_inv.company_id;
END;
$$;
```

---

## 7. Email Integration (Resend)

### 7.1 Runtime & Setup

Invitation email is sent by the **`team-invites` Supabase Edge Function**
(`supabase/functions/team-invites/index.ts`), which calls the Resend REST API over
`fetch`. This is the canonical backend — Jigged severely limits FastAPI use (see the
API Architecture Rule in `CLAUDE.md`), and all invitation logic lives in the Edge
Function, not in `api/`.

> `api/services/email.py` exists for other transactional mail; its own docstring notes
> invitation emails "can ride the same plumbing later." It is **not** wired to invitations
> today — the Edge Function owns invitation email end-to-end.

- **Sending:** Resend REST API via `fetch` from the Edge Function (Deno runtime).
- **Sending domain:** requires DNS configuration (SPF, DKIM, DMARC) on the verified sender.

### 7.2 Environment Variables (Edge Function)

Set as Supabase Edge Function secrets:

```bash
RESEND_API_KEY=re_xxxxxxxxxxxx          # Resend API key
# Sender address + app base URL are configured for the Edge Function's environment.
```

### 7.3 Email Template

A single team-invitation email is sent. Its link points at the first-party
`/auth/confirm` handler, which establishes the session and forwards to
`/accept-invite/[invitationId]` (see §9) — **not** a `?invite=TOKEN` signup URL.

```
Subject: You've been invited to join {company_name} on Jigged

Body:
Hi,

{inviter_name} has invited you to join {company_name} on Jigged as a {role}.

Jigged is a manufacturing data platform that helps shops manage jobs,
inventory, and shop floor operations.

Click the link below to accept your invitation:
{app_url}/auth/confirm?...   →  /accept-invite/{invitation_id}

This invitation expires on {expires_date}.

If you didn't expect this invitation, you can ignore this email.

—
Jigged Manufacturing Data Platform
```

### 7.4 Error Handling

- **Resend API failure:** the invitation row is still created (`status='pending'`); the
  Edge Function returns `email_sent: false` so the UI can warn rather than show a green
  "sent," and the admin can Resend later. (Confirm: `team-invites` POST handler.)
- **Invalid email / send rejected:** surfaced through the same `email_sent: false` path.
- **Bounce/complaint handling:** relies on Resend's built-in handling.

---

## 8. Rate Limiting (Deferred)

Rate limiting is **deferred — not shipped.** The `team-invites` Edge Function currently
enforces **no** per-company invitation rate limit, and no rate-limiting index exists.

The earlier draft proposed DB-backed limits (e.g. 10 invites/hour/company) by counting
recent `invitations` rows within a time window, plus a composite `(company_id, created_at)`
index. If/when abuse-prevention becomes a launch requirement, that approach (count-recent-
rows, no extra infrastructure) is the intended direction — but it is not built today, and
duplicate-pending suppression (§3.2) is the only write-side guard currently in place.

---

## 9. Accept-Invite Flow (Shipped)

The shipped feature does **not** rework `/signup` with `?invite=TOKEN`/`?ref=CODE` modes or
localStorage token persistence. Instead, invitation acceptance has its own dedicated page
reached through a first-party email-confirmation handler. This section documents the flow
as built.

### 9.1 Entry: `/auth/confirm` → `/accept-invite/[invitationId]`

The invitation email links to the first-party handler
`app/auth/confirm/route.ts` — e.g.
`https://jigged.app/auth/confirm?token_hash=…&type=invite&next=/accept-invite/<id>`.
The handler:

1. Validates `type` against an allow-list (`invite | magiclink | recovery | email | signup`)
   and only honors a same-origin relative `next` (rejects `//` and `/\` to prevent open
   redirects).
2. Exchanges the one-time `token_hash` for a session server-side via
   `supabase.auth.verifyOtp(...)` (setting the auth cookies the browser client reads).
3. Redirects to `next` (the accept-invite page) on success, or **fails closed to `/login`**
   on any missing/invalid/expired param (`verifyOtp` tokens are single-use).

### 9.2 The accept-invite page (`app/accept-invite/[invitationId]/page.tsx`)

A client page keyed by `invitationId` (the invitation's `id` — **no token**). Its state
machine is `loading → { no-session | name-prompt | accepting | error }`:

1. **Establish session.** It processes auth tokens directly from the URL if present —
   hash-fragment `access_token`/`refresh_token` (implicit flow) via `setSession`, or a
   `code` param (PKCE) via `exchangeCodeForSession` — then reads the session (waiting
   briefly on `onAuthStateChange` if it arrives asynchronously). No localStorage is
   involved.
2. **No session →** shows "Sign In Required" and routes to
   `/login?returnTo=/accept-invite/{invitationId}` (an allow-listed `returnTo`).
3. **Fetch the invitation** via `GET {team-invites}/{invitationId}` (Edge Function, service
   role — bypasses the RLS/JWT-propagation timing issues of a direct table read right after
   hash-fragment auth). The response includes the joined `company_name`.
4. **Validate:** if `status === 'accepted'`, redirect straight to `/dashboard/{company_id}`;
   any other non-`pending` status, or `expires_at` in the past, → error state. If the
   session email doesn't match the invitation email, → error ("This invitation was sent to
   {email}…").
5. **name-prompt →** the form collects **first name, last name, and an optional password**
   (pre-filled from user metadata when available; role shown as a chip).

### 9.3 Submit (`handleAccept`)

On submit the page:

1. Calls `supabase.auth.updateUser({ password?, data: { first_name, last_name,
   display_name, invitation_id: null } })` — sets the password if provided and clears
   `invitation_id` so the auth callback won't re-route here on future logins.
2. Calls the DB RPC `accept_invitation({ p_invitation_id, p_user_id })` (§6.1), which
   inserts the `user_company_access` row (role from the invitation, `name=''`) and marks the
   invitation `accepted`.
3. PATCHes the new `user_company_access` row's `name` to `"{first} {last}"` via the `team`
   Edge Function (the RPC stored an empty name).
4. `setLastCompany(userId, companyId)` and `router.replace('/dashboard/{companyId}')`.

**Reload semantics:** re-opening the emailed link after acceptance hits step 4 of §9.2 —
the page sees `status === 'accepted'` and routes straight to the dashboard, so acceptance
persists idempotently.

### 9.4 Existing user / already-logged-in

There is no separate "already signed in, accept?" confirmation screen. Because the flow is
session-first, an already-authenticated invitee who follows the link simply lands on the
accept-invite page with a session; if their session email matches the invitation they get
the name-prompt (or an immediate dashboard redirect if already accepted), and if it doesn't
match they get the email-mismatch error. A user with no active session is sent to
`/login?returnTo=/accept-invite/{id}` and returns here after logging in.

---

## 10. Expiration Handling

### Strategy: Lazy Expiration

Invitations are checked for expiry **at read time**, not via a scheduled cleanup:

- The `team-invites` **GET-list** handler lazily flips overdue rows —
  `update({ status: 'expired' }).eq('status','pending').lt('expires_at', now)` — before
  returning the company's invitations, so the Team grid shows accurate statuses.
- `accept_invitation()` re-checks `expires_at > NOW()` (§6.1) and rejects expired rows.
- The accept-invite page independently re-checks `expires_at` before showing the form (§9.2).

No `pg_cron` housekeeping job is required — the list handler's lazy flip keeps the `status`
column current for admin reporting.

---

## 11. Backend: `team-invites` Edge Function

The invitation backend is the Supabase **Edge Function**
`supabase/functions/team-invites/index.ts` (Deno). There are **no FastAPI invitation
routes** — this aligns with Jigged's Supabase-first, FastAPI-limited architecture. It uses
the service-role client for DB writes (bypassing RLS) and an anon client with the caller's
JWT to establish identity.

### 11.1 Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/team-invites` | Admin | Validate role/email, block demo companies, revoke any prior pending invite, insert `invitations` row (`expires_at = now + 7d`), generate a one-time link, send Resend email. Returns `email_sent` boolean. |
| `GET` | `/team-invites?company_id=X` | Admin | Lazily expire overdue pending rows, then list the company's invitations (newest first). |
| `GET` | `/team-invites/{id}` | Session (no admin check) | Fetch a single invitation + joined `company_name` for the accept-invite page. Email match is validated client-side. |
| `DELETE` | `/team-invites/{id}` | Admin | Revoke a **pending** invitation (`status='revoked'`); non-pending → 400. |
| `POST` | `/team-invites/{id}/resend` | Admin | For a **pending** invitation, reset `expires_at` to now + 7d and re-send the email; non-pending → 400. |

There is no `validate` route and no `accept` route on the Edge Function — validation happens
in the accept-invite page (§9.2) and acceptance goes through the `accept_invitation` DB RPC
(§6.1) called directly from that page. No referral routes exist.

### 11.2 Auth Pattern (`verifyAdmin`)

Admin routes call `verifyAdmin(supabase, authHeader, companyId)`, which extracts the user
from the JWT (anon client) and checks `user_company_access.role IN ('admin')` for that
company via the service-role client. The role check is **`admin` only** — there is no
`owner` role, and `user`/`operator` are refused. On failure it throws, mapped to **401**
("Not authenticated") or **403** ("Not authorized — admin role required").

```typescript
const { data: access } = await supabase
  .from('user_company_access')
  .select('role')
  .eq('user_id', user.id)
  .eq('company_id', companyId)
  .in('role', ['admin'])   // admin only — no 'owner'
  .single();

if (!access) {
  throw new Error('Not authorized — admin role required');
}
```

The single-invitation `GET /team-invites/{id}` intentionally skips the admin check (any
valid session can fetch it) because the accept-invite page validates the session-email
match itself.

---

## 12. UI Components & Pages

> **Shipped location:** team management lives at **`/dashboard/[companyId]/team`**, not the
> `/dashboard/[companyId]/settings/team` of the earlier draft. There is **no `/settings/*`
> route tree** and **no referrals UI** (that half is descoped).

### 12.1 Team page — `app/dashboard/[companyId]/team/page.tsx`

A single tabbed grid (**Admins / Users / Operators**), wrapped in `AdminGuard` so non-admins
see a permission message instead of the content. For each role tab:

- Active members (from the `team` Edge Function) and **pending invitations** for that role
  (from `team-invites`) are merged into one AG Grid — invitations become rows via
  `invitationToRow` with `id: 'inv-{id}'` and `status: 'pending'`.
- A per-tab search box filters rows client-side by name/email (debounced 300ms via
  `searchDebounced`).
- Each tab has an **"Invite {Role}"** button (hidden when `isDemoMode`) that navigates to
  the invite page below.
- Row actions include **Resend** and **Revoke** for pending-invitation rows; bulk delete
  splits the selection by the `inv-` id prefix — members are removed via
  `user_company_access` delete, invitations via the Edge Function.

```
┌──────────────────────────────────────────────────────────────────┐
│  [ Admins | Users | Operators ]                 [Invite Admin]    │
│  [ Search… ]                                                       │
├──────────────────────────────────────────────────────────────────┤
│  Name          Email              Role     Status     Actions      │
│  Jane Doe      jane@acme.com      Admin    Active     ···          │
│  alice@…       alice@example.com  Admin    Pending    [Resend] [✕] │
└──────────────────────────────────────────────────────────────────┘
```

### 12.2 Invite page — `app/dashboard/[companyId]/team/members/new/page.tsx`

A **full page** (not a modal) reached from the "Invite {Role}" buttons. It reads `?role`
into `defaultRole`, lets the admin confirm/change the role and enter an email, and POSTs to
`team-invites`. On `data.email_sent === false` it shows a warning and keeps the admin on the
page to Resend, rather than a green "sent" confirmation.

### 12.3 Accept-invite page — `app/accept-invite/[invitationId]/page.tsx`

The invitee-facing page documented in §9 (session-first, name/password prompt, `AuthLayout`
shell). Reached via the emailed `/auth/confirm` link, not the dashboard.

### 12.4 Navigation

Team is reached from the dashboard navigation (Team item), not a Settings section. No
Settings layout, Referrals page, or referral components exist.

---

## 13. Demo Mode Integration (Optional)

The [Demo Mode feature](./demo-mode.md) is independent of the Invitation System. Demo mode is user-initiated (entered on demand), so no automatic hooks are needed in the invitation flow.

**Post-acceptance experience for invited users:**
- Invited users join an existing company — they see whatever data that company already has.
- Demo companies are explicitly **blocked as invitation targets** by the Edge Function (400: "Cannot send invitations to a demo company"); the Team page also hides the "Invite {Role}" buttons when the company is in demo mode.

No code integration is required between these two features beyond the demo-company guard above.

---

## 14. Frontend Routing (Shipped)

### Routes that exist

```
app/
├── auth/confirm/route.ts                         # First-party email-link handler → /accept-invite/[id]
├── accept-invite/[invitationId]/page.tsx         # Invitee accept page (§9)
└── dashboard/[companyId]/team/
    ├── page.tsx                                  # Tabbed team grid + invitations (§12.1)
    └── members/new/page.tsx                      # Invite page, reads ?role (§12.2)
```

There is **no** `/dashboard/[companyId]/settings/*` tree and **no** referral route.

### Auth-route involvement

- `/login` accepts a `returnTo` param; its `isValidReturnTo` allow-list includes
  `/accept-invite`, so a no-session invitee is round-tripped through login back to the
  accept page.
- `/signup` was **not** reworked for invitations — there is no `?invite=TOKEN` or `?ref=CODE`
  signup mode. Acceptance is handled entirely by the accept-invite page.

---

## 15. Testing Strategy

> **Current state:** there are **no automated tests** for the invitation system in
> `__tests__/`, `e2e/`, or `api/tests/` today — every acceptance-criteria bullet in §16 is
> `automation-pending` or `manual`. This is a standing gap worth a follow-up (cf. the May
> 2026 `jobs.status` incident where an untested SELECT path shipped a regression). The
> matrix below is the intended coverage for that follow-up. Referral/token/rate-limit rows
> from the earlier draft are gone (those features don't exist).

### Unit Tests (Edge Function / DB)

| Test | Description |
|------|-------------|
| `accept_invitation()` | New user, existing user already in company, expired invitation, concurrent acceptance (row lock) |
| `verifyAdmin` | Admin allowed; `user`/`operator`/no-access refused (401/403) |
| POST create | Valid create; invalid role rejected; demo-company rejected; prior pending revoked before insert |
| GET list | Lazy-expire flips overdue pending → expired; returns company rows |
| DELETE / resend | Only pending revocable/resendable; resend resets `expires_at` |

### Unit Tests (Frontend)

| Test | Description |
|------|-------------|
| Accept-invite page | Session-first load; email-mismatch error; expired/revoked/accepted branches; name-prompt submit calls `accept_invitation` |
| `/auth/confirm` handler | Valid `type` + same-origin `next` redirect; open-redirect rejection; fail-closed to `/login` |
| Team page | Invitations merged into the role grid; search filter; invite buttons hidden in demo mode |

### Integration / E2E Tests

| Test | Description |
|------|-------------|
| Full invitation flow | Admin invites → email → `/auth/confirm` → accept-invite → name/password → `user_company_access` created → dashboard |
| Invitation for existing user | Invite → magic-link → accept → dashboard (no new signup) |
| Invitation revocation | Create → revoke → accept link shows "revoked" |

---

## 16. Acceptance Criteria

> **Scope note (audit #338, owner decisions applied):** Sections 3–14 now describe the
> **shipped** implementation. Per owner ruling, the invitation backend is canonically the
> Supabase **Edge Function** (`supabase/functions/team-invites/index.ts`) — FastAPI is not
> used; invitations are keyed by their **`id`** (there is **no `token` column** and no
> `?invite=TOKEN` signup mode); the accept flow is the shipped
> **`/accept-invite/[invitationId]`** + **`/auth/confirm`** pair; the team page is at
> **`/dashboard/[companyId]/team`** (not `/settings/team`); the **owner role has been
> removed** (only `admin | user | operator` exist, inviter scope is `admin`); **rate
> limiting is deferred**; and the **referral system is descoped** (no `referral_links` /
> `referral_redemptions` tables, no `redeem_referral` / `validate_*` DB functions, no
> referral UI). The 2026 audit that produced those findings (#338) closed with nothing
> outstanding; its report was retired in August 2026 under #634.

Each bullet is a Given/When/Then scenario carrying a verification clause — a pointer to the test that proves it, a manual procedure, or an explicit automation-pending tag. Every editable entity has at least one edit -> save -> reload -> persists bullet. Doc-vs-code disagreements this audit surfaced are recorded in the divergence report on issue #338.

The editable entities in the shipped system are: the **invitation** (created with an email + role; mutated via revoke, resend, and accept). No referral entity exists to test.

**Send an invitation (Create)**

- [ ] **Given** an admin on `/dashboard/[companyId]/team`, **when** they open a role tab and click "Invite {Role}", **then** they land on `/dashboard/[companyId]/team/members/new?role={role}` — a full page (not a modal `InviteTeamMemberDialog`) — with the role pre-selected — *manual: `app/dashboard/[companyId]/team/members/new/page.tsx` reads `?role` into `defaultRole`; automation-pending (no e2e/unit test exists for the team module)*.
- [ ] **Given** the invite page, **when** an admin submits an email + role, **then** a `POST` to the `team-invites` Edge Function creates an `invitations` row (`status='pending'`, `expires_at = now + 7 days`) and sends a Resend email — *automation-pending (`supabase/functions/team-invites/index.ts` POST handler; no backend or e2e test covers the Edge Function)*.
- [ ] **Given** a submitted invitation whose email send fails, **when** the Edge Function returns `email_sent: false`, **then** the page shows a warning (not a green "sent") and keeps the admin on the page to Resend — *automation-pending (`app/dashboard/[companyId]/team/members/new/page.tsx` `handleSubmit` branch on `data.email_sent === false`)*.
- [ ] **Given** an email that already has a pending invitation for the company, **when** a new invite is sent to it, **then** the prior pending row is set to `revoked` before the new one is inserted — *automation-pending (`team-invites` POST handler; enforced at write, not just by the `idx_invitations_pending_email_company` partial-unique index)*.
- [ ] **Given** a demo company (`companies.is_demo = true`), **when** an admin tries to invite, **then** the Edge Function rejects with 400 ("Cannot send invitations to a demo company") — *automation-pending (`team-invites` POST handler)*.
- [ ] **Given** a role outside `admin | user | operator`, **when** an invite is submitted, **then** the Edge Function rejects with 400 — matching the `invitations_role_check` constraint (no `owner`) — *automation-pending (`team-invites` POST handler)*.

**List, search & filter**

- [ ] **Given** an admin on the Team page, **when** a role tab loads, **then** pending invitations for that role are merged into the grid as `status: 'pending'` rows alongside active members — *automation-pending (`app/dashboard/[companyId]/team/page.tsx` `invitationToRow` + per-tab `combined` merge)*.
- [ ] **Given** the invitations list request, **when** the Edge Function serves `GET /team-invites?company_id=…`, **then** it first lazily flips any `pending` rows past `expires_at` to `expired`, then returns the company's invitations — *automation-pending (`team-invites` GET-list handler; lazy-expire `update(...).lt('expires_at', now)`)*.
- [ ] **Given** the Team grid, **when** an admin types in the per-tab search box, **then** rows filter client-side by name or email (debounced 300ms) — *automation-pending (`app/dashboard/[companyId]/team/page.tsx` `searchDebounced` filter)*.

**Accept an invitation (Edit -> save -> reload -> persists)**

- [ ] **Given** an invitee who opens the emailed `/auth/confirm` link, **when** they arrive at `/accept-invite/[invitationId]` with a session, **then** the page fetches the invitation via `GET /team-invites/{id}` and validates status is `pending`, not expired, and the session email matches the invitation email — *automation-pending (`app/accept-invite/[invitationId]/page.tsx` `checkSessionAndLoadInvitation`)*.
- [ ] **Given** a valid pending invitation, **when** the invitee submits first name, last name, and optional password, **then** `accept_invitation(p_invitation_id, p_user_id)` inserts a `user_company_access` row with the invitation's role and marks the invitation `accepted` (`accepted_by`, `accepted_at` set); **reloading** the emailed link afterward detects `status='accepted'` and routes straight to `/dashboard/{company_id}` — *automation-pending (`accept_invitation` DB function in `supabase/migrations/20260527151536_baseline.sql`; accept-invite page handles `status==='accepted'` by redirecting)*.
- [ ] **Given** an invitee already logged in as a different email, **when** the accept page loads, **then** it blocks with "This invitation was sent to {email}…" rather than joining the wrong account — *automation-pending (`app/accept-invite/[invitationId]/page.tsx` email-mismatch branch)*.
- [ ] **Given** an invitee with no session on the accept link, **when** the page resolves, **then** it shows "Sign In Required" and routes to `/login?returnTo=/accept-invite/{id}` (an allow-listed returnTo) — *automation-pending (`app/accept-invite/[invitationId]/page.tsx` no-session state; `components/auth/Login.tsx` `isValidReturnTo` allow-list includes `/accept-invite`)*.

**Resend & Revoke (Edit -> save -> reload -> persists)**

- [ ] **Given** a pending invitation row, **when** an admin clicks the Resend (send) icon, **then** `POST /team-invites/{id}/resend` resets `expires_at` to now + 7 days and re-sends the email; a non-pending invitation is rejected with 400 — *automation-pending (`team-invites` resend handler)*.
- [ ] **Given** a pending invitation row, **when** an admin clicks the Revoke (✕) icon, **then** `DELETE /team-invites/{id}` sets `status='revoked'` and the list reload drops it; **reloading** the invite link then shows "This invitation has been revoked" — *automation-pending (`team-invites` DELETE handler; `app/accept-invite/[invitationId]/page.tsx` non-pending branch)*.
- [ ] **Given** a mixed selection of active members and pending invitations, **when** an admin bulk-deletes, **then** members are removed via `user_company_access` delete (`count:'exact'`) and invitations are revoked via the Edge Function, with a toast reflecting partial failures — *automation-pending (`app/dashboard/[companyId]/team/page.tsx` `handleDelete` split-by-`inv-`-prefix)*.

**Authorization**

- [ ] **Given** a non-admin caller, **when** they hit any admin `team-invites` route, **then** `verifyAdmin` rejects (401/403); the check is role **`admin`** only, so `owner`/`user`/`operator` are refused — *automation-pending (`team-invites` `verifyAdmin`)*.
- [ ] **Given** the Team page, **when** a non-admin renders it, **then** `AdminGuard` blocks the UI with a permission message — *automation-pending (`app/dashboard/[companyId]/team/page.tsx` wraps content in `<AdminGuard>`)*.

**Schema & RLS**

- [ ] **Given** the `invitations` table, **when** inspected, **then** it has the `id`/`company_id`/`email`/`role`/`status`/`invited_by`/`accepted_by`/`expires_at`/`created_at`/`accepted_at` columns (no `token`), the `company_id`/`email` and partial-unique `pending_email_company` indexes, and RLS policies "Admins can manage invitations" + "Users can read invitations for their email" — *manual: `supabase/migrations/` `invitations` table + `supabase/migrations/20260527151536_baseline.sql` indexes/policies*.

**Referral system (descoped — owner decision)**

- [ ] **Given** the codebase, **when** you search for referral tables, functions, routes, or a `/settings/referrals` page, **then** none exist — the referral half of this spec is **descoped**, not merely unbuilt — *manual: no `referral_links`/`referral_redemptions` in `supabase/migrations/`; no `redeem_referral`/`validate_referral_code`/`validate_invitation_token` functions; no referral route under `app/`; see Resolved (owner decision) in the divergence report*.

**Coexistence & Demo Mode**

- [ ] **Given** the existing unified team Edge Function (`supabase/functions/team/index.ts`), **when** it and `team-invites` both operate, **then** direct-created members and invited members appear in one Team grid — *automation-pending (Team page merges `team` member rows with `team-invites` invitation rows)*.
- [ ] **Given** Demo Mode, **when** it is on for the company, **then** the "Invite {Role}" buttons are hidden and the invitation flow is independent of demo state — *automation-pending (`app/dashboard/[companyId]/team/page.tsx` gates invite buttons on `!isDemoMode`)*.

---

## 17. Open Questions (Resolved)

| # | Question | Resolution |
|---|----------|------------|
| 1 | Should demo mode be auto-entered on invitation acceptance? | No — demo mode is user-initiated. Invitations work independently. |
| 2 | Should we track referral chain analytics? | **Descoped** — referrals are out of scope, so no chain analytics (`referred_by_company_id` was never built). |
| 3 | Rate limiting approach in serverless? | **Deferred** — no rate limiting shipped on the `team-invites` Edge Function (see §8). |
| 4 | Email provider? | Resend, called over `fetch` from the `team-invites` **Edge Function** (not FastAPI). |
| 5 | Coexist with existing team Edge Function? | Yes — both paths supported. Direct creation for operators, invitations for standard onboarding. |
| 6 | Role model: `user` vs specific roles? | 3-role model: `admin`, `user`, `operator` — **no `owner`**. Old granular roles consolidated into `user`. |
| 7 | Token persistence through auth flow? | N/A — no token/localStorage flow. Session is established server-side by `/auth/confirm` (`verifyOtp`) and read by the accept-invite page. |
| 8 | Duplicate validation routes (GET+POST)? | N/A — validation lives in the accept-invite page + Edge Function list handler; acceptance is the `accept_invitation` RPC. |
| 9 | Where do invitation routes live? | The Supabase **Edge Function** `supabase/functions/team-invites/index.ts` — Jigged limits FastAPI use. |

---

## 18. Dependencies

- **No dependency on [Demo Mode](./demo-mode.md):** Demo mode is user-initiated and fully independent. Invitations work the same with or without demo mode deployed.
- **Resend account:** Must be set up with a verified sending domain (`RESEND_API_KEY` set as an Edge Function secret) before invitation email works.
- **DNS configuration:** SPF, DKIM, and DMARC records for the verified sending domain.

---

## 19. Success Metrics

- **Team invitation acceptance rate:** % of invitations accepted vs expired/revoked.
- **Time to acceptance:** median time from invite sent to `user_company_access` created.

*(Referral/viral metrics removed — the referral system is descoped.)*
