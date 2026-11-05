'use client';

import { useState } from 'react';
import Box from '@mui/material/Box';
import Button, { type ButtonProps } from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Popover from '@mui/material/Popover';
import CloseIcon from '@mui/icons-material/Close';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import PrecisionManufacturingOutlinedIcon from '@mui/icons-material/PrecisionManufacturingOutlined';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import { EYEBROW_COLOR } from '@/components/marketing/marketingStyles';
import { shortName } from './glyphs';
import PilotRequest from './PilotRequest';
import { finishedStill, type LivePart } from './showcaseData';

/** Where a part was picked from: the intro's carousel, the shop's card before any part, the Change part menu, or the closing card's. */
export type PickSource = 'intro' | 'prompt' | 'menu' | 'finished';

const MENU_BG = 'rgba(17, 20, 57, 0.98)';

/** The pilot-request form in a dialog: the visitor's own part. */
export function PilotDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <Box sx={{ position: 'relative' }}>
        <IconButton onClick={onClose} aria-label="Close" sx={{ position: 'absolute', top: 8, right: 8, zIndex: 1 }}>
          <CloseIcon />
        </IconButton>
        <PilotRequest />
      </Box>
    </Dialog>
  );
}

/** A part's picture, small: the part as its last cut leaves it, or a machine while it has none. */
function Thumb({ part }: { part: LivePart }) {
  const still = finishedStill(part);
  return (
    <Box sx={{ width: 72, height: 54, borderRadius: 1, overflow: 'hidden', bgcolor: 'common.black', display: 'grid', placeItems: 'center', color: 'rgba(255, 255, 255, 0.25)', flexShrink: 0 }}>
      {still ? <Box component="img" src={still} alt="" sx={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <PrecisionManufacturingOutlinedIcon />}
    </Box>
  );
}

/**
 * A button that opens the live parts, each with its picture, to make another without leaving the
 * shop; the one showing is marked. The visitor's own part comes last, as in the intro.
 */
export function PartMenu({
  parts,
  current,
  onPick,
  source,
  label,
  buttonProps,
}: {
  parts: LivePart[];
  current: string;
  onPick(id: string, source: PickSource): void;
  source: PickSource;
  label: string;
  buttonProps?: ButtonProps;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [pilot, setPilot] = useState(false);
  return (
    <>
      <Button size="small" endIcon={<ExpandMoreIcon />} aria-haspopup="menu" onClick={(e) => setAnchor(e.currentTarget)} {...buttonProps}>
        {label}
      </Button>
      <Popover
        open={!!anchor}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { sx: { width: 340, maxHeight: '70vh', bgcolor: MENU_BG, colorScheme: 'dark' } } }}
      >
        <List aria-label="Parts" sx={{ py: 0.5 }}>
          {parts.map((p) => (
            <ListItemButton
              key={p.id}
              selected={p.id === current}
              aria-current={p.id === current ? 'true' : undefined}
              onClick={() => {
                setAnchor(null);
                if (p.id !== current) onPick(p.id, source);
              }}
              sx={{ gap: 1.5 }}
            >
              <Thumb part={p} />
              <ListItemText
                primary={shortName(p)}
                secondary={p.id === current ? 'Showing now' : `${p.steps.length} steps`}
                slotProps={{ primary: { sx: { fontWeight: 600 } } }}
              />
            </ListItemButton>
          ))}
          <ListItemButton
            onClick={() => {
              setAnchor(null);
              setPilot(true);
            }}
            sx={{ gap: 1.5, borderTop: '1px solid rgba(255, 255, 255, 0.08)' }}
          >
            <ListItemIcon sx={{ minWidth: 0, width: 72, justifyContent: 'center', color: EYEBROW_COLOR }}>
              <UploadFileOutlinedIcon />
            </ListItemIcon>
            <ListItemText primary="Your own part" secondary="Send a CAD file or drawing" slotProps={{ primary: { sx: { fontWeight: 600 } } }} />
          </ListItemButton>
        </List>
      </Popover>
      <PilotDialog open={pilot} onClose={() => setPilot(false)} />
    </>
  );
}
