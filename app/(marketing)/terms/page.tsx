import type { Metadata } from 'next';
import Box from '@mui/material/Box';

import LegalPageContainer from '@/components/marketing/LegalPageContainer';
import LegalDocumentHeader from '@/components/marketing/LegalDocumentHeader';
import { legalHtmlSx } from '@/components/marketing/legalHtmlSx';
import { loadLegalDocument } from '@/lib/legal/documents';

export const metadata: Metadata = {
  title: 'Terms of Service – Jigged',
  description: 'Jigged Terms of Service for the precision manufacturing data platform.',
};

/**
 * The current Terms of Service.
 *
 * The document text lives in `public/legal/tos/v{n}.html`, not in this file:
 * a clickwrap record stores the SHA-256 of what the user was shown, and bytes
 * inlined in a component are edited casually and hash to something new every
 * time. `loadLegalDocument` re-verifies the hash and throws rather than serving
 * a document we cannot identify. This page is statically prerendered, so the
 * read happens at build time.
 */
export default function TermsPage() {
  const doc = loadLegalDocument('tos');

  return (
    <LegalPageContainer>
      <LegalDocumentHeader type="tos" version={doc.version.version} isCurrent={doc.isCurrent} />
      <Box sx={legalHtmlSx} dangerouslySetInnerHTML={{ __html: doc.html }} />
    </LegalPageContainer>
  );
}
