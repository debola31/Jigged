'use client';

import { useParams, useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import { PartForm } from '@/components/parts';
import { EMPTY_PART_FORM } from '@/types/part';

export default function NewPartPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;

  return (
    <Box>
      <PartForm
        mode="create"
        companyId={companyId}
        initialData={EMPTY_PART_FORM}
        onCancel={() => router.back()}
      />
    </Box>
  );
}
