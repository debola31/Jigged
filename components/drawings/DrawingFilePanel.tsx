'use client';

/**
 * The drawing, beside the row it produced.
 *
 * WHY A WIDE PANEL AND NOT A DRAWER. The job here is a glance, not a study: *does
 * this row match the sheet?* That is a comparison, so the two things have to be on
 * screen at once — a modal covers the row you are checking, and checking 31 rows
 * through a modal is 31 open-and-close cycles. The Storage drawer is 460px, which
 * is right for a list of places and hopeless for an E-size drawing: a title block
 * at that width is unreadable, which would make the panel decorative.
 *
 * So it is a panel that takes about half the screen and FOLLOWS the selected row.
 * Checking the package becomes clicking down the table, and the table survives the
 * squeeze because it is only Part and Description now.
 *
 * NO UPLOAD, NO NETWORK. Every row still holds its `File`, so this is an object
 * URL — the drawing appears instantly and nothing has been created yet, which is
 * the whole promise of the review step.
 *
 * PDF AND STEP BOTH RENDER — the sheet through pdf.js with zoom and pan, the model
 * through the same viewer the part page uses. DXF does not: that viewer is its own
 * piece of work (fonts have to be self-hosted or no text draws at all), and on a
 * real package the DXF is what the EXTRACTOR reads while the PDF is what a person
 * does.
 *
 * NOTHING HERE DOWNLOADS. These files came off this machine ten seconds ago; an
 * "open in a new tab" and a download button offered someone their own file back.
 */

import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import DrawingPdfView from '@/components/drawings/DrawingPdfView';
import StepViewer from '@/components/parts/workspace/tabs/StepViewer';
import Card from '@mui/material/Card';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import KeyboardDoubleArrowRightIcon from '@mui/icons-material/KeyboardDoubleArrowRight';

import type { BuiltRow } from '@/lib/drawingImportExtract';
import type { DrawingFile } from '@/types/drawingImport';
import { valueOf } from '@/types/drawingImport';

interface Props {
  row: BuiltRow;
  onClose: () => void;
}

/** What we can actually draw — see the module comment for why DXF is not here. */
const isViewable = (f: DrawingFile) => f.kind === 'pdf' || f.kind === 'step';

export default function DrawingFilePanel({ row, onClose }: Props) {
  const files = row.group.files;

  // The PDF first, because it is the one a person reads.
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const selected = useMemo(() => {
    const byName = files.find((f) => f.name === selectedName);
    return byName ?? files.find(isViewable) ?? files[0] ?? null;
  }, [files, selectedName]);

  return (
    <Card
      sx={{
        display: 'flex',
        flexDirection: 'column',
        width: { xs: '100%', md: '46%' },
        minWidth: { md: 420 },
        alignSelf: 'stretch',
        overflow: 'hidden',
      }}
      data-testid="drawing-file-panel"
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1.5,
          py: 1,
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Typography variant="subtitle2" noWrap sx={{ flex: 1, minWidth: 0 }}>
          {valueOf(row, 'part_name')}
        </Typography>
        {/*
          A collapse, not a close — an X here sat inches from the X that drops a
          part, and the two would have meant very different things.
        */}
        <Tooltip title="Hide the drawing">
          <IconButton size="small" onClick={onClose} aria-label="Hide the drawing">
            <KeyboardDoubleArrowRightIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>

      {files.length > 1 && (
        <Box sx={{ display: 'flex', gap: 0.5, px: 1.5, py: 1, flexWrap: 'wrap' }}>
          {files.map((f) => (
            <Button
              key={f.name}
              size="small"
              variant={selected?.name === f.name ? 'contained' : 'outlined'}
              onClick={() => setSelectedName(f.name)}
              sx={{ textTransform: 'uppercase', minWidth: 0, px: 1 }}
            >
              {f.kind}
            </Button>
          ))}
        </Box>
      )}

      <Box sx={{ flex: 1, minHeight: 460, display: 'flex', flexDirection: 'column' }}>
        {selected?.kind === 'pdf' ? (
          <DrawingPdfView key={selected.name} file={selected.file} />
        ) : selected?.kind === 'step' ? (
          <StepViewer key={selected.name} file={selected.file} height="100%" />
        ) : (
          <Box
            sx={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 1.5,
              p: 3,
              textAlign: 'center',
            }}
          >
            <Typography variant="body2" color="text.secondary">
              {selected
                ? `A ${selected.kind.toUpperCase()} is what we read, not what you look at — open the PDF for the sheet.`
                : 'This part arrived with no files.'}
            </Typography>
          </Box>
        )}
      </Box>
    </Card>
  );
}
