'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { VendorForm } from '@/components/vendors';
import { getVendor } from '@/utils/vendorsAccess';
import { vendorToFormData, EMPTY_VENDOR_FORM } from '@/types/vendor';
import type { VendorFormData } from '@/types/vendor';

export default function VendorEditPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const vendorId = params.vendorId as string;

  const [initialData, setInitialData] = useState<VendorFormData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchVendor() {
      try {
        const vendor = await getVendor(vendorId);
        if (!vendor) {
          setError('Vendor not found');
          setInitialData(EMPTY_VENDOR_FORM);
        } else {
          setInitialData(vendorToFormData(vendor));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
        setInitialData(EMPTY_VENDOR_FORM);
      } finally {
        setLoading(false);
      }
    }
    fetchVendor();
  }, [vendorId]);

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
        onClick={() => router.push(`/dashboard/${companyId}/vendors/${vendorId}`)}
        sx={{ color: 'text.secondary', mb: 2 }}
      >
        Back to Vendor
      </Button>
      <VendorForm
        mode="edit"
        initialData={initialData}
        vendorId={vendorId}
        onSuccess={() =>
          router.push(`/dashboard/${companyId}/vendors/${vendorId}`)
        }
        onCancel={() =>
          router.push(`/dashboard/${companyId}/vendors/${vendorId}`)
        }
      />
    </Box>
  );
}
