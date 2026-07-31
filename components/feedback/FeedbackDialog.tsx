'use client';

import { useState } from 'react';
import { useParams, usePathname } from 'next/navigation';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import CloseIcon from '@mui/icons-material/Close';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import { useAuth } from '@/components/providers/AuthProvider';
import { getSupabase } from '@/lib/supabase';
import MissingFieldsNotice from '@/components/common/MissingFieldsNotice';

function getPageTitle(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);

  if (segments.includes('quotes')) {
    if (segments.includes('new')) return 'New Quote';
    const idx = segments.indexOf('quotes');
    if (idx < segments.length - 1 && !['new'].includes(segments[idx + 1])) return 'Quote Details';
    return 'Quotes';
  }

  if (segments.includes('parts')) {
    if (segments.includes('routing')) {
      if (segments.includes('new')) return 'New Routing';
      if (segments.includes('edit')) return 'Edit Routing';
      return 'Routing';
    }
    if (segments.includes('new')) return 'New Part';
    if (segments.includes('edit')) return 'Edit Part';
    if (segments.includes('import')) return 'Import Parts';
    const idx = segments.indexOf('parts');
    if (idx < segments.length - 1 && !['new', 'edit', 'import'].includes(segments[idx + 1])) return 'Part Details';
    return 'Parts';
  }

  if (segments.includes('customers')) {
    if (segments.includes('new')) return 'New Customer';
    if (segments.includes('edit')) return 'Edit Customer';
    if (segments.includes('import')) return 'Import Customers';
    const idx = segments.indexOf('customers');
    if (idx < segments.length - 1 && !['new', 'edit', 'import'].includes(segments[idx + 1])) return 'Customer Details';
    return 'Customers';
  }

  if (segments.includes('operations')) {
    if (segments.includes('new')) return 'New Operation';
    if (segments.includes('edit')) return 'Edit Operation';
    if (segments.includes('import')) return 'Import Operations';
    return 'Operations';
  }

  if (segments.includes('jobs')) {
    if (segments.includes('new')) return 'New Job';
    if (segments.includes('edit')) return 'Edit Job';
    const idx = segments.indexOf('jobs');
    if (idx < segments.length - 1 && !['new', 'edit'].includes(segments[idx + 1])) return 'Job Details';
    return 'Jobs';
  }

  // Only two `/inventory` routes exist — `/inventory/locations` (the Storage board) and
  // `/inventory/count`. This block was a surviving copy of six branches Header.tsx already deleted
  // as pointing at routes that never existed ('New/Edit Inventory Item', 'Import Inventory'), and
  // its `idx + 1` fallback caught BOTH live routes — so every report filed from the Storage board or
  // mid-count was tagged **"Inventory Details"**, the name of a page that was never built. That
  // silently mis-buckets exactly the feedback these screens most need.
  if (segments.includes('locations')) return 'Storage';
  if (segments.includes('count')) return 'Count Inventory';

  if (segments.includes('settings')) return 'Settings';
  if (segments.includes('team')) return 'Team';

  if (segments.includes('vendors')) {
    if (segments.includes('new')) return 'New Vendor';
    if (segments.includes('edit')) return 'Edit Vendor';
    if (segments.includes('import')) return 'Import Vendors';
    const idx = segments.indexOf('vendors');
    if (idx < segments.length - 1 && !['new', 'edit', 'import'].includes(segments[idx + 1])) return 'Vendor Details';
    return 'Vendors';
  }

  if (segments.includes('work-centers')) {
    if (segments.includes('new')) return 'New Work Center';
    if (segments.includes('edit')) return 'Edit Work Center';
    if (segments.includes('import')) return 'Import Work Centers';
    const idx = segments.indexOf('work-centers');
    if (idx < segments.length - 1 && !['new', 'edit', 'import'].includes(segments[idx + 1])) return 'Work Center Details';
    return 'Work Centers';
  }

  return 'Dashboard';
}

interface FeedbackDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  userId?: string;
}

export default function FeedbackDialog({ open, onClose, onSuccess, userId }: FeedbackDialogProps) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const pathname = usePathname();
  const params = useParams();
  const { user } = useAuth();

  const [feedbackText, setFeedbackText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pageTitle = getPageTitle(pathname);
  const companyId = params.companyId as string;

  const handleSubmit = async () => {
    const resolvedUserId = userId ?? user?.id;
    if (!feedbackText.trim() || !resolvedUserId) return;

    setSubmitting(true);
    setError(null);

    try {
      const supabase = getSupabase();
      const { error: insertError } = await supabase.from('feedback').insert({
        company_id: companyId,
        user_id: resolvedUserId,
        page_path: pathname,
        page_title: pageTitle,
        feedback_text: feedbackText.trim(),
      });

      if (insertError) throw insertError;

      setFeedbackText('');
      onClose();
      onSuccess();
    } catch (err) {
      console.error('Feedback submission failed:', err);
      setError('Failed to submit feedback. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    if (!submitting) {
      setError(null);
      onClose();
    }
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="sm"
      fullWidth
      fullScreen={isMobile}
      scroll="paper"
      PaperProps={{
        sx: { maxHeight: '90vh' },
      }}
    >
      <DialogTitle
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          pb: 1,
        }}
      >
        Give Feedback
        <IconButton onClick={handleClose} size="small" sx={{ color: 'text.secondary' }} disabled={submitting}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent sx={{ pt: 2 }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Page: {pageTitle}
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        <TextField
          autoFocus
          fullWidth
          multiline
          rows={4}
          placeholder="What's on your mind?"
          value={feedbackText}
          onChange={(e) => setFeedbackText(e.target.value)}
          disabled={submitting}
        />

        <MissingFieldsNotice
          items={!feedbackText.trim() ? ['Enter your feedback before submitting'] : []}
        />
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={handleClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={!feedbackText.trim() || submitting}
          startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          {submitting ? 'Submitting…' : 'Submit'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
