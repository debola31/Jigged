'use client';

import { useParams, useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';

import VendorServiceForm from '@/components/vendors/VendorServiceForm';
import ErrorAlert from '@/components/common/ErrorAlert';
import { EMPTY_VENDOR_SERVICE_FORM } from '@/types/vendorService';
import { getVendor } from '@/utils/vendorsAccess';
import { useLoad } from '@/hooks/useLoad';

export default function NewVendorServicePage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const vendorId = params.vendorId as string;

  const { data: vendor, loading, error } = useLoad(() => getVendor(vendorId), [vendorId]);

  const backHref = `/dashboard/${companyId}/vendors/${vendorId}`;

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error || !vendor) {
    return (
      <Box>
        <ErrorAlert error={error} entity="vendor" fallback="Vendor not found" />
      </Box>
    );
  }

  return (
    <Box>
      <Button startIcon={<ArrowBackIcon />} onClick={() => router.push(backHref)} sx={{ mb: 2 }}>
        Back to {vendor.name}
      </Button>
      <Typography variant="h5" sx={{ fontWeight: 600, mb: 3 }}>
        Add a service
      </Typography>
      <VendorServiceForm
        mode="create"
        companyId={companyId}
        vendorId={vendorId}
        vendorName={vendor.name}
        initialData={EMPTY_VENDOR_SERVICE_FORM}
      />
    </Box>
  );
}
