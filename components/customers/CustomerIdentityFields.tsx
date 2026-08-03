'use client';

import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';

import SaveStatus, { type SaveState } from '@/components/common/SaveStatus';
import type { CustomerFieldEditingProps } from '@/components/customers/customerFieldEditing';

/**
 * Company name + website, edited in place in the detail page's header card.
 *
 * Ported from components/parts/workspace/PartIdentitySection.tsx, which solved
 * this exact problem for parts — same audience, same all-columns update
 * function, same name-uniqueness-on-blur — and which is why /parts/{id}/edit no
 * longer exists. Matching a pattern that already shipped beats inventing one.
 *
 * The name is a heading-sized input rather than a click-to-reveal pencil. A
 * pencil hides the affordance behind a hover on the one field most likely to be
 * corrected, and the audience here is 50-60 year olds on an office desktop who
 * should not have to discover that text is editable. It reads as the title
 * because it is styled as the title.
 *
 * Uniqueness is checked on blur by the page, before the write — including the
 * case where the CHECK ITSELF FAILS, which is refused rather than reported as a
 * duplicate. See the persist handler on the detail page.
 */
export default function CustomerIdentityFields({
  form,
  fieldErrors,
  onTextChange,
  onTextBlur,
  readOnly,
  saveState,
}: CustomerFieldEditingProps & { saveState: SaveState }) {
  if (readOnly) return null;

  return (
    <Stack spacing={2} sx={{ maxWidth: 640 }}>
      <TextField
        label="Company name"
        value={form.name}
        onChange={(e) => onTextChange('name', e.target.value)}
        onBlur={onTextBlur}
        onKeyDown={(e) => {
          // Enter commits by blurring — the same write the blur handler does,
          // just without making the user reach for the mouse or Tab.
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        error={!!fieldErrors.name}
        helperText={fieldErrors.name || ' '}
        required
        fullWidth
        slotProps={{
          htmlInput: { 'aria-label': 'Company name' },
        }}
        sx={{ '& .MuiInputBase-input': { fontSize: '1.5rem', fontWeight: 600 } }}
      />
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <TextField
          label="Website"
          value={form.website}
          onChange={(e) => onTextChange('website', e.target.value)}
          onBlur={onTextBlur}
          placeholder="https://example.com"
          error={!!fieldErrors.website}
          helperText={fieldErrors.website || ' '}
          fullWidth
        />
        <SaveStatus state={saveState} />
      </Box>
    </Stack>
  );
}
