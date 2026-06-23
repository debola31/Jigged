'use client';

import { useEffect, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Autocomplete from '@mui/material/Autocomplete';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import CloseIcon from '@mui/icons-material/Close';
import EmailIcon from '@mui/icons-material/Email';

import type { QuoteWithRelations } from '@/types/quote';
import type { Company } from '@/utils/companyAccess';
import { generateQuotePdf, quotePdfFilename } from '@/utils/quotePdf';
import {
  buildQuoteMailto,
  defaultBody,
  defaultSubject,
  pickPrimaryContact,
} from '@/utils/quoteMailto';

interface QuoteEmailDialogProps {
  open: boolean;
  onClose: () => void;
  quote: QuoteWithRelations;
  company: Company;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trim, drop empties, and de-dupe (case-insensitive) an address list. */
function normalizeEmails(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = raw.trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/**
 * Compose-and-send dialog for emailing a quote. Mailto can't carry an
 * attachment, so on confirm this BOTH downloads the quote PDF (so it's waiting
 * in the user's downloads folder) AND opens their default mail client with the
 * drafted To/Cc/subject/body — then reminds them to attach the downloaded file.
 * The message is shown editable so the user sees exactly what will be sent.
 */
export default function QuoteEmailDialog({ open, onClose, quote, company }: QuoteEmailDialogProps) {
  const [toList, setToList] = useState<string[]>([]);
  const [ccList, setCcList] = useState<string[]>([]);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the fields each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    const primaryEmail = pickPrimaryContact(quote)?.email ?? '';
    setToList(primaryEmail ? [primaryEmail] : []);
    setCcList([]);
    setSubject(defaultSubject(quote.quote_number, company.name));
    setBody(defaultBody(quote, company, quote.created_by_member?.name ?? ''));
    setError(null);
    setSending(false);
  }, [open, quote, company]);

  const handleConfirm = async () => {
    setError(null);
    const to = normalizeEmails(toList);
    const cc = normalizeEmails(ccList);
    if (to.length === 0) {
      setError('Add at least one recipient in the To field.');
      return;
    }
    const invalid = [...to, ...cc].filter((e) => !EMAIL_RE.test(e));
    if (invalid.length > 0) {
      setError(`These addresses look invalid: ${invalid.join(', ')}`);
      return;
    }
    setSending(true);
    try {
      // Download the PDF first so it's already in the downloads folder when the
      // mail client opens (mailto can't carry the attachment itself).
      const doc = await generateQuotePdf(quote, company);
      doc.save(quotePdfFilename(quote));
      // Then open the mail client with the drafted message.
      window.location.href = buildQuoteMailto(quote, company, { to, cc, subject, body });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to prepare the email.');
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onClose={sending ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pr: 6 }}>
        Email {quote.quote_number ?? 'Quote'}
        <IconButton
          aria-label="Close"
          onClick={onClose}
          disabled={sending}
          sx={{ position: 'absolute', right: 12, top: 12 }}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Alert severity="info">
            Your mail app can&apos;t attach files automatically. When you confirm, we&apos;ll
            download <strong>{quotePdfFilename(quote)}</strong> — attach it to the email before
            sending.
          </Alert>

          <Autocomplete
            multiple
            freeSolo
            options={[]}
            value={toList}
            onChange={(_e, v) => setToList(normalizeEmails(v as string[]))}
            renderInput={(params) => (
              <TextField
                {...params}
                label="To"
                placeholder="Add email and press Enter"
                size="small"
                required
              />
            )}
          />
          <Autocomplete
            multiple
            freeSolo
            options={[]}
            value={ccList}
            onChange={(_e, v) => setCcList(normalizeEmails(v as string[]))}
            renderInput={(params) => (
              <TextField {...params} label="Cc" placeholder="Add email and press Enter" size="small" />
            )}
          />
          <TextField
            label="Subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            size="small"
            fullWidth
          />
          <TextField
            label="Message"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            multiline
            minRows={6}
            fullWidth
          />

          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={sending} sx={{ minHeight: 48 }}>
          Cancel
        </Button>
        <Button
          variant="contained"
          startIcon={sending ? <CircularProgress size={16} color="inherit" /> : <EmailIcon />}
          onClick={handleConfirm}
          disabled={sending}
          sx={{ minHeight: 48 }}
        >
          {sending ? 'Preparing…' : 'Download PDF & open email'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
