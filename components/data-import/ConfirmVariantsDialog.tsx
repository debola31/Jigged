'use client';

import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { findVariantGroups } from '@/lib/dataImportActions';
import { ENTITY_LABELS } from '@/lib/dataImportSchema';
import type { WorkingFile } from '@/lib/dataImportEditing';

interface ConfirmVariantsDialogProps {
  file: WorkingFile;
  colId: string;
  onMerge: (colId: string, canonical: string, variants: string[]) => void;
  onClose: () => void;
}

/**
 * "These two names look alike — are they the same part?"
 *
 * The research is emphatic and counterintuitive here: explanations and confidence scores make
 * NON-EXPERTS trust a wrong suggestion MORE ("explanations increase blind trust rather than
 * appropriate reliance", worst in novices — MSR Aether over-reliance review). So this shows no
 * score and no reasoning. It puts the two records side by side with the other things we know
 * about them, and asks the owner — who knows their shop — to state the conclusion. That's a
 * cognitive forcing function: the named mitigation that actually reduces over-reliance.
 *
 * One decision per screen, and either answer moves on: "keep separate" is a real answer, not
 * a dismissal.
 */
export default function ConfirmVariantsDialog({ file, colId, onMerge, onClose }: ConfirmVariantsDialogProps) {
  const groups = useMemo(() => findVariantGroups(file, colId), [file, colId]);
  const [index, setIndex] = useState(0);

  if (!groups.length) return null;
  const group = groups[Math.min(index, groups.length - 1)];
  const entity = ENTITY_LABELS[file.entityType].toLowerCase().replace(/s$/, '');

  const next = () => {
    if (index + 1 >= groups.length) onClose();
    else setIndex((i) => i + 1);
  };

  const keepSeparate = () => next();

  const same = () => {
    // Merge onto the spelling they use most — a fact from their data, not a preference of ours.
    const ranked = [...group.variants].sort((a, b) => b.count - a.count);
    const canonical = ranked[0].value;
    const rest = ranked.slice(1).map((v) => v.value);
    onMerge(colId, canonical, rest);
    next();
  };

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 700 }}>Are these the same {entity}?</DialogTitle>
      <DialogContent dividers>
        <Typography sx={{ mb: 2.5 }}>
          You know your shop — we don&apos;t. If they&apos;re the same, we&apos;ll combine them into one{' '}
          {entity}.
        </Typography>

        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}>
          {group.variants.map((v) => (
            <VariantCard key={v.value} file={file} colId={colId} value={v.value} count={v.count} />
          ))}
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
          {index + 1} of {groups.length}
        </Typography>
        <Button onClick={onClose}>Finish later</Button>
        <Button onClick={keepSeparate}>No — keep separate</Button>
        <Button variant="contained" onClick={same}>
          Yes — same {entity}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** The evidence: everything else we know about the rows carrying this spelling. */
function VariantCard({
  file,
  colId,
  value,
  count,
}: {
  file: WorkingFile;
  colId: string;
  value: string;
  count: number;
}) {
  const row = file.rows.find((r) => (r[colId] ?? '').trim() === value);
  // Other columns worth judging by — skip blanks and the name itself.
  const facts = (file.headers ?? [])
    .filter((h) => h !== colId)
    .map((h) => ({ h, v: (row?.[h] ?? '').trim() }))
    .filter((f) => f.v)
    .slice(0, 4);

  return (
    <Paper variant="outlined" sx={{ p: 1.75 }}>
      <Typography sx={{ fontWeight: 700, wordBreak: 'break-word', mb: 1 }}>{value}</Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 0.5, columnGap: 1.25 }}>
        <Typography variant="caption" color="text.secondary">
          Rows
        </Typography>
        <Typography variant="caption">{count.toLocaleString()}</Typography>
        {facts.map((f) => (
          <Box key={f.h} sx={{ display: 'contents' }}>
            <Typography variant="caption" color="text.secondary" sx={{ wordBreak: 'break-word' }}>
              {f.h}
            </Typography>
            <Typography variant="caption" sx={{ wordBreak: 'break-word' }}>
              {f.v}
            </Typography>
          </Box>
        ))}
      </Box>
    </Paper>
  );
}
