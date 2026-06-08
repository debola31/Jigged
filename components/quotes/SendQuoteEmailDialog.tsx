'use client';

import { useEffect, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import SendIcon from '@mui/icons-material/Send';

import type { QuoteWithRelations } from '@/types/quote';
import type { Company } from '@/utils/companyAccess';
import { generateQuotePdf, quotePdfFilename } from '@/utils/quotePdf';
import { sendQuoteEmail } from '@/utils/quoteEmail';
import { isValidEmail } from '@/lib/validators';

interface SendQuoteEmailDialogProps {
  open: boolean;
  onClose: () => void;
  onSent: (toEmail: string) => void;
  quote: QuoteWithRelations;
  company: Company;
}

function defaultSubject(quoteNumber: string | null, companyName: string): string {
  const num = quoteNumber ?? 'Quote';
  return `Quote ${num} from ${companyName}`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Pick the customer's primary contact from the joined customer_contacts list.
 * Mirrors the helper in utils/quotePdf.ts — same primary-row resolution rule.
 */
function pickPrimaryContact(quote: QuoteWithRelations) {
  const contacts = quote.customers?.customer_contacts ?? [];
  return contacts.find((c) => c.is_primary) ?? null;
}

function defaultBody(quote: QuoteWithRelations, company: Company, senderName: string): string {
  const primary = pickPrimaryContact(quote);
  const contactName = primary?.name || quote.customers?.name || 'there';
  const quoteNumber = quote.quote_number ?? 'attached';
  const expiry = quote.expiration_date
    ? ` The prices are valid until ${formatDate(quote.expiration_date)}.`
    : '';
  const signOff = senderName || company.name;
  return [
    `Hi ${contactName},`,
    '',
    `Please find attached Quote ${quoteNumber} for your recent inquiry.${expiry}`,
    'Let me know if you have any questions, or reply with a PO to accept.',
    '',
    'Thanks,',
    signOff,
  ].join('\n');
}

export default function SendQuoteEmailDialog({
  open,
  onClose,
  onSent,
  quote,
  company,
}: SendQuoteEmailDialogProps) {
  const senderName = quote.created_by_member?.name ?? '';

  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const primary = pickPrimaryContact(quote);
    setTo(primary?.email ?? '');
    setCc('');
    setSubject(defaultSubject(quote.quote_number, company.name));
    setBody(defaultBody(quote, company, senderName));
    setError(null);
  }, [open, quote, company, senderName]);

  const handleSend = async () => {
    setError(null);
    if (!to.trim()) {
      setError('Recipient email is required.');
      return;
    }
    if (!isValidEmail(to)) {
      setError('Enter a valid recipient email address.');
      return;
    }
    if (cc.trim() && !isValidEmail(cc)) {
      setError('Enter a valid CC email address (or clear it).');
      return;
    }
    setSending(true);
    try {
      const doc = await generateQuotePdf(quote, company);
      const pdf = doc.output('blob');
      const filename = quotePdfFilename(quote);
      await sendQuoteEmail(quote.id, {
        to: to.trim(),
        cc: cc.trim() || undefined,
        subject,
        body,
        pdf,
        pdfFilename: filename,
      });
      onSent(to.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send email');
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onClose={sending ? undefined : onClose} maxWidth="md" fullWidth>
      <DialogTitle>Email quote {quote.quote_number ?? ''}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}

          <TextField
            label="To"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            type="email"
            required
            error={to.trim() !== '' && !isValidEmail(to)}
            helperText={
              to.trim() !== '' && !isValidEmail(to) ? 'Enter a valid email address' : undefined
            }
            disabled={sending}
            placeholder="customer@example.com"
            fullWidth
          />
          <TextField
            label="CC"
            value={cc}
            onChange={(e) => setCc(e.target.value)}
            type="email"
            error={cc.trim() !== '' && !isValidEmail(cc)}
            helperText={
              cc.trim() !== '' && !isValidEmail(cc) ? 'Enter a valid email address' : undefined
            }
            disabled={sending}
            placeholder="optional"
            fullWidth
          />
          <TextField
            label="Subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            disabled={sending}
            fullWidth
          />
          <TextField
            label="Message"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            disabled={sending}
            multiline
            minRows={8}
            fullWidth
          />

          <Box>
            <Chip
              icon={<AttachFileIcon />}
              label={quotePdfFilename(quote)}
              variant="outlined"
            />
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              The current quote PDF is attached automatically.
              {company.email
                ? ` Replies go to ${company.email}.`
                : ' Set a company email in Settings → Company Profile so customer replies have a destination.'}
            </Typography>
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={sending}>
          Cancel
        </Button>
        <Button
          onClick={handleSend}
          variant="contained"
          disabled={sending}
          startIcon={sending ? <CircularProgress size={16} color="inherit" /> : <SendIcon />}
        >
          {sending ? 'Sending…' : 'Send email'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
