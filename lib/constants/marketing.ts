// Marketing copy + data. Kept out of the section components so both landing-page
// design variants stay purely presentational and share one source of truth for words.

export const SHOP_SIZES = [
  '1–5 people',
  '6–15 people',
  '16–50 people',
  '50+ people',
];

export const MARKETING_META = {
  title: 'Jigged — Your shop floor, finally under control',
  description:
    'Paperless shop-floor software for precision machine shops. See where every job stands, and capture the notes and photos your operators take at the machine — no paper travelers, no tribal knowledge walking out the door.',
};

export const HERO = {
  eyebrow: 'Paperless operations for precision machine shops',
  // Two display lines: the control promise, then the reassurance.
  headlineLead: 'Your shop floor,',
  headlineEmphasis: 'finally under control.',
  subhead:
    'Go paperless from quote to done. Jigged shows you where every job stands without walking the floor — and captures the notes and photos your operators take at the machine, so the fix your best guy figured out is still there next time you run the part.',
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
    'The know-how that makes your hardest parts run right lives in a few people’s heads — and walks out the door when they retire.',
    'Quoting, the floor, shipping, invoicing — each lives in a different tool, and none of them talk.',
    'A job comes back around and the setup, the speeds, the fix from last time are gone. You solve it from scratch again.',
    'You’ve stitched together an ERP, a stack of spreadsheets, and homegrown tools — and it still doesn’t fit how your shop runs.',
  ],
  closer:
    'Shop owners keep telling us the same thing: they’re running the whole operation across an ERP, a pile of spreadsheets, and homegrown tools nobody else could use. We’re building Jigged to do the whole job in one place — tailored to how a precision shop actually works. Everything they need, nothing they don’t.',
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
    headline: 'Quote faster, win more work',
    description:
      'Build cost-plus quotes in minutes. Set markups by part category and Jigged does the math the same way every time.',
    image: '/screenshots/feature-quotes.png',
    alt: 'Jigged quote showing base cost, markup, and unit price for a part',
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
    'Scan the QR on the traveler and land on the exact job and step.',
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

export const STEPS: Step[] = [
  {
    number: '01',
    headline: 'Set up your shop',
    description:
      'Add your team, part categories, and markup defaults. About 15 minutes.',
  },
  {
    number: '02',
    headline: 'Quote and track',
    description:
      'Create quotes, turn them into jobs, and follow everything from one place.',
  },
  {
    number: '03',
    headline: 'Run your shop, not your software',
    description:
      'No implementation consultants. No six-month rollout. Jigged stays out of the way.',
  },
];

export const EARLY_ACCESS = {
  heading: 'We’re building this with our founding shops.',
  body: 'We’re taking on a small group of precision shops as founding partners — they shape where Jigged goes, and get in before we open it up. Request access and we’ll talk.',
};

export const FINAL_CTA = {
  heading: 'Ready to stop fighting your software?',
  subhead:
    'We’re working closely with a small group of founding shops. Request access and we’ll reach out.',
  primaryCta: { label: 'Request access', href: '/invite/early-access' },
  emailLabel: 'Or request early access and we’ll reach out:',
};
