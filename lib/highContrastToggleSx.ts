/**
 * High-contrast styling for ToggleButtonGroup on the dark theme.
 *
 * The default MUI ToggleButton is too subtle on Jigged's dark background —
 * the selected state blends in and a 50-60-year-old shop owner glancing at
 * the form on a tablet under fluorescent lighting can't tell which option
 * is active. This sx applies:
 *
 *   - Selected button: filled with primary.main, white text, slight shadow,
 *     bold typography. Reads as obviously "this is on" from across the room.
 *   - Unselected button: dashed border at 0.7 opacity, muted text. Reads as
 *     obviously "this is off" but still clickable.
 *
 * Apply by spreading onto a ToggleButtonGroup's `sx`:
 *   <ToggleButtonGroup sx={highContrastToggleSx}>
 *
 * If staging review still finds this too subtle, the iteration-2 fallback
 * is to swap the ToggleButtonGroup for two stacked clickable Cards. That's
 * a contained UI change with no schema impact.
 */
export const highContrastToggleSx = {
  '& .MuiToggleButton-root': {
    border: '1px dashed',
    borderColor: 'divider',
    color: 'text.secondary',
    opacity: 0.7,
    fontWeight: 500,
    transition: 'all 0.15s ease-in-out',
    '&:hover': {
      opacity: 1,
      bgcolor: 'action.hover',
    },
    '&.Mui-selected': {
      bgcolor: 'primary.main',
      color: 'primary.contrastText',
      borderStyle: 'solid',
      borderColor: 'primary.main',
      opacity: 1,
      fontWeight: 700,
      boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
      '&:hover': {
        bgcolor: 'primary.dark',
      },
    },
  },
} as const;
