import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import TermlyContent from '@/components/marketing/TermlyContent';
import LegalDocumentHeader from '@/components/marketing/LegalDocumentHeader';
import { loadLegalDocument, publishedVersions } from '@/lib/legal/documents';

interface Props {
  params: Promise<{ version: string }>;
}

/** See the note on the Terms archive route: a stored hash must always resolve
 *  to a document a person can read. */
export const dynamicParams = false;

export function generateStaticParams() {
  return publishedVersions('privacy').map((v) => ({ version: `v${v.version}` }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { version } = await params;
  return {
    title: `Privacy Policy (${version}) – Jigged`,
    description: 'An archived version of the Jigged Privacy Policy.',
  };
}

export default async function ArchivedPrivacyPage({ params }: Props) {
  const { version } = await params;
  const parsed = Number(version.replace(/^v/, ''));
  if (!Number.isInteger(parsed) || parsed < 1) notFound();

  const doc = loadLegalDocument('privacy', parsed);

  return (
    <TermlyContent
      html={doc.html}
      header={
        <LegalDocumentHeader type="privacy" version={doc.version.version} isCurrent={doc.isCurrent} />
      }
    />
  );
}
