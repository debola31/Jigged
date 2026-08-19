import type { Metadata } from 'next';

import TermlyContent from '@/components/marketing/TermlyContent';
import LegalDocumentHeader from '@/components/marketing/LegalDocumentHeader';
import { loadLegalDocument } from '@/lib/legal/documents';

export const metadata: Metadata = {
  title: 'Privacy Policy – Jigged',
  description: 'Jigged Privacy Policy — how we collect, store, and protect your data.',
};

export default function PrivacyPage() {
  const doc = loadLegalDocument('privacy');

  return (
    <TermlyContent
      html={doc.html}
      header={
        <LegalDocumentHeader type="privacy" version={doc.version.version} isCurrent={doc.isCurrent} />
      }
    />
  );
}
