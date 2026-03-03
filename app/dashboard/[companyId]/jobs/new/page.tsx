'use client';

import { useSearchParams } from 'next/navigation';
import { JobForm } from '@/components/jobs';
import { EMPTY_JOB_FORM } from '@/types/job';

export default function NewJobPage() {
  const searchParams = useSearchParams();

  // Pre-fill form from URL params (used when returning from routing creation)
  const initialData = {
    ...EMPTY_JOB_FORM,
    customer_id: searchParams.get('customer_id') || '',
    part_id: searchParams.get('part_id') || '',
    description: searchParams.get('description') || '',
  };

  return <JobForm mode="create" initialData={initialData} />;
}
