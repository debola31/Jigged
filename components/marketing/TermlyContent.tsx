'use client';

import Box from '@mui/material/Box';
import LegalPageContainer from './LegalPageContainer';

/**
 * Wrapper for Termly-generated HTML content that applies dark theme overrides.
 * Termly outputs light-themed HTML with data-custom-class attributes and inline styles.
 * This component overrides those styles to match Jigged's dark UI.
 */
export default function TermlyContent({
  html,
  header,
}: {
  html: string;
  /** Rendered above the document, inside the container — the version line and,
   *  for an archived version, the supersession banner. */
  header?: React.ReactNode;
}) {
  return (
    <LegalPageContainer>
      {header}
      <Box
        sx={{
          // Override Termly's light-theme data-custom-class styles
          '& [data-custom-class="title"], & [data-custom-class="title"] *': {
            fontFamily: 'inherit !important',
            fontSize: '2rem !important',
            color: '#f3f4f6 !important',
            fontWeight: '700 !important',
          },
          '& [data-custom-class="subtitle"], & [data-custom-class="subtitle"] *': {
            fontFamily: 'inherit !important',
            color: '#6b7280 !important',
            fontSize: '14px !important',
          },
          '& [data-custom-class="heading_1"], & [data-custom-class="heading_1"] *': {
            fontFamily: 'inherit !important',
            fontSize: '1.2rem !important',
            color: '#f3f4f6 !important',
            fontWeight: '700 !important',
          },
          '& [data-custom-class="heading_2"], & [data-custom-class="heading_2"] *': {
            fontFamily: 'inherit !important',
            fontSize: '1rem !important',
            color: '#e5e7eb !important',
            fontWeight: '600 !important',
          },
          '& [data-custom-class="body_text"], & [data-custom-class="body_text"] *': {
            color: '#d1d5db !important',
            fontSize: '15px !important',
            fontFamily: 'inherit !important',
          },
          '& [data-custom-class="link"], & [data-custom-class="link"] *': {
            color: '#4682B4 !important',
            fontSize: '15px !important',
            fontFamily: 'inherit !important',
          },
          '& [data-custom-class="body"]': {
            background: 'transparent !important',
            backgroundColor: 'transparent !important',
          },
          '& [data-custom-class="body"] *': {
            background: 'transparent !important',
            backgroundColor: 'transparent !important',
          },
          // General element overrides
          '& p, & div': { lineHeight: 1.7 },
          '& a': { color: '#4682B4 !important' },
          '& ul': { ml: 3, listStyleType: 'square' },
          '& li': { mb: 1, color: '#d1d5db' },
          // Hide Termly branding logo
          '& > span[style*="background: url"]': { display: 'none !important' },
          // Hide Termly attribution at bottom
          '& > br + div': { display: 'none' },
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </LegalPageContainer>
  );
}
