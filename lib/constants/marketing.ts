// Marketing copy + data. Kept out of the section components so the landing page stays
// purely presentational and there is one source of truth for words.
//
// HOUSE RULE: when a line is worded a particular way for a reason, record the reason here.
//
// SECOND RULE, added 2026-09-14 after review: DO NOT WRITE THE "BEFORE" UNLESS SOMEONE
// WATCHED IT. A Today/With-Jigged table shipped here for two days and every row of its
// left column was invented — shops were said to re-key everything into QuickBooks at
// month-end (they invoice when they invoice), to quote by digging up last year's
// spreadsheet (they quote from memory, and want room to adjust), and to lose paper
// travelers (the traveler is a good visual tool and is staying). A reader who does the
// job spots a wrong "before" instantly, and then disbelieves the "after" too. If we have
// not observed it, we do not describe it.

export const SHOP_SIZES = [
  '1–5 people',
  '6–15 people',
  '16–50 people',
  '50+ people',
];

export const MARKETING_META = {
  // Mirrors the hero headline — keep the two in step.
  title: 'Jigged — Your whole shop, in one place',
  // KEEP UNDER ~155 CHARS. Google truncates the snippet around there. Front-load the
  // offer; the segment is folded in so "machine shop" still matches what an owner types.
  description:
    'Run your machine shop in one place — quoting, jobs, parts, storage and invoicing, from the customer’s PO to the invoice. Office to floor.',
};

export const HERO = {
  // Category + segment + SIZE. The size qualifier answers an owner's first question, and
  // disqualifies the enterprise reflex that the word "ERP" triggers.
  // 5–50, not 3–30: corrected 2026-09-14. Fifty is where the product is aimed.
  eyebrow: 'Shop software for precision machine shops, 5 to 50 people',
  headlineLead: 'Your whole shop,',
  headlineEmphasis: 'in one place.',
  // Cut from 45 words to 26. Two redundancies went with it: the old version listed the
  // modules AND described the span, which are the same claim twice, and it explained the
  // knowledge story in full here and again two sections down.
  //
  // "TO THE INVOICE", not "to the packing slip" — the slip comes BEFORE invoicing, so
  // naming it as the end of the line stopped the sentence one step short of where the
  // work actually ends. This is now the ONLY place on the page that describes the span.
  subhead:
    'Everything from the customer’s PO to the invoice — and what your best guy works out at the machine stays with the part.',
  primaryCta: { label: 'Request access', href: '/invite/early-access' },
  secondaryCta: { label: 'See how it works', href: '#how-it-works' },
};

// Honest credibility strip. No customer logos are cleared yet, so this states who Jigged
// is for and the shop capabilities it covers. Structured so a real grayscale logo row can
// replace the tags later without touching the layout.
//
// A price + terms band lived here briefly. Removed 2026-09-14: /pricing already carries
// the number, and repeating it on the home page bought a second recital of the same terms
// on a page that is trying to lose text, not gain it.
export const CAPABILITY_STRIP = {
  label: 'Built with precision machine shops running 5 to 50 people',
  tags: ['CNC milling', 'Turning', 'Deburring', 'Anodizing', 'Inspection'],
};

// ── What you get ───────────────────────────────────────────────────────────────────
// FIVE STEPS, ONE SECTION. Until 2026-09-14 this was two: a "Quoting" showcase with big
// screenshots and a separate "What you get" grid of chips with no pictures. They were the
// same argument told twice at different resolutions — the grid named the capability and
// the showcase proved it, two sections apart — so they are merged. main's original had
// three numbered rows; this is that shape with five, and every one carries a picture.
//
// WHAT EACH ROW IS: a number, a claim, ONE line of description, the sub-features as chips,
// and a screenshot. The chips are the breadth (twenty capability names readable without a
// click); the picture is the proof; the description is the only prose, and it stays to one
// line. That balance is the whole design — earlier passes lost it by letting the prose grow
// back, twice.
//
// EVERY CHIP WAS CHECKED AGAINST THE CODE. Deliberately absent because they do not exist:
// supplier purchase orders and receiving (no schema), carrier label generation (no carrier
// API), an invoice aging report — and anything resembling an operator scoreboard, which is
// forbidden rather than merely unbuilt.
export type Step = {
  key: string;
  eyebrow: string;
  headline: string;
  description: string;
  /** Each bullet names an icon in WhatYouGet.tsx — keep the two in step. */
  items?: { icon: string; label: string }[];
  image: string;
  alt: string;
  /** A second, smaller shot overlapping the first — the outcome, not the step. */
  inset?: string;
  insetAlt?: string;
  /** Renders as a phone rather than a desktop screenshot. */
  phone?: boolean;
  /** True while the art is a labelled stand-in rather than a real capture. */
  placeholder?: boolean;
};

export const WHAT_YOU_GET: Step[] = [
  {
    key: 'quote',
    eyebrow: 'Quoting',
    headline: 'Their prints in. Your quote out.',
    description:
      'Drop the customer’s whole folder. Jigged reads the title blocks, you check one row per part, and the parts go straight into a quote.',
    // THREE BULLETS, AND EACH ONE HAS TO EARN ITS LINE. This row used to carry "Quotes and
    // quote PDFs" and "Customers and terms" — nouns that name a screen rather than tell a
    // shop owner anything he did not assume. The test now: would a man who already runs a
    // shop learn something, or change his mind, by reading it? If not, it is not a bullet.
    items: [
      { icon: 'print', label: 'Material, finish and revision read off the print' },
      // Customer 3's actual ask: calculated pricing on the repeatable orders, room to type
      // over it on the odd ones. Both exist — every quote line carries its own
      // `unit_price` and an `is_quote_override` flag.
      { icon: 'price', label: 'Priced from cost — and you can override it' },
      // Verified: the extraction is deterministic and runs in the browser tab. No upload,
      // no model, no network call anywhere in the flow.
      { icon: 'lock', label: 'The drawings never leave your computer' },
    ],
    image: '/screenshots/feature-drawings.png',
    alt: 'A folder of engineering drawings read into a reviewable list of parts in Jigged, with the drawing shown beside the row it produced',
    inset: '/screenshots/feature-quote.png',
    insetAlt: 'The finished quote — customer, line items, unit price and total',
  },
  {
    key: 'job',
    eyebrow: 'Jobs',
    headline: 'Every job, at a glance',
    description:
      'Making, shipping and billing move independently, because in a real shop they do.',
    // QuickBooks moved here from the AI row on 2026-09-21. It never belonged beside "ask
    // your shop in plain English" — billing is part of the job's life, not part of the
    // assistant — and mixing them made both rows read as a list of unrelated nouns.
    items: [
      { icon: 'outside', label: 'Outside processing, sent and received' },
      { icon: 'ship', label: 'Packing slips, carrier and tracking' },
      { icon: 'invoice', label: 'Invoice into QuickBooks, and see when you’re paid' },
    ],
    image: '/screenshots/feature-job.png',
    alt: 'A Jigged job — customer, purchase order, due date, routed operations and the activity from the floor',
  },
  {
    key: 'floor',
    eyebrow: 'The shop floor',
    headline: 'The floor, on his own phone',
    description:
      'Your guys already have the device. He picks his station, sees the jobs waiting on him, and records what he finished — nothing to buy, nothing to install.',
    items: [
      { icon: 'done', label: 'Record what you finished' },
      { icon: 'camera', label: 'Notes, photos and video at the machine' },
      { icon: 'scan', label: 'Scan a shelf label or a traveler' },
      { icon: 'machine', label: 'A logbook for every machine' },
    ],
    image: '/screenshots/feature-operator-step.png',
    alt: 'An operator recording how many pieces he finished on a job step in Jigged, with notes, photos and video on the same screen',
    phone: true,
  },
  {
    key: 'stock',
    eyebrow: 'Storage',
    headline: 'Where it is, and where it came from',
    description:
      'Print a label for every shelf, then scan it to see what is there or move what is on it.',
    items: [
      { icon: 'label', label: 'A printable label for every shelf' },
      { icon: 'count', label: 'Stock counts with live variance' },
      { icon: 'cert', label: 'Heats and mill certs, receiving to packing slip' },
    ],
    image: '/screenshots/feature-storage.png',
    alt: 'The Jigged storage board — a rack drawn as numbered bins, each with its own printable label',
  },
  {
    key: 'books',
    eyebrow: 'Ask your shop',
    headline: 'AI that only knows your shop',
    description:
      'Ask in the words you’d use out loud. Get a number, a chart, or a one-page report on your letterhead.',
    // NO BULLETS. It used to carry four, three of which were QuickBooks and import items
    // that had nothing to do with the assistant, and the fourth — "Ask in plain English" —
    // was the description again. The worked questions below ARE this row's detail: a
    // reader cannot judge a text field, only an answer.
    image: '/screenshots/feature-insights.png',
    alt: 'The Jigged dashboard answering a plain-English question about the shop with a chart',
  },
];

// Worked examples for the last row, shown instead of an empty chat box — a reader cannot
// judge a text field, but he can judge an answer.
//
// EVERY EXAMPLE MUST BE ANSWERABLE. Check new ones against api/services/ai/semantics.md,
// which is rendered into the live prompt. In particular do NOT promise a quoted-versus-
// actual comparison: per-operation cost actuals are deferred (docs/modules/jobs.md).
export const AI_EXAMPLES = [
  { q: 'Which jobs are late this week?', a: 'Four. Two waiting on the Haas, two on inspection.' },
  { q: 'What did we ship last month?', a: '$61,400, across 19 jobs.' },
  { q: 'Which customers haven’t ordered since the spring?', a: 'Three. Longest gap is 214 days.' },
];

// Two lines, in body text, never collapsed.
export const AI_TRUST = [
  'Included in the price. No AI add-on, no per-question billing.',
  'It reads your data. It cannot change it.',
];

export const KNOWLEDGE = {
  eyebrow: 'Knowledge capture',
  heading: 'Keep the knowledge that usually walks out the door.',
  // Trimmed 2026-09-14. The old version spent sixty words setting up a point the heading
  // had already made.
  body: 'Your best machinist knows the trick that saves an hour on that fixture. In Jigged he leaves a note, a photo or a short video right on the job — and it stays with the part.',
  micro:
    'It’s the difference between software that tracks work and software that remembers it.',
  image: '/screenshots/placeholder-phone-note.png',
  alt: 'Placeholder for an operator note with a photo attached',
};

// ── Testimonial ─────────────────────────────────────────────────────────────────────
// APPROVED 2026-09-11. Johnnie Trammell signed off this exact wording, which is what
// `approved: true` records. The gate exists because two things require his adoption of
// the sentence rather than merely his goodwill:
//
//   1. Issues #489/#509 forbid an invented voice on this page — which is why
//      Testimonial.tsx sat dormant for months rather than shipping a placeholder.
//   2. The FTC's Endorsement Guides treat quotation marks as a representation that these
//      are the endorser's exact words (16 CFR § 255.1(b)). The line below is a compression
//      of a paraphrase of a conversation, so it was his to adopt or change. He adopted it.
//
// IF THE WORDING CHANGES, THE FLAG GOES BACK TO FALSE until the new sentence is signed off
// too. Editing an approved quote in place is the failure this gate is here to catch: the
// approval is of these words, not of the idea of a quote.
//
// A "Contour is a pilot shop and is on discounted pricing" line ran under the attribution
// for two days and was REMOVED ON REQUEST 2026-09-14 — the judgement being that it reads
// as a discredit rather than as candour. Recording it here so the next person knows it was
// a decision and not an oversight: Contour is on a reserved $250 price with no trial
// (docs/modules/billing.md §1), which is the kind of arrangement the same Endorsement
// Guides treat as a material connection.
export const TESTIMONIAL = {
  approved: true,
  quote: 'I’ve used other ERPs. This one just works how you think it should.',
  name: 'Johnnie Trammell',
  role: 'Contour Tool & Machine',
  logo: '/logos/contour-tool-and-machine.png',
  logoAlt: 'Contour Tool & Machine',
};

// A real sequence — set up → quote and track → ship and invoice.
//
// CORRECTED: step 01 used to read "Add your team, part categories, and markup defaults."
// Neither exists; markup rates were removed in #569 and each part owns its pricing.
export type HowItWorksStep = { number: string; headline: string; description: string };

export const STEPS: HowItWorksStep[] = [
  {
    number: '01',
    headline: 'Bring your shop in',
    description:
      'Your parts, customers and prices come in from the files you already have. No consultants, no six-month rollout.',
  },
  {
    number: '02',
    headline: 'Quote and track',
    description:
      'Turn a quote into a job against the customer’s PO, then follow every step from one place.',
  },
  {
    number: '03',
    headline: 'Ship and get paid',
    description:
      'Log what ships, invoice from the job, and see it land in QuickBooks.',
  },
];

// The concrete answer to "how long until we're running" — the objection the reviews in
// this category say actually decides these deals, ahead of price.
export const FIRST_WEEK = {
  heading: 'Your first week',
  days: [
    'Day one — your customers and parts go in from a spreadsheet.',
    'Day two — quote a job and send the PDF.',
    'Day three — an operator picks his station and records a step.',
  ],
  // Demo mode has shipped for months and the page never mentioned it. For a buyer with no
  // reason to trust an unknown vendor, "look before you load anything" is the most useful
  // sentence available.
  demo: 'Not ready to load anything? Open a sample shop, already full of jobs, and walk around it first.',
};

// ── FAQ ─────────────────────────────────────────────────────────────────────────────
// Four, down from eight. Removed on request, in two passes. The four that went:
//   - "Will my guys be tracked?" — removed 2026-09-21. Note what goes with it: the
//     no-surveillance guarantee is now absent from the page entirely, the floor copy
//     having lost its stopwatch line a week earlier. It remains true, and remains
//     enforced by the schema; it is simply no longer claimed here.
//   - "What does the AI actually see?" — it answers with today's table allowlist, and that
//     list is about to widen. A page that documents a boundary we are moving is a page
//     that will be wrong.
//   - "What doesn't Jigged do yet?" — the gaps it named are days of work, not architecture,
//     so publishing them dates the page and undersells the product.
//   - "Can I get my data out if I leave?" — nobody in the pilot has asked it.
// Kept short deliberately: this section is depth for the reader who wants it, not a second
// features list.
export const FAQ = [
  {
    q: 'Is this right for a shop my size?',
    a: 'It is built for precision shops up to about 50 people. Bigger than that and you will want something with a planner and a full-time admin behind it.',
  },
  {
    q: 'How long until we’re actually running?',
    a: 'Days, not quarters. Your parts, customers and prices load from the files you already have, and there is a sample shop you can walk around before you load anything.',
  },
  {
    q: 'Do I have to re-key everything from my spreadsheets?',
    a: 'No. Point the importer at your spreadsheets or your old system’s export — it recognises a Tangle or JobBOSS/E2 one — and it maps the columns, then shows you what needs fixing before anything saves.',
  },
  {
    q: 'Does it replace QuickBooks?',
    // Corrected 2026-09-14 to describe what shops actually do: they invoice when they
    // invoice, not in a month-end batch, and the mirror tells them when it was paid
    // (`qb_status` / `qb_balance`, kept current by Intuit webhooks).
    a: 'No, and it shouldn’t. Invoice a job whenever you’re ready and Jigged creates it in QuickBooks — Online or Desktop — then shows you when it’s paid. Your books stay the system of record.',
  },
];

// One closing beat: the founding-shops message is folded into the single CTA.
export const FINAL_CTA = {
  heading: 'Ready to stop fighting your software?',
  subhead:
    'We’re taking on a small group of precision shops as founding partners — they shape where Jigged goes, and get in before we open it up.',
  primaryCta: { label: 'Request access', href: '/invite/early-access' },
  emailLabel: 'Or request early access and we’ll reach out:',
};

// ── Pricing page (/pricing) ─────────────────────────────────────────────────────────
// THE PRICE BELOW IS PUBLIC COPY, AND IT IS ALSO CITED IN THE TERMS OF SERVICE. Stripe is
// the source of truth for what anyone is charged, and nothing structurally links this
// string to STRIPE_PRICE_ID — a price change means editing both, in the same PR. As of
// 2026-08-18 they agree: the live default is $399/month (price_1U0afKHxiLXphzfAu8VRTtBy).
// The superseded $300 price is still active in Stripe and must not be pointed back at.
// Raising the price is a NEW Price object, never a mutation — docs/modules/billing.md §6.
// Trial and cancellation claims come from that doc (§1, §8).
export const PRICING = {
  meta: {
    // The root layout applies the '%s | Jigged' template — do NOT append the suffix here.
    title: 'Pricing — $399/month for your whole shop',
    // Same ~155-char budget as MARKETING_META. This is 122.
    description:
      'Jigged pricing: $399/month flat for your whole shop. Unlimited users, every feature included. 30-day trial, month to month.',
  },
  headlineLead: 'Simple pricing.',
  headlineEmphasis: 'Whole shop.',
  amount: '$399',
  period: '/month',
  unit: 'per shop',
  includes: [
    'Unlimited users. Every feature included.',
    'Quoting, jobs, the shop floor, storage, shipping and QuickBooks.',
    '30-day trial. Month to month. Cancel anytime.',
  ],
  cta: { label: 'Request access', href: '/invite/early-access' },
  contact: {
    lead: 'Bigger shop or something unusual? Email',
    email: 'hello@jigged.app',
  },
  faqHeading: 'Questions we get',
  // EXACTLY THREE, asserted by __tests__/lib/pricingCopy.test.ts.
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
      a: 'We set up your shop with you. Your parts, customers and open jobs load from the files you already have — the importer maps your columns and flags what needs fixing before anything saves.',
    },
  ],
};
