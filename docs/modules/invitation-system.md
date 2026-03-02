# Invitation System

## 1. Overview

Enable viral growth through user-to-user referrals and streamlined team onboarding via email invitations.

### Problem Statement

- No mechanism to invite new users to the platform
- Company admins cannot onboard team members without manually creating accounts
- No viral growth loop — users cannot refer others to create their own companies

### Solution

1. **Team Invitations:** Company admins send email invites for team members with specific roles
2. **Referral Links:** Company admins generate shareable links for others to create their own companies

### Role Model

The `user_company_access.role` CHECK constraint allows 4 roles:

```
owner, admin, user, operator
```

This PRD uses the following roles for invitation targets:

| Invitation Role | Maps to DB Role | Notes |
|----------------|-----------------|-------|
| `admin` | `admin` | Full company access |
| `user` | `user` | Can use all modules but cannot manage team/settings |
| `operator` | `operator` | Shop floor access only |

Referral link users who create their own company receive the `owner` role.

### Reconciliation with Existing Team Edge Function

The current team management system (`supabase/functions/team/index.ts`) creates team members by directly providing email + password. The invitation system is a **parallel path** — both will coexist:

| Method | Use Case | How It Works |
|--------|----------|--------------|
| Direct creation (existing) | Operators who don't have personal email, quick admin setup | Admin provides email + password via Edge Function |
| Invitation (new) | Standard onboarding for knowledge workers | Admin sends email invite, recipient creates own account |

The team management UI (`/dashboard/[companyId]/settings/team`) will show a unified view of all team members regardless of how they were added. An "Invite" button will be added alongside the existing "Add" button.

> **Note:** The existing Edge Function validates `['admin', 'user', 'operator']` for roles (line 62, 154, 258). This should be updated to match the full role set from the DB CHECK constraint, but that is a separate fix — not gated on this PRD.

---

## 2. User Stories

### Company Admin

- Invite team members by email with a specific role
- View pending, accepted, and expired invitations
- Resend invitation emails
- Revoke pending invitations
- Generate referral links (max 5 uses per link)
- See who redeemed referral links
- Revoke referral links

### Invited User (New)

- Receive email with invitation link
- Click link to see company name and assigned role
- Sign up with email and password
- Automatically join the company with the specified role
- Optionally receive a demo company (if Demo Company feature is deployed)

### Invited User (Existing Account)

- Receive email with invitation link
- Click link, recognized as existing user
- Log in (if not already logged in)
- Automatically join the company — no signup needed
- Redirected to the new company's dashboard

### Referred User

- Click a referral link shared by someone
- See "Referred by {Company Name}"
- Sign up with email and password
- Name their new company
- Become the `owner` of the new company
- Optionally receive a demo company (if Demo Company feature is deployed)

---

## 3. Feature Specifications

### 3.1 Invitation Types

| Type | Initiator | Outcome |
|------|-----------|---------|
| Team Invite | Company Admin | Recipient joins existing company with specified role |
| Referral Link | Company Admin | Recipient creates a new company as owner |

### 3.2 Limits & Expiry

| Parameter | Value |
|-----------|-------|
| Team invite expiry | 7 days |
| Referral link expiry | 30 days |
| Referral link max uses | 5 per link |
| Pending invites per email per company | 1 (prevent duplicates) |
| Rate limit: invitations | 10 per hour per company |
| Rate limit: referral link creation | 3 per hour per company |

### 3.3 Role-Based Permissions

| Role | Can Invite | Can Create Referrals | Can View Invitations |
|------|-----------|---------------------|---------------------|
| Owner | Yes | Yes | All |
| Admin | Yes | Yes | All |
| All other roles | No | No | No |

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

### 4.2 `referral_links` Table

```sql
CREATE TABLE referral_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    code VARCHAR(20) UNIQUE NOT NULL,
    max_uses INTEGER DEFAULT 5,
    current_uses INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'active',
    created_by UUID NOT NULL REFERENCES auth.users(id),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT referral_links_status_check CHECK (
        status IN ('active', 'exhausted', 'expired', 'revoked')
    ),
    CONSTRAINT referral_links_uses_check CHECK (current_uses <= max_uses)
);

-- Indexes
CREATE INDEX idx_referral_links_code ON referral_links(code);
CREATE INDEX idx_referral_links_company_id ON referral_links(company_id);

-- RLS
ALTER TABLE referral_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Company admins can manage referral_links"
    ON referral_links FOR ALL
    USING (is_company_admin(company_id));
```

### 4.3 `referral_redemptions` Table

```sql
CREATE TABLE referral_redemptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referral_link_id UUID NOT NULL REFERENCES referral_links(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    referred_by_company_id UUID NOT NULL REFERENCES companies(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_referral_redemptions_link ON referral_redemptions(referral_link_id);
CREATE INDEX idx_referral_redemptions_user ON referral_redemptions(user_id);

-- RLS
ALTER TABLE referral_redemptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Company admins can view their referral redemptions"
    ON referral_redemptions FOR SELECT
    USING (is_company_admin(referred_by_company_id));
```

> **Referral chain analytics:** The `referred_by_company_id` column enables tracking referral chains. To query "who referred who," join `referral_redemptions` → `referral_links` → `companies`. Multi-level chain queries (A referred B who referred C) use recursive CTEs on `referred_by_company_id`.

---

## 5. Token & Code Generation

### 5.1 Invitation Tokens

- **Length:** 64 characters
- **Character set:** URL-safe alphanumeric (`a-zA-Z0-9`)
- **Generation:** Python `secrets.token_urlsafe(48)` (produces 64 characters)
- **Runtime:** FastAPI backend
- **URL format:** `https://app.jigged.com/signup?invite=TOKEN`

### 5.2 Referral Codes

- **Length:** 8 characters
- **Character set:** Uppercase alphanumeric, no ambiguous characters (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789` — no I, O, 0, 1)
- **Generation:** Python `''.join(secrets.choice(CHARSET) for _ in range(8))`
- **Case-sensitivity:** Case-insensitive (stored and compared as uppercase)
- **Runtime:** FastAPI backend
- **URL format:** `https://app.jigged.com/signup?ref=CODE`

---

## 6. Database Functions

### 6.1 `validate_invitation_token()`

```sql
CREATE OR REPLACE FUNCTION validate_invitation_token(p_token VARCHAR)
RETURNS TABLE(
    valid BOOLEAN,
    invitation_id UUID,
    company_name TEXT,
    role VARCHAR,
    email VARCHAR,
    expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT
        (i.status = 'pending' AND i.expires_at > NOW()) AS valid,
        i.id AS invitation_id,
        c.name AS company_name,
        i.role,
        i.email,
        i.expires_at
    FROM invitations i
    JOIN companies c ON c.id = i.company_id
    WHERE i.token = p_token;

    -- If no rows returned, return invalid
    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, NULL::UUID, NULL::TEXT, NULL::VARCHAR, NULL::VARCHAR, NULL::TIMESTAMPTZ;
    END IF;
END;
$$;
```

### 6.2 `validate_referral_code()`

```sql
CREATE OR REPLACE FUNCTION validate_referral_code(p_code VARCHAR)
RETURNS TABLE(
    valid BOOLEAN,
    referral_link_id UUID,
    company_name TEXT,
    uses_remaining INTEGER,
    expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT
        (r.status = 'active' AND r.expires_at > NOW() AND r.current_uses < r.max_uses) AS valid,
        r.id AS referral_link_id,
        c.name AS company_name,
        (r.max_uses - r.current_uses) AS uses_remaining,
        r.expires_at
    FROM referral_links r
    JOIN companies c ON c.id = r.company_id
    WHERE UPPER(r.code) = UPPER(p_code);

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, NULL::UUID, NULL::TEXT, NULL::INTEGER, NULL::TIMESTAMPTZ;
    END IF;
END;
$$;
```

### 6.3 `accept_invitation()`

```sql
CREATE OR REPLACE FUNCTION accept_invitation(p_token VARCHAR, p_user_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_invitation RECORD;
    v_company_id UUID;
BEGIN
    -- Lock the invitation row
    SELECT * INTO v_invitation
    FROM invitations
    WHERE token = p_token AND status = 'pending' AND expires_at > NOW()
    FOR UPDATE;

    IF v_invitation IS NULL THEN
        RAISE EXCEPTION 'Invalid or expired invitation token';
    END IF;

    v_company_id := v_invitation.company_id;

    -- Check if user already has access to this company
    IF EXISTS (
        SELECT 1 FROM user_company_access
        WHERE user_id = p_user_id AND company_id = v_company_id
    ) THEN
        -- Already has access — just mark invitation as accepted
        UPDATE invitations
        SET status = 'accepted', accepted_by = p_user_id, accepted_at = NOW()
        WHERE id = v_invitation.id;

        RETURN v_company_id;
    END IF;

    -- Create user_company_access
    INSERT INTO user_company_access (user_id, company_id, role)
    VALUES (p_user_id, v_company_id, v_invitation.role);

    -- Mark invitation as accepted
    UPDATE invitations
    SET status = 'accepted', accepted_by = p_user_id, accepted_at = NOW()
    WHERE id = v_invitation.id;

    RETURN v_company_id;
END;
$$;
```

### 6.4 `redeem_referral()`

```sql
CREATE OR REPLACE FUNCTION redeem_referral(
    p_code VARCHAR,
    p_user_id UUID,
    p_company_name VARCHAR
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_referral RECORD;
    v_new_company_id UUID;
BEGIN
    -- Lock the referral link row
    SELECT * INTO v_referral
    FROM referral_links
    WHERE UPPER(code) = UPPER(p_code)
      AND status = 'active'
      AND expires_at > NOW()
      AND current_uses < max_uses
    FOR UPDATE;

    IF v_referral IS NULL THEN
        RAISE EXCEPTION 'Invalid, expired, or exhausted referral code';
    END IF;

    -- Create new company
    INSERT INTO companies (name)
    VALUES (p_company_name)
    RETURNING id INTO v_new_company_id;

    -- Create user_company_access (owner role)
    INSERT INTO user_company_access (user_id, company_id, role)
    VALUES (p_user_id, v_new_company_id, 'owner');

    -- Record redemption
    INSERT INTO referral_redemptions (referral_link_id, user_id, company_id, referred_by_company_id)
    VALUES (v_referral.id, p_user_id, v_new_company_id, v_referral.company_id);

    -- Increment usage count
    UPDATE referral_links
    SET current_uses = current_uses + 1,
        status = CASE WHEN current_uses + 1 >= max_uses THEN 'exhausted' ELSE status END
    WHERE id = v_referral.id;

    RETURN v_new_company_id;
END;
$$;
```

---

## 7. Email Integration (Resend)

### 7.1 Package & Setup

- **Package:** `resend` Python SDK (`pip install resend`, add to `requirements.txt`)
- **Runtime:** FastAPI backend (not Edge Functions — keeps all invitation logic in one codebase)
- **Sending domain:** `mail.jigged.app` (requires DNS configuration: SPF, DKIM, DMARC)

### 7.2 Environment Variables

```bash
RESEND_API_KEY=re_xxxxxxxxxxxx          # Resend API key
RESEND_FROM_EMAIL=noreply@mail.jigged.app  # Verified sending address
NEXT_PUBLIC_APP_URL=https://app.jigged.app  # For constructing invitation URLs
```

### 7.3 Email Templates

Two email templates are needed, implemented as Python string templates (not React Email — keeping it simple in the FastAPI backend):

#### Team Invitation Email

```
Subject: You've been invited to join {company_name} on Jigged

Body:
Hi,

{inviter_name} has invited you to join {company_name} on Jigged as a {role}.

Jigged is a manufacturing ERP system that helps shops manage work orders,
inventory, and shop floor operations.

Click the link below to accept your invitation:
{app_url}/signup?invite={token}

This invitation expires on {expires_date}.

If you didn't expect this invitation, you can ignore this email.

—
Jigged Manufacturing ERP
```

#### Referral Invitation Email (Future Enhancement)

Not required for MVP. Referral links are shared manually by admins via copy/paste.

### 7.4 Email Sending Code Location

```
api/
├── services/
│   └── email.py          # Resend client wrapper, send_invitation_email()
├── routes/
│   └── invitation_routes.py  # Invitation CRUD + sending
```

### 7.5 Error Handling

- **Resend API failure:** Log the error, return 500 to the caller. The invitation is still created in the DB with status `pending` — admin can "Resend" later.
- **Invalid email address:** Resend validates email format. If rejected, return 422 to the caller.
- **Rate limiting by Resend:** Free tier allows 100 emails/day, 3000/month. Track sending volume and surface a warning in the UI if approaching limits.
- **Bounce/complaint handling:** Future enhancement. For MVP, rely on Resend's built-in bounce handling.

---

## 8. Rate Limiting

### Problem

The current rate limiter (`api/utils/rate_limiter.py`) is in-memory with `threading.Lock`. On Vercel serverless, each invocation gets a fresh process — the rate limiter resets on every cold start.

### Solution: Database-Backed Rate Limiting

Use the `invitations` and `referral_links` tables themselves for rate limiting. Count recent rows within the time window:

```python
async def check_invitation_rate_limit(company_id: str, supabase) -> bool:
    """Check if company has exceeded invitation rate limit (10/hour)."""
    one_hour_ago = datetime.now(timezone.utc) - timedelta(hours=1)

    result = supabase.from_('invitations') \
        .select('id', count='exact') \
        .eq('company_id', company_id) \
        .gte('created_at', one_hour_ago.isoformat()) \
        .execute()

    return result.count < 10


async def check_referral_rate_limit(company_id: str, supabase) -> bool:
    """Check if company has exceeded referral link creation rate limit (3/hour)."""
    one_hour_ago = datetime.now(timezone.utc) - timedelta(hours=1)

    result = supabase.from_('referral_links') \
        .select('id', count='exact') \
        .eq('company_id', company_id) \
        .gte('created_at', one_hour_ago.isoformat()) \
        .execute()

    return result.count < 3
```

**Advantages:**
- Works in serverless environments (no in-memory state)
- Accurate across all instances
- No additional infrastructure (no Redis needed)
- Uses existing tables — no new rate-limiting tables

**Performance:** These are simple COUNT queries with index support. Adding a composite index `(company_id, created_at)` on both tables ensures fast lookups.

---

## 9. Signup Page Rework

### 9.1 Current State

`components/auth/SignUp.tsx` is a basic email/password form. After signup, it shows "Check your email for a confirmation link" and mentions "an administrator will grant you access."

### 9.2 Required Changes

The signup page must handle three modes:

#### Mode 1: Standard Signup (no params)

Current behavior, with updated post-signup messaging:
- Remove "an administrator will grant you access" text
- Replace with "You'll be set up with a demo company to explore"

#### Mode 2: Invitation Signup (`?invite=TOKEN`)

```
1. Page mounts with ?invite=TOKEN in URL
2. Call GET /api/invitations/validate/{token}
3. If valid: Show invitation details above the form
   ┌──────────────────────────────────────────────────┐
   │  You've been invited to join                     │
   │  **Acme Manufacturing** as an **Admin**          │
   │                                                  │
   │  [Email] ← pre-filled from invitation, disabled  │
   │  [Password]                                      │
   │  [Confirm Password]                              │
   │  [Accept Invitation]                             │
   │                                                  │
   │  Already have an account? Sign in to accept →    │
   └──────────────────────────────────────────────────┘
4. If invalid/expired: Show error message with link to standard signup
5. On form submit:
   a. Sign up with Supabase Auth (email from invitation, user's password)
   b. Store token in localStorage: invite_token = TOKEN
   c. Show email verification message
   d. After email verification + login, token is consumed (see section 9.3)
```

#### Mode 3: Referral Signup (`?ref=CODE`)

```
1. Page mounts with ?ref=CODE in URL
2. Call GET /api/referrals/validate/{code}
3. If valid: Show referral details above the form
   ┌──────────────────────────────────────────────────┐
   │  Referred by **Acme Manufacturing**              │
   │                                                  │
   │  [Your Company Name] ← new field                 │
   │  [Email]                                         │
   │  [Password]                                      │
   │  [Confirm Password]                              │
   │  [Create Account & Company]                      │
   └──────────────────────────────────────────────────┘
4. If invalid/expired: Show error with link to standard signup
5. On form submit:
   a. Sign up with Supabase Auth
   b. Store in localStorage: ref_code = CODE, company_name = "My Shop"
   c. Show email verification message
   d. After email verification + login, referral is redeemed (see section 9.3)
```

### 9.3 Post-Auth Token Consumption

The critical challenge: tokens/codes must survive the signup → email verification → login flow. The solution uses `localStorage` to persist the token across page reloads.

**Implementation in `getPostLoginRoute()` (`utils/companyAccess.ts`):**

```typescript
export async function getPostLoginRoute(userId: string): Promise<string> {
  // Check for pending invitation token
  const inviteToken = typeof window !== 'undefined'
    ? localStorage.getItem('invite_token')
    : null;

  if (inviteToken) {
    try {
      const res = await fetch(`/api/invitations/accept/${inviteToken}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      const { company_id } = await res.json();
      localStorage.removeItem('invite_token');
      await setLastCompany(userId, company_id);
      return `/dashboard/${company_id}`;
    } catch (e) {
      console.error('Failed to accept invitation:', e);
      localStorage.removeItem('invite_token');
    }
  }

  // Check for pending referral code
  const refCode = typeof window !== 'undefined'
    ? localStorage.getItem('ref_code')
    : null;
  const companyName = typeof window !== 'undefined'
    ? localStorage.getItem('ref_company_name')
    : null;

  if (refCode && companyName) {
    try {
      const res = await fetch(`/api/referrals/redeem/${refCode}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ company_name: companyName })
      });
      const { company_id } = await res.json();
      localStorage.removeItem('ref_code');
      localStorage.removeItem('ref_company_name');
      await setLastCompany(userId, company_id);
      return `/dashboard/${company_id}`;
    } catch (e) {
      console.error('Failed to redeem referral:', e);
      localStorage.removeItem('ref_code');
      localStorage.removeItem('ref_company_name');
    }
  }

  // ... existing routing logic (fetch companies, etc.)
}
```

### 9.4 Existing User Accepting Invitation

If the user clicks an invitation link but already has an account:

1. They click "Already have an account? Sign in to accept"
2. Redirected to `/login?invite=TOKEN`
3. Login page stores `invite_token` in localStorage
4. After login, `getPostLoginRoute()` detects the token and calls `accept_invitation()`
5. User is routed to the new company's dashboard

### 9.5 Already Logged-In User

If a logged-in user clicks an invitation link:

1. Signup page detects existing auth session
2. Shows: "You're already signed in as {email}. Accept invitation to join {company}?"
3. Two buttons: "Accept Invitation" / "Sign in as different user"
4. "Accept Invitation" calls `accept_invitation()` directly (no signup needed)

---

## 10. Expiration Handling

### Strategy: Lazy Expiration

Invitations and referral links are checked for expiry **at query time**, not via a scheduled cleanup.

- `validate_invitation_token()` checks `expires_at > NOW()` — expired tokens return `valid = false`
- `validate_referral_code()` checks `expires_at > NOW()` — expired codes return `valid = false`
- `accept_invitation()` checks `expires_at > NOW()` — rejects expired tokens

### Periodic Cleanup (Optional)

A scheduled job (Supabase `pg_cron` or external cron) can update statuses for housekeeping:

```sql
-- Run daily: mark expired invitations
UPDATE invitations SET status = 'expired'
WHERE status = 'pending' AND expires_at < NOW();

-- Run daily: mark expired referral links
UPDATE referral_links SET status = 'expired'
WHERE status = 'active' AND expires_at < NOW();
```

This is cosmetic — the validation functions already reject expired items. But it keeps the `status` column accurate for admin reporting.

---

## 11. API Endpoints

All endpoints are **FastAPI routes** in `api/routes/invitation_routes.py`, registered in `api/index.py`.

### 11.1 Invitations

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/invitations` | Company Admin | Create invitation + send email |
| `GET` | `/api/invitations?company_id=X` | Company Admin | List invitations for company |
| `DELETE` | `/api/invitations/{id}` | Company Admin | Revoke invitation |
| `POST` | `/api/invitations/{id}/resend` | Company Admin | Resend invitation email |
| `GET` | `/api/invitations/validate/{token}` | Public | Validate token (for signup page) |
| `POST` | `/api/invitations/accept/{token}` | Authenticated | Accept invitation |

### 11.2 Referral Links

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/referrals` | Company Admin | Create referral link |
| `GET` | `/api/referrals?company_id=X` | Company Admin | List referral links for company |
| `DELETE` | `/api/referrals/{id}` | Company Admin | Revoke referral link |
| `GET` | `/api/referrals/validate/{code}` | Public | Validate referral code (for signup page) |
| `POST` | `/api/referrals/redeem/{code}` | Authenticated | Redeem referral code |
| `GET` | `/api/referrals/redemptions?company_id=X` | Company Admin | List redemptions for company |

### 11.3 Auth Pattern

Admin endpoints verify the caller's identity and role:

```python
async def verify_company_admin(company_id: str, request: Request) -> str:
    """Verify the caller is an admin of the specified company. Returns user_id."""
    # Extract Supabase JWT from Authorization header
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    # Verify with Supabase and get user_id
    user = supabase.auth.get_user(token)
    user_id = user.user.id

    # Check admin access
    result = supabase.from_('user_company_access') \
        .select('role') \
        .eq('user_id', user_id) \
        .eq('company_id', company_id) \
        .in_('role', ['owner', 'admin']) \
        .single() \
        .execute()

    if not result.data:
        raise HTTPException(status_code=403, detail="Not authorized")

    return user_id
```

Public endpoints (validate) require no auth. Accept/redeem endpoints require only authentication (any valid JWT).

---

## 12. UI Components & Pages

### 12.1 New Pages

#### `/dashboard/[companyId]/settings/team`

Enhanced version of the existing team management page:

```
┌──────────────────────────────────────────────────────────────────┐
│  Team Members                           [Invite]  [Add Member]   │
├──────────────────────────────────────────────────────────────────┤
│  Name          Email              Role       Status    Actions    │
│  John Smith    john@acme.com      Owner      Active    ···        │
│  Jane Doe      jane@acme.com      Admin      Active    ···        │
│  Bob Wilson    bob@acme.com       Operator   Active    ···        │
├──────────────────────────────────────────────────────────────────┤
│  Pending Invitations                                              │
│  alice@example.com    Engineer    Expires Feb 27    [Resend] [✕]  │
│  carl@example.com     Sales       Expires Feb 28    [Resend] [✕]  │
└──────────────────────────────────────────────────────────────────┘
```

#### `/dashboard/[companyId]/settings/referrals`

```
┌──────────────────────────────────────────────────────────────────┐
│  Referral Links                              [Create Link]        │
├──────────────────────────────────────────────────────────────────┤
│  Code        Uses      Expires       Status    Actions            │
│  ABCD1234    2/5       Mar 20        Active    [Copy Link] [✕]    │
│  WXYZ5678    5/5       Mar 15        Exhausted                    │
├──────────────────────────────────────────────────────────────────┤
│  Redemptions                                                      │
│  User                 Company Created      Date                   │
│  alice@example.com    Alice's Shop         Feb 15, 2026           │
│  bob@example.com      Bob's Machine Shop   Feb 18, 2026           │
└──────────────────────────────────────────────────────────────────┘
```

### 12.2 New Components

| Component | Description |
|-----------|-------------|
| `InviteTeamMemberDialog` | Modal with email + role selector. Validates email, checks for duplicates, sends invitation. |
| `InvitationsList` | Table of pending/accepted/expired invitations with resend and revoke actions. |
| `ReferralLinkCard` | Displays referral code, shareable URL with copy button, usage stats. |
| `ReferralRedemptionsList` | Table of users who redeemed referral links. |

### 12.3 Settings Navigation

The settings section doesn't currently exist. Create a settings layout:

```
/dashboard/[companyId]/settings/
├── team            # Team management + invitations
├── referrals       # Referral link management
└── (future pages)
```

Navigation: Add a "Settings" item to the sidebar menu, with sub-navigation for Team and Referrals.

---

## 13. Demo Company Integration (Optional Hook)

If the [Demo Company feature](./demo-company.md) is deployed, the following hook points apply:

### On Invitation Acceptance

After `accept_invitation()` returns a `company_id`:
```python
# Optional: create demo company for the new user
# Only if Demo Company feature is deployed
if demo_feature_enabled():
    await create_demo_company(user_id)
```

### On Referral Redemption

After `redeem_referral()` returns a `new_company_id`:
```python
# Optional: create demo company for the new user
if demo_feature_enabled():
    await create_demo_company(user_id)
```

### Feature Detection

```python
def demo_feature_enabled() -> bool:
    """Check if demo company feature is deployed."""
    # Check if demo_templates table exists and has an active template
    result = supabase.from_('demo_templates') \
        .select('id') \
        .eq('is_active', True) \
        .limit(1) \
        .execute()
    return bool(result.data)
```

This ensures the Invitation System works independently of the Demo Company feature. If demo_templates doesn't exist (feature not deployed), the hook is silently skipped.

---

## 14. Frontend Routing Changes

### New Routes

```
app/
├── dashboard/[companyId]/settings/
│   ├── layout.tsx       # Settings layout with sub-navigation
│   ├── page.tsx         # Redirects to /team
│   ├── team/
│   │   └── page.tsx     # Team management + invitations
│   └── referrals/
│       └── page.tsx     # Referral link management
```

### Modified Routes

| Route | Change |
|-------|--------|
| `/signup` | Handle `?invite=TOKEN` and `?ref=CODE` params |
| `/login` | Handle `?invite=TOKEN` param (store in localStorage) |
| `/no-access` | Update messaging: "Your demo company is being set up" or "Contact your admin" |

---

## 15. Testing Strategy

### Unit Tests (Backend)

| Test | Description |
|------|-------------|
| `validate_invitation_token()` | Valid token, expired token, revoked token, invalid token |
| `validate_referral_code()` | Valid code, expired code, exhausted code, invalid code, case-insensitivity |
| `accept_invitation()` | New user, existing user already in company, expired token, concurrent acceptance |
| `redeem_referral()` | Valid redemption, company creation, usage increment, exhaustion |
| Token generation | 64-char URL-safe tokens, uniqueness |
| Code generation | 8-char uppercase, no ambiguous chars, uniqueness |
| Rate limiting | Under limit, at limit, over limit |
| Email sending | Successful send, API failure, invalid email |

### Unit Tests (Frontend)

| Test | Description |
|------|-------------|
| Signup with `?invite=TOKEN` | Validates token on mount, pre-fills email, stores token |
| Signup with `?ref=CODE` | Validates code on mount, shows company name input, stores code |
| Signup standard | No params, standard flow |
| `getPostLoginRoute()` with invite token | Accepts invitation, routes to company |
| `getPostLoginRoute()` with ref code | Redeems referral, routes to company |
| Existing user flow | Detects session, shows accept button |

### Integration Tests

| Test | Description |
|------|-------------|
| Full invitation flow | Create → email sent → validate → signup → verify → login → accept → dashboard |
| Full referral flow | Create → share → validate → signup → verify → login → redeem → dashboard |
| Invitation for existing user | Create → email → login → accept → dashboard |
| Invitation revocation | Create → revoke → validate fails |
| Rate limiting | Create 10 invitations → 11th fails |

---

## 16. Acceptance Criteria

- [ ] `invitations` table exists with proper indexes and RLS
- [ ] `referral_links` table exists with proper indexes and RLS
- [ ] `referral_redemptions` table exists with `referred_by_company_id` for chain tracking
- [ ] Resend integration sends invitation emails successfully
- [ ] Team invitation email includes correct company name, role, and link
- [ ] Invitation acceptance works for new users (signup → verify → accept)
- [ ] Invitation acceptance works for existing users (login → accept)
- [ ] Invitation acceptance works for already-logged-in users (accept directly)
- [ ] Referral link generation produces valid 8-char codes
- [ ] Referral redemption creates new company with user as owner
- [ ] Referral redemption includes company name input
- [ ] Rate limiting prevents spam (DB-backed, works in serverless)
- [ ] Expired invitations/referrals are rejected at validation and acceptance
- [ ] Signup page handles `?invite=TOKEN`, `?ref=CODE`, and no params
- [ ] Token persists through signup → email verification → login flow via localStorage
- [ ] Settings/Team page shows unified team view + pending invitations
- [ ] Settings/Referrals page shows links with usage stats and redemptions
- [ ] Demo company integration is optional (works with or without Demo Company feature)
- [ ] Existing team Edge Function continues to work alongside invitations

---

## 17. Open Questions (Resolved)

| # | Question | Resolution |
|---|----------|------------|
| 1 | Should demo company creation be required on invitation acceptance? | No — optional hook. Invitations work independently. |
| 2 | Should we track referral chain analytics? | Yes — `referred_by_company_id` column enables recursive CTE queries. |
| 3 | Rate limiting approach in serverless? | DB-backed — count recent rows in the invitations/referral_links tables. |
| 4 | Email provider? | Resend via Python SDK in FastAPI backend. |
| 5 | Coexist with existing team Edge Function? | Yes — both paths supported. Direct creation for operators, invitations for standard onboarding. |
| 6 | Role model: `user` vs specific roles? | Simplified 3-role model: `admin`, `user`, `operator`. Old granular roles (bookkeeper, engineer, quality, sales) consolidated into `user`. |
| 7 | Token persistence through auth flow? | localStorage — survives page reloads and redirects. |
| 8 | Duplicate validation routes (GET+POST)? | Consolidate to GET only for validation. POST for acceptance/redemption. |
| 9 | Where do invitation routes live? | FastAPI backend (`api/routes/invitation_routes.py`). Single codebase for all invitation logic. |

---

## 18. Dependencies

- **No hard dependency on [Demo Company](./demo-company.md):** Demo creation is an optional hook. If the Demo Company feature is not deployed, invitations still work — users just join companies without getting a demo.
- **Resend account:** Must be set up with a verified sending domain before email features work.
- **DNS configuration:** SPF, DKIM, and DMARC records for `mail.jigged.app`.

---

## 19. Success Metrics

- **Team invitation acceptance rate:** % of invitations accepted vs expired/revoked
- **Referral conversion rate:** % of referral link clicks that result in signups
- **Referral chain depth:** Average depth of referral chains (A → B → C = depth 2)
- **Viral coefficient:** Average number of new users generated per existing user via referrals
