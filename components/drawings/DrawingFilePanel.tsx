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
 * DXF AND STEP ARE NOT RENDERED, and say so rather than showing an empty frame.
 * A DXF viewer is its own piece of work (fonts have to be self-hosted or no text
 * draws at all), and on real packages the PDF is the human-readable sheet anyway —
 * the DXF is what the extractor reads, not what a person does.
 */

import { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import DownloadIcon from '@mui/icons-material/Download';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';

import type { BuiltRow } from '@/lib/drawingImportExtract';
import type { DrawingFile } from '@/types/drawingImport';
import { valueOf } from '@/types/drawingImport';

interface Props {
  row: BuiltRow;
  onClose: () => void;
}

/** Only a PDF renders in a frame today — see the module comment. */
const isViewable = (f: DrawingFile) => f.kind === 'pdf';

export default function DrawingFilePanel({ row, onClose }: Props) {
  const files = row.group.files;

  // The PDF first, because it is the one a person reads.
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const selected = useMemo(() => {
    const byName = files.find((f) => f.name === selectedName);
    return byName ?? files.find(isViewable) ?? files[0] ?? null;
  }, [files, selectedName]);

  // DERIVED, not stored: the URL is a pure function of the chosen file, and
  // setting it from an effect meant a render pass with the frame pointing at the
  // previous drawing.
  const url = useMemo(
    () => (selected ? URL.createObjectURL(selected.file) : null),
    [selected],
  );

  // The effect exists only to hand the blob back — a 31-part package would
  // otherwise leave 31 drawings held in memory for the tab's lifetime.
  useEffect(() => {
    if (!url) return;
    return () => URL.revokeObjectURL(url);
  }, [url]);

  const download = () => {
    if (!url || !selected) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = selected.name;
    a.click();
  };

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
        {url && (
          <>
            <Tooltip title="Open in a new tab">
              <IconButton size="small" href={url} target="_blank" rel="noopener noreferrer">
                <OpenInNewIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Download">
              <IconButton size="small" onClick={download}>
                <DownloadIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </>
        )}
        <IconButton size="small" onClick={onClose} aria-label="Close the drawing">
          <CloseIcon fontSize="small" />
        </IconButton>
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

      <Box sx={{ flex: 1, minHeight: 420, display: 'flex' }}>
        {selected && isViewable(selected) && url ? (
          <Box
            component="iframe"
            src={url}
            title={`${selected.name} preview`}
            sx={{ flex: 1, border: 0, backgroundColor: '#fff' }}
          />
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
                ? `${selected.kind.toUpperCase()} files don’t preview here yet — open or download it to look.`
                : 'This part arrived with no files.'}
            </Typography>
            {selected && (
              <Button variant="outlined" startIcon={<DownloadIcon />} onClick={download}>
                Download {selected.name}
              </Button>
            )}
          </Box>
        )}
      </Box>
    </Card>
  );
}
