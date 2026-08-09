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
 * It shows every station in the company, deliberately. There was a `filteredStations` prop that
 * narrowed the list, left over from a scan flow that no longer exists — no caller ever passed it,
 * so every render already showed the full list and the prop was a description of behaviour the
 * component did not have.
 *
 * ## It does NOT name the company, and that is the second answer to the same problem
 *
 * This screen used to identify nothing: the jobs page hides its toolbar while the picker is up
 * and the layout hides the bottom nav, so the card was the whole screen, while the operator LOGIN
 * page one step earlier does show the company name — it appeared, then vanished at exactly the
 * moment you commit to a working context.
 *
 * The fix belongs in the header, not here. `OperatorCompanyLabel` fills the AppBar's centre slot
 * whenever no station is chosen, which covers this card AND the screens where it is absent —
 * "Me" and Inventory are both reachable before a station is picked. An interim version put the
 * name in both places, and on this screen it rendered twice within about 100px. One fact, one
 * place: the header owns company identity, this card owns the task.
 */
export default function StationSelector({
  subtitle,
}: {
  subtitle?: string;
} = {}) {
  const { stations, setStation, loading } = useStationContext();

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

          {stations.length === 0 ? (
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
              {stations.map((station) => (
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
