import type { Metadata } from 'next';
import { readFileSync } from 'fs';
import { join } from 'path';
import TermlyContent from '@/components/marketing/TermlyContent';

export const metadata: Metadata = {
  title: 'Privacy Policy – Jigged',
  description: 'Jigged Privacy Policy — how we collect, store, and protect your data.',
};

export default function PrivacyPage() {
  const html = readFileSync(
    join(process.cwd(), 'public', 'legal', 'privacy.html'),
    'utf-8'
  );

  return <TermlyContent html={html} />;
}
