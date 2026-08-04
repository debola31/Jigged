'use client';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import PaymentTermsPicker from '@/components/common/PaymentTermsPicker';
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
  companyId,
  form,
  fieldErrors,
  onTextChange,
  onTextBlur,
  onSelectChange,
  readOnly,
  saveState,
}: CustomerFieldEditingProps & { saveState: SaveState; companyId: string }) {

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
            <Box sx={{ minWidth: 160 }}>
              <Typography variant="body2" color="text.secondary">
                Payment terms
              </Typography>
              <Typography variant="body1" sx={{ fontWeight: 500 }}>
                {form.default_payment_terms || '—'}
              </Typography>
            </Box>
            <Box sx={{ minWidth: 160 }}>
              <Typography variant="body2" color="text.secondary">
                FOB point
              </Typography>
              <Typography variant="body1" sx={{ fontWeight: 500 }}>
                {form.default_fob_point || '—'}
              </Typography>
            </Box>
          </Stack>
        ) : (
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
            {/* The SAME control the quote form uses. It was a bare text box
                here, which is how "net 45" typed on a customer ends up beside
                QuickBooks' "Net 45" as a separate option on the quote — the
                exact drift the picker's QuickBooks-first ordering exists to
                prevent. A select, so it saves on change rather than on blur. */}
            <PaymentTermsPicker
              companyId={companyId}
              value={form.default_payment_terms}
              onChange={(next) => onSelectChange({ default_payment_terms: next })}
              size="medium"
              helperText="Applied to a new quote for this customer."
            />
            <TextField
              label="FOB point"
              value={form.default_fob_point}
              onChange={(e) => onTextChange('default_fob_point', e.target.value)}
              onBlur={onTextBlur}
              error={!!fieldErrors.default_fob_point}
              helperText={
                fieldErrors.default_fob_point ||
                'Where title and risk transfer. Who pays the freight is set per order.'
              }
              fullWidth
            />
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
