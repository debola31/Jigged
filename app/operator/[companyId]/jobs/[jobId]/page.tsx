'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardActionArea from '@mui/material/CardActionArea';
import Chip from '@mui/material/Chip';
import LinearProgress from '@mui/material/LinearProgress';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import IconButton from '@mui/material/IconButton';
import Button from '@mui/material/Button';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';

import { getOperatorJobParts } from '@/utils/operatorAccess';
import type { OperatorJobPartSummary } from '@/types/operator';

/**
 * Operator parts hub. When an operator scans a job QR code, they land here.
 * If the job has only one part, this page redirects directly to its work
 * view. If the job has multiple parts, the operator picks which part they
 * are physically holding before drilling into Start/Stop/Complete.
 */
export default function OperatorJobPartsHubPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const jobId = params.jobId as string;

  const [parts, setParts] = useState<OperatorJobPartSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const navigateToPart = useCallback(
    (jobPartId: string) => {
      router.replace(`/operator/${companyId}/jobs/${jobId}/parts/${jobPartId}`);
    },
    [companyId, jobId, router],
  );

  const loadParts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getOperatorJobParts(jobId, companyId);
      if (data.length === 0) {
        setParts([]);
      } else if (data.length === 1) {
        navigateToPart(data[0].id);
        return;
      } else {
        setParts(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load job');
    } finally {
      setLoading(false);
    }
  }, [companyId, jobId, navigateToPart]);

  useEffect(() => {
    loadParts();
  }, [loadParts]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="error">{error}</Alert>
      </Box>
    );
  }

  if (!parts || parts.length === 0) {
    return (
      <Box sx={{ p: 2, textAlign: 'center', py: 6 }}>
        <Typography variant="h6" color="text.secondary" sx={{ mb: 2 }}>
          This job has no parts.
        </Typography>
        <Button variant="outlined" onClick={() => router.push(`/operator/${companyId}/jobs`)}>
          Back to jobs
        </Button>
      </Box>
    );
  }

  return (
    <Box>
      <IconButton
        onClick={() => router.push(`/operator/${companyId}/jobs`)}
        sx={{ mb: 2 }}
        aria-label="Back to jobs list"
      >
        <ArrowBackIcon />
      </IconButton>

      <Typography variant="h5" component="h1" sx={{ fontWeight: 700, mb: 0.5 }}>
        Pick a part
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        This job has {parts.length} parts. Tap the one you&apos;re working on.
      </Typography>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {parts.map((part) => {
          const progressPct =
            part.operations_total > 0
              ? (part.operations_completed / part.operations_total) * 100
              : 0;
          const done = part.production_status === 'completed';
          return (
            <Card
              key={part.id}
              elevation={2}
              sx={{
                bgcolor: done ? 'rgba(50, 200, 100, 0.08)' : 'rgba(26, 31, 74, 0.55)',
                backdropFilter: 'blur(8px)',
                opacity: done ? 0.7 : 1,
              }}
            >
              <CardActionArea
                onClick={() => navigateToPart(part.id)}
                disabled={done}
                sx={{ p: 0 }}
              >
                <CardContent>
                  <Box
                    sx={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      mb: 1,
                      gap: 1,
                    }}
                  >
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="h6" fontWeight={700}>
                        {part.part_name}
                      </Typography>
                      {part.part_description && (
                        <Typography variant="body2" color="text.secondary" noWrap>
                          {part.part_description}
                        </Typography>
                      )}
                      <Typography variant="caption" color="text.secondary">
                        Order qty {part.quantity}
                      </Typography>
                    </Box>
                    <Chip
                      size="small"
                      label={part.production_status}
                      color={
                        part.production_status === 'in_progress'
                          ? 'primary'
                          : part.production_status === 'completed'
                            ? 'success'
                            : 'default'
                      }
                    />
                  </Box>

                  {part.next_operation_name ? (
                    <Typography variant="body2" sx={{ mb: 1 }}>
                      Next: <strong>{part.next_operation_name}</strong>
                    </Typography>
                  ) : (
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                      No ready operations
                    </Typography>
                  )}

                  <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                    <Typography variant="caption" color="text.secondary">
                      Progress
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {part.operations_completed} / {part.operations_total}
                    </Typography>
                  </Box>
                  <LinearProgress
                    variant="determinate"
                    value={progressPct}
                    sx={{ height: 6, borderRadius: 1 }}
                  />
                </CardContent>
              </CardActionArea>
            </Card>
          );
        })}
      </Box>
    </Box>
  );
}
