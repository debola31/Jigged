'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import { useStationContext } from '@/components/operator/OperatorStationContext';

/**
 * Station Selector prompt.
 *
 * Shown when no station is selected. Displays available stations
 * as large tappable buttons so the operator can pick one.
 *
 * When `filteredStations` is provided (e.g. from a job QR scan),
 * only those stations are shown instead of all company stations.
 */
export default function StationSelector({
  filteredStations,
  subtitle,
}: {
  filteredStations?: Array<{ id: string; name: string }>;
  subtitle?: string;
} = {}) {
  const { stations, setStation, loading } = useStationContext();

  const displayStations = filteredStations || stations;

  if (loading) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '40vh',
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box sx={{ py: 4 }}>
      <Card
        elevation={2}
        sx={{
          bgcolor: 'rgba(26, 31, 74, 0.55)',
          backdropFilter: 'blur(8px)',
        }}
      >
        <CardContent sx={{ textAlign: 'center', py: 4 }}>
          <Typography variant="h5" fontWeight={600} sx={{ mb: 1 }}>
            Select Your Station
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 4 }}>
            {subtitle || 'Choose the station you are working at to continue.'}
          </Typography>

          {displayStations.length === 0 ? (
            <Typography variant="body1" color="text.secondary">
              No stations available. Please contact your supervisor.
            </Typography>
          ) : (
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                gap: 1.5,
                maxWidth: 400,
                mx: 'auto',
              }}
            >
              {displayStations.map((station) => (
                <Button
                  key={station.id}
                  variant="outlined"
                  size="large"
                  onClick={() => setStation(station.id)}
                  sx={{
                    minHeight: 56,
                    fontSize: '1.1rem',
                    fontWeight: 500,
                    justifyContent: 'flex-start',
                    px: 3,
                    borderColor: 'rgba(255, 255, 255, 0.2)',
                    '&:hover': {
                      borderColor: '#D4872A',
                      bgcolor: 'rgba(212, 135, 42, 0.08)',
                    },
                  }}
                >
                  {station.name}
                </Button>
              ))}
            </Box>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}
