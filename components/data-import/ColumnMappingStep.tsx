'use client';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { ENTITY_FIELDS, ENTITY_LABELS, KNOWN_ENTITIES } from '@/lib/dataImportSchema';
import type { WorkingFile } from '@/lib/dataImportEditing';
import type { EntityType } from '@/types/data-import';

interface ColumnMappingStepProps {
  files: WorkingFile[];
  onEntityChange: (fileIndex: number, entityType: EntityType) => void;
  onRoleChange: (fileIndex: number, field: string, rawHeader: string) => void;
}

/**
 * The **Map** stage: for each uploaded file, confirm what it is and which column holds
 * each Jigged field. Pre-filled from the AI structure pass; the owner corrects anything
 * wrong before we run the review, so the review reflects the mapping they confirmed —
 * never an invisible guess. Kept to the review-relevant fields (identity / required /
 * referential / cost) so a correction here visibly changes the outcome.
 */
export default function ColumnMappingStep({
  files,
  onEntityChange,
  onRoleChange,
}: ColumnMappingStepProps) {
  const entityOptions: EntityType[] = [...KNOWN_ENTITIES, 'unknown'];

  return (
    <Stack spacing={2}>
      {files.map((f, i) => {
        const fields = ENTITY_FIELDS[f.entityType] ?? [];
        const usedHeaders = new Set(Object.values(f.columnRoles));
        const unused = f.headers.filter((h) => !usedHeaders.has(h));
        const isUnknown = f.entityType === 'unknown';

        return (
          <Card key={f.filename} variant="outlined">
            <CardContent>
              <Box
                sx={{
                  display: 'flex',
                  gap: 2,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  mb: isUnknown ? 0 : 2,
                }}
              >
                <Typography sx={{ fontWeight: 600, flex: '1 1 220px', wordBreak: 'break-all' }}>
                  {f.filename}
                </Typography>
                <FormControl size="small" sx={{ minWidth: 220 }}>
                  <InputLabel id={`entity-label-${i}`}>This file is…</InputLabel>
                  <Select
                    labelId={`entity-label-${i}`}
                    label="This file is…"
                    value={f.entityType}
                    onChange={(e) => onEntityChange(i, e.target.value as EntityType)}
                  >
                    {entityOptions.map((et) => (
                      <MenuItem key={et} value={et}>
                        {ENTITY_LABELS[et]}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <Chip size="small" label={`${f.rows.length.toLocaleString()} rows`} />
              </Box>

              {isUnknown ? (
                <Typography variant="body2" color="text.secondary">
                  We&apos;ll skip this file unless you tell us what it is.
                </Typography>
              ) : (
                <>
                  {fields.map((field) => {
                    const value = f.columnRoles[field.key] ?? '';
                    const missingRequired = field.required && !value;
                    return (
                      <Box
                        key={field.key}
                        sx={{ display: 'flex', gap: 1.5, alignItems: 'center', py: 0.5, flexWrap: 'wrap' }}
                      >
                        <Typography
                          variant="body2"
                          sx={{ minWidth: 200, fontWeight: field.required ? 600 : 400 }}
                        >
                          {field.label}
                          {field.required && ' *'}
                        </Typography>
                        <FormControl size="small" sx={{ minWidth: 240 }} error={missingRequired}>
                          <Select
                            value={value}
                            displayEmpty
                            onChange={(e) => onRoleChange(i, field.key, e.target.value as string)}
                          >
                            <MenuItem value="">
                              <em>— not in this file —</em>
                            </MenuItem>
                            {f.headers.map((h) => (
                              <MenuItem key={h} value={h}>
                                {h}
                              </MenuItem>
                            ))}
                          </Select>
                        </FormControl>
                        {missingRequired && (
                          <Typography variant="caption" color="error">
                            needed to import
                          </Typography>
                        )}
                      </Box>
                    );
                  })}
                  {unused.length > 0 && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                      Columns we won&apos;t import: {unused.join(', ')}
                    </Typography>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        );
      })}
    </Stack>
  );
}
