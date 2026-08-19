'use client';

/**
 * Which of these parts is this quote for?
 *
 * A package is rarely a quote. The shop imported everything the customer sent and
 * is answering an enquiry about some of it, so the choice belongs here — before
 * the quote form, where removing a line means removing it from a document that
 * already exists.
 *
 * EVERY PART IS OFFERED, PRICED OR NOT. The earlier version quietly filtered to
 * the ones that could carry a price, which meant the parts most needing attention
 * were the ones it never mentioned. The quote form names each gap and links
 * straight to the part, so it is a better place to finish that work than a list
 * that pretended those parts did not exist — and a part with no price is still a
 * line someone can type a price onto.
 *
 * What this screen owes them is the difference, plainly: which lines will arrive
 * ready and which will want a number.
 */

import { useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';

import type { CreatedRow } from '@/utils/drawingImportCreate';

interface Props {
  open: boolean;
  parts: CreatedRow[];
  onClose: () => void;
  onConfirm: (partIds: string[]) => void;
}

export default function QuotePartPicker({ open, parts, onClose, onConfirm }: Props) {
  // Only parts that actually exist can go on a quote; a failed row has no id.
  const available = useMemo(() => parts.filter((p) => p.partId), [parts]);
  /**
   * Everything is chosen to begin with: the common case is quoting the package
   * that was just imported, and making someone tick thirty-one boxes to reach the
   * default is the wrong way round.
   *
   * Seeded as INITIAL state rather than synced by an effect — the caller mounts
   * this fresh per opening (`open` gates the render), so there is no stale
   * selection to correct and no cascading render to cause.
   */
  const [chosen, setChosen] = useState<Set<string>>(
    () => new Set(available.map((p) => p.partId as string)),
  );

  const toggle = (id: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allOn = available.length > 0 && chosen.size === available.length;
  const needsAPrice = available.filter((p) => chosen.has(p.partId as string) && !p.quotable).length;

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Which parts is this quote for?</DialogTitle>
      <DialogContent dividers>
        <FormControlLabel
          control={
            <Checkbox
              checked={allOn}
              indeterminate={chosen.size > 0 && !allOn}
              onChange={() =>
                setChosen(allOn ? new Set() : new Set(available.map((p) => p.partId as string)))
              }
            />
          }
          label={`All ${available.length}`}
        />

        <List dense sx={{ maxHeight: '46vh', overflowY: 'auto' }}>
          {available.map((p) => {
            const id = p.partId as string;
            return (
              <ListItem key={id} disableGutters sx={{ py: 0 }} data-testid="quote-part-option">
                <Checkbox
                  checked={chosen.has(id)}
                  onChange={() => toggle(id)}
                  inputProps={{ 'aria-label': `Quote ${p.partName}` }}
                />
                <ListItemText primary={p.partName} primaryTypographyProps={{ variant: 'body2' }} />
                {!p.quotable && (
                  <Chip size="small" color="warning" variant="outlined" label="needs a price" />
                )}
              </ListItem>
            );
          })}
        </List>

        {needsAPrice > 0 && (
          <Alert severity="info" sx={{ mt: 1 }}>
            {needsAPrice} of these {needsAPrice === 1 ? 'has' : 'have'} no price yet. They still go
            on the quote — each line links to its part, so you can set what it costs there and come
            back, or type a price straight onto the line.
          </Alert>
        )}

        {available.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            None of these parts were created, so there is nothing to quote.
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Box sx={{ flex: 1, pl: 1 }}>
          <Typography variant="caption" color="text.secondary">
            {chosen.size} of {available.length} selected
          </Typography>
        </Box>
        <Button onClick={onClose}>Cancel</Button>
        {/* Never disabled — interaction-standards §4. With nothing chosen it says so. */}
        <Button variant="contained" onClick={() => onConfirm([...chosen])}>
          Start the quote
        </Button>
      </DialogActions>
    </Dialog>
  );
}
