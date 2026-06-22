'use client';

import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';

interface DeleteIconButtonProps {
  /** Required — describes what gets deleted (e.g. "Delete note"). Also used as the tooltip when `tooltip` is omitted. */
  ariaLabel: string;
  onClick: () => void;
  disabled?: boolean;
  /** Tooltip text. Defaults to `ariaLabel`. Pass `null` to render no tooltip. */
  tooltip?: string | null;
  /** Render at the end edge of a MUI `ListItem` secondaryAction. */
  edge?: 'end' | false;
  size?: 'small' | 'medium';
}

/**
 * The one destructive row-action affordance. Per docs/interaction-standards.md
 * a delete control is an **error-colored trash icon shown at rest** (never
 * grey-until-hover) — this preset bakes that in so it can't be re-hand-rolled
 * wrong. Low-emphasis ghost icon (no filled-red background); confirmation
 * friction (dialog vs inline+undo) is the caller's responsibility, scaled to
 * the consequence.
 */
export default function DeleteIconButton({
  ariaLabel,
  onClick,
  disabled = false,
  tooltip,
  edge = false,
  size = 'small',
}: DeleteIconButtonProps) {
  const button = (
    <IconButton
      edge={edge}
      size={size}
      color="error"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
    >
      <DeleteOutlineIcon fontSize="small" />
    </IconButton>
  );

  const title = tooltip === undefined ? ariaLabel : tooltip;
  if (!title) return button;

  // A disabled IconButton swallows pointer events; wrap so the tooltip still shows.
  return (
    <Tooltip title={title}>
      <span>{button}</span>
    </Tooltip>
  );
}
