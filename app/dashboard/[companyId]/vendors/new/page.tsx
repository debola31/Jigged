'use client';

import { useRouter, useParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { VendorForm } from '@/components/vendors';
import { EMPTY_VENDOR_FORM } from '@/types/vendor';

export default function NewVendorPage() {
  const router = useRouter();
  const params = useParams();
  const companyId = params.companyId as string;

  return (
    <Box>
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => router.push(`/dashboard/${companyId}/vendors`)}
        sx={{ color: 'text.secondary', mb: 2 }}
      >
        Back to Vendors
      </Button>
      <VendorForm mode="create" initialData={EMPTY_VENDOR_FORM} />
    </Box>
  );
}
