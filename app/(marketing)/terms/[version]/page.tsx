import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Box from '@mui/material/Box';

import LegalPageContainer from '@/components/marketing/LegalPageContainer';
import LegalDocumentHeader from '@/components/marketing/LegalDocumentHeader';
import { legalHtmlSx } from '@/components/marketing/legalHtmlSx';
import { loadLegalDocument, publishedVersions } from '@/lib/legal/documents';

interface Props {
  params: Promise<{ version: string }>;
}

/**
 * A specific, published version of the Terms of Service.
 *
 * WHY THIS ROUTE EXISTS. Every `terms_acceptances` row names a version and a
 * hash. If the only readable copy were whatever is current, that row would
 * point at a document nobody could produce — which is the whole failure the
 * hash is meant to prevent. No version is ever deleted, so every acceptance
 * stays resolvable to a page a person can read.
 */
export const dynamicParams = false;

export function generateStaticParams() {
  return publishedVersions('tos').map((v) => ({ version: `v${v.version}` }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { version } = await params;
  return {
    title: `Terms of Service (${version}) – Jigged`,
    description: `An archived version of the Jigged Terms of Service.`,
  };
}

export default async function ArchivedTermsPage({ params }: Props) {
  const { version } = await params;
  const parsed = Number(version.replace(/^v/, ''));
  if (!Number.isInteger(parsed) || parsed < 1) notFound();

  const doc = loadLegalDocument('tos', parsed);

  return (
    <LegalPageContainer>
      <LegalDocumentHeader type="tos" version={doc.version.version} isCurrent={doc.isCurrent} />
      <Box sx={legalHtmlSx} dangerouslySetInnerHTML={{ __html: doc.html }} />
    </LegalPageContainer>
  );
}
