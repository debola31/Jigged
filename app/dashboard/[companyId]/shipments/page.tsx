'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import InputAdornment from '@mui/material/InputAdornment';
import AddIcon from '@mui/icons-material/Add';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import SearchIcon from '@mui/icons-material/Search';

import { AgGridReact } from 'ag-grid-react';
import { ModuleRegistry, AllCommunityModule } from 'ag-grid-community';
import type {
  ColDef,
  ICellRendererParams,
  RowClickedEvent,
} from 'ag-grid-community';
ModuleRegistry.registerModules([AllCommunityModule]);

import { jiggedAgGridTheme } from '@/lib/agGridTheme';
import { getCompany, type Company } from '@/utils/companyAccess';
import { isShipmentsEnabled } from '@/lib/featureFlags';
import { listShipmentsForCompanyWithJobs } from '@/utils/shipmentsAccess';
import type { ShipmentListRow } from '@/types/shipment';
import PackingSlipPreviewDialog from '@/components/shipments/PackingSlipPreviewDialog';

function formatShipDate(value: string | null | undefined): string {
  if (!value) return '—';
  const ymd = /^\d{4}-\d{2}-\d{2}$/.exec(value);
  if (ymd) {
    const [y, m, d] = value.split('-').map((n) => parseInt(n, 10));
    return new Date(y, m - 1, d).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }
  return new Date(value).toLocaleDateString();
}

export default function ShipmentsListPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;

  const [company, setCompany] = useState<Company | null>(null);
  const [companyLoading, setCompanyLoading] = useState(true);
  const [rows, setRows] = useState<ShipmentListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [previewShipmentId, setPreviewShipmentId] = useState<string | null>(null);
  const gridRef = useRef<AgGridReact<ShipmentListRow>>(null);

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
    if (companyLoading) return;
    if (!shipmentsEnabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const data = await listShipmentsForCompanyWithJobs(companyId);
        if (!cancelled) setRows(data);
      } catch (err) {
        if (!cancelled) {
          console.error('Shipments list load failed:', err);
          setError(err instanceof Error ? err.message : 'Failed to load shipments.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId, shipmentsEnabled, companyLoading]);

  // Debounce search (≈300ms) so AG Grid doesn't refilter on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setSearchDebounced(search.trim().toLowerCase()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const filteredRows = useMemo(() => {
    if (!searchDebounced) return rows;
    return rows.filter((r) => {
      const hay = [
        r.packing_slip_number,
        r.customer_name ?? '',
        r.tracking_number ?? '',
        r.job_numbers.join(' '),
        r.carrier ?? '',
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(searchDebounced);
    });
  }, [rows, searchDebounced]);

  const columnDefs = useMemo<ColDef<ShipmentListRow>[]>(() => [
    {
      field: 'packing_slip_number',
      headerName: 'Packing Slip #',
      minWidth: 160,
      cellRenderer: (params: ICellRendererParams<ShipmentListRow>) => (
        <Typography variant="body2" sx={{ fontWeight: 600, color: 'primary.main' }}>
          {params.value}
        </Typography>
      ),
    },
    {
      field: 'ship_date',
      headerName: 'Ship Date',
      minWidth: 140,
      valueFormatter: (p) => formatShipDate(p.value as string),
    },
    {
      field: 'customer_name',
      headerName: 'Customer',
      minWidth: 200,
      flex: 1,
      valueFormatter: (p) => p.value ?? '—',
    },
    {
      field: 'job_numbers',
      headerName: 'Jobs',
      minWidth: 220,
      sortable: false,
      cellRenderer: (params: ICellRendererParams<ShipmentListRow>) => {
        const jobs = (params.value ?? []) as string[];
        if (jobs.length === 0) return <Typography variant="body2" sx={{ color: 'text.secondary' }}>—</Typography>;
        return (
          <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
            {jobs.map((j) => (
              <Chip
                key={j}
                size="small"
                label={j}
                variant="outlined"
                sx={{ height: 22, fontSize: 11 }}
              />
            ))}
          </Stack>
        );
      },
    },
    {
      field: 'carrier',
      headerName: 'Carrier',
      minWidth: 120,
      valueFormatter: (p) => (p.value as string) || '—',
    },
    {
      field: 'tracking_number',
      headerName: 'Tracking',
      minWidth: 160,
      valueFormatter: (p) => (p.value as string) || '—',
    },
    {
      field: 'line_item_count',
      headerName: 'Lines',
      width: 90,
      type: 'rightAligned',
    },
    {
      headerName: 'Created By',
      minWidth: 160,
      sortable: false,
      valueGetter: (p) => p.data?.created_by_member?.name ?? p.data?.created_by_member?.email ?? '—',
    },
  ], []);

  const handleRowClicked = useCallback((e: RowClickedEvent<ShipmentListRow>) => {
    if (!e.data) return;
    setPreviewShipmentId(e.data.id);
  }, []);

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

  const gridHeight = 'calc(100vh - 240px)';

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          gap: 2,
          mb: 3,
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <TextField
          size="small"
          placeholder="Search packing slip, customer, tracking, job…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
          sx={{ width: 360 }}
        />
        <Box sx={{ flex: 1 }} />
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => router.push(`/dashboard/${companyId}/shipments/new`)}
        >
          New Shipment
        </Button>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {!loading && rows.length === 0 ? (
        <Card elevation={2}>
          <CardContent sx={{ p: 6, textAlign: 'center' }}>
            <LocalShippingIcon sx={{ fontSize: 64, color: 'text.secondary', mb: 2 }} />
            <Typography variant="h6" color="text.secondary" gutterBottom>
              No shipments yet
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              Once you create one, it&apos;ll show up here with a link to the packing slip.
            </Typography>
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={() => router.push(`/dashboard/${companyId}/shipments/new`)}
            >
              New Shipment
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card elevation={2}>
          <Box
            sx={{
              width: '100%',
              height: gridHeight,
              '& .ag-root-wrapper': { border: 'none' },
              '& .ag-row': { cursor: 'pointer' },
              '& .ag-cell:focus, & .ag-header-cell:focus': {
                outline: 'none !important',
                border: 'none !important',
              },
            }}
          >
            <AgGridReact<ShipmentListRow>
              ref={gridRef}
              rowData={filteredRows}
              columnDefs={columnDefs}
              theme={jiggedAgGridTheme}
              defaultColDef={{ sortable: true, resizable: true }}
              onRowClicked={handleRowClicked}
              pagination={true}
              paginationPageSize={25}
              paginationPageSizeSelector={[25, 50, 100]}
              domLayout="normal"
              loading={loading}
              getRowId={(p) => p.data.id}
              enableCellTextSelection={true}
              ensureDomOrder={true}
            />
          </Box>
        </Card>
      )}

      <PackingSlipPreviewDialog
        open={previewShipmentId !== null}
        shipmentId={previewShipmentId}
        onClose={() => setPreviewShipmentId(null)}
      />
    </Box>
  );
}
