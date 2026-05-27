#!/bin/bash
# =============================================================
# Create GitHub Issues: "Improve Credibility & Delight Through Design"
# =============================================================
# Usage: GITHUB_TOKEN=ghp_xxx bash scripts/create-design-issues.sh
# =============================================================

REPO="debola31/Jigged"
TOKEN="${GITHUB_TOKEN}"
API="https://api.github.com/repos/${REPO}"

if [ -z "$TOKEN" ]; then
  echo "❌ Set GITHUB_TOKEN env var first: export GITHUB_TOKEN=ghp_..."
  exit 1
fi

HEADERS=(-H "Authorization: token ${TOKEN}" -H "Accept: application/vnd.github+json" -H "Content-Type: application/json")

# ---------------------------
# Step 1: Create Labels
# ---------------------------
echo "🏷️  Creating labels..."

create_label() {
  local name="$1" color="$2" desc="$3"
  curl -s -X POST "${API}/labels" "${HEADERS[@]}" \
    -d "{\"name\":\"${name}\",\"color\":\"${color}\",\"description\":\"${desc}\"}" > /dev/null
  echo "   ✅ Label: ${name}"
}

create_label "theme: design & credibility" "6F3FF5" "Improve credibility and delight through design"
create_label "landing page" "0E8A16" "Landing page related tasks"
create_label "branding" "FBCA04" "Logo, brand identity, visual assets"
create_label "coming soon" "D93F0B" "Pre-launch coming soon page"
create_label "infrastructure" "C5DEF5" "DNS, deployment, config"
create_label "polish" "BFD4F2" "Responsive design, SEO, final QA"
create_label "high impact" "B60205" "High expected impact"
create_label "medium effort" "FEF2C0" "Medium estimated effort"

echo ""
echo "📝 Creating issues..."
echo ""

# ---------------------------
# Step 2: Create Issues
# ---------------------------
create_issue() {
  local title="$1" body="$2" labels="$3"
  
  # Escape the body for JSON
  local escaped_body
  escaped_body=$(echo "$body" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))")
  
  local payload="{\"title\":\"${title}\",\"body\":${escaped_body},\"labels\":[${labels}]}"
  
  local response
  response=$(curl -s -X POST "${API}/issues" "${HEADERS[@]}" -d "$payload")
  
  local number
  number=$(echo "$response" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('number','ERROR'))" 2>/dev/null)
  echo "   ✅ #${number} — ${title}"
}

# ----- ISSUE 1: Logo -----
create_issue \
  "Design Jigged logo (icon + wordmark)" \
  "## Context
Jigged needs a professional logo that communicates modern manufacturing software. The brand targets small precision manufacturing shop owners (often 50-60 year old), so the aesthetic should be **professional and industrial, not trendy or playful**.

## Brand Reference
From \`docs/design-system.md\`:
- **Primary color:** Steel Blue \`#4682B4\`
- **Foundation color:** Deep Indigo \`#111439\`
- **Aesthetic:** Industrial, precision manufacturing — \"like a precision-machined surface under focused lighting\"
- **Tone:** Substantial, not playful. Professional, not trendy.

## Deliverables
- [ ] Primary logo: Icon + \"Jigged\" wordmark
- [ ] Icon-only variant (for favicon, app icon, social profiles)
- [ ] Light variant (for dark backgrounds — primary use case given our dark gradient theme)
- [ ] Dark variant (for light backgrounds — external use: emails, docs, white pages)
- [ ] SVG source files in \`/public/\` directory
- [ ] Favicon in multiple sizes (16x16, 32x32, 180x180 apple-touch-icon)
- [ ] Replace current Next.js default \`app/favicon.ico\`

## Design Direction
- Should evoke precision, manufacturing, reliability
- Consider: geometric forms, machined edges, tooling references
- Must be legible at small sizes (favicon, mobile tab)
- Must work on the dark gradient background (\`linear-gradient(135deg, #111439 0%, #4682B4 50%, #111439 100%)\`)

## Acceptance Criteria
- [ ] Logo renders crisply at all sizes from 16px to full width
- [ ] Looks professional on both the dark gradient and white backgrounds
- [ ] Favicon updated and visible in browser tabs
- [ ] SVGs are optimized and accessible in \`/public/\`" \
  '"theme: design & credibility","branding","high impact","medium effort"'

# ----- ISSUE 2: Brand Style Guide -----
create_issue \
  "Create minimal brand style guide" \
  "## Context
We have a detailed design system in \`docs/design-system.md\` covering the MUI theme, but we need a lightweight **brand-facing** style guide that covers logo usage, voice, and identity — enough to keep the landing page, coming soon page, and any marketing materials consistent.

## Reference
Pull from the existing \`docs/design-system.md\` and \`lib/theme.ts\` for color values and design principles.

## Deliverables
Create \`docs/brand-guide.md\` covering:

- [ ] Logo usage rules (minimum size, clear space, backgrounds)
- [ ] Primary color palette with hex values (Steel Blue \`#4682B4\`, Deep Indigo \`#111439\`, Light Blue \`#6FA3D8\`, Neutral Gray \`#B0B3B8\`)
- [ ] Typography choices for marketing pages (can differ from app — app uses system font stack)
- [ ] Brand voice & tone guidelines (professional, clear, no jargon, speaks to shop owners)
- [ ] Do's and don'ts for brand presentation
- [ ] Gradient specification for marketing use

## Acceptance Criteria
- [ ] \`docs/brand-guide.md\` is committed to repo
- [ ] Consistent with existing design system values
- [ ] Provides enough guidance for landing page and coming soon page development" \
  '"theme: design & credibility","branding"'

# ----- ISSUE 3: Domain Setup -----
create_issue \
  "Configure jigged.app domain on Vercel" \
  "## Context
The app is currently deployed at \`jigged-ai.vercel.app\`. We own \`jigged.app\` and need to point it to the Vercel deployment with proper DNS and SSL.

## Tasks
- [ ] Add \`jigged.app\` as a custom domain in Vercel project settings
- [ ] Configure DNS records at registrar (A record / CNAME per Vercel docs)
- [ ] Verify SSL certificate is provisioned and working
- [ ] Set up \`www.jigged.app\` redirect to \`jigged.app\` (or vice versa)
- [ ] Verify deployment works at \`https://jigged.app\`

## Acceptance Criteria
- [ ] \`https://jigged.app\` loads the application
- [ ] SSL certificate is valid (green padlock)
- [ ] \`www\` subdomain redirects properly
- [ ] Old \`jigged-ai.vercel.app\` URL still works (Vercel handles this)" \
  '"theme: design & credibility","infrastructure","high impact"'

# ----- ISSUE 4: Landing Page Wireframe -----
create_issue \
  "Design landing page wireframe and layout" \
  "## Context
Currently \`app/page.tsx\` is just an auth redirect with a spinner — there's no public-facing landing page. We need a proper marketing page that communicates Jigged's value proposition to small manufacturing shop owners.

## Target Audience
- Small precision manufacturing shop owners (50-60 year olds)
- Currently using legacy ERP systems (Tangle, E2 JobBoss)
- Pain points: inflexible inventory, no shop-floor visibility, operator compliance gaps

## Proposed Page Structure
1. **Hero Section** — Headline, subheadline, primary CTA, hero visual
2. **Problem Section** — What's broken with legacy ERPs (2-3 pain points)
3. **Solution / Features** — How Jigged solves each pain point (3-4 cards)
4. **Social Proof** — Testimonial placeholder, \"trusted by\" section
5. **CTA Section** — Final call to action (email signup or demo request)
6. **Footer** — Navigation links, contact, legal

## Design Constraints
- Must use the Jigged gradient background (\`linear-gradient(135deg, #111439 0%, #4682B4 50%, #111439 100%)\`)
- Glassmorphism cards per design system
- Professional, industrial aesthetic — not SaaS-trendy
- Mobile-first responsive

## Deliverables
- [ ] Wireframe (can be a rough sketch, Figma, or annotated mockup)
- [ ] Content outline with headline/subheadline copy drafts
- [ ] Defined sections and component breakdown

## Acceptance Criteria
- [ ] Wireframe approved before development begins
- [ ] Covers all sections listed above
- [ ] Responsive layout considered (mobile + desktop)" \
  '"theme: design & credibility","landing page","high impact","medium effort"'

# ----- ISSUE 5: Hero Section -----
create_issue \
  "Build landing page hero section" \
  "## Context
The hero is the first thing visitors see. It needs to immediately communicate what Jigged does and who it's for.

## Dependencies
- #_WIREFRAME_ (wireframe issue should be completed first)
- Logo should be available

## Implementation
Create a new public landing page route (e.g., \`app/(marketing)/page.tsx\` or similar) separate from the authenticated app. The current \`app/page.tsx\` auth redirect should remain for logged-in users.

## Content Direction
- **Headline:** Something direct about modern shop management (e.g., \"Your shop floor, finally visible.\")
- **Subheadline:** 1-2 sentences expanding on the value prop — reduce admin burden, real-time visibility, operator compliance
- **Primary CTA:** \"Get Early Access\" or \"Join the Waitlist\" (links to email capture)
- **Hero Visual:** Product screenshot, illustration, or abstract visual reinforcing manufacturing/precision

## Technical Notes
- Use MUI components per design system
- Jigged gradient background with \`background-attachment: fixed\`
- Glassmorphism styling where appropriate
- Must be fully responsive (mobile, tablet, desktop)
- Consider performance: optimize any images, lazy load below-fold content

## Acceptance Criteria
- [ ] Hero section renders on \`jigged.app\` for unauthenticated visitors
- [ ] Headline, subheadline, and CTA are present
- [ ] Matches brand aesthetic (dark gradient, Steel Blue accents, professional tone)
- [ ] Responsive across breakpoints
- [ ] CTA button is functional (even if target page is placeholder)" \
  '"theme: design & credibility","landing page","high impact","medium effort"'

# ----- ISSUE 6: Features Section -----
create_issue \
  "Build landing page features/benefits section" \
  "## Context
Below the hero, we need to clearly articulate the 3-4 key value propositions that differentiate Jigged from legacy ERPs.

## Suggested Features to Highlight
From the PRD goals and problem statement:

1. **Flexible Inventory Management** — Track materials in granular and bulk measurements. Know when to reorder before stockouts.
2. **Real-Time Shop Floor Visibility** — See which jobs are generating revenue, where bottlenecks exist, and how jobs are progressing.
3. **Operator Engagement** — Gamified experiences (metrics, streaks, achievements) drive consistent data capture and process compliance.
4. **AI-Powered Insights** — Surface bottlenecks and recommend actions to preserve operational efficiency.

## Design Direction
- Use glassmorphism cards from the design system
- Icon or illustration per feature
- Short headline + 1-2 sentence description per feature
- Grid layout: 2x2 on desktop, stacked on mobile

## Acceptance Criteria
- [ ] 3-4 feature cards rendered with icons, headlines, and descriptions
- [ ] Uses glassmorphism card styling per \`docs/design-system.md\`
- [ ] Content is clear and speaks to shop owner pain points (not developer jargon)
- [ ] Responsive grid layout" \
  '"theme: design & credibility","landing page","medium effort"'

# ----- ISSUE 7: Social Proof Section -----
create_issue \
  "Build landing page social proof section" \
  "## Context
Credibility is critical for manufacturing shop owners evaluating new software. We need a social proof section even if content is placeholder initially.

## Options (implement what's available)
- [ ] Testimonial quote from a pilot customer (get permission first)
- [ ] \"Designed with input from real manufacturing shops\" messaging
- [ ] Key stats: \"10+ hours saved per week\" or similar from PRD goals
- [ ] Placeholder for future client logos

## Design Direction
- Subtle styling — don't oversell with limited proof
- Can use a highlighted quote block or card
- Consider a \"Designed for shops like yours\" angle rather than fake social proof

## Acceptance Criteria
- [ ] Section exists on the landing page
- [ ] Content feels authentic and credible (no fake testimonials)
- [ ] Responsive layout" \
  '"theme: design & credibility","landing page"'

# ----- ISSUE 8: Footer -----
create_issue \
  "Build landing page footer" \
  "## Context
Professional footer with navigation, contact info, and legal links. Shared across landing page and coming soon page.

## Content
- [ ] Jigged logo (small)
- [ ] Navigation links: Home, Features, Contact (or similar)
- [ ] Contact email
- [ ] Legal links: Privacy Policy, Terms of Service (can be placeholder pages)
- [ ] Copyright notice: \"© 2026 Jigged. All rights reserved.\"
- [ ] Optional: Social media links (if applicable)

## Technical Notes
- Create as a reusable component (e.g., \`components/marketing/Footer.tsx\`)
- Dark background variant that complements the gradient
- Keep it simple and clean

## Acceptance Criteria
- [ ] Footer renders on landing page and coming soon page
- [ ] All links are functional (placeholder pages are fine for legal links)
- [ ] Responsive layout
- [ ] Reusable component" \
  '"theme: design & credibility","landing page","coming soon"'

# ----- ISSUE 9: Coming Soon Page -----
create_issue \
  "Build coming soon page with email capture" \
  "## Context
We need a standalone \"coming soon\" page that can be used to collect early interest from the 7 target early users and beyond. This could serve as the initial state of \`jigged.app\` before the full landing page is ready.

## Content
- [ ] Jigged logo (prominently displayed)
- [ ] Tagline: Brief, compelling line about what's coming
- [ ] Email capture form: Name + email input with submit button
- [ ] Expected timeline or \"Launching soon\" messaging
- [ ] Brief description of what Jigged does (1-2 sentences)
- [ ] Optional: Social links or \"Follow for updates\"

## Design Direction
- Centered, single-focus layout
- Jigged gradient background
- Glassmorphism card for the signup form
- Clean, confident, professional — this is the first impression for potential users
- Consider subtle animation (e.g., gradient shift, fade-in) but keep it tasteful per design principles (\"professional, not trendy\")

## Technical Notes
- Route: \`app/(marketing)/coming-soon/page.tsx\` or similar
- Email form submission — see issue for email capture integration
- Must work standalone (can be deployed before full landing page)

## Acceptance Criteria
- [ ] Page loads at \`/coming-soon\` route
- [ ] Logo and tagline are prominently displayed
- [ ] Email form submits successfully
- [ ] Responsive across all breakpoints
- [ ] Looks polished and professional" \
  '"theme: design & credibility","coming soon","high impact","medium effort"'

# ----- ISSUE 10: Email Capture Integration -----
create_issue \
  "Set up email capture integration for coming soon page" \
  "## Context
The coming soon page needs a working email capture form. Collected emails will be the start of our early user list (targeting ~7 initial users for feedback, with room to grow).

## Options (pick one)
1. **Supabase table** (simplest — we already use Supabase)
   - Create a \`waitlist\` table: \`id\`, \`email\`, \`name\`, \`created_at\`, \`source\`
   - API endpoint via existing FastAPI backend
   - Pros: No new services, full data ownership
   - Cons: No built-in email marketing features

2. **Loops / Resend / Mailchimp**
   - Third-party email marketing tool
   - Pros: Built-in welcome emails, drip campaigns later
   - Cons: Another service to manage

## Recommended: Supabase table (start simple)
We can always export to a marketing tool later.

## Tasks
- [ ] Create \`waitlist\` table in Supabase (migration file)
- [ ] Create FastAPI endpoint: \`POST /api/waitlist\` (email, name)
- [ ] Add duplicate email handling (don't error, just acknowledge)
- [ ] Add basic validation (valid email format)
- [ ] Connect coming soon form to the endpoint
- [ ] Add success/error states to the form UI
- [ ] Optional: Send a simple confirmation email via Supabase Edge Function or Resend

## Acceptance Criteria
- [ ] Email submissions are stored in Supabase
- [ ] Duplicate emails are handled gracefully
- [ ] Form shows success state after submission
- [ ] Form shows error state on failure
- [ ] Data is queryable for follow-up outreach" \
  '"theme: design & credibility","coming soon","infrastructure"'

# ----- ISSUE 11: Responsive Pass -----
create_issue \
  "Responsive design QA pass on landing page and coming soon page" \
  "## Context
Manufacturing shop owners may view the landing page on desktop, tablet, or phone. Both pages need to look polished across all devices.

## Test Breakpoints
- Mobile: 375px (iPhone SE), 390px (iPhone 14)
- Tablet: 768px (iPad)
- Desktop: 1280px, 1440px, 1920px

## Checklist
- [ ] Hero section: text is readable, CTA is tappable, no overflow
- [ ] Features section: cards stack properly on mobile
- [ ] Social proof section: responsive layout
- [ ] Footer: stacks cleanly on mobile
- [ ] Coming soon page: centered and usable on all sizes
- [ ] Email form: inputs are properly sized for mobile (min 48px touch targets per design system)
- [ ] Gradient background: no visual artifacts on any viewport
- [ ] Images/illustrations: properly sized and don't break layout
- [ ] Typography: readable at all breakpoints (min 16px body text per design system)

## Acceptance Criteria
- [ ] No horizontal scroll on any breakpoint
- [ ] All interactive elements meet 48px minimum touch target
- [ ] Text remains readable without zooming on mobile
- [ ] Pages tested on Chrome, Safari, Firefox" \
  '"theme: design & credibility","polish","landing page","coming soon"'

# ----- ISSUE 12: Meta Tags & SEO -----
create_issue \
  "Add meta tags, OG image, and favicon to marketing pages" \
  "## Context
When someone shares a link to \`jigged.app\` on LinkedIn, Slack, or iMessage, it should show a professional preview — not a blank card or default Next.js branding.

## Tasks
- [ ] Add \`<title>\` and \`<meta name=\"description\">\` to marketing pages
- [ ] Create Open Graph image (1200x630px) with Jigged logo and tagline
- [ ] Add OG meta tags: \`og:title\`, \`og:description\`, \`og:image\`, \`og:url\`
- [ ] Add Twitter card meta tags: \`twitter:card\`, \`twitter:title\`, \`twitter:description\`, \`twitter:image\`
- [ ] Update \`app/layout.tsx\` or use Next.js metadata API
- [ ] Update favicon to new Jigged logo (replaces current Next.js default)
- [ ] Add \`apple-touch-icon\` and \`manifest.json\` for PWA-readiness

## Suggested Meta Content
- **Title:** \"Jigged — Modern Shop Floor Management\"
- **Description:** \"The operations system built for small manufacturing shops. Track jobs, manage inventory, and empower your operators.\"

## Acceptance Criteria
- [ ] Sharing \`jigged.app\` on Slack/LinkedIn/iMessage shows branded preview
- [ ] Favicon shows Jigged logo in browser tab
- [ ] \`lighthouse\` SEO audit passes with 90+ score on marketing pages" \
  '"theme: design & credibility","polish","landing page","high impact"'

echo ""
echo "============================================="
echo "✅ All issues created! Check your repo:"
echo "   https://github.com/debola31/Jigged/issues"
echo "============================================="
