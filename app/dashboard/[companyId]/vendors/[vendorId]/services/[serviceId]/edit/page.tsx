'use client';

import { useParams, useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';

import VendorServiceForm from '@/components/vendors/VendorServiceForm';
import ErrorAlert from '@/components/common/ErrorAlert';
import { vendorServiceToFormData } from '@/types/vendorService';
import { getVendorService } from '@/utils/vendorServicesAccess';
import { getVendor } from '@/utils/vendorsAccess';
import { useLoad } from '@/hooks/useLoad';

export default function EditVendorServicePage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const vendorId = params.vendorId as string;
  const serviceId = params.serviceId as string;

  const { data, loading, error } = useLoad(
    async () => {
      const [vendor, service] = await Promise.all([
        getVendor(vendorId),
        getVendorService(serviceId),
      ]);
      return { vendor, service };
    },
    [vendorId, serviceId],
  );

  const backHref = `/dashboard/${companyId}/vendors/${vendorId}`;

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error || !data?.vendor || !data.service) {
    return (
      <Box>
        <ErrorAlert error={error} entity="service" fallback="Service not found" />
      </Box>
    );
  }

  return (
    <Box>
      <Button startIcon={<ArrowBackIcon />} onClick={() => router.push(backHref)} sx={{ mb: 2 }}>
        Back to {data.vendor.name}
      </Button>
      <Typography variant="h5" sx={{ fontWeight: 600, mb: 3 }}>
        {data.service.name}
      </Typography>
      <VendorServiceForm
        mode="edit"
        companyId={companyId}
        vendorId={vendorId}
        vendorName={data.vendor.name}
        serviceId={serviceId}
        initialData={vendorServiceToFormData(data.service)}
      />
    </Box>
  );
}
