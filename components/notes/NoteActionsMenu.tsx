'use client';

import { useState } from 'react';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';

/**
 * Edit / Delete for one note on the OPERATOR surfaces — the job feed, the Playbook
 * sheet and the machine logbook (#628).
 *
 * WHY AN OVERFLOW MENU HERE AND TWO BARE ICONS ON THE OFFICE SURFACES. These note
 * header rows already carry an author name, an optional step chip and a timestamp,
 * and they already wrap at 375px. Two more 48px targets push every note's header
 * onto a third line. One overflow target costs a single row of chrome, and MUI
 * MenuItems are >= 48px under this theme, so the touch-target floor is met at the
 * point of CHOICE rather than at the point of disclosure — which is where it
 * actually matters, since a mis-tap on the kebab is harmless and a mis-tap on a
 * bare trash icon is not.
 *
 * The office Activity tab deliberately does NOT use this: docs/interaction-standards.md
 * requires the destructive control to be an error-coloured trash icon shown at rest,
 * and burying it behind a kebab would regress a rule that was argued for explicitly.
 * Desktop has the width and the hover; the phone constraint does not apply there.
 *
 * Renders nothing at all when neither action is available, so callers can drop it in
 * unconditionally rather than duplicating the permission test to decide whether to
 * mount it.
 */
export default function NoteActionsMenu({
  canEdit,
  canDelete,
  onEdit,
  onDelete,
  /** Distinguishes "note" from "comment" in the labels and aria text. */
  noun = 'note',
}: {
  canEdit: boolean;
  canDelete: boolean;
  onEdit: () => void;
  onDelete: () => void;
  noun?: string;
}) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  if (!canEdit && !canDelete) return null;

  const close = () => setAnchorEl(null);

  return (
    <>
      <IconButton
        aria-label={`Actions for this ${noun}`}
        onClick={(e) => setAnchorEl(e.currentTarget)}
        // 48px floor (design system). flexShrink so it survives a wrapping header.
        sx={{ width: 48, height: 48, flexShrink: 0 }}
      >
        <MoreVertIcon fontSize="small" />
      </IconButton>

      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={close}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        {canEdit && (
          <MenuItem
            onClick={() => {
              close();
              onEdit();
            }}
            sx={{ minHeight: 48 }}
          >
            <ListItemIcon>
              <EditOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Edit</ListItemText>
          </MenuItem>
        )}
        {canDelete && (
          <MenuItem
            onClick={() => {
              close();
              onDelete();
            }}
            sx={{ minHeight: 48, color: 'error.main' }}
          >
            <ListItemIcon>
              <DeleteOutlineIcon fontSize="small" color="error" />
            </ListItemIcon>
            <ListItemText>Delete</ListItemText>
          </MenuItem>
        )}
      </Menu>
    </>
  );
}
