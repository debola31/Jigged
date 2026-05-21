'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';

import { getSupabase } from '@/lib/supabase';
import { getCompany, type Company } from '@/utils/companyAccess';
import { isShipmentsEnabled } from '@/lib/featureFlags';
import SearchableSelect, { type SelectOption } from '@/components/common/SearchableSelect';
import ShipmentForm from '@/components/shipments/ShipmentForm';
import PackingSlipPreviewDialog from '@/components/shipments/PackingSlipPreviewDialog';

interface CustomerOption {
  id: string;
  name: string;
}

export default function NewShipmentWizardPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const companyId = params.companyId as string;
  const preselectedCustomerId = searchParams.get('customer');

  const [company, setCompany] = useState<Company | null>(null);
  const [companyLoading, setCompanyLoading] = useState(true);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [customersLoading, setCustomersLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>(
    preselectedCustomerId ?? '',
  );
  const [createdShipmentId, setCreatedShipmentId] = useState<string | null>(null);

  const shipmentsEnabled = useMemo(() => isShipmentsEnabled(company), [company]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const c = await getCompany(companyId);
        if (!cancelled) setCompany(c);
      } finally {
        if (!cancelled) setCompanyLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  useEffect(() => {
    if (companyLoading || !shipmentsEnabled) return;
    let cancelled = false;
    (async () => {
      setCustomersLoading(true);
      try {
        const supabase = getSupabase();
        const { data, error: customersErr } = await supabase
          .from('customers')
          .select('id, name')
          .eq('company_id', companyId)
          .order('name', { ascending: true });
        if (customersErr) throw customersErr;
        if (!cancelled) setCustomers((data ?? []) as CustomerOption[]);
      } catch (err) {
        if (!cancelled) {
          console.error('Customer load failed:', err);
          setError(
            err instanceof Error ? err.message : 'Failed to load customers.',
          );
        }
      } finally {
        if (!cancelled) setCustomersLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId, companyLoading, shipmentsEnabled]);

  const selectOptions = useMemo<SelectOption[]>(
    () => customers.map((c) => ({ id: c.id, label: c.name })),
    [customers],
  );

  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === selectedCustomerId) ?? null,
    [customers, selectedCustomerId],
  );

  const handleCreated = useCallback(
    async (result: { shipmentId: string; packingSlipNumber: string }) => {
      setCreatedShipmentId(result.shipmentId);
    },
    [],
  );

  const handlePreviewClose = useCallback(() => {
    setCreatedShipmentId(null);
    router.push(`/dashboard/${companyId}/shipments`);
  }, [router, companyId]);

  // ---------- Render guards ----------
  if (companyLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!shipmentsEnabled) {
    return (
      <Box>
        <Alert severity="info">
          Shipments are not enabled for this company. Contact an admin to enable the feature.
        </Alert>
      </Box>
    );
  }

  return (
    <Box>
      <Box sx={{ mb: 2 }}>
        <Button
          startIcon={<ArrowBackIcon />}
          onClick={() => router.push(`/dashboard/${companyId}/shipments`)}
          size="small"
          color="inherit"
        >
          Back to Shipments
        </Button>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Card elevation={2}>
        <CardContent sx={{ p: 3 }}>
          <Stack spacing={3}>
            <Box>
              <Typography variant="overline" sx={{ color: 'text.secondary' }}>
                Step 1 of 2
              </Typography>
              <Typography variant="h6" sx={{ mb: 2 }}>
                Customer
              </Typography>
              <SearchableSelect
                options={selectOptions}
                value={selectedCustomerId}
                onChange={setSelectedCustomerId}
                label="Pick a customer"
                placeholder={customersLoading ? 'Loading customers…' : 'Search customers'}
                loading={customersLoading}
                fullWidth
              />
              {selectedCustomer && (
                <Typography variant="body2" sx={{ color: 'text.secondary', mt: 1 }}>
                  Showing open lines for <b>{selectedCustomer.name}</b>. Switching the
                  customer above resets the line selection.
                </Typography>
              )}
            </Box>

            {selectedCustomerId && (
              <>
                <Box>
                  <Typography variant="overline" sx={{ color: 'text.secondary' }}>
                    Step 2 of 2
                  </Typography>
                  <Typography variant="h6" sx={{ mb: 2 }}>
                    Lines and shipment details
                  </Typography>
                </Box>
                <ShipmentForm
                  key={selectedCustomerId}
                  source={{ kind: 'customer', customerId: selectedCustomerId }}
                  companyId={companyId}
                  onCreated={handleCreated}
                  onCancel={() => router.push(`/dashboard/${companyId}/shipments`)}
                />
              </>
            )}
          </Stack>
        </CardContent>
      </Card>

      <PackingSlipPreviewDialog
        open={createdShipmentId !== null}
        shipmentId={createdShipmentId}
        onClose={handlePreviewClose}
      />
    </Box>
  );
}
