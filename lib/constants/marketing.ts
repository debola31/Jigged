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

// ── Showcases ───────────────────────────────────────────────────────────────────────
// The two stories that need a picture to be believed, and the two pictures that carry the
// page. Moved directly under the hero on 2026-09-14 — they were sixth and seventh, behind
// three text sections, which is the wrong order when they are the strongest thing here.
export type Showcase = {
  key: string;
  eyebrow: string;
  headline: string;
  description: string;
  points?: string[];
  image: string;
  alt: string;
  /** A second, smaller shot overlapping the first — the outcome, not the step. */
  inset?: string;
  insetAlt?: string;
};

export const SHOWCASES: Showcase[] = [
  {
    key: 'drawings',
    eyebrow: 'Quoting',
    // WAS "93 drawings. 31 parts. No typing." Two problems with it, both raised in review:
    // the count came from one customer's package and reads as borrowed rather than as a
    // property of the product, and — worse — it advertised PART CREATION as though that
    // were the point. Reading drawings is one on-ramp; the destination is the quote, and
    // the old headline stopped at the intermediary step. The section now names both ends.
    headline: 'Their prints in. Your quote out.',
    description:
      'Drop the customer’s whole folder. Jigged reads the title blocks, you check one row per part, and the parts go straight into a quote.',
    points: [
      'Part number, material, finish and revision come off the print.',
      // Customer 3's actual ask: calculated pricing on the bigger, repeatable orders and
      // room to type over it on the small or odd ones. Both exist — every quote line
      // carries its own `unit_price` and an `is_quote_override` flag.
      'Priced from what the part costs — type over it when the job is odd.',
      // Verified: the extraction is deterministic and runs in the browser tab. No upload,
      // no model, no network call anywhere in the flow.
      'The drawings never leave your computer.',
    ],
    image: '/screenshots/feature-drawings.png',
    alt: 'A folder of engineering drawings read into a reviewable list of parts in Jigged, with the drawing shown beside the row it produced',
    // The payoff, overlapping the first image the way the hero's phone does — so the
    // section shows where the flow ENDS and not only where it starts.
    inset: '/screenshots/feature-quote.png',
    insetAlt: 'A finished Jigged quote — customer, line items, unit price and total',
  },
  {
    key: 'insights',
    eyebrow: 'Ask your shop',
    headline: 'AI that only knows your shop',
    description:
      'Ask in the words you’d use out loud. Get a number, a chart, or a one-page report on your letterhead.',
    image: '/screenshots/feature-insights.png',
    alt: 'The Jigged dashboard answering a plain-English question about the shop with a chart',
  },
];

// Worked examples, shown instead of an empty chat box — a reader cannot judge a text
// field, but he can judge an answer.
//
// EVERY EXAMPLE MUST BE ANSWERABLE. Check new ones against api/services/ai/semantics.md,
// which is rendered into the live prompt. In particular do NOT promise a quoted-versus-
// actual comparison: per-operation cost actuals are deferred (docs/modules/jobs.md).
export const AI_EXAMPLES = [
  { q: 'Which jobs are late this week?', a: 'Four. Two waiting on the Haas, two on inspection.' },
  { q: 'What did we ship last month?', a: '$61,400, across 19 jobs.' },
  { q: 'Which customers haven’t ordered since the spring?', a: 'Three. Longest gap is 214 days.' },
];

// Two lines, in body text, never collapsed. Trimmed from three on 2026-09-14: the third
// listed what the assistant cannot do yet, and the roadmap moves faster than the page.
export const AI_TRUST = [
  'Included in the price. No AI add-on, no per-question billing.',
  'It reads your data. It cannot change it.',
];

// ── What Jigged covers ──────────────────────────────────────────────────────────────
// The compression that makes this page possible. The old FEATURES array gave three
// capabilities a full screen each (~717px per feature); the real product that way would
// have added ~8,600px.
//
// THE RULE: hide depth, never breadth. The WORD "mill certs" has to be readable without a
// click; the paragraph explaining mill certs does not. Each cell is an icon, a claim, and
// the list of what is actually in it.
//
// THE BODY SENTENCES ARE GONE (2026-09-14). Five cells x a sentence each was a paragraph
// of prose sitting on top of the twenty words that do the work, and the review verdict was
// the correct one: "even I won't read all that." The chips were always the content.
//
// AND THE CHIPS THEMSELVES ARE LABELS, NOT SENTENCES (same review, second pass). "Record
// how many good pieces you finished" became "Record what you finished": this grid is a
// breadth audit, so a chip only has to NAME the thing well enough that an owner recognises
// it. The place to explain it is the showcase above or the FAQ below, not here.
//
// EVERY ITEM WAS CHECKED AGAINST THE CODE. Deliberately absent, because they do not exist:
// supplier purchase orders and receiving (no schema), carrier label generation (no carrier
// API), an invoice aging report — and anything resembling an operator scoreboard, which is
// forbidden rather than merely unbuilt.
export type Capability = {
  key: string;
  /** Maps to an icon in Capabilities.tsx — keep the two in step. */
  icon: 'quote' | 'job' | 'phone' | 'shelf' | 'books';
  heading: string;
  items: string[];
};

export const CAPABILITIES: Capability[] = [
  {
    key: 'win',
    icon: 'quote',
    heading: 'Quoting — minutes, not evenings',
    items: [
      'Quotes and quote PDFs',
      'Customers and terms',
      'Per-part pricing',
      'Drawings straight to parts',
    ],
  },
  {
    key: 'run',
    icon: 'job',
    heading: 'Every job, at a glance',
    items: [
      'Jobs and travelers',
      'Work centers and routing',
      'Outside processing',
      'Packing slips and tracking',
    ],
  },
  {
    key: 'floor',
    icon: 'phone',
    heading: 'The floor, on his own phone',
    items: [
      'Record what you finished',
      'Scan a label or traveler',
      'Notes, photos and video',
      'Machine logbooks',
    ],
  },
  {
    key: 'stock',
    icon: 'shelf',
    heading: 'Where it is, and where it came from',
    items: [
      'Storage you can scan',
      'Stock counts',
      'Heats and mill certs',
      'Vendors and services',
    ],
  },
  {
    key: 'books',
    icon: 'books',
    heading: 'Books, and a straight answer',
    items: [
      'QuickBooks Online and Desktop',
      'See when you’re paid',
      'Ask in plain English',
      'Import from spreadsheets',
    ],
  },
];

// The operator/shop-floor section.
//
// CORRECTED 2026-07-15 → 2026-09-11, three claims that had gone false:
//   1. "Operators work from a tablet at their station." A founder observation on
//      2026-07-31 settled the device model: "No one used a shop tablet in Contour or any
//      shop I've seen." It is the machine's own HMI, a personal phone, or an office
//      computer. Every doc was corrected; this page was missed. PostHog agrees — one
//      tablet pageview on the marketing site in 90 days.
//   2. "One tap to mark a step complete — no timers, no training." Both halves wrong.
//      Quantity capture shipped in July, chained work-centre intervals in August, pause
//      and resume in September. The honest version is better: he maintains no timecard,
//      because the clock rides on taps he was already making.
//   3. "Runs on any tablet or phone." See 1.
export const SHOP_FLOOR = {
  eyebrow: 'On the shop floor',
  heading: 'Built for the person at the machine',
  subhead:
    'Your guys already have the device. Jigged runs on the phone in their pocket — nothing to buy, nothing to install.',
  points: [
    'He signs in once, picks his station, and sees only the jobs waiting on him.',
    'The current print and the work instructions, right there at the machine.',
    'He records how many good pieces he finished. Partial counts are normal.',
    'The clock runs off the taps he was already making — no timecard to keep.',
  ],
  images: [
    '/screenshots/feature-operator-queue.png',
    '/screenshots/feature-operator-step.png',
  ],
  // Split from one shared string: two different screenshots previously read the same
  // sentence aloud, which tells a screen-reader user nothing about either.
  altQueue:
    'The Jigged operator view on a phone, showing the jobs waiting at this station',
  altStep:
    'An operator recording how many good pieces he finished on a job step in Jigged',
  // The sentence an owner needs before he will roll this out, and the one claim on the
  // page guaranteed by the schema rather than by intention.
  noSurveillance:
    'Your guys will ask if this is a stopwatch on them. It isn’t, and you can show them: Jigged never displays a score, a count, an average or a leaderboard — not to them, and not to you.',
};

export const KNOWLEDGE = {
  eyebrow: 'Knowledge capture',
  heading: 'Keep the knowledge that usually walks out the door.',
  // Trimmed 2026-09-14. The old version spent sixty words setting up a point the heading
  // had already made.
  body: 'Your best machinist knows the trick that saves an hour on that fixture. In Jigged he leaves a note, a photo or a short video right on the job — and it stays with the part, so the next person runs it right.',
  micro:
    'No incumbent ERP does this. It’s the difference between software that tracks work and software that remembers it.',
  image: '/screenshots/feature-knowledge-note.png',
  alt: 'An operator note with a photo attached to a job in Jigged',
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

export type Step = { number: string; headline: string; description: string };

// A real sequence — set up → quote and track → ship and invoice.
//
// CORRECTED: step 01 used to read "Add your team, part categories, and markup defaults."
// Neither exists; markup rates were removed in #569 and each part owns its pricing.
export const STEPS: Step[] = [
  {
    number: '01',
    headline: 'Bring your shop in',
    description:
      'Your parts, customers and prices come in from the files you already have — messy headers and all. No consultants, no six-month rollout.',
  },
  {
    number: '02',
    headline: 'Quote and track',
    description:
      'Build a quote, turn it into a job against the customer’s PO, and follow every step from one place.',
  },
  {
    number: '03',
    headline: 'Ship and get paid',
    description:
      'Log what goes out the door, invoice from the job, and see it land in QuickBooks.',
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
// Five, down from eight on 2026-09-14. The three that went:
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
    a: 'It is built for precision shops running up to about 50 people. Bigger than that and you will want something with a planner and a full-time admin behind it.',
  },
  {
    q: 'How long until we’re actually running?',
    a: 'Days, not quarters. Your parts, customers and prices load from the files you already have, and there is a sample shop you can walk around before you load anything.',
  },
  {
    q: 'Do I have to re-key everything from my spreadsheets?',
    a: 'No. Point the importer at your spreadsheets or your old system’s export and it maps the columns for you — it recognises a Tangle or JobBOSS/E2 export — then shows you what needs fixing before anything saves.',
  },
  {
    q: 'Will my guys be tracked?',
    a: 'No. Jigged never displays a score, a count, an average or a leaderboard — not to them, and not to you. There is no per-operator performance screen, and there will not be one.',
  },
  {
    q: 'Does it replace QuickBooks?',
    // Corrected 2026-09-14 to describe what shops actually do: they invoice when they
    // invoice, not in a month-end batch, and the mirror tells them when it was paid
    // (`qb_status` / `qb_balance`, kept current by Intuit webhooks).
    a: 'No, and it shouldn’t. Invoice a job whenever you’re ready and Jigged creates it in QuickBooks — Online or Desktop — then shows you when it’s been paid. Your books stay the system of record.',
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
