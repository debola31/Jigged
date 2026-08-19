'use client';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';

interface AIAnalysisLoadingProps {
  description: string;
}

export default function AIAnalysisLoading({ description }: AIAnalysisLoadingProps) {
  return (
    <Card elevation={2}>
      <CardContent sx={{ p: 4, textAlign: 'center' }}>
        <CircularProgress size={64} sx={{ mb: 2 }} />
        <Typography variant="h6" gutterBottom>
          Analyzing Your CSV
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1 }}>
          <AutoAwesomeIcon sx={{ color: 'primary.main', fontSize: 20 }} />
          <Typography variant="body2" color="text.secondary">
            {description}
          </Typography>
        </Box>
      </CardContent>
    </Card>
  );
}
