'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';

import { JobForm } from '@/components/jobs';
import { getJobWithRelations } from '@/utils/jobsAccess';
import { jobToFormData } from '@/types/job';
import type { JobWithRelations } from '@/types/job';

export default function EditJobPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const jobId = params.jobId as string;

  const [job, setJob] = useState<JobWithRelations | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchJob = async () => {
      try {
        const data = await getJobWithRelations(jobId, companyId);
        if (!data) {
          setError('Job not found');
          return;
        }

        // Check if job can be edited
        if (data.status !== 'not_started') {
          setError('Only not started jobs can be edited');
          return;
        }

        setJob(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load job');
      } finally {
        setLoading(false);
      }
    };
    fetchJob();
  }, [jobId, companyId]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 400 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error || !job) {
    return (
      <Box>
        <Alert severity="error">{error || 'Job not found'}</Alert>
      </Box>
    );
  }

  return (
    <JobForm
      mode="edit"
      initialData={jobToFormData(job)}
      jobId={job.id}
      jobNumber={job.job_number}
    />
  );
}
