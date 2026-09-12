// Marketing copy + data. Kept out of the section components so the landing page
// stays purely presentational and there is one source of truth for words.
//
// HOUSE RULE, inherited and worth keeping: when a line is worded a particular way for a
// reason, record the reason here. That commentary is the only surviving record of why the
// page says what it says — and it is what caught three claims that had quietly gone false
// between 2026-07-15 and 2026-09-11 (a tablet nobody uses, a one-tap completion that now
// takes a quantity and runs a clock, and setup steps naming two concepts the schema does
// not have).

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
  // a ~920px budget). Front-load the offer; the segment is folded in so "machine shop"
  // still matches what an owner searches.
  description:
    'Run your machine shop in one place — quote to invoice, office to floor. $399/month flat, every feature, every user. 30-day trial.',
};

export const HERO = {
  // Category + segment + SIZE. The size qualifier is new: an owner's first question is
  // "is this for a shop my size", and the answer disqualifies the enterprise reflex that
  // "ERP" triggers. It also matches the pricing page and the footer.
  eyebrow: 'Shop software for precision machine shops, 3 to 30 people',
  // Two display lines. The headline states WHAT WE OFFER (StoryBrand's grunt test); the
  // subhead carries HOW IT MAKES LIFE BETTER. Both kept from the July rewrite — they were
  // reasoned through carefully and nothing about the product has made them less true.
  headlineLead: 'Your whole shop,',
  headlineEmphasis: 'in one place.',
  // Unpacks "whole shop" by naming the span, then delivers the differentiator. Widened
  // from the July version, which named only quoting and invoicing — the product now runs
  // storage, the floor, outside processing and shipping too, and "everything in between"
  // was carrying all of that invisibly.
  subhead:
    'Quoting, jobs, parts, storage and invoicing — one system from the customer’s PO to the packing slip. And the notes and photos your operators take at the machine stay with the part, so the fix your best guy figured out is there next time someone needs it.',
  primaryCta: { label: 'Request access', href: '/invite/early-access' },
  secondaryCta: { label: 'See how it works', href: '#how-it-works' },
};

// ── Price + terms strip ─────────────────────────────────────────────────────────────
// Directly under the hero, replacing the old standalone capability strip (whose tags now
// ride on this band's second line).
//
// WHY THE NUMBER IS ON THE LANDING PAGE. Pricing transparency is the single change B2B
// buyers most often ask for, and roughly 4% of software vendors publish a price at all.
// Nobody in this category does — the nearest competitors link to a "pricing" page that
// still refuses to print a figure. Publishing it is the cheapest differentiator available
// and it disqualifies the wrong prospect before either side spends a call on it.
//
// THE AMOUNT ITSELF IS NOT DUPLICATED — it is read from PRICING below, which is pinned by
// __tests__/lib/pricingCopy.test.ts and cited in the Terms of Service. One string, one
// place to change, one test guarding it.
export const PRICE_STRIP = {
  terms: 'Every feature, every user — the whole shop.',
  // "Card up front" is deliberate. The trial DOES take a card (billing.md §1; billing
  // begins day 31), and "30-day trial" left bare is read as "no card" by most people.
  // Finding that out at the checkout is exactly the small untruth this buyer never
  // forgives, and it costs one clause to avoid.
  trial: '30-day trial, card up front. Month to month, cancel any time.',
  fine: 'No setup fee. No per-module pricing. No AI add-on.',
  tags: ['CNC milling', 'Turning', 'Deburring', 'Anodizing', 'Inspection'],
};

// ── Today / With Jigged ─────────────────────────────────────────────────────────────
// Replaces the four PainPoints pull-quote cards. Same job — "why change" — but a table
// makes the argument AND names capabilities AND does the positioning, in fewer words and
// less vertical space. The left column has to be recognisable enough that the reader
// finishes it before reading the right; that is the whole mechanism.
export const TODAY_WITH_JIGGED = {
  eyebrow: 'The daily reality',
  heading: 'Sound familiar?',
  columns: { today: 'Today', jigged: 'With Jigged' },
  rows: [
    {
      job: 'Quoting a job',
      today: 'Dig up last year’s spreadsheet and hope the numbers still hold.',
      jigged: 'Every part carries its own pricing, so the math comes out the same every time.',
    },
    {
      job: 'Finding out where a job stands',
      today: 'Walk the floor, or call the lead and interrupt him.',
      jigged: 'Open the jobs list. Making, shipping and billing each sit on their own line.',
    },
    {
      job: 'Knowing whether a job made money',
      today: 'You find out at month-end, if you find out.',
      jigged: 'What shipped, against what the job was costed at, job by job.',
    },
    {
      job: 'The operator’s paperwork',
      today: 'A paper traveler that gets marked up, lost, or left in the machine.',
      jigged: 'He records how many good pieces he finished, on the phone already in his pocket.',
    },
    {
      job: 'Month-end',
      today: 'Re-key everything into QuickBooks.',
      jigged: 'Bill what shipped and the invoice is created in QuickBooks for you.',
    },
  ],
};

export type Step = { number: string; headline: string; description: string };

// A real sequence — set up → quote and track → ship and invoice.
//
// CORRECTED 2026-09-11. Step 01 used to read "Add your team, part categories, and markup
// defaults." Neither part categories nor markup defaults exist: markup rates were removed
// in #569 and each part now owns its pricing. It also promised 15 minutes of DIY setup
// while the pricing FAQ promised white-glove loading — two different stories. The truth
// got better in between: the guided importer maps your columns for you and recognises a
// Tangle or JobBOSS/E2 export, so the honest version is "it comes in from the files you
// already have."
export const STEPS: Step[] = [
  {
    number: '01',
    headline: 'Bring your shop in',
    description:
      'Your parts, customers and prices come in from the files you already have — messy headers and all. You check the list before it saves. No consultants, no six-month rollout.',
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
      'Log what goes out the door, then push the invoice straight to QuickBooks. No re-keying.',
  },
];

// The concrete answer to "how long until we're running", which the reviews in this
// category say is the objection that actually kills deals — ahead of price.
export const FIRST_WEEK = {
  heading: 'Your first week',
  days: [
    'Day one — your customers and parts go in from a spreadsheet.',
    'Day two — quote a job and send the PDF.',
    'Day three — an operator picks his station and records a step.',
  ],
  // Demo mode has shipped for months and the page has never mentioned it. For a buyer
  // with no reason to trust an unknown vendor, "look before you load anything" is the
  // most useful sentence on the page.
  demo: 'Not ready to load anything? Open a sample shop, already full of jobs, and walk around it first.',
};

// ── What Jigged covers ──────────────────────────────────────────────────────────────
// The compression that makes this page possible. The old FEATURES array gave three
// capabilities a full screen each (~717px per feature); carrying the real product that
// way would have added something like 8,600px and doubled the page.
//
// THE RULE: hide depth, never breadth. The WORD "mill certs" has to be readable without
// a click; the paragraph explaining mill certs does not. So each cell states a claim,
// explains it in one sentence, and then lists what is actually in it. Twenty feature
// names, visible, for roughly the height of one old feature row.
//
// EVERY ITEM BELOW WAS CHECKED AGAINST THE CODE. Nothing aspirational, nothing
// deprecated. Deliberately absent, because they do not exist: supplier purchase orders
// and receiving (no schema at all), carrier label generation (no carrier API), an invoice
// aging report, reorder emails, quality inspection — and anything resembling an operator
// scoreboard, which is forbidden rather than merely unbuilt.
export type Capability = {
  key: string;
  heading: string;
  body: string;
  items: string[];
};

export const CAPABILITIES: Capability[] = [
  {
    key: 'win',
    heading: 'Quoting — minutes, not evenings',
    body: 'Price the work from what the part actually costs, and turn the quote into a job against the customer’s PO.',
    items: [
      'Quotes and quote PDFs',
      'Customers, contacts and terms',
      'Per-part pricing and quantity breaks',
      'Read a whole folder of drawings',
    ],
  },
  {
    key: 'run',
    heading: 'Every job, at a glance',
    body: 'Making, shipping and billing move independently, because in a real shop they do.',
    items: [
      'Jobs and printed travelers',
      'Work centers and routed steps',
      'Outside processing, sent and received',
      'Packing slips, carrier and tracking',
    ],
  },
  {
    key: 'floor',
    heading: 'The floor, on the phone in his pocket',
    body: 'Nothing to buy, nothing to install, and no screen that ever scores anybody.',
    items: [
      'Record how many good pieces you finished',
      'Scan a shelf label or a traveler',
      'Notes with photos and short video',
      'A logbook for every machine',
    ],
  },
  {
    key: 'stock',
    heading: 'Where it is, and where it came from',
    body: 'Print a label for every shelf, then scan it to see what is there or move what is on it.',
    items: [
      'Storage places you can scan',
      'Stock counts with live variance',
      'Heats and mill certificates',
      'Vendors and outside services',
    ],
  },
  {
    key: 'books',
    heading: 'Books, and a straight answer',
    body: 'Bill what shipped, and ask the shop a question in the words you would actually use.',
    items: [
      'QuickBooks Online and Desktop',
      'Ask about your own shop, in plain English',
      'Bring your data in from spreadsheets',
      'One activity feed for the whole shop',
    ],
  },
];

// ── Showcases ───────────────────────────────────────────────────────────────────────
// Only the two stories that need a picture to be believed. Everything else is named in
// CAPABILITIES above. (This replaces the three-row FEATURES array; quoting and QuickBooks
// moved into the grid, and the operator story has always had its own section.)
export type Showcase = {
  key: string;
  eyebrow: string;
  headline: string;
  description: string;
  points?: string[];
  image: string;
  alt: string;
};

export const SHOWCASES: Showcase[] = [
  {
    key: 'drawings',
    eyebrow: 'Quoting',
    // The measured figure, from the real customer package: 93 files became 31 parts
    // (docs/modules/parts.md). A specific number an owner can picture beats "fast".
    headline: '93 drawings. 31 parts. No typing.',
    description:
      'Drop the customer’s whole folder of prints. Jigged reads the title blocks, groups the revisions, and hands you one row per part to check before anything is created.',
    points: [
      'Part number, material, finish and revision come off the print.',
      'Route the parts by tapping stations, then quote the package.',
      // The strongest and least expected line on the page, and it is literally true:
      // the extraction is deterministic and runs in the browser tab. Nothing is uploaded,
      // nothing is sent to a model, and there is no network call in the whole flow.
      'The drawings never leave your computer.',
    ],
    image: '/screenshots/feature-drawings.png',
    alt: 'A folder of engineering drawings read into a reviewable list of parts in Jigged, with the drawing shown beside the row it produced',
  },
  {
    key: 'insights',
    eyebrow: 'Ask your shop',
    headline: 'AI that only knows your shop',
    description:
      'It reads your jobs, your parts, your prices and your shipments. Nothing else. Ask in the words you would use out loud, and get a number, a chart, or a one-page report on your letterhead.',
    image: '/screenshots/feature-insights.png',
    alt: 'The Jigged dashboard answering a plain-English question about the shop with a chart',
  },
];

// Worked examples, shown instead of an empty chat box — a reader cannot judge a text
// field, but he can judge an answer.
//
// EVERY EXAMPLE HERE MUST BE ANSWERABLE. Check new ones against
// api/services/ai/semantics.md, which is rendered into the live prompt and defines late,
// revenue, job value, open quote, dormant customer and cost. Specifically DO NOT promise
// a quoted-versus-actual comparison: per-operation cost actuals are deferred
// (docs/modules/jobs.md), and the profit figure that exists is booked revenue minus a
// standard cost frozen at job creation, with labour at standard rates.
export const AI_EXAMPLES = [
  { q: 'Which jobs are late this week?', a: 'Four. Two waiting on the Haas, two on inspection.' },
  { q: 'What did we ship last month?', a: '$61,400, across 19 jobs.' },
  { q: 'Which customers haven’t ordered since the spring?', a: 'Three. Longest gap is 214 days.' },
];

// Body text, never behind the accordion. This buyer verifies rather than worries, so the
// useful thing is a checkable boundary — including the limit. Naming what it cannot do
// yet costs nothing against a demo that would reveal it anyway.
export const AI_TRUST = [
  'Included in the price. No AI add-on, no per-question billing.',
  'It can read your data. It cannot change it.',
  'Jigged never acts on its own. Today it answers questions — it doesn’t write quotes or purchase orders.',
];

// The operator/shop-floor section.
//
// CORRECTED 2026-09-11, three claims that had gone false:
//   1. "Operators work from a tablet at their station." A founder observation on
//      2026-07-31 — two weeks after this copy was written — settled the device model:
//      "No one used a shop tablet in Contour or any shop I've seen." It is the machine's
//      own HMI, a personal phone, or an office computer. Every doc was corrected; this
//      page was missed. PostHog agrees, for what it is worth: one tablet pageview on the
//      marketing site in 90 days.
//   2. "One tap to mark a step complete — no timers, no training." Both halves wrong.
//      Quantity capture shipped in July (he enters a count, not a tap) and chained
//      work-centre time intervals shipped in August, with pause and resume in September.
//      The honest version is better anyway: he maintains no timecard, because the clock
//      rides on taps he was already making.
//   3. "Runs on any tablet or phone." See 1.
export const SHOP_FLOOR = {
  eyebrow: 'On the shop floor',
  heading: 'Built for the person at the machine',
  subhead:
    'Your guys already have the device. Jigged runs on the phone in their pocket — no tablet to buy, no kiosk, nothing to install.',
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
  // page that is guaranteed by the schema rather than by intention: there is no surface
  // that reflects an operator's pace back at anyone, and building one is forbidden.
  noSurveillance:
    'Your guys will ask if this is a stopwatch on them. It isn’t, and you can show them: Jigged never displays a score, a count, an average or a leaderboard — not to them, and not to you.',
};

export const KNOWLEDGE = {
  eyebrow: 'Knowledge capture',
  heading: 'Keep the knowledge that usually walks out the door.',
  body: 'Your best machinist knows the trick that saves an hour on that fixture. Right now it lives in his head. In Jigged, operators leave notes, photos and short videos right on the job — the setup, the workaround, the thing that went wrong last time. It stays with the part, so the next person runs it right.',
  micro:
    'No incumbent ERP does this. It’s the difference between software that tracks work and software that remembers it.',
  image: '/screenshots/feature-knowledge-note.png',
  alt: 'An operator note with a photo attached to a job in Jigged',
};

// ── Testimonial ─────────────────────────────────────────────────────────────────────
// DO NOT SET `approved` TO TRUE WITHOUT JOHNNIE'S WRITTEN SIGN-OFF ON THIS EXACT WORDING.
//
// The section renders nothing while `approved` is false, so this is a one-line change
// once the email is in hand — and a deliberate barrier until it is. Two reasons it is a
// barrier rather than a note:
//
//   1. Issues #489/#509 forbid an invented voice on this page, which is why
//      Testimonial.tsx sat dormant for months rather than shipping a placeholder.
//   2. The FTC's Endorsement Guides treat quotation marks as a representation that these
//      are the endorser's exact words (16 CFR § 255.1(b)): copy "may not be presented out
//      of context or reworded so as to distort in any way the endorser's opinion." The
//      line below is a compression of a paraphrase of a conversation, so until Johnnie
//      adopts it as his own in writing, the quotation marks are the problem. Once he
//      replies "yes, publish that as my words", it is his sentence and the issue is gone.
//      If he changes a word, use his word.
//
// ALSO STILL OWED, and the reason `disclosure` is not empty: Contour is on a reserved
// $250 price with no trial (docs/modules/billing.md §1). That is a material connection
// under the same Guides, so it is disclosed next to the quote rather than omitted. It
// costs nothing in credibility and omitting it is the likeliest way this becomes a
// problem.
//
// Worth collecting from him at the same time, in rough order of value: a number he will
// stand behind (minutes to build a quote, or how long before he was running it); what
// Jigged replaced; how the floor took to it; his exact title; town and state; headcount
// and what they make; a phone photo at a machine.
export const TESTIMONIAL = {
  approved: false,
  // Built from the two things he actually said. "I've used other ERPs" is the only
  // differentiating claim in the raw material — a comparison no vendor can make about
  // itself — and the second half is close to his own sentence. Everything a machine shop
  // has ever been told about ease of use is a category claim; the comparison is not.
  quote: 'I’ve used other ERPs. This one just works how you think it should.',
  name: 'Johnnie Trammell',
  role: 'Contour Tool & Machine',
  logo: '/logos/contour-tool-and-machine.png',
  logoAlt: 'Contour Tool & Machine',
  disclosure: 'Contour is a pilot shop and is on discounted pricing.',
};

// ── FAQ ─────────────────────────────────────────────────────────────────────────────
// The most content per pixel on the page: eight answers in roughly the height of half a
// feature row. These are the objections the reviews in this category actually turn on —
// implementation time first, price a long way second.
//
// Answers must stay checkable. Two are narrower than a marketer would write them, on
// purpose: CSV export ships on jobs, parts, customers, vendors, work centres and team
// but NOT on quotes and not on the inventory ledger, and "what we don't do yet" is a
// real list rather than a humblebrag.
export const FAQ = [
  {
    q: 'Is this right for a shop my size?',
    a: 'It is built for precision shops running roughly 3 to 30 people. Bigger than that and you will want something with a planner and a full-time admin behind it.',
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
    a: 'No, and it shouldn’t. You bill the quantities that shipped and Jigged creates the invoice in QuickBooks — Online or Desktop. Your books stay the system of record.',
  },
  {
    q: 'Can I get my data out if I leave?',
    a: 'Yes. Jobs, parts, customers, vendors, work centers and your team each export to CSV from their list page, any time, including after you cancel.',
  },
  {
    q: 'What does the AI actually see?',
    a: 'Your jobs, parts, prices and shipments, over a read-only connection it cannot write to. It never sees your invoices or your QuickBooks data, and your shop’s data is never shared with another shop.',
  },
  {
    q: 'What doesn’t Jigged do yet?',
    a: 'No carrier labels — you record the carrier and tracking number yourself. No purchase orders to your suppliers, no receiving against a PO, and no aging report. We would rather you heard that here than found it in week two.',
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
// THE PRICE BELOW IS PUBLIC COPY, AND IT IS ALSO CITED IN THE TERMS OF SERVICE. Stripe
// is the source of truth for what anyone is actually charged, and nothing structurally
// links this string to STRIPE_PRICE_ID — a price change means editing both, in the same
// PR. As of 2026-08-18 they agree: the live default is $399/month
// (price_1U0afKHxiLXphzfAu8VRTtBy, the Jigged product's default_price). The superseded
// $300 price is still active in Stripe and must not be pointed back at. Raising the
// price is a NEW Price object, never a mutation — docs/modules/billing.md §6.
// The trial and cancellation claims below also come from that doc (§1, §8): 30-day
// trial with card upfront, and Customer-Portal cancellation.
//
// NOTE (2026-09-11): the landing page now prints this amount too, via PRICE_STRIP above,
// which reads `amount` and `period` from here rather than repeating them. One string.
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
    'Quoting, jobs, the shop floor, storage, shipping and QuickBooks.',
    '30-day trial. Month to month. Cancel anytime.',
  ],
  cta: { label: 'Request access', href: '/invite/early-access' },
  // Split so the address can be a mailto link; renders as one sentence.
  contact: {
    lead: 'Bigger shop or something unusual? Email',
    email: 'hello@jigged.app',
  },
  faqHeading: 'Questions we get',
  // EXACTLY THREE, asserted by __tests__/lib/pricingCopy.test.ts. The landing page's FAQ
  // is the long one; this stays short because a pricing page answers pricing questions.
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
      // "your existing files", not "exports": plenty of 5-50 person shops run on
      // spreadsheets and have no ERP to export from. Updated 2026-09-11 to name the
      // importer's real behaviour, which is now the answer to the biggest objection in
      // the category rather than a footnote.
      a: 'We set up your shop with you. Your parts, customers and open jobs load from the files you already have — the importer maps your columns and flags what needs fixing before anything saves.',
    },
  ],
};
