# Invitation System

> **Condensed 2026-08-03 (#634). 4,968 → 3,342 words** (`wc -w`; 2,869 after the first pass, plus
> a verification pass that restored the audit-#338 provenance and corrected §1). Cut: a ~1,200-word acceptance-criteria
> block in which *every* bullet was `automation-pending` (the module *then* had zero automated
> tests — stated once as a named gap; partially closed 2026-08-06 when the accept page was split
> into two paths, see §5.1 and §8); ~10 restatements of "referrals are descoped", ~8 of "there is
> no `owner` role", ~4 of "the backend is the Edge Function, not FastAPI" (collapsed into one
> **Never built** table); pasted SQL bodies for `invitations` and `accept_invitation()`; an ASCII
> grid mockup; prose narrating what each page component does. Kept deliberately: every deferred
> item and its intended direction, every "why not the obvious alternative", the security
> reasoning behind `getOriginUrl` / `getEmailBaseUrl` / the `/auth/confirm` allow-lists, and the
> two enforcement citations (billing-gate exemption, function-EXECUTE allowlist).
>
> **Seven corrections against code**, each marked inline in italics where the claim sat. The
> largest, found on the verification pass: §1's "two paths to a team member coexist, by design"
> — direct creation via `POST /team` was deleted in **March 2026** (#76) and invitation has been
> the only path ever since, so the doc's headline framing of the module was a year stale.
> Next: the old §4 SQL block declared a `token VARCHAR(64) UNIQUE` column and an
> `idx_invitations_token` index that have never existed — 39 lines above the doc's own statement
> that there is no token column; and the doc said acceptance redirects to `/dashboard/{id}` when
> the code has routed through `homePathForRole` since the operator surface shipped. The other
> four: the RLS policy set, the email body, the auth on `GET /team-invites/{id}`, and a missing
> second entry path (`/auth/callback`).

**As-built, verified 2026-08-03** against `supabase/functions/team-invites/index.ts`,
`supabase/migrations/`, and the `app/` routes below.

**Provenance of the "owner decision" rulings below** — referrals descoped, the `owner` role
removed, the Edge Function (not FastAPI) as canonical backend, `/team` rather than
`/settings/team` — is audit **#338** ("ACs + divergence: Invitation System"), which closed
with nothing outstanding. Its divergence report was retired in August 2026 under #634, so
#338 is the only surviving record of why those calls were made.

---

## 1. What it is

A company admin invites someone by **email + role**; the recipient opens the emailed link,
sets their name (and optionally a password), and joins that company with that role.

**Roles are exactly three: `admin | user | operator`.** Enforced identically by
`user_company_access_role_check`, `invitations_role_check`, the `team` Edge Function, and the
`team-invites` Edge Function. **There is no `owner` role** — the first company creator is an
`admin`. Only `admin` can send, list, resend or revoke; `user` and `operator` have no
invitation permissions at all.

| Role | Scope |
|---|---|
| `admin` | Full company access incl. team management. Only role that can invite. |
| `user` | All modules, no team/settings management |
| `operator` | Shop floor only |

**An invitation is the only way to add a team member.** *(This doc previously described "two
paths that coexist by design" — direct creation with an admin-supplied email + password for
operators without a personal email, alongside invitations — and an "Add Member" button next to
the Invite buttons. Both are stale. Commit `4f00832`, "replace temp password team creation with
magic link invitations" (#76, March 2026), deleted `POST /team`; the function's own docstring
records it: "Team member creation is now handled via magic link invitations in the team-invites
Edge Function. The old POST /team endpoint has been removed." There is no "Add Member" control
on the Team page.)*

`supabase/functions/team/` survives as the **member-management** function only —
`GET /team?company_id` (list, optionally `&role=`), `GET /team/:id`, `PATCH /team/:id`
(name / role), `POST /team/:id/reset-password` (admin-triggered, emails a single-use recovery
link; the admin never sees or sets a password). The Team page and the accept flow both call it.

**Consequence worth naming:** the removed path was the escape hatch for an operator with no
personal email. Every member now needs a deliverable address, because the only way in is a link
sent to one.

---

## 2. Never built / descoped / deferred

One table replaces every scattered denial in the old draft. Everything here was *proposed in an
earlier draft of this same spec* and is not in the code today.

| Thing | Status | Why not |
|---|---|---|
| **Referral links** — shareable codes letting outsiders self-create a company as owner, for viral growth | **Descoped** (owner decision) | Not on the roadmap. No `referral_links` / `referral_redemptions` tables, no `redeem_referral` / `validate_referral_code`, no referral route or UI, no `referred_by_company_id` chain column, no viral metrics. |
| **`token` column + `?invite=TOKEN` signup mode + localStorage token persistence** | **Never built** | Wrong model. An invitation is identified by its primary-key `id` (uuid); the session is established server-side by `/auth/confirm` calling `verifyOtp`. There is nothing for the app to generate, persist, or validate itself. |
| `validate_invitation_token()` DB function | **Never built** | Assumed the nonexistent token column. Status/expiry/email validation lives in the accept page (§5) and the Edge Function list handler. |
| **`owner` role** | **Never existed** | 3-role model; old granular roles consolidated into `user`. |
| **Rate limiting** | **Deferred** | Not shipped: `team-invites` enforces no per-company limit and no rate-limit index exists. Intended direction if abuse-prevention becomes a launch requirement: count recent `invitations` rows in a window (e.g. 10/hour/company) plus a composite `(company_id, created_at)` index — no extra infrastructure. Today the only write-side guard is duplicate-pending suppression. |
| **`/dashboard/[companyId]/settings/*` route tree** | **Never built** | Team lives at `/dashboard/[companyId]/team`, reached from dashboard navigation. *([demo-mode.md](./demo-mode.md) "Depends on:" still lists "the Settings page layout from invitation-system.md" — a stale cross-reference to this never-built tree; the fix belongs in that doc.)* |
| **`InviteTeamMemberDialog` modal** | **Never built** | Inviting is a full page (§4). |
| **Scheduled expiry job (`pg_cron`)** | **Not needed** | Expiry is lazy (§6). |
| **FastAPI invitation routes** | **Never built** | Supabase-first architecture (CLAUDE.md, API Architecture Rule). *(This row used to point at `api/services/email.py`, whose docstring said invitation email "can ride the same plumbing later". It never did — invitations ship on the Edge Function calling Resend over `fetch` (§7) — and that module was deleted with the quote-email route, its only caller. Python sends no mail at all now.)* |
| **Automated tests** | **Partial** — the accept page and the existing-user E2E journey are covered; everything else is still `automation-pending (#367)` | See §8. |

---

## 3. Data model

`public.invitations` — columns `id, company_id, email, role, status, invited_by, accepted_by,
expires_at, created_at, accepted_at`. **No `token` column.**
*(This doc previously pasted a `CREATE TABLE` block declaring `token VARCHAR(64) UNIQUE NOT NULL`
and `CREATE INDEX idx_invitations_token`; neither has ever existed in the schema.)*

| Constraint / index | Value |
|---|---|
| `invitations_role_check` | `admin` \| `user` \| `operator` |
| `invitations_status_check` | `pending` \| `accepted` \| `expired` \| `revoked` |
| `idx_invitations_pending_email_company` | UNIQUE on `(email, company_id) WHERE status = 'pending'` — one pending invite per email per company |
| `idx_invitations_company_id`, `idx_invitations_email` | plain btree |
| Expiry | `expires_at = now + 24 hours`, set on create and reset on every (re)send — see §3.1 |
| FKs | `company_id → companies ON DELETE CASCADE`; `invited_by`, `accepted_by → auth.users` |

### 3.1 Why 24 hours, and why it is not ours to pick

`expires_at` is **not** the thing that decides whether a link works. The link carries a GoTrue
one-time token minted by `generateLink`, and that token's lifetime is the project's **Email OTP
Expiration** — capped by Supabase at 24 hours (*"An expiry duration of more than 86400 seconds is
disallowed"*). `expires_at` is our own bookkeeping on top, and it must not promise more than the
token can deliver.

It did, for a long time: the row said **7 days** while the setting said **1 hour**. So the team page
showed a week-long invitation for a link that was dead before the end of the working day. That is
the whole of [#722](https://github.com/debola31/Jigged/issues/722) — three invites to one shop went
out at 7pm, were opened the next morning, and were refused; re-sent live on a call, two of the three
were accepted inside two minutes. The number now lives in one place per side —
`INVITE_TTL_HOURS` in `supabase/functions/team-invites/index.ts`, `otp_expiry` in
`supabase/config.toml`, and the dashboard setting — and the three must move together.

Two RLS policies, both in `supabase/migrations/20260527151536_baseline.sql`:
`Admins can manage invitations` (ALL, `is_company_admin(company_id)`) and
`Users can read invitations for their email` (SELECT, `email = auth.uid()`'s email).
*(The doc previously named a single policy "Company admins can manage invitations".)*

`accept_invitation(p_invitation_id uuid, p_user_id uuid) RETURNS uuid` is the **only**
invitation DB function. `SECURITY DEFINER`, `search_path = public`. It re-selects the row
`FOR UPDATE` on `status='pending' AND expires_at > NOW()` (raising `Invalid or expired
invitation` otherwise), inserts `user_company_access` **if not already present**, marks the
invitation accepted, and returns `company_id`. The insert writes `name = ''` on purpose — the
accept page collects the real name and PATCHes it in a separate step (§5).

---

## 4. Routes and files

| Path | Role |
|---|---|
| `supabase/functions/team-invites/index.ts` | The entire invitation backend (§6) |
| `app/auth/confirm/route.ts` | First-party email-link handler → accept page (§5) |
| `app/auth/callback/route.ts` | PKCE callback. **Second, undocumented entry path:** when `next` is the default `/`, it reads `user_metadata.invitation_id` and redirects to the accept page — a fallback for Supabase stripping query params from `redirect_to`. |
| `app/accept-invite/[invitationId]/page.tsx` | Invitee-facing accept page (§5) |
| `app/dashboard/[companyId]/team/page.tsx` | Tabbed grid (Admins / Users / Operators), wrapped in `AdminGuard message="You don't have permission to manage team members."` — a non-admin sees that message *instead of* the content, not an empty grid |
| `app/dashboard/[companyId]/team/members/new/page.tsx` | Invite page — full page, reads `?role` into `defaultRole` |
| `app/dashboard/[companyId]/team/members/[id]/page.tsx` | Member detail; member rows click through here, invitation rows are click-inert |

**Team page behaviour worth knowing:** per-role tabs merge active members (from the `team`
Edge Function) with that role's pending invitations (`invitationToRow`, id prefixed `inv-`,
`status: 'pending'`); per-tab search filters client-side on name/email, **debounced 300 ms**;
`Invite {Role}` buttons are hidden when `isDemoMode`; row actions Resend (send icon) and Revoke
(✕) appear on invitation rows only; bulk delete splits the selection on the `inv-` prefix —
members via `user_company_access` delete with `count:'exact'`, invitations via the Edge
Function — and reports partial failures honestly.

`/signup` was **not** reworked for invitations. `/login` accepts `returnTo`; its
`isValidReturnTo` allow-list (`components/auth/Login.tsx`) is `['/dashboard', '/operator',
'/accept-invite']` plus a same-origin check.

---

## 5. Accept flow, as built

**Entry.** The email links to `/auth/confirm?token_hash=…&type=…&next=/accept-invite/<id>`.
The handler validates `type` against `['invite','magiclink','recovery','email','signup']`,
honours `next` only if it is relative and neither `//` nor `/\` (open-redirect guard), exchanges
the single-use `token_hash` via `verifyOtp` (setting the cookies the browser client reads), and
**fails closed to `/login`** on anything missing, invalid, or already consumed.

It fails closed **with an explanation**: `?reason=invite-link-expired` (or `reset-link-expired` for
`type=recovery`), plus `returnTo=<the sanitised next>`. `Login.tsx` reads both — it says the link
aged out, warns that signing in will not work because no password exists yet, and offers **Send me
a new link**, which pulls the invitation id out of `returnTo` and calls `request-resend` (§7).
Before this, an expired link produced a bare sign-in form; the invitee typed credentials for a
password-less account and was told "Invalid login credentials", which was true, useless, and named
the wrong problem.

**Page state machine** (`app/accept-invite/[invitationId]/page.tsx`):
`loading → { no-session | confirm-join | name-prompt | accepting | error }`.

1. Processes auth tokens straight off the URL if present — hash-fragment
   `access_token`/`refresh_token` via `setSession`, or `code` via `exchangeCodeForSession` — then
   reads the session, waiting up to **3000 ms** on `onAuthStateChange` if it arrives async. No
   localStorage anywhere.
2. **No session →** "Sign In Required" → `/login?returnTo=/accept-invite/{id}`.
3. Fetches the invitation via `GET {team-invites}/{id}`, which returns the joined `company_name`.
   **Why not read the table directly:** JWT propagation timing after hash-fragment auth makes a
   direct select or RPC fail; the Edge Function uses the service role and sidesteps it.
4. Validates: `status === 'accepted'` → straight to the user's home surface; any other
   non-`pending` status or a past `expires_at` → error; session email ≠ invitation email → error
   naming the invited address.
5. **Picks a path** (see §5.1). Established account → `confirm-join`; brand-new invitee →
   `name-prompt`.
6. **name-prompt:** first name, last name, password + confirm — **all four required**. Name
   pre-fills from user metadata; role shown as a chip. *(Password was optional until the paths
   split, with helper text reading "Leave blank if you already have one". That sentence existed
   only because one form served both kinds of invitee. It no longer does, and a blank password now
   means an account reachable only by emailed magic link.)*

**Submit** (`acceptAndRedirect`, shared by both paths): `accept_invitation` RPC →
`updateUser({ password?, data? })` → PATCH the new `user_company_access` row's `name` via the
`team` Edge Function (the RPC stored `''`) → `setLastCompany` → `posthog.identify` +
`posthog.capture('invitation_accepted', { role, existing_user })` →
`router.replace(homePathForRole(role, companyId))`.

**The RPC runs first, and that ordering is load-bearing.** It used to run after `updateUser`, so
any auth failure — in practice `same_password` — threw before the user was ever added to the
company. The message named a password problem while the actual outcome was no membership at all.
Access is what the invitee came for; it must not be contingent on a profile write. If `updateUser`
fails now, the page says "You've been added to {Company}" and offers a Continue button.

`accept_invitation` is **not idempotent** — it selects `WHERE status = 'pending'` and raises
`Invalid or expired invitation` on a second call. The page holds the granted company id and skips
the RPC on a retry; without that, retrying after a partial failure reports the wrong error.

**`homePathForRole`** (`utils/companyAccess.ts`) returns `/operator/{companyId}` for operators
and `/dashboard/{companyId}` for everyone else. *(This doc previously said acceptance redirects
to `/dashboard/{company_id}`; that was the pre-operator-surface behaviour and a new operator's
first screen was a dashboard flash before `AuthGuard` bounced them out.)*

**Reload is idempotent:** re-opening the link after acceptance hits step 4 and routes home.

### 5.1 Two paths, because there are two kinds of invitee

An existing Jigged user invited to a **second** company already has a name and a password. Showing
them the new-hire form asked for both, and the password box actively invited the failure: typing
their real password returns GoTrue's `same_password`
("New password should be different from the old password").

They cannot be told apart from the link. `generateLink({ type: 'invite' })` fails for an
already-registered email and the function falls back to a **magic link** (§7), which carries no
marker saying so. So the page asks the question itself:

```
established = auth metadata has a name  ||  hasAnyCompanyAccess(userId)
```

`hasAnyCompanyAccess` (`utils/companyAccess.ts`) is a `head`/`count` read of
`user_company_access`. Metadata is checked first — it is free and true for anyone who has completed
setup once — and membership catches the rest (e.g. someone provisioned by a system admin, who has a
row but no name). It throws rather than returning `false` on a read failure; the page falls back to
metadata alone rather than guessing someone is brand new.

| Path | Shown | Writes |
|---|---|---|
| `confirm-join` (established) | Company name, role chip, "Signed in as …", one **Join {Company}** button, and **Not you? Sign out** | RPC only. No password write at all — not even an empty one. Name for the new membership comes from their existing metadata, falling back to the email's local part |
| `name-prompt` (new) | First name, last name, password, confirm — all required | RPC, then `updateUser` with password + profile, including `invitation_id: null` so the `/auth/callback` fallback stops re-routing here on future logins |

The single button on `confirm-join` is a deliberate stop rather than an automatic join: it is where
the invitee sees **which** company and **which** role they are accepting, and it keeps a mail-client
link prefetch from silently joining them.

`same_password` is treated as the no-op it is — the account already holds exactly that value — and
swallowed on both paths. Matched on `error.code` with the message as a fallback, since the code
post-dates some deployed GoTrue versions.

---

## 6. `team-invites` Edge Function

Deno. Service-role client for DB writes (bypassing RLS); anon client with the caller's JWT to
establish identity. **`verify_jwt = false` in `supabase/config.toml`** — the platform performs no
auth check, so every route's authorization is whatever the function does itself.

| Method / path | Auth | Behaviour |
|---|---|---|
| `POST /team-invites` | `verifyAdmin` | Validate role + email shape (400s), reject demo companies (400, "…Invite users to the main company instead — they will automatically get demo access"), reject an email that **already has access** to the company (400), revoke any prior pending invite, insert with `expires_at = now + 24h`, mint a one-time link, send via Resend. Returns `email_sent`. |
| `GET /team-invites?company_id=X` | `verifyAdmin` | Lazily flip `pending` rows past `expires_at` to `expired`, then list newest-first. |
| `GET /team-invites/{id}` | **none** | Returns the invitation + `company_name`. No `verifyAdmin`, no `getUser`, and `verify_jwt=false` — so this route is **unauthenticated**; the unguessable invitation uuid is the only capability. *(This doc previously listed its auth as "Session (no admin check)".)* See the open question below. |
| `DELETE /team-invites/{id}` | `verifyAdmin` | Only a `pending` invitation is revocable → `status='revoked'`; otherwise 400. |
| `POST /team-invites/{id}/resend` | `verifyAdmin` | `pending` **or `expired`** (`RESENDABLE_STATUSES`); resets `expires_at` to now + 24h, sets `status='pending'`, re-sends. Email failure here returns **500**, not `email_sent:false`. |
| `POST /team-invites/{id}/request-resend` | **none** | The invitee's own escape hatch from an expired link. Same effect as `resend`, minus `verifyAdmin` — deliberately, since the caller by definition has no account to authenticate with. Refuses `accepted` / `revoked`, and 429s if `expires_at` is still within 60 s of its ceiling (a send just happened). |

No `validate` route, no `accept` route, no referral routes.

**Open question — is `GET /team-invites/{id}` meant to be unauthenticated?** What the code
records as intentional is only the *admin* check being skipped ("No admin check — just returns
the invitation. The accept-invite page validates email match client-side"), and there is a real
reason the accept page cannot read the table itself (JWT-propagation timing, §5 step 3 — it does send
a bearer token, the function simply never looks at it). What is **not** recorded anywhere is the
decision to accept *no* caller identity at all. As written, anyone holding a forwarded link gets
`{email, role, company_name, invited_by, status, expires_at}` with no session — after revocation
and after expiry too, since neither status short-circuits the read. `DELETE` and `resend` leak
existence the same way, 404-ing before `verifyAdmin` runs. Either add a `getUser()` (any session,
no role check — it costs nothing and the caller always has one) or write the capability-URL
choice down in the function. Until then treat this as unruled, not as a design decision.

**`request-resend` is the one place that choice IS written down.** It is unauthenticated on
purpose, and the reasoning is narrower than "the uuid is a capability": the request carries no
destination. The address comes off the row, so the whole power of a leaked invitation uuid is to
send mail to the person who was already invited — bounded to once a minute by the `expires_at`
guard. If the `GET` question above is ever settled by adding a session requirement, this route must
be excluded from that change; requiring a session here would re-create the dead-end it exists to
remove.

`verifyAdmin(supabase, authHeader, companyId)` extracts the user from the JWT via the anon
client, then checks `user_company_access.role IN ('admin')` for that company via the service
role. Failure throws → **401** "Not authenticated" or **403** "Not authorized — admin role
required".

**Expiry is lazy, in three independent places** — the GET-list handler's flip (which is what
keeps the Team grid's `status` column honest for reporting), `accept_invitation()`'s
`expires_at > NOW()` re-check, and the accept page's own check before rendering the form.

**A missing `RESEND_API_KEY` 500s every route, including `GET` list** — the check runs before
routing, so an unconfigured environment breaks the Team page's invitation list, not just sending.

---

## 7. Email

Sent by the Edge Function calling the **Resend REST API over `fetch`**. The body is HTML built
inline by `buildInviteEmailHtml` — a dark-themed card with the Jigged logo and an "Accept
Invitation" button. Subject: `You've been invited to {company_name || 'Jigged'}`.
*(This doc previously pasted a plain-text template containing the inviter's name, the assigned
role, a product blurb and an expiry date. The real email contains none of those four.)*

`supabase/templates/invite.html` and `[auth.email.template.invite]` in `config.toml` still
exist, but are **not** this path — `generateLink` only mints a token, it does not send. Those
templates serve Supabase's own `invite_user_by_email`, used by
`api/routes/admin_routes.py` for system-admin company creation.

| Env var (Edge Function secret) | Purpose | Default |
|---|---|---|
| `RESEND_API_KEY` | Resend auth | none — 500 if unset |
| `SITE_URL` | `getEmailBaseUrl()` — base for the logo and the `/auth/confirm` link | `https://jigged.app` |
| `JIGGED_FROM_EMAIL` | `getEmailFrom()` — sender | `Jigged <hello@jigged.app>` |
| `NEXT_PUBLIC_APP_URL` | legacy fallback inside `getOriginUrl` only | `http://localhost:3000` |

Three deliberate decisions in `supabase/functions/_shared/`:

- **`getEmailBaseUrl` is request-independent, not derived from the request origin.** An admin
  sending an invite from a Vercel preview must not mint an email pointing at an ephemeral
  preview URL that later gets torn down.
- **`getOriginUrl` validates the request Origin/Referer against an allow-list**
  (`*.jigged.app`, `*.vercel.app`, localhost, 127.0.0.1) before ever using it. Returning a raw
  header would let an attacker craft a Host/Origin that makes Supabase mint a token whose
  confirmation URL phishes the user — OWASP "Host header injection" on password reset.
- **`redirectTo` passed to `generateLink` is vestigial** (our `/auth/confirm` does the
  redirecting now) but is kept so `generateLink`'s allow-list validation and the
  `/auth/callback` metadata fallback keep working.

`generateLink` tries `type: 'invite'` first (creates the auth user if new) and falls back to
`'magiclink'` for existing users; the returned `hashed_token` and its type build the
`/auth/confirm` URL.

**On Resend failure at create time, the invitation row still exists** and the function returns
`email_sent: false` with a message. The invite page shows a **warning** and keeps the admin on
the page to Resend, rather than a green "sent" it would be wrong to trust. Bounces and
complaints rely on Resend's own handling.

**Deployment dependency:** a Resend account with a verified sending domain and SPF, DKIM and
DMARC records, plus `RESEND_API_KEY` set as an Edge Function secret.

---

## 8. Invariants and enforcement

| Invariant | Enforced by | Failure it prevents |
|---|---|---|
| `accept_invitation` stays browser-`EXECUTE`-able | Its entry on the reviewed allowlist inside `function_execute_leaks()`, asserted by `api/tests/integration/test_function_execute_grants.py::test_no_security_definer_function_is_browser_executable_off_allowlist` | The accept page calls the RPC directly from the browser. A blanket revoke silently breaks every acceptance. |
| `invitations` is **exempt** from the billing write-gate | The identity/bootstrap exempt list in `tenant_tables_missing_write_gate()`, asserted by `api/tests/integration/test_billing_enforcement.py::test_no_tenant_table_left_ungated` | Gating it would block team onboarding for a shop whose subscription lapsed. Deliberate — do not "fix" it by adding the gate. |
| One pending invite per (email, company) | `idx_invitations_pending_email_company` **and** the POST handler revoking the prior row first | A partial-unique index alone would make the second invite a 23505 error instead of a re-send. |
| `/auth/confirm` fails closed | `app/auth/confirm/route.ts` — type allow-list, relative-`next` check, redirect to `/login` on any error | Open redirect; a consumed token rendering a half-authenticated page. |
| …and fails closed *legibly* | `__tests__/app/auth/confirmRoute.test.ts` — asserts `reason` + `returnTo` travel with the failure, and that a hostile `next` is dropped from both the success and failure redirects | The silent login wall of #722: an unexplained sign-in form that answers a password-less account with "Invalid login credentials". |
| `expires_at` never outlives the token in the link | `INVITE_TTL_HOURS` (edge function) = `otp_expiry` (config.toml) = Email OTP Expiration (dashboard), §3.1 | A team page that shows a live invitation whose link stopped working hours ago. **Nothing enforces this** — the three values are in three systems. |
| Concurrent acceptance is safe | `SELECT … FOR UPDATE` in `accept_invitation()` + the `WHERE NOT EXISTS` guard on the access insert | Duplicate `user_company_access` rows from a double-clicked link. |

**Standing gap — still largely uncovered, but no longer zero.** The accept page now has
behavioural tests, added with the two-path split (§5.1) because the existing-user case is exactly
the one this table used to list as untested and it had shipped a real defect:

| Layer | Covered | Where |
|---|---|---|
| Frontend | Both paths: existing user is shown no password field, joins in one tap and never calls `updateUser`; membership recognised by metadata *or* `hasAnyCompanyAccess`; operator lands on the shop floor; RPC ordered before `updateUser`; `same_password` swallowed; access survives a genuine profile-write failure; the RPC is not re-run on retry; new users must set a password | `__tests__/app/accept-invite/AcceptInvitePage.test.tsx` |
| E2E | Existing user with a company is invited to a second one → confirm → real `accept_invitation` → membership in the DB, first company intact, invitation marked accepted, **original password still signs them in**, and both companies reachable from the switcher | `e2e/existing-user-second-company.spec.ts` (stubs only the `GET /team-invites/:id` read — see the spec header for why) |

The rest of §5 and §6 remains **`automation-pending (#367)`**. This is the same shape as the May
2026 `jobs.status` incident, where an untested read path shipped a regression. Remaining coverage,
in priority order:

| Layer | Target |
|---|---|
| DB | `accept_invitation()` — new user, user already in company, expired row, concurrent acceptance |
| Edge Function | `verifyAdmin` (admin allowed; user/operator/no-access → 401/403); POST valid + invalid-role + demo-company + already-has-access + prior-pending-revoked; GET list lazy-expire; DELETE pending-only; resend accepting `expired`; `request-resend` refusing `accepted`/`revoked`, honouring the 60 s guard, and mailing only the row's own address |
| Frontend | Accept page: expired/revoked/accepted branches, email mismatch. Team page: merge, search, demo-mode button hiding. **Done:** `/auth/confirm` (`__tests__/app/auth/confirmRoute.test.ts`) and the expired-invite login screen (`__tests__/components/auth/LoginExpiredInvite.test.tsx`) |
| E2E | New-hire invite → email → `/auth/confirm` → accept → `user_company_access` created → home surface; revoke-then-open-link |

---

## 9. Resolved questions

| Question | Resolution |
|---|---|
| Auto-enter demo mode on acceptance? | No — demo mode is user-initiated. The two features share no code beyond the demo-company guard. |
| Referral chain analytics? | Descoped with referrals (§2). |
| Rate limiting in serverless? | Deferred (§2). |
| Email provider? | Resend, over `fetch` from the Edge Function. |
| Coexist with the direct-creation `team` function? | **Obsolete.** The answer was "yes, both paths supported"; `POST /team` was removed by #76 and invitation is now the only path (§1). |
| `user` vs granular roles? | Three roles, no `owner` (§1). |
| Token persistence through the auth flow? | N/A — no token. Session comes from `verifyOtp` in `/auth/confirm`. |
| Where do invitation routes live? | The `team-invites` Edge Function. Not FastAPI. |

## 10. Success metrics

Acceptance rate (accepted vs expired/revoked) and median time from send to
`user_company_access` created. The instrumentation is already in place:
`invitation_accepted` (with `role`) plus a `posthog.identify` fire on the accept page — no
dashboard is built on them yet.
