import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';

import {
  LEGAL_LABELS,
  archiveHref,
  currentVersion,
  type LegalDocumentType,
} from '@/lib/legal/manifest';

interface Props {
  type: LegalDocumentType;
  version: number;
  isCurrent: boolean;
}

/**
 * The version line above a legal document, and — when an archived version is
 * being read — the banner saying so.
 *
 * RENDERS THE VERSION, NOT A SECOND DATE. Every document states its own
 * "Last Updated" inside the bytes that were hashed and accepted, so printing an
 * effective date here would put a second, unhashed copy of the same fact on the
 * page, free to drift from the one in the contract. The version number is the
 * thing the document itself does not carry and that `terms_acceptances.version`
 * refers to.
 */
export default function LegalDocumentHeader({ type, version, isCurrent }: Props) {
  const current = currentVersion(type);

  return (
    <Box sx={{ mb: 4 }}>
      <Typography
        variant="body2"
        sx={{ color: 'text.secondary', letterSpacing: '0.04em', textTransform: 'uppercase' }}
      >
        Version {version}
      </Typography>

      {!isCurrent && (
        <Alert severity="info" sx={{ mt: 2 }}>
          This is version {version} of the {LEGAL_LABELS[type]}, kept so the exact text
          people agreed to stays available. It has been superseded by{' '}
          <MuiLink href={archiveHref(type, current.version)} underline="hover">
            version {current.version}
          </MuiLink>
          , which took effect on {current.effective_date}.
        </Alert>
      )}
    </Box>
  );
}
