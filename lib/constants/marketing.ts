// Marketing copy + data. Kept out of the section components so both landing-page
// design variants stay purely presentational and share one source of truth for words.

export const SHOP_SIZES = [
  '1–5 people',
  '6–15 people',
  '16–50 people',
  '50+ people',
];

export const MARKETING_META = {
  // Mirrors the hero headline — keep the two in step.
  title: 'Jigged — Your whole shop, in one place',
  // KEEP THIS UNDER ~155 CHARS. Google truncates the snippet around there (it's really
  // a ~920px budget), and the previous 220-char version was cut at "...take at the
  // machine" — so its whole payoff ("no tribal knowledge walking out the door") was
  // invisible in search results. Front-load the offer; the segment is folded into it so
  // "precision machine shop" still matches what an owner searches.
  description:
    'Run your machine shop in one place — quote to invoice and everything between. Tricks your best guys figured out are there next time someone needs them.',
};

export const HERO = {
  // Category + segment (the frame of reference). "Paperless operations" claimed the wrong
  // category — that's the operator-view pitch, and it already lives in the subhead. Pick
  // the frame deliberately: left unstated, a shop owner files us under "another ERP",
  // which is the worst shelf given our own pain line about 500-person plants. Segment
  // stays "precision machine shops" (who someone IS) rather than "precision
  // manufacturing" (an industry abstraction) — narrow beachhead, and it matches the
  // capability strip + footer.
  eyebrow: 'Shop software for precision machine shops',
  // Two display lines. The headline states WHAT WE OFFER (StoryBrand's grunt test);
  // the subhead below carries HOW IT MAKES LIFE BETTER — which is where the
  // know-how/capture story belongs, both by the framework and because leading with
  // "we capture your operations" reads as taking the thing a shop holds dear.
  // "Your shop floor, finally under control" stated a feeling, not an offer; it also
  // positioned against disorder rather than against the real alternative (an ERP + a
  // stack of spreadsheets + homegrown tools), and undersold a product that now runs
  // quote → floor → shipping → invoicing.
  headlineLead: 'Your whole shop,',
  headlineEmphasis: 'in one place.',
  // Unpacks the headline rather than repeating it: "whole shop" is abstract, so this says
  // what it actually spans, then delivers the two benefits (grunt test: subhead = how it
  // makes life better). Opened "Go paperless" before — the narrow pitch we cut from the
  // eyebrow, and paperless is a mechanism anyway (the shop-floor section sells it).
  // "Jigged shows you" made Jigged the actor; the customer is the hero. "Captures the
  // notes your operators take" → "stay with the part": same fact, the shop's side of the
  // table. "Next time someone needs it" (not "you run the part") is availability, not just
  // the owner's own recall.
  subhead:
    'Quoting to invoicing and everything in between. See where every job stands without walking the floor — and the notes and photos your operators take at the machine stay with the part, so the fix your best guy figured out is there next time someone needs it.',
  primaryCta: { label: 'Request access', href: '/invite/early-access' },
  secondaryCta: { label: 'See how it works', href: '#how-it-works' },
};

export const CAPABILITY_STRIP = {
  label: 'Built with precision machine shops running 5 to 50 people',
  tags: ['CNC milling', 'Turning', 'Deburring', 'Anodizing', 'Inspection'],
};

export const PAIN = {
  eyebrow: 'The daily reality',
  heading: 'Sound familiar?',
  points: [
    'Your best setups live in one machinist’s head — and walk out the door the day he retires.',
    'An ERP, a stack of spreadsheets, a few homegrown tools — a different one for every step, and none of them talk.',
    'Your systems log the numbers, but how the parts sit in the fixture and the finesse in the setup never get written down.',
    'Software built for a 500-person plant expects a planner and a full-time admin. You’ve got a shop to run.',
  ],
  closer:
    'Owners run the whole shop across an ERP, spreadsheets, and homegrown tools nobody else could use. We’re building Jigged to do it all in one place — everything they need, nothing they don’t.',
};

export type Feature = {
  key: string;
  headline: string;
  description: string;
  image: string | string[];
  alt: string;
};

// Three desktop tools in flow order: job status leads, then quoting, then the
// QuickBooks invoicing integration (replaced the inventory row — inventory isn't
// demo-ready yet). The operator/mobile story is its own section (ShopFloorShowcase).
export const FEATURES: Feature[] = [
  {
    key: 'jobs',
    headline: 'Know where every job stands',
    description:
      'Track jobs from quote to done. See what’s running, what’s waiting, and what’s late — without walking the floor or calling the lead.',
    image: '/screenshots/feature-job-status.png',
    alt: 'Jigged job list showing production and fulfillment status for each job',
  },
  {
    key: 'quotes',
    // "Set markups by part category" described the markup-rates module, which was removed
    // (#569 — each part now owns its own pricing). Copy follows the product.
    headline: 'Quote faster, win more work',
    description:
      'Build cost-plus quotes in minutes. Every part carries its own pricing, so the math comes out the same every time.',
    image: '/screenshots/feature-quotes.png',
    alt: 'A Jigged quote — line items, unit prices and total, ready to convert to a job',
  },
  {
    key: 'invoicing',
    headline: 'Invoicing, wired straight to QuickBooks',
    description:
      'Jigged is directly integrated with QuickBooks. Bill the quantities that shipped and Jigged creates the invoice in QuickBooks for you — no re-keying, no double entry. Your books stay the system of record.',
    image: '/screenshots/feature-invoicing-quickbooks.png',
    alt: 'Creating a QuickBooks invoice from a Jigged job — billing shipped quantities, synced to QuickBooks',
  },
];

// The operator/shop-floor experience gets its own two-phone showcase (ShopFloorShowcase)
// rather than a row in FEATURES, so it can carry bullet points and two device shots.
// Kept paperless-experience-focused; the notes/photos knowledge angle is KnowledgeCapture.
export const SHOP_FLOOR = {
  eyebrow: 'On the shop floor',
  heading: 'Built for the person at the machine',
  subhead:
    'Operators work from a tablet at their station — no paper travelers, no hunting for the latest revision.',
  points: [
    'Operators sign in, pick their station, and see only the jobs waiting on them.',
    'The current drawing and work instructions, right there at the machine.',
    'One tap to mark a step complete — no timers, no training.',
    'Runs on any tablet or phone. Nothing to install.',
  ],
  images: [
    '/screenshots/feature-operator-queue.png',
    '/screenshots/feature-operator-step.png',
  ],
  alt: 'The Jigged operator view on a phone — the station job queue and a job step with one-tap mark complete',
};

export const KNOWLEDGE = {
  eyebrow: 'Knowledge capture',
  heading: 'Keep the knowledge that usually walks out the door.',
  body: 'Your best machinist knows the trick that saves an hour on that fixture. Right now it lives in his head. In Jigged, operators leave notes and snap photos right on the job — the setup, the workaround, the thing that went wrong last time. It stays with the part, so the next person runs it right.',
  micro:
    'No incumbent ERP does this. It’s the difference between software that tracks work and software that remembers it.',
  image: '/screenshots/feature-knowledge-note.png',
  alt: 'An operator note with a photo attached to a job in Jigged',
};

export type Step = { number: string; headline: string; description: string };

// A real sequence — quote → track → ship and invoice — so the 01/02/03 numbering
// encodes something true. (03 used to be "Run your shop, not your software," which
// was a benefit, not a step, and said the same thing as the closing CTA right below
// it. The no-rollout objection it carried now sits in 01, next to "15 minutes.")
export const STEPS: Step[] = [
  {
    number: '01',
    headline: 'Set up your shop',
    description:
      'Add your team, part categories, and markup defaults. About 15 minutes — no consultants, no six-month rollout.',
  },
  {
    number: '02',
    headline: 'Quote and track',
    description:
      'Create quotes, turn them into jobs, and follow every step from one place.',
  },
  {
    number: '03',
    headline: 'Ship and get paid',
    description:
      'Log what goes out the door, then push the invoice straight to QuickBooks. No re-keying.',
  },
];

// The founding-shops beat lives here, folded into the single closing CTA — a separate
// "early access" band above it just repeated the same message before the same button.
export const FINAL_CTA = {
  heading: 'Ready to stop fighting your software?',
  subhead:
    'We’re taking on a small group of precision shops as founding partners — they shape where Jigged goes, and get in before we open it up.',
  primaryCta: { label: 'Request access', href: '/invite/early-access' },
  emailLabel: 'Or request early access and we’ll reach out:',
};

// ── Pricing page (/pricing) ─────────────────────────────────────────────────────────
// THE PRICE BELOW IS PUBLIC COPY, AND IT IS ALSO CITED IN THE TERMS OF SERVICE. Stripe
// is the source of truth for what anyone is actually charged, and nothing structurally
// links this string to STRIPE_PRICE_ID — a price change means editing both, in the same
// PR. As of 2026-08-18 they agree: the live default is $399/month
// (price_1U0afKHxiLXphzfAu8VRTtBy, the Jigged product's default_price). The superseded
// $300 price is still active in Stripe and must not be pointed back at. Raising the
// price is a NEW Price object, never a mutation — docs/modules/billing.md §6.
// The trial and cancellation claims below also come from that doc (§1, §8): 30-day
// trial with card upfront, and Customer-Portal cancellation.
export const PRICING = {
  meta: {
    // The root layout applies the '%s | Jigged' template — do NOT append the suffix
    // here (/terms and /privacy do, and render "… – Jigged | Jigged").
    title: 'Pricing — $399/month for your whole shop',
    // Same ~155-char budget as MARKETING_META above. This is 122.
    description:
      'Jigged pricing: $399/month flat for your whole shop. Unlimited users, every feature included. 30-day trial, month to month.',
  },
  // Two display lines, split the way HERO is — the break is forced, not left to wrap.
  headlineLead: 'Simple pricing.',
  headlineEmphasis: 'Whole shop.',
  amount: '$399',
  period: '/month',
  unit: 'per shop',
  includes: [
    'Unlimited users. Every feature included.',
    'Quoting, jobs, operator workflows, inventory, shipping, QuickBooks.',
    '30-day trial. Month to month. Cancel anytime.',
  ],
  cta: { label: 'Request access', href: '/invite/early-access' },
  // Split so the address can be a mailto link; renders as one sentence.
  contact: {
    lead: 'Bigger shop or something unusual? Email',
    email: 'hello@jigged.app',
  },
  faqHeading: 'Questions we get',
  faq: [
    {
      q: 'Do you charge per user?',
      a: 'No. Flat rate for the whole shop. We want your operators in Jigged, not locked out of it.',
    },
    {
      q: 'Is there a long-term contract?',
      a: 'No. Month to month, cancel anytime from your billing portal.',
    },
    {
      q: 'What does setup look like?',
      a: 'We set up your shop with you: your parts, your customers, your open jobs loaded before day one.',
    },
  ],
};
