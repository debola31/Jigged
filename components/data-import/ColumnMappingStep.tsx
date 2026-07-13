'use client';

import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Collapse from '@mui/material/Collapse';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import ReportProblemOutlinedIcon from '@mui/icons-material/ReportProblemOutlined';
import { ENTITY_FIELDS, ENTITY_LABELS, KNOWN_ENTITIES } from '@/lib/dataImportSchema';
import type { WorkingFile } from '@/lib/dataImportEditing';
import type { EntityType } from '@/types/data-import';

interface ColumnMappingStepProps {
  files: WorkingFile[];
  onEntityChange: (fileIndex: number, entityType: EntityType) => void;
  onRoleChange: (fileIndex: number, field: string, rawHeader: string) => void;
}

const ENTITY_OPTIONS: EntityType[] = [...KNOWN_ENTITIES, 'unknown'];
const CONFIDENCE_THRESHOLD = 0.7;

/** A few distinct, non-blank example values from a column — so a non-technical owner
 *  recognizes their DATA, not a field name. */
function sampleValues(file: WorkingFile, header: string, n = 3): string[] {
  const out: string[] = [];
  for (const row of file.rows) {
    const v = (row[header] ?? '').trim();
    if (v && !out.includes(v)) {
      out.push(v);
      if (out.length >= n) break;
    }
  }
  return out;
}

/**
 * The **Map** stage, reframed for a non-technical owner: instead of a field-by-field grid,
 * we TELL them what we understood from each file and only ask about the few things we're
 * unsure of (a low-confidence file type, or a missing required field). Confident matches are
 * shown, not re-confirmed; the full column-by-column mapping is tucked behind "see details"
 * for the rare power user. Everything is still correctable later in the Review grid.
 */
export default function ColumnMappingStep({
  files,
  onEntityChange,
  onRoleChange,
}: ColumnMappingStepProps) {
  return (
    <Stack spacing={2}>
      {files.map((f, i) => (
        <FileReviewCard
          key={f.filename}
          file={f}
          index={i}
          onEntityChange={onEntityChange}
          onRoleChange={onRoleChange}
        />
      ))}
    </Stack>
  );
}

function FileReviewCard({
  file,
  index,
  onEntityChange,
  onRoleChange,
}: {
  file: WorkingFile;
  index: number;
  onEntityChange: (fileIndex: number, entityType: EntityType) => void;
  onRoleChange: (fileIndex: number, field: string, rawHeader: string) => void;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const [changingType, setChangingType] = useState(false);

  const isUnknown = file.entityType === 'unknown' || (file.entityConfidence ?? 1) < CONFIDENCE_THRESHOLD;
  const fields = ENTITY_FIELDS[file.entityType] ?? [];
  const missingRequired = fields.filter((f) => f.required && !file.columnRoles[f.key]);
  const usedHeaders = new Set(Object.values(file.columnRoles));
  const unused = file.headers.filter((h) => !usedHeaders.has(h));

  const state: 'ok' | 'needs' | 'unknown' = isUnknown
    ? 'unknown'
    : missingRequired.length > 0
      ? 'needs'
      : 'ok';

  const StatusIcon =
    state === 'ok' ? CheckCircleIcon : state === 'needs' ? ReportProblemOutlinedIcon : HelpOutlineIcon;
  const statusColor =
    state === 'ok' ? 'success.main' : state === 'needs' ? 'warning.main' : 'info.main';

  const entityPicker = (
    <FormControl size="small" sx={{ minWidth: 200 }}>
      <InputLabel id={`entity-${index}`}>What kind of data is this?</InputLabel>
      <Select
        labelId={`entity-${index}`}
        label="What kind of data is this?"
        value={file.entityType}
        onChange={(e) => {
          onEntityChange(index, e.target.value as EntityType);
          setChangingType(false);
        }}
      >
        {ENTITY_OPTIONS.map((et) => (
          <MenuItem key={et} value={et}>
            {ENTITY_LABELS[et]}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );

  return (
    <Card variant="outlined">
      <CardContent>
        {/* Header: status + what it is + row count */}
        <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <StatusIcon sx={{ color: statusColor, mt: 0.25 }} />
          <Box sx={{ flex: 1, minWidth: 200 }}>
            {state === 'unknown' ? (
              <Typography sx={{ fontWeight: 600 }}>
                We couldn&apos;t tell what {file.filename} is
              </Typography>
            ) : (
              <Typography sx={{ fontWeight: 600 }}>
                {file.filename} looks like your <strong>{ENTITY_LABELS[file.entityType]}</strong>
              </Typography>
            )}
            <Typography variant="body2" color="text.secondary">
              {file.rows.length.toLocaleString()} rows
              {state === 'ok' && ' · we matched everything we need'}
            </Typography>
          </Box>
          {state !== 'unknown' && !changingType && (
            <Button size="small" onClick={() => setChangingType(true)}>
              Not {ENTITY_LABELS[file.entityType].toLowerCase()}?
            </Button>
          )}
        </Box>

        {/* What is this? (low confidence) or the "change type" picker */}
        {(state === 'unknown' || changingType) && (
          <Box sx={{ mt: 2 }}>
            {state === 'unknown' && (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                Tell us what this file holds so we can bring it in (or skip it).
              </Typography>
            )}
            {entityPicker}
          </Box>
        )}

        {/* One question per missing required field — recognized by sample values, not field names */}
        {state === 'needs' && (
          <Stack spacing={1.5} sx={{ mt: 2 }}>
            {missingRequired.map((field) => (
              <Box key={field.key}>
                <Typography variant="body2" sx={{ mb: 0.5 }}>
                  Which column has the <strong>{field.label.toLowerCase()}</strong>?
                </Typography>
                <FormControl size="small" sx={{ minWidth: 280 }} error>
                  <Select
                    value=""
                    displayEmpty
                    onChange={(e) => onRoleChange(index, field.key, e.target.value as string)}
                  >
                    <MenuItem value="" disabled>
                      Pick a column…
                    </MenuItem>
                    {file.headers.map((h) => {
                      const ex = sampleValues(file, h);
                      return (
                        <MenuItem key={h} value={h}>
                          {h}
                          {ex.length > 0 && (
                            <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                              — {ex.join(', ')}
                            </Typography>
                          )}
                        </MenuItem>
                      );
                    })}
                  </Select>
                </FormControl>
              </Box>
            ))}
          </Stack>
        )}

        {/* Reassurance + the power-user grid, tucked away */}
        {unused.length > 0 && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
            Extra columns we&apos;ll skip: {unused.join(', ')}
          </Typography>
        )}
        {fields.length > 0 && (
          <>
            <Button size="small" sx={{ mt: 1 }} onClick={() => setShowDetails((v) => !v)}>
              {showDetails ? 'Hide details' : 'See how we matched each column'}
            </Button>
            <Collapse in={showDetails}>
              <Stack spacing={1} sx={{ mt: 1 }}>
                {fields.map((field) => (
                  <Box key={field.key} sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Typography variant="body2" sx={{ minWidth: 180 }}>
                      {field.label}
                      {field.required && ' *'}
                    </Typography>
                    <FormControl size="small" sx={{ minWidth: 220 }} error={field.required && !file.columnRoles[field.key]}>
                      <Select
                        value={file.columnRoles[field.key] ?? ''}
                        displayEmpty
                        onChange={(e) => onRoleChange(index, field.key, e.target.value as string)}
                      >
                        <MenuItem value="">
                          <em>— not in this file —</em>
                        </MenuItem>
                        {file.headers.map((h) => (
                          <MenuItem key={h} value={h}>
                            {h}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  </Box>
                ))}
              </Stack>
            </Collapse>
          </>
        )}
      </CardContent>
    </Card>
  );
}
