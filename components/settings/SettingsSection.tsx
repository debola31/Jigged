'use client';

import type { ReactNode } from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';

interface SettingsSectionProps {
  title: string;
  /** Optional status/label chip rendered inline to the right of the title. */
  statusChip?: ReactNode;
  /** One-line helper text under the title. Keep it short. */
  description?: ReactNode;
  /**
   * `default` — a standard settings block (elevation 2).
   * `advanced` — a de-emphasized block (outlined, muted heading) for rarely
   * used / destructive zones like Demo Mode, set apart from everyday settings.
   */
  variant?: 'default' | 'advanced';
  children: ReactNode;
}

/**
 * Shared wrapper giving every Settings block one compact, consistent header
 * rhythm — a single title row (with optional status chip), a one-line helper,
 * and the content — instead of each card re-implementing a heavy header +
 * divider. Density comes from cutting chrome, not shrinking controls.
 */
export default function SettingsSection({
  title,
  statusChip,
  description,
  variant = 'default',
  children,
}: SettingsSectionProps) {
  const advanced = variant === 'advanced';

  return (
    <Card
      elevation={advanced ? 0 : 2}
      variant={advanced ? 'outlined' : 'elevation'}
    >
      <CardContent sx={{ p: 2.5, '&:last-child': { pb: 2.5 } }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: description ? 0.5 : 2 }}>
          <Typography
            variant="h6"
            sx={{ fontWeight: 600, color: advanced ? 'text.secondary' : 'text.primary' }}
          >
            {title}
          </Typography>
          {statusChip}
        </Box>

        {description && (
          <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
            {description}
          </Typography>
        )}

        {children}
      </CardContent>
    </Card>
  );
}
