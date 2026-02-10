# Invitation System & Demo Company

### 5.3 Demo Reset Flow

1. User clicks "Reset Demo" in demo company settings

2. Confirmation modal: "This will delete all your changes to the demo"

3. User confirms

4. System deletes all company data and re-clones from active template

5. Page refreshes with fresh demo data

---

## 6. UI Components

### New Pages

- /signup - Modified to handle invite tokens and referral codes

- /dashboard/[companyId]/settings/team - Invitation management

- /dashboard/[companyId]/settings/referrals - Referral link management

### New Components

- InviteTeamMemberDialog - Modal for creating team invitations

- ReferralLinkCard - Display shareable referral link with copy button

- InvitationsList - Table of pending/accepted invitations

- DemoResetButton - Button with confirmation for resetting demo

- DemoBanner - Visual indicator when viewing demo company

---

## 7. Open Questions

1. Should demo companies count toward any limits? (e.g., if we add company limits later)
  1. No

2. Should we track referral chain analytics? (who referred who for growth metrics)
  1. Yes

3. Should demo operators be interactive? (can log in as demo operator for full experience)
  1. Yes

4. Rate limiting on referral creation? (prevent spam link generation)
  1. Yes

---

## 8. Success Metrics

- Referral conversion rate - % of referral link clicks that result in signups

- Demo engagement - % of users who interact with demo before creating real data

- Team invitation acceptance rate - % of team invites accepted vs expired

- Time to first real job - How quickly users go from signup to creating real jobs

---

## 9. Technical Notes

### Email Provider

Recommend Resend for transactional emails:

- Modern API designed for developers

- React Email templates support

- Generous free tier (100 emails/day, 3,000/month)

- Easy integration with Next.js and FastAPI

### API Endpoints

Invitations: POST/GET/DELETE /api/invitations, GET/POST /api/invitations/validate/{token}, /api/invitations/accept/{token}

Referrals: POST/GET/DELETE /api/referrals, GET /api/referrals/validate/{code}, POST /api/referrals/redeem/{code}

Demo: POST /api/demo/reset/{company_id}, GET/POST /api/demo/templates

[Platform Foundation](invitation-system.md#platform-foundation)
## 1. Overview

  Establish platform-level administrative capabilities for managing Jigged as a SaaS product.

### Problem Statement

  No distinction between company admins and platform-level administrators who manage the entire system.

### Solution

  Create a system_admins infrastructure that grants platform-wide privileges.

  ---

## 2. Database Schema

### New Table: system_admins

  ```sql
  CREATE TABLE system_admins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id),
    UNIQUE(user_id)
  );
  ```

### RLS Policies

  - Only system admins can read/write this table

  - Bootstrap: First admin added via direct DB insert

### Helper Function

  ```sql
  CREATE FUNCTION is_system_admin(user_id UUID) RETURNS BOOLEAN
  ```

  ---

## 3. UI Components

  - None initially (admin operations via Supabase dashboard)

  - Future: /admin dashboard routes

  ---

## 4. API Endpoints

  - GET /api/admin/status - Check if current user is system admin

  ---

## 5. Acceptance Criteria

  - [ ] system_admins table exists with RLS

  - [ ] is_system_admin() function works correctly

  - [ ] At least one bootstrap admin can be added

[Demo Company](invitation-system.md#demo-company)
## 1. Overview

  Provide every user with an isolated sandbox environment pre-populated with realistic manufacturing data to explore Jigged risk-free.

### Problem Statement

  - New users have no safe way to explore features before committing real data

  - Learning curve is steep without example data to reference

### Solution

  Every new user automatically receives a personal demo company with realistic mock data that can be reset at any time.

  ---

## 2. User Stories

  **System Admin: Create/update demo templates, set active template version, view template usage statistics**

  **All Users: Automatically receive demo company on signup, access demo risk-free, reset demo at any time, switch between real and demo company, demo operators are interactive**

  ---

## 3. Feature Specifications

### 3.1 Demo Company Naming

  Format: "{User's First Name}'s Demo Shop" (e.g., "John's Demo Shop")

### 3.2 Demo Data Included

  - 3 Customers (Acme Manufacturing, Ajax Industries, Precision Corp)

  - 6 Parts with pricing tiers

  - 4 Resource Groups (CNC, Manual, Quality, Finishing)

  - 8 Operation Types with labor rates

  - 3 Routings with nodes and edges

  - 5 Quotes (draft, pending, accepted)

  - 4 Jobs (pending, in_progress, completed)

  - 10+ Job Operations, 8 Inventory Items

  - 2 Demo Operators (Mike Johnson, Sarah Williams) - interactive with PIN codes

### 3.3 Reset Behavior

  1. Deletes all user-created/modified data in demo company

  2. Re-clones from current active template

  3. Preserves company name and user_company_access record

  4. Instant operation (< 3 seconds)

  > 💡 Demo companies do NOT count toward any future limits

  ---

## 4. Database Schema

### 4.1 New Table: demo_templates

  ```sql
  CREATE TABLE demo_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    is_active BOOLEAN DEFAULT FALSE,
    template_data JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id),
    UNIQUE(name, version)
  );
  ```

### 4.2 Companies Table Modifications

  ```sql
  ALTER TABLE companies ADD COLUMN is_demo BOOLEAN DEFAULT FALSE;
  ALTER TABLE companies ADD COLUMN demo_template_id UUID REFERENCES demo_templates(id);
  ALTER TABLE companies ADD COLUMN demo_owner_id UUID REFERENCES auth.users(id);
  ```

### 4.3 Database Functions

  ```sql
  CREATE FUNCTION clone_demo_company(p_user_id UUID, p_template_name VARCHAR DEFAULT 'default') RETURNS UUID
  CREATE FUNCTION reset_demo_company(p_company_id UUID) RETURNS VOID
  ```

  ---

## 5. User Flows

### 5.1 Demo Creation on Signup

  1. User completes email verification → 2. System calls clone_demo_company(user_id) → 3. Demo company created with user's name → 4. Demo populated from active template → 5. user_company_access record created (role: admin) → 6. User lands on dashboard

### 5.2 Demo Reset Flow

  1. User clicks Reset Demo button → 2. Confirmation dialog shown → 3. User confirms → 4. Loading indicator → 5. reset_demo_company() called → 6. Page reloads with fresh data → 7. Success toast

  ---

## 6. UI Components

  **DemoBanner**: Sticky banner at top when viewing demo. Text: "You're viewing your demo company." Contains Reset Demo button.

  **DemoResetButton**: Appears in DemoBanner and Settings. Opens confirmation dialog. Shows loading state during reset.

  **Company Switcher Enhancement**: Demo company shows (Demo) suffix or badge with different icon/color.

  ---

## 7. API Endpoints

  - POST /api/demo/create - Create demo for current user

  - POST /api/demo/reset/{company_id} - Reset demo company

  - GET /api/demo/templates - List templates (System Admin)

  - POST /api/demo/templates - Create template (System Admin)

  - PUT /api/demo/templates/{id}/activate - Set active template (System Admin)

  ---

## 8. Success Metrics

  - Demo engagement: % of users who interact with demo before creating real data

  - Demo reset usage: How often users reset their demo

  - Time to first real job: How quickly users go from signup to creating real jobs

  ---

## 9. Acceptance Criteria

  - [ ] demo_templates table with seed data

  - [ ] companies.is_demo, demo_template_id, demo_owner_id columns

  - [ ] clone_demo_company() function works

  - [ ] reset_demo_company() function works (< 3 seconds)

  - [ ] Signup flow creates demo company automatically

  - [ ] DemoBanner displays when viewing demo

  - [ ] Demo company appears in company switcher with badge

  - [ ] Reset Demo button works with confirmation

  - [ ] Demo operators can be logged into

[Invitation System](invitation-system.md#invitation-system)
## 1. Overview

  Enable viral growth through user-to-user referrals and streamlined team onboarding via email invitations.

### Problem Statement

  No mechanism to invite new users, company admins cannot onboard team members, no viral growth loop.

### Solution

  1. Team Invitations: Admins send email invites for team members with specific roles. 2. Referral Links: Admins generate shareable links for others to create their own companies.

  ---

## 2. User Stories

  **System Admin**: Invite anyone via email, manage all invitations/referrals, view referral chain analytics

  **Company Admin**: Invite team members with role, generate referral links (max 5 uses), see who redeemed, revoke invitations/links

  **Invited User**: Receive email link, see company + role, sign up/in and join, also get demo company (PRD 0B)

  **Referred User**: Click referral link, see referrer, sign up + name company, become owner + get demo (PRD 0B)

  ---

## 3. Feature Specifications

### 3.1 Invitation Types

  Team Invite (Company Admin → email → joins existing company) | Referral Link (Company Admin → shareable URL → creates new company) | System Invite (Platform Admin → email → creates new company)

### 3.2 Limits & Expiry

  Team invite: 7 days | Referral link: 5 uses max, 30 days | 1 pending invite per email per company | Rate limit: 3 referrals/hour/company

### 3.3 Role-Based Permissions

  Admins: Full access | Users: View own invitation history | Operators: No access to invitation features

  ---

## 4. Database Schema

### 4.1 invitations table

  ```sql
  CREATE TABLE invitations (
    id UUID PRIMARY KEY,
    company_id UUID NOT NULL REFERENCES companies(id),
    email VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL,  -- admin, user, operator
    token VARCHAR(64) UNIQUE NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',  -- pending, accepted, expired, revoked
    invited_by UUID, accepted_by UUID,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  ```

### 4.2 referral_links table

  ```sql
  CREATE TABLE referral_links (
    id UUID PRIMARY KEY,
    company_id UUID NOT NULL REFERENCES companies(id),
    code VARCHAR(20) UNIQUE NOT NULL,
    max_uses INTEGER DEFAULT 5,
    current_uses INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'active',
    created_by UUID, expires_at TIMESTAMPTZ NOT NULL
  );
  ```

### 4.3 referral_redemptions table

  ```sql
  CREATE TABLE referral_redemptions (
    id UUID PRIMARY KEY,
    referral_link_id UUID NOT NULL REFERENCES referral_links(id),
    user_id UUID NOT NULL, company_id UUID NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  ```

### 4.4 Database Functions

  ```sql
  validate_invitation_token(token) → (valid, company_name, role, email)
  validate_referral_code(code) → (valid, company_name, uses_remaining)
  accept_invitation(token, user_id) → company_id
  redeem_referral(code, user_id, company_name) → new_company_id
  ```

  ---

## 5. User Flows

### 5.1 Team Invitation Flow

  Admin clicks Invite → Enters email + role → System sends email via Resend → Recipient clicks /signup?invite=TOKEN → Validates, shows company/role → User signs up/in → accept_invitation() → Demo created (PRD 0B) → Redirect to dashboard

### 5.2 Referral Link Flow

  Admin creates link → Shares URL → Recipient visits /signup?ref=CODE → Shows Referred by {Company} → User signs up + names company → redeem_referral() → Demo created (PRD 0B) → Redirect to new company

  ---

## 6. UI Components

  **Pages**: /signup (enhanced), /dashboard/[companyId]/settings/team, /dashboard/[companyId]/settings/referrals

  **Components**: InviteTeamMemberDialog, InvitationsList, ReferralLinkCard, ReferralRedemptionsList

  ---

## 7. API Endpoints

  **Invitations**: POST/GET/DELETE /api/invitations, POST /api/invitations/{id}/resend, GET/POST /api/invitations/validate/{token}, /api/invitations/accept/{token}

  **Referrals**: POST/GET/DELETE /api/referrals, GET/POST /api/referrals/validate/{code}, /api/referrals/redeem/{code}, GET /api/referrals/redemptions

  ---

## 8. Technical Notes

  Email: Resend (100/day free, 3000/month) | Tokens: 64 char secure random | Codes: 8 char alphanumeric | Rate limits: 10 invites/hr, 3 referrals/hr per company

  ---

## 9. Success Metrics

  Team invitation acceptance rate | Referral conversion rate | Referral chain depth | Viral coefficient

  ---

## 10. Acceptance Criteria

  - [ ] invitations table with proper indexes and RLS

  - [ ] referral_links table with proper indexes and RLS

  - [ ] referral_redemptions table for analytics

  - [ ] Resend integration working

  - [ ] Team invitation email sends correctly

  - [ ] Invitation accept flow works for new and existing users

  - [ ] Referral link generation and display

  - [ ] Referral redemption creates new company

  - [ ] Rate limiting prevents spam

  - [ ] All flows create demo company via PRD 0B

> 📋 This PRD has been split into three separate documents for clearer implementation.



## Implementation Order



1. [**[Phase 0A: Platform Foundation](https://www.notion.so/Phase-0A-Platform-Foundation-2e95314e84758186a863f4c8f68c3d5d)**](https://www.notion.so/Phase-0A-Platform-Foundation-2e95314e84758186a863f4c8f68c3d5d) - system_admins table for platform-level admin privileges

2. [**[Phase 0B: Demo Company](https://www.notion.so/Phase-0B-Demo-Company-2e95314e847581518912ed236a58976a)**](https://www.notion.so/Phase-0B-Demo-Company-2e95314e847581518912ed236a58976a) - Sandbox environment with demo data, reset functionality, DemoBanner

3. [**[Phase 0C: Invitation System](https://www.notion.so/Phase-0C-Invitation-System-2e95314e847581bdb102d04827204734)**](https://www.notion.so/Phase-0C-Invitation-System-2e95314e847581bdb102d04827204734) - Team invitations, referral links, email via Resend



---

## Dependency Diagram

```plain text
Phase 0A: Platform Foundation
        ↓
Phase 0B: Demo Company
        ↓
Phase 0C: Invitation System
```



---

## Summary



**Phase 0A** establishes platform-level admin capabilities (Small effort)

**Phase 0B** provides demo company sandbox with realistic manufacturing data (Medium effort)

**Phase 0C** enables viral growth via team invites and referral links (Large effort)
