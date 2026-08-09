'use client';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import PaymentTermsPicker from '@/components/common/PaymentTermsPicker';
import SaveStatus, { type SaveState } from '@/components/common/SaveStatus';
import type { CustomerFieldEditingProps } from '@/components/customers/customerFieldEditing';

/**
 * The customer's standing terms, editable in place.
 *
 * Auto-save (interaction-standards §2 mode 1). Payment terms are non-financial
 * by that section's own test — they seed a NEW quote and nothing else. An
 * existing quote froze its own terms at creation and never reads these again,
 * so a typo here cannot change what any customer is charged. That is what puts
 * them in auto-save rather than behind a staged Save button.
 *
 * **One field left, and it is a picker.** Both of its former neighbours were
 * removed on the same reasoning — a standing default is only worth storing if
 * shops actually set it:
 *   - Lead time (2026-08-03) — a function of current shop load and the specific
 *     part, not of the customer, so a standing value was a stale promise waiting
 *     to be quoted. It lives on the quote now.
 *   - FOB point (2026-08-08) — 0 of 586 real customers ever set one. See
 *     docs/modules/customers.md, open question 3.
 *
 * With FOB gone this card has no free-text input at all, which is why it takes
 * only `onSelectChange`: the picker commits on change, so there is nothing to
 * validate on blur.
 */
export default function CustomerTermsCard({
  companyId,
  form,
  onSelectChange,
  readOnly,
  saveState,
}: Omit<CustomerFieldEditingProps, 'fieldErrors' | 'onTextChange' | 'onTextBlur'> & {
  saveState: SaveState;
  companyId: string;
}) {

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
