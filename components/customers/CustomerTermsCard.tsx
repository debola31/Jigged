'use client';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import SaveStatus, { type SaveState } from '@/components/common/SaveStatus';
import type { CustomerFieldEditingProps } from '@/components/customers/customerFieldEditing';

/**
 * The customer's standing terms, editable in place.
 *
 * Auto-save on blur (interaction-standards §2 mode 1). These are three
 * independent free-text prose fields, and they are non-financial by that
 * section's own test — they seed a NEW quote and nothing else. An existing
 * quote froze its own terms at creation and never reads these again, so a typo
 * here cannot change what any customer is charged. That is what puts them in
 * auto-save rather than behind a staged Save button.
 *
 * Plain free text on purpose, matching what the old edit form offered: the
 * preset picker lives on the quote form, where the term is actually being
 * committed to a document. Offering presets in two places invites them to drift.
 *
 * Lead time used to sit here and was removed: it is a function of current shop
 * load and the specific part, not of the customer, so a standing value here was
 * a stale promise waiting to be quoted. It lives on the quote, stated at the
 * moment someone judges the shop's actual backlog.
 */
export default function CustomerTermsCard({
  form,
  fieldErrors,
  onTextChange,
  onTextBlur,
  readOnly,
  saveState,
}: CustomerFieldEditingProps & { saveState: SaveState }) {
  const fields = [
    {
      key: 'default_payment_terms' as const,
      label: 'Payment terms',
      helper: 'Such as Net 30, or 50% deposit.',
    },
    {
      key: 'default_fob_point' as const,
      label: 'FOB point',
      helper: 'Where title and risk transfer. Who pays the freight is set per order.',
    },
  ];

  return (
    <Card elevation={2}>
      <CardContent>
        <Box
          sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}
        >
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Terms
          </Typography>
          {!readOnly && <SaveStatus state={saveState} />}
        </Box>

        {readOnly ? (
          <Stack direction="row" spacing={4} sx={{ flexWrap: 'wrap' }}>
            {fields.map((f) => (
              <Box key={f.key} sx={{ minWidth: 160 }}>
                <Typography variant="body2" color="text.secondary">
                  {f.label}
                </Typography>
                <Typography variant="body1" sx={{ fontWeight: 500 }}>
                  {form[f.key] || '—'}
                </Typography>
              </Box>
            ))}
          </Stack>
        ) : (
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
            {fields.map((f) => (
              <TextField
                key={f.key}
                label={f.label}
                value={form[f.key]}
                onChange={(e) => onTextChange(f.key, e.target.value)}
                onBlur={onTextBlur}
                error={!!fieldErrors[f.key]}
                helperText={fieldErrors[f.key] || f.helper}
                fullWidth
              />
            ))}
          </Stack>
        )}

        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
          Applied to new quotes for this customer. Quotes you&rsquo;ve already sent keep the
          terms they were created with.
        </Typography>
      </CardContent>
    </Card>
  );
}
