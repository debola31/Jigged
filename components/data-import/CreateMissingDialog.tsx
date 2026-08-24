'use client';

import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { ENTITY_LABELS } from '@/lib/dataImportSchema';
import type { AutoCreateLink, CreateEntry, MissingParent } from '@/lib/dataImportLinks';

interface CreateMissingDialogProps {
  /** Mounted only when there's something to create, keyed by finding — so the suggestions
   *  below seed once, from real data, with no state-syncing effect. */
  link: AutoCreateLink;
  missing: MissingParent[];
  onClose: () => void;
  onConfirm: (entries: CreateEntry[]) => void;
}

/**
 * The answer to "6,565 routing steps reference a work center that isn't in your upload."
 *
 * Instead of sending the owner back to a CSV they exported from a system they may not even
 * run anymore, we show the exact names we couldn't match and offer to create them here. Two
 * research constraints shape this: (1) never create records silently — the owner confirms
 * (they're the only one who knows their shop); (2) where we guess (internal vs outsourced),
 * say plainly that it's a guess and make it one tap to flip, rather than dressing it up with
 * a confidence score that invites over-trust.
 */
export default function CreateMissingDialog({ link, missing, onClose, onConfirm }: CreateMissingDialogProps) {
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());

  const parentLabel = ENTITY_LABELS[link.parentEntity].toLowerCase();
  const childLabel = ENTITY_LABELS[link.childEntity].toLowerCase();
  const chosen = useMemo(() => missing.filter((m) => !excluded.has(m.name)), [missing, excluded]);

  const toggle = (name: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const confirm = () => onConfirm(chosen.map((m) => ({ name: m.name })));

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 700 }}>
        {`Add the ${missing.length} ${parentLabel} we couldn't find?`}
      </DialogTitle>
      <DialogContent dividers>
        <Typography variant="body1" sx={{ mb: 2 }}>
          Your {childLabel} mention these {parentLabel}, but they aren&apos;t in the files you uploaded. We can add them as
          part of the import so everything connects.
        </Typography>

        <Stack divider={<Divider flexItem />}>
          {missing.map((m) => {
            const included = !excluded.has(m.name);
            return (
              <Box key={m.name} sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1, flexWrap: 'wrap' }}>
                <Checkbox checked={included} onChange={() => toggle(m.name)} sx={{ p: 0.5 }} />
                <Box sx={{ flex: 1, minWidth: 160 }}>
                  <Typography sx={{ fontWeight: 600, opacity: included ? 1 : 0.5 }}>{m.name}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    used by {m.refCount.toLocaleString()} {childLabel} row{m.refCount === 1 ? '' : 's'}
                  </Typography>
                </Box>
              </Box>
            );
          })}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
          {chosen.length === 0
            ? 'Nothing selected'
            : `Adding ${chosen.length} ${parentLabel}`}
        </Typography>
        <Button onClick={onClose}>Not now</Button>
        <Button variant="contained" onClick={confirm} disabled={chosen.length === 0}>
          Add {chosen.length} {parentLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
