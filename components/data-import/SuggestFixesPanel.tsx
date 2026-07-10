'use client';

import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import CloseIcon from '@mui/icons-material/Close';
import type { FixSuggestion } from '@/types/data-import';

interface SuggestFixesPanelProps {
  suggestions: FixSuggestion[] | null; // null = not requested yet
  loading: boolean;
  available: boolean;
  onRequest: () => void;
}

/**
 * Guardrail-bound AI suggestions: fires only on an explicit click, proposes plain-language
 * steps the owner takes with the deterministic fix tools, shows honest uncertainty (never a
 * confidence score), and NEVER changes data — the owner disposes. Research: low-literacy users
 * over-trust AI, so this suggests, it doesn't act.
 */
export default function SuggestFixesPanel({
  suggestions,
  loading,
  available,
  onRequest,
}: SuggestFixesPanelProps) {
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());

  if (suggestions === null) {
    return (
      <Box sx={{ mb: 2, display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
        <Button variant="outlined" startIcon={<AutoAwesomeIcon />} disabled={loading} onClick={onRequest}>
          {loading ? 'Thinking…' : 'Suggest how to fix these'}
        </Button>
        <Typography variant="caption" color="text.secondary">
          Uses AI to suggest steps — it never changes your data. You decide what to do.
        </Typography>
      </Box>
    );
  }

  if (!available) {
    return (
      <Alert severity="info" sx={{ mb: 2 }}>
        AI suggestions aren&apos;t available right now — the fix tools below still work.
      </Alert>
    );
  }

  const visible = suggestions.map((s, i) => ({ s, i })).filter(({ i }) => !dismissed.has(i));
  if (visible.length === 0) return null;

  return (
    <Card variant="outlined" sx={{ mb: 2 }}>
      <CardContent>
        <Typography
          variant="subtitle2"
          sx={{ mb: 1, display: 'flex', alignItems: 'center', gap: 0.5 }}
        >
          <AutoAwesomeIcon fontSize="small" /> Suggested fixes
        </Typography>
        <Stack spacing={1.25}>
          {visible.map(({ s, i }) => (
            <Box key={i} sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
              <Box sx={{ flex: 1 }}>
                <Typography variant="body2">{s.action}</Typography>
                {s.uncertainty && (
                  <Typography variant="caption" color="warning.main" sx={{ display: 'block' }}>
                    Not sure: {s.uncertainty}
                  </Typography>
                )}
              </Box>
              <IconButton
                size="small"
                aria-label="dismiss suggestion"
                onClick={() => setDismissed((d) => new Set(d).add(i))}
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            </Box>
          ))}
        </Stack>
      </CardContent>
    </Card>
  );
}
