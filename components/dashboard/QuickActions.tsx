'use client';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import Link from 'next/link';

interface QuickActionsProps {
  companyId: string;
}

/**
 * Quick action buttons. Jobs are created exclusively by converting an
 * accepted quote (see utils/quotesAccess#convertQuoteToJob), so there's
 * no "New Job" CTA here — the quote flow is the entry point.
 */
export default function QuickActions({ companyId }: QuickActionsProps) {
  return (
    <Card elevation={2}>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Quick Actions
        </Typography>
        <Box
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', sm: 'row' },
            gap: 2,
            mt: 2,
          }}
        >
          <Button
            component={Link}
            href={`/dashboard/${companyId}/quotes/new`}
            variant="contained"
            color="primary"
            startIcon={<AddIcon />}
            sx={{
              flex: { sm: 1 },
              py: 1.5,
            }}
          >
            New Quote
          </Button>
        </Box>
      </CardContent>
    </Card>
  );
}
