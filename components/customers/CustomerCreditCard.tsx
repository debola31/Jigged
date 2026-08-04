'use client';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import SaveStatus, { type SaveState } from '@/components/common/SaveStatus';
import type { CustomerFieldEditingProps } from '@/components/customers/customerFieldEditing';
import { applyCreditStatusChange } from '@/components/customers/customerFieldEditing';
import type { CustomerCreditStatus } from '@/types/customer';

/**
 * Credit standing, editable in place.
 *
 * THIS CARD EXISTS BECAUSE THE EDIT PAGE WENT AWAY. credit_status and
 * credit_hold_note had no editor anywhere on the detail page — CustomerForm was
 * the only writer in the repo. Deleting that route without a replacement would
 * have made a credit hold permanently unsettable and unclearable on any
 * existing customer, settable only at create time. (reviveArchivedCustomerByName
 * never touches them either, so not even a re-create could clear one.)
 *
 * Separate from Terms rather than folded into it: this is a different decision
 * with different consequences. Terms is what we agreed; this is whether we'll
 * ship to them at all right now.
 *
 * Auto-save (interaction-standards §2 mode 1), and non-financial by that
 * section's own test — nothing prices or blocks on credit_status. It is
 * warn-only by design: a held customer's quote, job and shipment all proceed,
 * showing a banner. If this ever grows a threshold to compare a balance
 * against, it has become the numeric credit limit the module refuses, and the
 * saving mode should be reconsidered along with everything else.
 */
export default function CustomerCreditCard({
  form,
  onTextChange,
  onTextBlur,
  onSelectChange,
  readOnly,
  saveState,
}: CustomerFieldEditingProps & { saveState: SaveState }) {
  const onHold = form.credit_status === 'hold';

  return (
    <Card elevation={2}>
      <CardContent>
        <Box
          sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Credit
            </Typography>
            {onHold && <Chip label="On hold" color="warning" size="small" />}
          </Box>
          {!readOnly && <SaveStatus state={saveState} />}
        </Box>

        {readOnly ? (
          <Box>
            <Typography variant="body1" sx={{ fontWeight: 500 }}>
              {onHold ? 'On hold' : 'Open'}
            </Typography>
            {onHold && form.credit_hold_note && (
              <Typography variant="body2" color="warning.main" sx={{ mt: 0.5 }}>
                {form.credit_hold_note}
              </Typography>
            )}
          </Box>
        ) : (
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ alignItems: 'start' }}>
            <FormControl sx={{ minWidth: 200 }}>
              <InputLabel id="customer-credit-status-label">Credit status</InputLabel>
              <Select
                labelId="customer-credit-status-label"
                label="Credit status"
                value={form.credit_status}
                // Discrete control: saves on change, not on blur. Lifting a hold
                // also clears the reason in the SAME write — see
                // applyCreditStatusChange for why.
                onChange={(e) =>
                  onSelectChange(
                    applyCreditStatusChange(form, e.target.value as CustomerCreditStatus),
                  )
                }
              >
                <MenuItem value="open">Open</MenuItem>
                <MenuItem value="hold">On hold</MenuItem>
              </Select>
            </FormControl>

            {onHold && (
              <TextField
                label="Reason"
                value={form.credit_hold_note}
                onChange={(e) => onTextChange('credit_hold_note', e.target.value)}
                onBlur={onTextBlur}
                helperText="Shown with the warning. Whatever the next person needs to know."
                fullWidth
              />
            )}
          </Stack>
        )}

        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
          Putting a customer on hold shows a warning when someone quotes or ships to them. It
          never stops the work — the decision stays yours.
        </Typography>
      </CardContent>
    </Card>
  );
}
