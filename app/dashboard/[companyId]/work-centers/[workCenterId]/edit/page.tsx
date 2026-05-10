'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { WorkCenterForm } from '@/components/work-centers';
import { getWorkCenter } from '@/utils/workCentersAccess';
import { workCenterToFormData, EMPTY_WORK_CENTER_FORM } from '@/types/workCenter';
import type { WorkCenterFormData } from '@/types/workCenter';

export default function WorkCenterEditPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const workCenterId = params.workCenterId as string;

  const [initialData, setInitialData] = useState<WorkCenterFormData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchWorkCenter() {
      try {
        const wc = await getWorkCenter(workCenterId);
        if (!wc) {
          setError('Work center not found');
          setInitialData(EMPTY_WORK_CENTER_FORM);
        } else {
          setInitialData(workCenterToFormData(wc));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
        setInitialData(EMPTY_WORK_CENTER_FORM);
      } finally {
        setLoading(false);
      }
    }
    fetchWorkCenter();
  }, [workCenterId]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return (
      <Alert severity="error" sx={{ mb: 3 }}>
        {error}
      </Alert>
    );
  }

  if (!initialData) {
    return null;
  }

  return (
    <Box>
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => router.push(`/dashboard/${companyId}/work-centers/${workCenterId}`)}
        sx={{ color: 'text.secondary', mb: 2 }}
      >
        Back to Work Center
      </Button>
      <WorkCenterForm
        mode="edit"
        initialData={initialData}
        workCenterId={workCenterId}
        onSuccess={() =>
          router.push(`/dashboard/${companyId}/work-centers/${workCenterId}`)
        }
        onCancel={() =>
          router.push(`/dashboard/${companyId}/work-centers/${workCenterId}`)
        }
      />
    </Box>
  );
}
