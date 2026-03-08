#!/usr/bin/env bash
# =============================================================================
# Jigged Productionization Backlog v2 — GitHub Issues & Project Setup
# =============================================================================
# Updated after Shane/Contour Inc user interview (March 2026).
#
# Changes from v1:
#   - REMOVED 3 issues for already-built features (AI Insights, Operator View,
#     AI rate limiting)
#   - REPLACED vague "Module refinements" with 6 specific Shane feedback issues
#   - RE-PRIORITIZED: product features → P0, infrastructure → P1
#   - CORRECTED effort estimates based on actual codebase state
#   - Total: 29 issues (was 26)
#
# Prerequisites:
#   1. Install GitHub CLI: https://cli.github.com/
#   2. Authenticate: gh auth login
#   3. Run from anywhere: bash create-jigged-backlog.sh
# =============================================================================

set -e

REPO="debola31/Jigged"
PROJECT_NUMBER=2
OWNER="debola31"

echo "=========================================="
echo "  Jigged Productionization Backlog v2"
echo "=========================================="
echo ""
echo "Repo: $REPO"
echo "Project: #$PROJECT_NUMBER"
echo ""

# ------------------------------------------------------------------
# STEP 1: Create Labels
# ------------------------------------------------------------------
echo ">>> Step 1: Creating labels..."

create_label() {
  gh label create "$1" --repo "$REPO" --color "$2" --force 2>/dev/null || true
}

# Theme labels (purple tones)
create_label "theme: trust & reliability"    "7B2D8B"
create_label "theme: first impressions"      "1E90FF"
create_label "theme: ease of use"            "2BBCB3"
create_label "theme: multi-tenancy & growth" "D4872A"
create_label "theme: operational control"    "4682B4"
create_label "theme: compliance & credibility" "8B6914"
# Phase labels
create_label "P0: this week"              "FF0000"
create_label "P1: before salesperson"     "FF8C00"
create_label "P2: before usability tests" "FFD700"
create_label "P3: post-launch"            "90EE90"
# Effort labels
create_label "effort: S"  "EDEDED"
create_label "effort: M"  "D4C5F9"
create_label "effort: L"  "C2E0C6"
create_label "effort: XL" "FEF2C0"
# Owner labels
create_label "owner: debola"      "0E8A16"
create_label "owner: claude-code" "1D76DB"
create_label "owner: both"        "5319E7"
# Work type labels
create_label "frontend"        "A2EEEF"
create_label "backend"         "D4C5F9"
create_label "infrastructure"  "C5DEF5"
create_label "hardening"       "FF6666"
create_label "ux"              "FBCA04"
create_label "branding"        "E99695"
create_label "auth"            "BFD4F2"
create_label "security"        "B60205"
create_label "new-feature"     "0075CA"
create_label "devops"          "D876E3"
create_label "testing"         "BFD4F2"
create_label "client-feedback" "F9D0C4"
create_label "observability"   "006B75"
create_label "legal"           "FBCA04"
create_label "compliance"      "FEF2C0"
create_label "database"        "C5DEF5"
create_label "tech-debt"       "E4E669"
create_label "ai"              "7057FF"

echo "    Labels created."

# ------------------------------------------------------------------
# STEP 2: Get Project ID and Field IDs for custom fields
# ------------------------------------------------------------------
echo ">>> Step 2: Fetching project metadata..."

PROJECT_ID=$(gh project list --owner "$OWNER" --format json | jq -r ".projects[] | select(.number == $PROJECT_NUMBER) | .id")

if [ -z "$PROJECT_ID" ]; then
  echo "ERROR: Could not find project #$PROJECT_NUMBER. Check the project number."
  exit 1
fi

echo "    Project ID: $PROJECT_ID"

# Create custom fields if they don't exist (will error silently if they do)
echo ">>> Step 2b: Ensuring custom fields exist..."

gh project field-create "$PROJECT_NUMBER" --owner "$OWNER" --name "Phase" --data-type "SINGLE_SELECT" 2>/dev/null || true
gh project field-create "$PROJECT_NUMBER" --owner "$OWNER" --name "Effort" --data-type "SINGLE_SELECT" 2>/dev/null || true
gh project field-create "$PROJECT_NUMBER" --owner "$OWNER" --name "Theme" --data-type "SINGLE_SELECT" 2>/dev/null || true
gh project field-create "$PROJECT_NUMBER" --owner "$OWNER" --name "Owner" --data-type "SINGLE_SELECT" 2>/dev/null || true

# Get field IDs
get_field_id() {
  gh project field-list "$PROJECT_NUMBER" --owner "$OWNER" --format json | jq -r ".fields[] | select(.name == \"$1\") | .id"
}

PHASE_FIELD_ID=$(get_field_id "Phase")
EFFORT_FIELD_ID=$(get_field_id "Effort")
THEME_FIELD_ID=$(get_field_id "Theme")
OWNER_FIELD_ID=$(get_field_id "Owner")

echo "    Phase field:  $PHASE_FIELD_ID"
echo "    Effort field: $EFFORT_FIELD_ID"
echo "    Theme field:  $THEME_FIELD_ID"
echo "    Owner field:  $OWNER_FIELD_ID"

# ------------------------------------------------------------------
# STEP 3: Helper function to create an issue and add to project
# ------------------------------------------------------------------
create_issue() {
  local title="$1"
  local body="$2"
  local labels="$3"
  local phase="$4"
  local effort="$5"
  local theme="$6"
  local owner="$7"

  echo ""
  echo "  Creating: $title"

  # Create the issue
  ISSUE_URL=$(gh issue create \
    --repo "$REPO" \
    --title "$title" \
    --body "$body" \
    --label "$labels" \
    2>&1)

  echo "    Issue: $ISSUE_URL"

  # Add to project
  ITEM_ID=$(gh project item-add "$PROJECT_NUMBER" --owner "$OWNER" --url "$ISSUE_URL" --format json | jq -r '.id')

  echo "    Project Item: $ITEM_ID"

  # Set custom fields
  if [ -n "$PHASE_FIELD_ID" ] && [ -n "$phase" ]; then
    gh project item-edit --project-id "$PROJECT_ID" --id "$ITEM_ID" --field-id "$PHASE_FIELD_ID" --single-select-option-id "$(get_or_create_option "$PHASE_FIELD_ID" "$phase")" 2>/dev/null || echo "    (Could not set Phase)"
  fi
  if [ -n "$EFFORT_FIELD_ID" ] && [ -n "$effort" ]; then
    gh project item-edit --project-id "$PROJECT_ID" --id "$ITEM_ID" --field-id "$EFFORT_FIELD_ID" --single-select-option-id "$(get_or_create_option "$EFFORT_FIELD_ID" "$effort")" 2>/dev/null || echo "    (Could not set Effort)"
  fi
  if [ -n "$THEME_FIELD_ID" ] && [ -n "$theme" ]; then
    gh project item-edit --project-id "$PROJECT_ID" --id "$ITEM_ID" --field-id "$THEME_FIELD_ID" --single-select-option-id "$(get_or_create_option "$THEME_FIELD_ID" "$theme")" 2>/dev/null || echo "    (Could not set Theme)"
  fi
  if [ -n "$OWNER_FIELD_ID" ] && [ -n "$owner" ]; then
    gh project item-edit --project-id "$PROJECT_ID" --id "$ITEM_ID" --field-id "$OWNER_FIELD_ID" --single-select-option-id "$(get_or_create_option "$OWNER_FIELD_ID" "$owner")" 2>/dev/null || echo "    (Could not set Owner)"
  fi
}

# Helper to get or create a single-select option and return its ID
# Note: gh CLI doesn't support creating options directly, so we use GraphQL
get_or_create_option() {
  local field_id="$1"
  local option_name="$2"

  # First try to find existing option
  local option_id=$(gh api graphql -f query='
    query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          fields(first: 20) {
            nodes {
              ... on ProjectV2SingleSelectField {
                id
                options {
                  id
                  name
                }
              }
            }
          }
        }
      }
    }
  ' -f projectId="$PROJECT_ID" --jq ".data.node.fields.nodes[] | select(.id == \"$field_id\") | .options[] | select(.name == \"$option_name\") | .id" 2>/dev/null)

  if [ -n "$option_id" ]; then
    echo "$option_id"
    return
  fi

  # Option doesn't exist — create it via GraphQL mutation
  option_id=$(gh api graphql -f query='
    mutation($projectId: ID!, $fieldId: ID!, $name: String!) {
      createProjectV2FieldOption(input: {projectId: $projectId, fieldId: $fieldId, name: $name}) {
        projectV2FieldOption {
          id
        }
      }
    }
  ' -f projectId="$PROJECT_ID" -f fieldId="$field_id" -f name="$option_name" --jq '.data.createProjectV2FieldOption.projectV2FieldOption.id' 2>/dev/null)

  echo "$option_id"
}

# ------------------------------------------------------------------
# STEP 4: Create all issues
# ------------------------------------------------------------------
echo ""
echo ">>> Step 3: Creating issues..."
echo "=========================================="

# ============================================================
# P0: THIS WEEK — Johnny is playing with the app NOW
# Focus: Make the quote-to-job workflow solid + prevent crashes
# ============================================================

create_issue \
  "Routing UX: Add 'Add Operation' button alongside drag-and-drop" \
  "## Problem
Shane's feedback: the routing editor only supports drag-and-drop from the sidebar to add operations. New users (especially Johnny evaluating the app) won't discover this. Need an explicit \"Add Operation\" button as a primary CTA.

## What Already Exists
- \`OperationsSidebar.tsx\` with drag-and-drop operation tiles
- \`RoutingWorkflowBuilder.tsx\` with React Flow canvas
- Operations grouped by resource group with search

## Acceptance Criteria
- [ ] \"+ Add Operation\" button visible on the canvas (not just sidebar drag)
- [ ] Clicking button opens a modal/popover to select operation from available list
- [ ] Selected operation added to canvas at a sensible default position
- [ ] Drag-and-drop still works alongside the button (both paths supported)
- [ ] Button uses primary color and is obvious for first-time users

## Key Files
- \`components/routings/RoutingWorkflowBuilder.tsx\`
- \`components/routings/OperationsSidebar.tsx\`
- \`components/routings/RoutingWizard.tsx\`" \
  "frontend,ux,client-feedback,P0: this week,effort: M,theme: ease of use,owner: claude-code" \
  "P0: This Week" "M" "Ease of Use" "Claude Code"

create_issue \
  "Dashboard: Surface Shane's 4 KPI metrics as defaults" \
  "## Problem
Shane explicitly requested four dashboard metrics: open quotes, active jobs, jobs in progress, and completed jobs. The PinnedMetrics component and SummaryCard component already exist, but may not show these specific metrics by default.

## What Already Exists
- \`PinnedMetrics.tsx\` — customizable metric display
- \`SummaryCard.tsx\` — card component with icon, value, color
- \`dashboardAccess.ts\` — metric fetching with \`AVAILABLE_METRICS\` including \`open_quotes\`, \`active_jobs\`, \`weekly_revenue\`
- Metrics stored in localStorage for persistence

## Acceptance Criteria
- [ ] Verify \`jobs_in_progress\` and \`completed_jobs\` exist as available metrics (add if missing)
- [ ] Default pinned metrics for new users: Open Quotes, Active Jobs, Jobs In Progress, Completed Jobs
- [ ] All four metrics display correctly with real data from Shane's company
- [ ] Metrics are prominent and visible immediately on dashboard load (top of page)

## Key Files
- \`components/dashboard/PinnedMetrics.tsx\`
- \`components/dashboard/SummaryCard.tsx\`
- \`utils/dashboardAccess.ts\`
- \`app/dashboard/[companyId]/page.tsx\`" \
  "frontend,client-feedback,P0: this week,effort: S,theme: ease of use,owner: claude-code" \
  "P0: This Week" "S" "Ease of Use" "Claude Code"

create_issue \
  "Inventory: Verify unit conversion UI for Shane's use case" \
  "## Problem
Shane needs to remove inventory in different units than the primary unit (e.g., feet of cold roll steel bar stored by the bar). The backend supports this but the UI may not expose it properly.

## What Already Exists (Backend)
- \`InventoryUnitConversion\` table with conversion rules per item
- \`convertToBaseUnit()\` helper function
- \`removeStock()\` accepts unit parameter
- Transaction stores both original unit and converted quantity

## Acceptance Criteria
- [ ] When removing stock, user can select from available units (not just primary unit)
- [ ] Unit conversion is displayed clearly: \"Removing 6 feet = 1 bar\"
- [ ] Available units populated from \`InventoryUnitConversion\` records for that item
- [ ] If no conversions configured, only primary unit is shown (no errors)
- [ ] Test with Shane's specific case: cold roll steel bar measured in feet

## Key Files
- \`utils/inventoryAccess.ts\` (removeStock, convertToBaseUnit)
- \`app/dashboard/[companyId]/inventory/[itemId]/page.tsx\`
- \`types/inventory.ts\`" \
  "frontend,client-feedback,P0: this week,effort: S,theme: ease of use,owner: claude-code" \
  "P0: This Week" "S" "Ease of Use" "Claude Code"

create_issue \
  "Inventory: Surface job selector in stock depletion form" \
  "## Problem
Shane wants to link inventory removals to specific jobs so he can track which job consumed stock. The backend already supports \`job_id\` on transactions, but the UI needs to expose a job picker in the depletion form.

## What Already Exists (Backend)
- \`inventory_transactions\` table has \`job_id\` and \`job_operation_id\` columns
- \`removeStock()\` in \`inventoryAccess.ts\` accepts \`jobId\` and \`jobOperationId\` params
- Full audit trail: operator, created_by, timestamps

## Acceptance Criteria
- [ ] Stock removal form includes optional \"Related Job\" dropdown
- [ ] Dropdown populated with active jobs for the company
- [ ] Selected job ID saved to transaction record via existing \`removeStock()\` params
- [ ] Job reference displayed in transaction history for the item
- [ ] Job is optional — stock can still be removed without linking to a job

## Key Files
- \`utils/inventoryAccess.ts\` (removeStock function signature)
- \`app/dashboard/[companyId]/inventory/[itemId]/page.tsx\`
- \`utils/jobsAccess.ts\` (to fetch active jobs for dropdown)" \
  "frontend,client-feedback,P0: this week,effort: S,theme: ease of use,owner: claude-code" \
  "P0: This Week" "S" "Ease of Use" "Claude Code"

create_issue \
  "Add root-level error boundary and 404 page" \
  "## Problem
Per-module error boundaries exist (parts, customers, jobs) but there's no root-level catch-all. If Shane or Johnny hits an unhandled error outside a module, they see a white screen or Next.js default error. Also no custom 404 for invalid routes.

## What Already Exists
- Per-module \`error.tsx\` files in parts, customers, jobs directories
- Basic pattern: Alert with error message + \"Try Again\" button

## Acceptance Criteria
- [ ] Root-level \`app/error.tsx\` catches all unhandled errors
- [ ] Branded error page with Jigged logo, \"Something went wrong\" message, \"Go back to Dashboard\" button
- [ ] \`app/not-found.tsx\` for invalid routes — branded, not Next.js default
- [ ] Error details logged to console (Sentry integration later)

## Key Files
- \`app/error.tsx\` (create)
- \`app/not-found.tsx\` (create)
- \`app/dashboard/[companyId]/parts/error.tsx\` (reference pattern)" \
  "frontend,hardening,P0: this week,effort: S,theme: trust & reliability,owner: claude-code" \
  "P0: This Week" "S" "Trust & Reliability" "Claude Code"

create_issue \
  "Landing page polish — credible for forwarded links" \
  "## Problem
Shane is showing jigged.app to others this week. If he texts the URL, the landing page is their first impression. It needs to look intentional and professional.

## What Already Exists
- Marketing layout at \`app/(marketing)/\`
- \`LandingPageContent\` component
- Metadata with title/description set
- Professional fonts (DM Sans + Space Mono)
- Open Graph metadata configured
- Domain: jigged.app

## Acceptance Criteria
- [ ] Verify landing page renders correctly (no broken images/layout)
- [ ] Link preview looks good in iMessage, Slack, LinkedIn (OG tags working)
- [ ] Clear CTA — \"Sign In\" for existing users
- [ ] Responsive on mobile (Shane's contacts will likely open on phone)
- [ ] Favicon is Jigged icon
- [ ] No placeholder or lorem ipsum text visible

## Key Files
- \`app/(marketing)/page.tsx\`
- \`components/marketing/LandingPageContent.tsx\`
- \`app/layout.tsx\` (metadata)" \
  "frontend,branding,P0: this week,effort: S,theme: first impressions,owner: claude-code" \
  "P0: This Week" "S" "First Impressions" "Claude Code"

# ============================================================
# P1: BEFORE 2-WEEK MEETING — Johnny formally evaluates
# Focus: Complete quoting workflow + reliability hardening
# ============================================================

create_issue \
  "Quotes: Add margin/markup fields to QuoteForm" \
  "## Problem
Shane discussed customizable margin settings during the meeting. Currently quotes only store unit_price and total_price with no margin/markup calculation. A salesperson needs to see and adjust margins.

## What Already Exists
- \`QuoteForm.tsx\` with customer, part, quantity, unit_price, total_price fields
- Volume pricing via \`PricingTier[]\` with auto-calculation (\`getUnitPrice()\`)
- Quote status workflow (Draft → Pending → Approved → Job)

## Acceptance Criteria
- [ ] Add margin percentage field to QuoteForm
- [ ] Add cost/base price field (from part's base cost or manual entry)
- [ ] Margin auto-calculates unit_price: \`cost * (1 + margin/100)\`
- [ ] User can edit either margin % or unit_price (they update each other)
- [ ] Margin displayed on quote detail/view page
- [ ] Database: add \`margin_percent\` and \`base_cost\` columns to quotes table (migration)

## Key Files
- \`components/quotes/QuoteForm.tsx\`
- \`utils/quotesAccess.ts\`
- \`types/quote.ts\`" \
  "frontend,backend,new-feature,client-feedback,P1: before salesperson,effort: M,theme: ease of use,owner: both" \
  "P1: Before Salesperson" "M" "Ease of Use" "Both"

create_issue \
  "Handle Supabase session expiry gracefully" \
  "## Problem
If a user's Supabase auth token expires while using the app, API calls silently fail. The user sees broken data or blank pages with no indication of what happened.

## Acceptance Criteria
- [ ] Detect 401/token expiry responses from Supabase calls
- [ ] Attempt silent token refresh first
- [ ] If refresh fails, redirect to login with flash message: \"Your session expired. Please sign in again.\"
- [ ] Preserve the URL they were on so they return to the same page after re-auth

## Key Files
- \`components/providers/AuthProvider.tsx\`
- \`lib/supabase.ts\`" \
  "frontend,auth,hardening,P1: before salesperson,effort: M,theme: trust & reliability,owner: claude-code" \
  "P1: Before Salesperson" "M" "Trust & Reliability" "Claude Code"

create_issue \
  "Fix visible console errors and smoke test all modules" \
  "## Problem
Open DevTools and click through every module. Any console errors, layout shifts, or broken states need to be caught before Johnny's evaluation.

## Acceptance Criteria
- [ ] Zero console errors on initial page load of every module
- [ ] Zero layout shifts or flash-of-unstyled-content
- [ ] All navigation links work (no dead links)
- [ ] Loading states display correctly (no infinite spinners)
- [ ] Smoke test: Create, edit, delete one record in each module
- [ ] Quote → Job conversion flow works end-to-end" \
  "frontend,hardening,P1: before salesperson,effort: S,theme: trust & reliability,owner: claude-code" \
  "P1: Before Salesperson" "S" "Trust & Reliability" "Claude Code"

create_issue \
  "Audit and verify RLS data isolation between companies" \
  "## Problem
Before any second company touches the app, verify Company A cannot see Company B's data — through the UI, direct Supabase queries, or URL/ID manipulation.

## What Already Exists
- RLS policies on all tables using \`get_user_company_ids()\` function
- Client-side \`*Access.ts\` layers consistently filter by \`company_id\`
- AI bypass role (\`ai_readonly\`) in migration 20260305000002 — needs scoping audit

## Acceptance Criteria
- [ ] Create a test company with test data in Supabase
- [ ] Log in as Shane's account and verify zero test company data appears anywhere
- [ ] Attempt to access test company records via URL manipulation (change companyId in URL)
- [ ] Verify RLS policies exist and are correct on ALL tables
- [ ] Audit the \`ai_readonly\` bypass role scope — ensure it cannot leak cross-company data
- [ ] Document any tables missing RLS policies" \
  "backend,security,hardening,P1: before salesperson,effort: M,theme: trust & reliability,owner: debola" \
  "P1: Before Salesperson" "M" "Trust & Reliability" "Debola"

create_issue \
  "Error tracking with Sentry" \
  "## Problem
Once other people are using the app, you need to know when things break without them telling you. Find out about errors before users report them.

## Acceptance Criteria
- [ ] Sentry free tier integrated (or equivalent: LogRocket, Bugsnag)
- [ ] Frontend errors captured with user context (company_id, user_id, page)
- [ ] Backend/API errors captured
- [ ] Source maps uploaded so stack traces are readable
- [ ] Alert configured for new errors (email or Slack)
- [ ] Error boundary (from error boundary issue) reports to Sentry" \
  "infrastructure,observability,P1: before salesperson,effort: M,theme: operational control,owner: claude-code" \
  "P1: Before Salesperson" "M" "Operational Control" "Claude Code"

create_issue \
  "Mobile / tablet responsive pass" \
  "## Problem
A salesperson in a manufacturing shop will likely pull up the app on a phone or tablet. The operator view is already mobile-optimized, but the admin dashboard has a fixed 240px sidebar and hardcoded \`ml: '240px'\` that breaks on small screens.

## What Already Exists (Mobile-Ready)
- Operator view at \`/operator/[companyId]/\` — mobile-first with BottomNavigation
- Touch targets enforced at 48px minimum via theme
- Dark theme optimized for shop floor

## What Needs Work (Desktop-Only)
- Dashboard layout: fixed sidebar, hardcoded margin-left
- No \`useMediaQuery\` hooks or responsive breakpoints
- AG Grid tables may overflow on small screens

## Acceptance Criteria
- [ ] Sidebar collapses to hamburger menu on mobile/tablet
- [ ] AG Grid tables scroll horizontally with key columns pinned
- [ ] All modal forms usable on mobile (no overflow, buttons reachable)
- [ ] Quote/Job detail pages readable on tablet
- [ ] Test at: 375px (phone), 768px (tablet), 1024px (small laptop)" \
  "frontend,ux,P1: before salesperson,effort: L,theme: ease of use,owner: claude-code" \
  "P1: Before Salesperson" "L" "Ease of Use" "Claude Code"

create_issue \
  "Performance check with realistic data volumes" \
  "## Problem
The app needs to feel snappy with Shane's actual data volumes. AG Grid uses batch fetching (1000 rows per batch) which works for small shops but should be verified.

## Acceptance Criteria
- [ ] Measure page load time for each module with Shane's current data volume
- [ ] Target: < 1.5s initial load, < 500ms for interactions (sort, filter, search)
- [ ] Identify and fix any N+1 queries (e.g., \`getCustomerWithRelations\` makes 3 separate queries)
- [ ] AG Grid pagination configured appropriately
- [ ] Parts module: verify JSONB pricing tiers don't slow down list/detail views" \
  "testing,hardening,P1: before salesperson,effort: M,theme: trust & reliability,owner: debola" \
  "P1: Before Salesperson" "M" "Trust & Reliability" "Debola"

create_issue \
  "Environment separation — dev, UAT, prod" \
  "## Problem
No safe place to test changes without risking the production app Shane is using. A broken deploy during Johnny's evaluation would be catastrophic.

## Acceptance Criteria
- [ ] Separate Supabase projects: dev (local/CI), staging/UAT, production
- [ ] Vercel environments configured: preview (per-PR), staging (staging branch), production (main branch)
- [ ] Environment variables isolated per environment
- [ ] Database migrations testable in staging before applying to prod
- [ ] Deploy process documented: merge to staging → test → merge to main → auto-deploy
- [ ] **Critical:** Freeze production deploys during salesperson visit unless emergency" \
  "infrastructure,devops,P1: before salesperson,effort: L,theme: multi-tenancy & growth,owner: both" \
  "P1: Before Salesperson" "L" "Multi-Tenancy & Growth" "Both"

# ============================================================
# P2: BEFORE USABILITY TESTS — Two new businesses evaluate
# Focus: Onboarding, legal, polish for external companies
# ============================================================

create_issue \
  "Company self-registration and onboarding flow" \
  "## Problem
Currently companies are manually created in Supabase. For usability tests with new businesses, they need to sign up and set up their own company — or at minimum a streamlined semi-automated process.

## What Already Exists
- Supabase Auth signup (email/password)
- Post-signup message: \"An administrator will grant you access\"
- \`getPostLoginRoute()\` for intelligent redirect based on company access
- No-access page for users with zero companies

## Acceptance Criteria
- [ ] New user signs up via Supabase Auth (email/password or magic link)
- [ ] Post-signup flow: \"Create your company\" form (company name, optional logo)
- [ ] Company record created in Supabase with RLS automatically scoped
- [ ] User assigned as admin role for their new company
- [ ] Redirect to dashboard with welcome/empty state
- [ ] Existing users can be invited to a company (invitation flow)
- [ ] **Stretch:** Guided setup wizard

**Fallback:** If full self-service is too heavy, build a \"Request Access\" form that emails you + a setup script that takes 2 minutes instead of 20." \
  "frontend,backend,new-feature,P2: before usability tests,effort: XL,theme: multi-tenancy & growth,owner: both" \
  "P2: Before Usability Tests" "XL" "Multi-Tenancy & Growth" "Both"

create_issue \
  "Empty states for remaining module pages" \
  "## Problem
When new businesses log in for usability testing, some pages will show empty AG Grid tables with no guidance.

## What Already Exists (Done)
- Customers page: icon + \"No customers yet\" + Add/Import CTAs ✅
- Parts page: icon + \"No parts yet\" + Add/Import CTAs ✅
- Jobs page: icon + \"No jobs found\" + contextual message ✅

## What Still Needs Empty States
- [ ] Quotes page: \"No quotes yet\" + \"Create your first quote\" CTA
- [ ] Operations/Resources page: \"No resources configured\" + \"Set up your shop resources\" CTA
- [ ] Inventory page: \"No inventory items\" + \"Add your first item\" CTA
- [ ] Dashboard: Welcome message + guided checklist (already has OnboardingCard — verify it works well)
- [ ] All CTAs route to the correct create/add flow" \
  "frontend,ux,P2: before usability tests,effort: M,theme: first impressions,owner: claude-code" \
  "P2: Before Usability Tests" "M" "First Impressions" "Claude Code"

create_issue \
  "In-app feedback mechanism" \
  "## Problem
During usability tests, you want structured feedback from within the app — not just what people remember to say verbally afterward.

## Acceptance Criteria
- [ ] Persistent \"Give Feedback\" button (floating or in sidebar footer)
- [ ] Simple form: What page are you on? (auto-detected), What's your feedback? (text), How urgent? (low/medium/high)
- [ ] Submissions go to a feedback table in Supabase or directly to email
- [ ] Optional: screenshot capture (nice-to-have)
- [ ] Confirmation message after submission" \
  "frontend,new-feature,P2: before usability tests,effort: S,theme: ease of use,owner: claude-code" \
  "P2: Before Usability Tests" "S" "Ease of Use" "Claude Code"

create_issue \
  "Terms of service and privacy policy" \
  "## Problem
Other businesses storing their data in your system need to see basic legal protections. Doesn't need to be lawyer-reviewed yet, but it needs to exist.

## Acceptance Criteria
- [ ] Terms of Service page at jigged.app/terms (or linked from footer)
- [ ] Privacy Policy page at jigged.app/privacy
- [ ] Covers: what data you collect, how it's stored (Supabase/Vercel), who can access it, data retention/deletion
- [ ] Link to both from signup flow and landing page footer
- [ ] Consider using a generator (Termly, iubenda) as a starting point" \
  "legal,compliance,P2: before usability tests,effort: M,theme: compliance & credibility,owner: debola" \
  "P2: Before Usability Tests" "M" "Compliance & Credibility" "Debola"

create_issue \
  "Demo mode / sample data for new companies" \
  "## Problem
New businesses in usability testing need sample data to explore. Starting from scratch is slow and painful.

## Acceptance Criteria
- [ ] New companies can toggle \"Load sample data\" during onboarding
- [ ] Sample data covers: 5-10 customers, 10-20 parts with pricing tiers, 3-5 quotes (various statuses), 2-3 jobs, resource groups + resources
- [ ] Sample data is realistic for a small precision manufacturing shop
- [ ] Demo banner visible when viewing sample data
- [ ] User can clear sample data when ready to use real data
- [ ] Sample data is per-company (RLS isolated)

**Lighter alternative:** Pre-built SQL script run after company creation that inserts realistic sample data scoped to that company_id." \
  "frontend,backend,new-feature,P2: before usability tests,effort: XL,theme: first impressions,owner: both" \
  "P2: Before Usability Tests" "XL" "First Impressions" "Both"

create_issue \
  "Role consolidation migration (7 → 3 roles)" \
  "## Problem
The live database still enforces the 7-role CHECK constraint (owner, admin, operator, bookkeeper, engineer, quality, sales) but the app was designed around 3 roles (admin, user, operator). New companies signing up will hit this mismatch.

## Acceptance Criteria
- [ ] ALTER TABLE migration to update CHECK constraint to 3 roles
- [ ] Migrate existing user_company_access records to new role values
- [ ] Mapping: owner → admin, admin → admin, operator → operator, bookkeeper/engineer/quality/sales → user
- [ ] Update all frontend role checks to use new role values
- [ ] Update RLS policies if they reference specific role values
- [ ] Test in staging before applying to production" \
  "backend,database,tech-debt,P2: before usability tests,effort: L,theme: multi-tenancy & growth,owner: both" \
  "P2: Before Usability Tests" "L" "Multi-Tenancy & Growth" "Both"

create_issue \
  "Invitation system for company team members" \
  "## Problem
For usability testing, new businesses will want to invite their team members (salesperson, operator). There needs to be a way to invite users to a company.

## Acceptance Criteria
- [ ] Admin can invite users by email from a \"Team\" or \"Settings\" page
- [ ] Invited user receives email with signup/join link
- [ ] New user signs up and is automatically associated with the inviting company
- [ ] Admin can assign role (admin, user, operator) during invitation
- [ ] Admin can see pending invitations and revoke them
- [ ] Admin can remove users from the company" \
  "frontend,backend,new-feature,P2: before usability tests,effort: L,theme: multi-tenancy & growth,owner: both" \
  "P2: Before Usability Tests" "L" "Multi-Tenancy & Growth" "Both"

create_issue \
  "Branding consistency pass" \
  "## Problem
Ensure the finalized branding (Jigged logo, DM Sans font, Space Mono for data, color palette) is consistently applied across the entire app — not just the landing page.

## Acceptance Criteria
- [ ] Logo appears correctly in sidebar, landing page, login page, and error pages
- [ ] DM Sans used consistently for UI text; Space Mono for data/tables/code contexts
- [ ] Color palette matches brand guidelines (Warm Amber #D4872A, Steel Blue #4682B4, Teal #2BBCB3)
- [ ] Favicon is Jigged \"J\" icon
- [ ] Loading spinners/skeletons use brand colors (not default MUI blue)
- [ ] Email templates (Supabase auth emails) show Jigged branding" \
  "frontend,branding,P2: before usability tests,effort: M,theme: first impressions,owner: claude-code" \
  "P2: Before Usability Tests" "M" "First Impressions" "Claude Code"

create_issue \
  "Basic analytics / usage tracking" \
  "## Problem
During usability tests, you want quantitative data on which pages people visit, where they spend time, and where they drop off.

## Acceptance Criteria
- [ ] Lightweight analytics integrated (Plausible, PostHog free tier, or Vercel Analytics)
- [ ] Track: page views, unique users, session duration, navigation paths
- [ ] Privacy-friendly (no cookie banner needed if using Plausible)
- [ ] Dashboard where you can review usage patterns
- [ ] Do NOT track keystrokes, form contents, or PII" \
  "infrastructure,observability,P2: before usability tests,effort: M,theme: operational control,owner: claude-code" \
  "P2: Before Usability Tests" "M" "Operational Control" "Claude Code"

create_issue \
  "Mobile operator workflow refinements" \
  "## Problem
Shane tested the mobile operator workflow during the meeting. The operator view is built and functional at \`/operator/[companyId]/\` with mobile-first layout, bottom nav, and job tracking. Needs polish based on Shane's hands-on feedback, not a rebuild.

## What Already Exists
- Operator view at \`/app/operator/[companyId]/\` with AppBar + BottomNavigation
- Touch-friendly 48px+ targets enforced
- Jobs list and profile views
- Station selector

## Acceptance Criteria
- [ ] Collect specific feedback from Shane on operator workflow
- [ ] Address any navigation confusion or missing actions
- [ ] Ensure job status updates work smoothly on mobile
- [ ] Verify operation time tracking works
- [ ] Test on actual mobile device (not just browser resize)" \
  "frontend,ux,client-feedback,P2: before usability tests,effort: M,theme: ease of use,owner: both" \
  "P2: Before Usability Tests" "M" "Ease of Use" "Both"

# ============================================================
# P3: POST-LAUNCH — After usability tests validate core
# ============================================================

create_issue \
  "AI rate limiting enhancements" \
  "## Context
Base rate limiting is already implemented: 20 queries/hour per company, tracked in \`ai_chat_queries\` table, 429 responses, 5-saved-insight limit. These enhancements add visibility and control.

## Acceptance Criteria
- [ ] Per-user rate limit in addition to per-company (e.g., 10 requests per minute)
- [ ] Warning when approaching limit: \"You have 3 queries left this hour\"
- [ ] Admin dashboard to view AI usage per company
- [ ] Configurable limits per company (some may need higher limits)
- [ ] Retry-after header in 429 response" \
  "backend,ai,P3: post-launch,effort: M,theme: operational control,owner: both" \
  "P3: Post-Launch" "M" "Operational Control" "Both"

create_issue \
  "Automated database backup and recovery plan" \
  "## Problem
Once real customer data is in the system, data loss is existential. Need to verify Supabase backups are active and test a restore.

## Acceptance Criteria
- [ ] Verify Supabase daily backups are active (paid plan feature)
- [ ] Document backup frequency and retention period
- [ ] Test a full database restore to a new Supabase project
- [ ] Document the restore procedure
- [ ] Consider point-in-time recovery (PITR) if on Pro plan" \
  "infrastructure,devops,P3: post-launch,effort: M,theme: trust & reliability,owner: debola" \
  "P3: Post-Launch" "M" "Trust & Reliability" "Debola"

create_issue \
  "CSV import refinement across all modules" \
  "## Context
Post-usability-test feedback will likely surface import UX issues. Batch this work after real feedback from multiple shops trying to import their data.

## Potential Areas
- Better error messages for malformed CSVs
- Column mapping UI improvements
- Preview/undo for bulk imports
- Progress indicator for large files
- Template CSV downloads per module" \
  "frontend,backend,P3: post-launch,effort: L,theme: ease of use,owner: both" \
  "P3: Post-Launch" "L" "Ease of Use" "Both"

create_issue \
  "Comprehensive E2E test suite" \
  "## Problem
Unit/integration tests exist for customers module only. Need full coverage across all modules and E2E tests for the core workflow.

## Acceptance Criteria
- [ ] Playwright or Cypress E2E test framework set up
- [ ] E2E test: Full Quote → Job → Complete workflow
- [ ] E2E test: User signup → company creation → first customer
- [ ] E2E test: CSV import flow
- [ ] Unit/integration tests extended to Parts, Quotes, Jobs, Resources modules
- [ ] CI/CD runs E2E tests on PR preview deployments" \
  "testing,infrastructure,P3: post-launch,effort: XL,theme: trust & reliability,owner: both" \
  "P3: Post-Launch" "XL" "Trust & Reliability" "Both"

create_issue \
  "Custom domain email (noreply@jigged.app)" \
  "## Problem
Supabase auth emails currently come from a Supabase domain. Auth emails should come from noreply@jigged.app for brand credibility.

## Acceptance Criteria
- [ ] Configure custom SMTP in Supabase Auth settings
- [ ] Use Google Workspace SMTP (jigged.app is already a secondary domain)
- [ ] Auth emails (signup, password reset, magic link) show Jigged branding
- [ ] From address: noreply@jigged.app
- [ ] Test all auth email flows" \
  "infrastructure,P3: post-launch,effort: S,theme: compliance & credibility,owner: debola" \
  "P3: Post-Launch" "S" "Compliance & Credibility" "Debola"

# ------------------------------------------------------------------
# DONE
# ------------------------------------------------------------------
echo ""
echo "=========================================="
echo "  DONE! 29 issues created and added to"
echo "  Project #$PROJECT_NUMBER"
echo "=========================================="
echo ""
echo "Changes from v1:"
echo "  - REMOVED: Dashboard AI Insights (already built)"
echo "  - REMOVED: Operator View (already built)"
echo "  - REMOVED: AI Rate Limiting (already implemented)"
echo "  - REMOVED: Vague 'Module refinements' catch-all"
echo "  - ADDED: 6 specific Shane feedback issues (P0/P1)"
echo "  - ADDED: Operator workflow refinements (P2, not P3)"
echo "  - ADDED: AI rate limiting enhancements (P3, scoped to gaps)"
echo "  - RE-PRIORITIZED: Product features → P0, infrastructure → P1"
echo ""
echo "Next steps:"
echo "  1. Go to https://github.com/users/debola31/projects/$PROJECT_NUMBER"
echo "  2. Add a 'Group by: Phase' view for execution"
echo "  3. Start with P0 issues — Johnny is using the app NOW"
echo ""
