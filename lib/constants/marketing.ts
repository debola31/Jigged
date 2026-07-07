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
    'You quoted a job from memory because opening the ERP was slower than doing the math yourself.',
    'You lost track of a job’s status and had to walk the floor to find out.',
    'Your inventory says you have material. Your shelf says otherwise.',
    'You bought software built for 500-person plants and your 12-person shop uses 10% of it.',
  ],
  closer:
    'We built Jigged because shop owners kept telling us the same thing: nothing out there fits how they actually work.',
};

export type Feature = {
  key: string;
  headline: string;
  description: string;
  image: string | string[];
  alt: string;
};

// Job status leads. The DAG "routing workflow" shot is gone; the operator shot is
// the complete-only flow (no timer). See lib/constants comment + issue #489.
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
    key: 'inventory',
    headline: 'Inventory in the units you actually use',
    description:
      'Count stock in feet, sheets, or pieces — whatever’s on the shelf. Tie material to jobs so you know what’s allocated and what’s free.',
    image: '/screenshots/feature-inventory.png',
    alt: 'Jigged inventory transaction converting feet to inches when removing stock',
  },
  {
    key: 'operators',
    headline: 'A shop-floor view operators will actually use',
    description:
      'Operators scan the QR on the traveler, see their step, and tap once to mark it complete. No training manual. No timer to babysit.',
    image: ['/screenshots/feature-operator-complete.png'],
    alt: 'Jigged operator view on a phone with a single mark-complete action',
  },
];

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
  heading: 'Free during early access.',
  body: 'We’re onboarding a small group of shops and building exactly what they need. No card, no contract.',
};

export const FINAL_CTA = {
  heading: 'Ready to stop fighting your software?',
  subhead:
    'Free during early access. We’re working closely with a small group of shops.',
  primaryCta: { label: 'Request access', href: '/invite/early-access' },
  emailLabel: 'Or request early access and we’ll reach out:',
};
