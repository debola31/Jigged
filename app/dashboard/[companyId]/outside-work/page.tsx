'use client';

/**
 * OUTSIDE WORK — the cross-job register of outside-processing slips.
 *
 * READ AND REPRINT ONLY. There is no Send, no Receive and no Undo on this page,
 * and there must not be: those live exclusively on the operation (the job card
 * and the operator step screen). Void is reachable only INSIDE a slip's preview,
 * where the customer packing slip already puts it.
 *
 * That constraint is the whole reason this page is not a re-litigation of the
 * Aug 2026 decision to delete the outside-work tab. That tab carried Mark Sent
 * Out / Mark Received / Undo across every job -- a second place to act on a row
 * the op card already handled at full fidelity. These rows are DOCUMENTS:
 * numbered, printable, voidable, dated. "Reprint OSP-0141-2" and "what did we
 * send ProFinish in August" are questions an operation row cannot answer at all.
 * See docs/modules/jobs.md#outside-external-vendor-operations.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import InputAdornment from '@mui/material/InputAdornment';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import SearchIcon from '@mui/icons-material/Search';

import { AgGridReact } from 'ag-grid-react';
import { ModuleRegistry, AllCommunityModule } from 'ag-grid-community';
import type { ColDef, ICellRendererParams, RowClickedEvent } from 'ag-grid-community';
ModuleRegistry.registerModules([AllCommunityModule]);
import { jiggedAgGridTheme } from '@/lib/agGridTheme';

import { useLoad } from '@/hooks/useLoad';
import { usePageTitle } from '@/components/layout/PageTitleProvider';
import { OutsideShipmentPreviewDialog } from '@/components/outsideShipments';
import {
  listOutsideShipmentsForCompany,
  outstandingOn,
} from '@/utils/outsideShipmentsAccess';
import type { OutsideShipmentWithRelations } from '@/types/outsideShipment';

interface Row {
  id: string;
  slip_number: string;
  vendor_name: string;
  service_name: string;
  job_number: string;
  part_name: string;
  shipped_at: string;
  due_back_on: string | null;
  quantity: number;
  outstanding: number;
  days_out: number | null;
}

function toRow(s: OutsideShipmentWithRelations): Row {
  const out = outstandingOn(s);
  return {
    id: s.id,
    slip_number: s.slip_number,
    vendor_name: s.vendor_name,
    service_name: s.service_name,
    job_number: s.job?.job_number ?? '—',
    part_name: s.job_part?.part?.part_name ?? '—',
    shipped_at: s.shipped_at,
    due_back_on: s.due_back_on,
    quantity: Number(s.quantity),
    outstanding: out,
    // Stamped once at load rather than ticking: a row that silently changes
    // colour while somebody reads it is worse than one that is a few hours
    // stale, and this is a chase list, not a clock.
    days_out: out > 0 ? Math.floor((Date.now() - Date.parse(s.shipped_at)) / 86_400_000) : null,
  };
}

const fmtDate = (v: string | null) =>
  v ? new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

export default function OutsideWorkPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const gridRef = useRef<AgGridReact<Row>>(null);
  const [search, setSearch] = useState('');
  const [openOnly, setOpenOnly] = useState(true);
  const [previewId, setPreviewId] = useState<string | null>(null);

  // Set here rather than adding a getPageTitle() branch to Header -- the same
  // route the Storage page takes, and it keeps the title beside the page it names.
  const { setTitle } = usePageTitle();
  useEffect(() => {
    setTitle('Outside work');
    return () => setTitle(null);
  }, [setTitle]);

  const { data, loading, error, refresh } = useLoad(
    () => listOutsideShipmentsForCompany(companyId, { openOnly }),
    [companyId, openOnly],
  );

  const rows = useMemo(() => (data ?? []).map(toRow), [data]);

  // Filtered in memory: a shop's slip count is in the hundreds, and a debounced
  // round trip to narrow a list that is already on screen buys nothing.
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.slip_number, r.vendor_name, r.service_name, r.job_number, r.part_name]
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [rows, search]);

  const columnDefs = useMemo<ColDef<Row>[]>(
    () => [
      { field: 'slip_number', headerName: 'Slip', width: 150 },
      { field: 'vendor_name', headerName: 'Vendor', flex: 1, minWidth: 180 },
      { field: 'service_name', headerName: 'Process', flex: 1, minWidth: 150 },
      { field: 'job_number', headerName: 'Job', width: 120 },
      { field: 'part_name', headerName: 'Part', flex: 1, minWidth: 150 },
      {
        field: 'shipped_at',
        headerName: 'Sent',
        width: 130,
        valueFormatter: (p) => fmtDate(p.value as string),
      },
      {
        field: 'due_back_on',
        headerName: 'Due back',
        width: 130,
        valueFormatter: (p) => fmtDate(p.value as string | null),
      },
      { field: 'quantity', headerName: 'Sent qty', width: 110, type: 'numericColumn' },
      {
        field: 'outstanding',
        headerName: 'Still out',
        width: 110,
        type: 'numericColumn',
        cellRenderer: (p: ICellRendererParams<Row, number>) =>
          p.value && p.value > 0 ? String(p.value) : '—',
      },
      {
        field: 'days_out',
        headerName: 'Days out',
        width: 120,
        type: 'numericColumn',
        // 21 days is the shop-facing threshold the vendor page already paints
        // red; using the same one here means one boundary, not two.
        cellStyle: (p) =>
          typeof p.value === 'number' && p.value > 21 ? { color: '#ef5350', fontWeight: 600 } : null,
        cellRenderer: (p: ICellRendererParams<Row, number | null>) =>
          typeof p.value === 'number' ? String(p.value) : '—',
      },
    ],
    [],
  );

  const onRowClicked = useCallback((e: RowClickedEvent<Row>) => {
    if (e.data) setPreviewId(e.data.id);
  }, []);

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3, flexWrap: 'wrap' }}>
        <TextField
          size="small"
          placeholder="Search slip, vendor, job or part"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
          sx={{ minWidth: 320 }}
        />
        <FormControlLabel
          control={
            <Checkbox checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />
          }
          label="Still at a vendor"
        />
        <Box sx={{ flex: 1 }} />
        <Typography variant="body2" color="text.secondary">
          {visible.length} slip{visible.length === 1 ? '' : 's'}
        </Typography>
      </Box>

      {/* A failed load is not an empty list. Saying "nothing is out" when we
          could not read is the shape the access-check rule forbids. */}
      {error != null && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => refresh()}>
          Couldn&apos;t load outside slips. Check your connection and try again.
        </Alert>
      )}

      {!loading && !error && rows.length === 0 ? (
        <Card elevation={2}>
          <CardContent sx={{ p: 6, textAlign: 'center' }}>
            <LocalShippingIcon sx={{ fontSize: 64, color: 'text.disabled', mb: 2 }} />
            <Typography variant="h6" gutterBottom>
              {openOnly ? 'Nothing is out at a vendor' : 'No outside slips yet'}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Slips are made from a job&apos;s outside operation — open the job and send the parts
              out from there.
            </Typography>
          </CardContent>
        </Card>
      ) : (
        <Card elevation={2} sx={{ position: 'relative', minHeight: 600 }}>
          <Box
            sx={{
              height: 640,
              '& .ag-root-wrapper': { border: 'none' },
              '& .ag-row': { cursor: 'pointer' },
            }}
          >
            <AgGridReact<Row>
              ref={gridRef}
              rowData={visible}
              columnDefs={columnDefs}
              theme={jiggedAgGridTheme}
              defaultColDef={{ sortable: true, resizable: true }}
              onRowClicked={onRowClicked}
              pagination
              paginationPageSize={25}
              paginationPageSizeSelector={[25, 50, 100]}
              domLayout="normal"
              loading={loading}
              getRowId={(p) => p.data.id}
              enableCellTextSelection
              ensureDomOrder
            />
          </Box>
        </Card>
      )}

      {/* Read and reprint. onVoided is deliberately omitted -- voiding from a
          register is the "second place to act" this page exists without. */}
      <OutsideShipmentPreviewDialog
        open={previewId !== null}
        shipmentId={previewId}
        onClose={() => setPreviewId(null)}
      />
    </Box>
  );
}
