'use client';

import { useState } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import EditIcon from '@mui/icons-material/Edit';

import SaveStatus, { type SaveState } from '@/components/common/SaveStatus';
import type { CustomerFieldEditingProps } from '@/components/customers/customerFieldEditing';

/**
 * The customer's name in the detail-page header.
 *
 * Reads as a HEADING until you ask to change it. A name is the one field on
 * this page that is read constantly and edited almost never — an always-live
 * input in the title position makes the page look like a form and puts a
 * caret-sized target where a heading belongs. The pencil is the exception to
 * this page's otherwise auto-save-everywhere model, and it earns it: the terms
 * and credit fields are things you come here to set, the name is the thing you
 * came here to confirm.
 *
 * Still auto-save once open — commits on blur or Enter, same as every other
 * field, so the pencil reveals an editor rather than starting a staged form.
 * Escape reverts and closes without writing.
 *
 * Uniqueness is checked by the page before the write, including the case where
 * the check itself fails (refused, not reported as a duplicate).
 */
export default function CustomerIdentityFields({
  form,
  fieldErrors,
  onTextChange,
  onTextBlur,
  readOnly,
  saveState,
  displayName,
  onCancelEdit,
}: CustomerFieldEditingProps & {
  saveState: SaveState;
  /** The last SAVED name, so cancelling can restore it. */
  displayName: string;
  onCancelEdit: () => void;
}) {
  const [editing, setEditing] = useState(false);

  // A failed save keeps the editor open — closing it would hide the error next
  // to the value that caused it.
  const close = () => {
    if (saveState !== 'error') setEditing(false);
  };

  if (readOnly || !editing) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="h5" sx={{ fontWeight: 600 }}>
          {displayName}
        </Typography>
        {!readOnly && (
          <Tooltip title="Rename this customer">
            <IconButton size="small" onClick={() => setEditing(true)} aria-label="Edit name">
              <EditIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, maxWidth: 560 }}>
      <TextField
        autoFocus
        label="Company name"
        value={form.name}
        onChange={(e) => onTextChange('name', e.target.value)}
        onBlur={() => {
          onTextBlur();
          close();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            onCancelEdit();
            setEditing(false);
          }
        }}
        error={!!fieldErrors.name}
        helperText={fieldErrors.name || 'Enter to save, Escape to cancel'}
        required
        fullWidth
        sx={{ '& .MuiInputBase-input': { fontSize: '1.5rem', fontWeight: 600 } }}
      />
      <Box sx={{ pt: 2 }}>
        <SaveStatus state={saveState} />
      </Box>
    </Box>
  );
}
