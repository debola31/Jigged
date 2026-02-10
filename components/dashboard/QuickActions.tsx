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
 * Quick action buttons for creating new quotes and jobs.
 */
export default function QuickActions({ companyId }: QuickActionsProps) {
  return (
    <Card
      elevation={2}
      sx={{
        bgcolor: 'rgba(17, 20, 57, 0.6)',
        backdropFilter: 'blur(10px)',
      }}
    >
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
          <Button
            component={Link}
            href={`/dashboard/${companyId}/jobs/new`}
            variant="outlined"
            color="primary"
            startIcon={<AddIcon />}
            sx={{
              flex: { sm: 1 },
              py: 1.5,
            }}
          >
            New Job
          </Button>
        </Box>
      </CardContent>
    </Card>
  );
}
