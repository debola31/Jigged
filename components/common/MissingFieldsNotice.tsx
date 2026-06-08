'use client';

import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

interface MissingFieldsNoticeProps {
  /**
   * Human-readable reasons the submit button is disabled, e.g.
   * ["Customer PO is required", "Enter a valid due date"]. Render an empty array
   * (or nothing) when the form is submittable.
   */
  items: string[];
  /** Optional lead-in line above the list. */
  title?: string;
}

/**
 * Inline "what's still missing" notice shown above a disabled submit button.
 *
 * This is the standard, touch-friendly way to explain a greyed-out save button
 * in Jigged — an always-visible info Alert listing the blocking conditions.
 * We deliberately avoid hover tooltips for this: the app runs on shop-floor
 * tablets where hover isn't available. Renders nothing when `items` is empty.
 */
export default function MissingFieldsNotice({
  items,
  title = 'Before you can save:',
}: MissingFieldsNoticeProps) {
  if (items.length === 0) return null;
  return (
    <Alert severity="info" sx={{ mt: 1 }}>
      <Stack spacing={0.5}>
        {title && (
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {title}
          </Typography>
        )}
        {items.map((item, i) => (
          <Typography key={i} variant="body2">
            • {item}
          </Typography>
        ))}
      </Stack>
    </Alert>
  );
}
