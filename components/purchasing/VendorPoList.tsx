'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import InputAdornment from '@mui/material/InputAdornment';
import InputLabel from '@mui/material/InputLabel';
import ListItemText from '@mui/material/ListItemText';
import MenuItem from '@mui/material/MenuItem';
import MuiLink from '@mui/material/Link';
import OutlinedInput from '@mui/material/OutlinedInput';
import Select, { type SelectChangeEvent } from '@mui/material/Select';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import SearchIcon from '@mui/icons-material/Search';

import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import type {
  ColDef,
  GridReadyEvent,
  ICellRendererParams,
  SelectionChangedEvent,
  SortChangedEvent,
  ValueFormatterParams,
} from 'ag-grid-community';

ModuleRegistry.registerModules([AllCommunityModule]);

import { jiggedAgGridTheme } from '@/lib/agGridTheme';
import { useLoad } from '@/hooks/useLoad';
import { formatDateOnly, todayLocalISODate } from '@/lib/localDate';
import { formatMoney } from '@/lib/money';
import { purchasingHubPath, vendorPoPath } from '@/lib/purchasingRoutes';
import {
  VENDOR_PO_DEFAULT_LIST_STATUSES,
  VENDOR_PO_OVERDUE,
  VENDOR_PO_QUICKBOOKS_STATES,
  VENDOR_PO_QUICKBOOKS_STATE_CONFIG,
  VENDOR_PO_STATUSES,
  VENDOR_PO_STATUS_CONFIG,
  vendorPoStatusDisplay,
} from '@/lib/purchasing/vendorPoStatus';
import StatusDot from '@/components/common/StatusDot';
import SearchableSelect, { type SelectOption } from '@/components/common/SearchableSelect';
import ExportCsvButton from '@/components/common/ExportCsvButton';
import LoadFailedState from '@/components/common/LoadFailedState';
import { listVendorPos } from '@/utils/vendorPoAccess';
import { getAllVendors } from '@/utils/vendorsAccess';
import {
  VENDOR_PO_DEFAULT_SORT,
  type VendorPoListRow,
  type VendorPoQuickBooksState,
  type VendorPoSortField,
  type VendorPoStatus,
} from '@/types/vendorPo';
import type { Vendor } from '@/types/vendor';

// ------------------------------------------------------------------------------------------------
// URL and remembered state
// ------------------------------------------------------------------------------------------------

/** Device-local memory of the Status choice, per company (the Jobs list's precedent). */
const statusStorageKey = (companyId: string) => `jigged.purchasing.statusFilter.${companyId}`;

function parseList<T extends string>(value: string | null, allowed: readonly T[]): T[] | null {
  if (value === null) return null;
  const picked = value
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is T => (allowed as readonly string[]).includes(s));
  return picked;
}

function readStoredStatus(companyId: string): VendorPoStatus[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(statusStorageKey(companyId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((s): s is VendorPoStatus => typeof s === 'string' && (VENDOR_PO_STATUSES as readonly string[]).includes(s));
  } catch {
    return null;
  }
}

function writeStoredStatus(companyId: string, statuses: VendorPoStatus[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(statusStorageKey(companyId), JSON.stringify(statuses));
  } catch {
    // Best effort: a private window or a full quota only costs the memory, never the list.
  }
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/**
 * The grid's column ids are the row's own (camelCase) fields; the server sorts by the VIEW's
 * columns. This map is the only bridge, so a header click can only ever reach `.order()` as one of
 * `VENDOR_PO_SORT_FIELDS` — a derived column (Jobs) is `sortable: false` and absent here.
 */
const SORT_FIELD_BY_COLUMN: Partial<Record<keyof VendorPoListRow, VendorPoSortField>> = {
  poNumber: 'po_number',
  vendorName: 'vendor_name',
  status: 'status',
  orderedOn: 'ordered_on',
  nextExpectedOn: 'next_expected_on',
  openAmount: 'open_amount',
  quickbooksState: 'quickbooks_state',
};

const DEFAULT_SORT_COLUMN = 'nextExpectedOn';
const STATUS_ALL = '__all__';
const EMPTY_ROWS: VendorPoListRow[] = [];

export interface VendorPoListProps {
  companyId: string;
}

/**
 * The Orders tab of the Purchasing hub (plan §3.13): every live PO to a vendor, FILTERED AND SORTED
 * ON THE SERVER against `vendor_purchase_order_status`, so the status, the next due date and the
 * open value are the ones the database derives for every other surface.
 *
 * The default view is the open POs — Draft, Sent, Partly received — due soonest first, which is the
 * "what is coming in" list without a separate page for it. The Status choice is remembered per
 * company on this device; every filter is in the URL (router.replace, never push, so Back still
 * leaves the page), and a URL that names a status wins over the remembered one.
 *
 * Four states, four sentences: a failed load says it failed and offers Retry (never "no POs"), an
 * empty open list offers to make one, a filter with no matches offers to clear it, and a capped page
 * says how much it is showing.
 */
export default function VendorPoList({ companyId }: VendorPoListProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const gridRef = useRef<AgGridReact<VendorPoListRow>>(null);

  const urlStatuses = parseList(searchParams.get('status'), VENDOR_PO_STATUSES);
  const [statuses, setStatuses] = useState<VendorPoStatus[]>(() => urlStatuses ?? [...VENDOR_PO_DEFAULT_LIST_STATUSES]);
  const [vendorId, setVendorId] = useState<string>(() => searchParams.get('vendor') ?? '');
  const [jobId, setJobId] = useState<string | null>(() => searchParams.get('job'));
  const [overdueOnly, setOverdueOnly] = useState<boolean>(() => searchParams.get('overdue') === 'true');
  const [qbStates, setQbStates] = useState<VendorPoQuickBooksState[]>(
    () => parseList(searchParams.get('qb'), VENDOR_PO_QUICKBOOKS_STATES) ?? [],
  );
  const [search, setSearch] = useState<string>(() => searchParams.get('q') ?? '');
  const [searchDebounced, setSearchDebounced] = useState<string>(() => searchParams.get('q') ?? '');
  const [sort, setSort] = useState<{ field: VendorPoSortField; direction: 'asc' | 'desc' }>(VENDOR_PO_DEFAULT_SORT);
  const [selectedCount, setSelectedCount] = useState(0);
  const [vendors, setVendors] = useState<Vendor[]>([]);

  // The remembered Status choice, applied once after mount: localStorage is not there during the
  // server render, and reading it in the initializer would mismatch hydration. A URL ?status= wins.
  const statusHydrated = useRef(false);
  useEffect(() => {
    if (statusHydrated.current) return;
    statusHydrated.current = true;
    if (searchParams.get('status') !== null) return;
    const stored = readStoredStatus(companyId);
    // Intentional mount-time sync from localStorage, which is unavailable during SSR.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (stored) setStatuses(stored);
  }, [companyId, searchParams]);

  useEffect(() => {
    let cancelled = false;
    getAllVendors(companyId)
      .then((rows) => {
        if (!cancelled) setVendors(rows);
      })
      // The vendor filter is a convenience; the list itself must not fail because of it.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  /** Keep the URL honest. `replace`, so Back leaves the page instead of undoing a filter. */
  const writeUrl = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const next = new URLSearchParams(searchParams.toString());
      mutate(next);
      router.replace(`?${next.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  // Debounced search: the server matches `search_text`, so it re-reads per settled query.
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
  }, []);
  const handleSearch = (value: string) => {
    setSearch(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setSearchDebounced(value);
      writeUrl((p) => {
        if (value.trim()) p.set('q', value.trim());
        else p.delete('q');
      });
    }, 300);
  };

  const statusKey = [...statuses].sort().join(',');
  const qbKey = [...qbStates].sort().join(',');
  const { data, loading, error, reload } = useLoad(
    () =>
      listVendorPos(companyId, {
        today: todayLocalISODate(),
        statuses,
        vendorId: vendorId || null,
        jobId,
        overdueOnly,
        search: searchDebounced.trim() || null,
        quickbooksStates: qbStates,
        sort,
      }),
    // Primitive deps only (hooks/useLoad.ts): the lists collapse to sorted keys.
    [companyId, statusKey, vendorId, jobId, overdueOnly, searchDebounced, qbKey, sort.field, sort.direction],
  );
  const rows = data?.rows ?? EMPTY_ROWS;

  const clearSelection = () => {
    setSelectedCount(0);
    gridRef.current?.api?.deselectAll();
  };

  // ---------------------------------------------------------------------------------------------
  // Filter handlers
  // ---------------------------------------------------------------------------------------------

  const allStatusesSelected = statuses.length === VENDOR_PO_STATUSES.length;
  const handleStatusChange = (event: SelectChangeEvent<string[]>) => {
    const raw = event.target.value;
    const picked = (typeof raw === 'string' ? raw.split(',') : raw) as string[];
    const next: VendorPoStatus[] = picked.includes(STATUS_ALL)
      ? allStatusesSelected
        ? []
        : [...VENDOR_PO_STATUSES]
      : picked.filter((s): s is VendorPoStatus => (VENDOR_PO_STATUSES as readonly string[]).includes(s));
    setStatuses(next);
    writeStoredStatus(companyId, next);
    clearSelection();
    writeUrl((p) => p.set('status', next.join(',')));
  };

  const handleQbChange = (event: SelectChangeEvent<string[]>) => {
    const raw = event.target.value;
    const picked = (typeof raw === 'string' ? raw.split(',') : raw) as string[];
    const next = picked.filter((s): s is VendorPoQuickBooksState =>
      (VENDOR_PO_QUICKBOOKS_STATES as readonly string[]).includes(s),
    );
    setQbStates(next);
    clearSelection();
    writeUrl((p) => {
      if (next.length > 0) p.set('qb', next.join(','));
      else p.delete('qb');
    });
  };

  const handleVendorChange = (value: string) => {
    setVendorId(value);
    clearSelection();
    writeUrl((p) => {
      if (value) p.set('vendor', value);
      else p.delete('vendor');
    });
  };

  const handleOverdueChange = (checked: boolean) => {
    setOverdueOnly(checked);
    clearSelection();
    writeUrl((p) => {
      if (checked) p.set('overdue', 'true');
      else p.delete('overdue');
    });
  };

  const clearJob = () => {
    setJobId(null);
    clearSelection();
    writeUrl((p) => p.delete('job'));
  };

  const isDefaultStatus = sameSet(statuses, VENDOR_PO_DEFAULT_LIST_STATUSES);
  const hasFilters =
    !isDefaultStatus || Boolean(vendorId) || Boolean(jobId) || overdueOnly || qbStates.length > 0 || Boolean(searchDebounced.trim());

  const clearFilters = () => {
    const defaults = [...VENDOR_PO_DEFAULT_LIST_STATUSES];
    setStatuses(defaults);
    writeStoredStatus(companyId, defaults);
    setVendorId('');
    setJobId(null);
    setOverdueOnly(false);
    setQbStates([]);
    setSearch('');
    setSearchDebounced('');
    clearSelection();
    writeUrl((p) => {
      for (const key of ['status', 'vendor', 'job', 'overdue', 'qb', 'q']) p.delete(key);
    });
  };

  // ---------------------------------------------------------------------------------------------
  // Grid
  // ---------------------------------------------------------------------------------------------

  const handleGridReady = (event: GridReadyEvent<VendorPoListRow>) => {
    event.api.applyColumnState({
      state: [{ colId: DEFAULT_SORT_COLUMN, sort: 'asc' }],
      defaultState: { sort: null },
    });
  };

  const handleSortChanged = (event: SortChangedEvent) => {
    const sorted = event.api.getColumnState().find((col) => col.sort !== null && col.sort !== undefined);
    const field = sorted ? SORT_FIELD_BY_COLUMN[sorted.colId as keyof VendorPoListRow] : undefined;
    if (sorted?.sort && field) setSort({ field, direction: sorted.sort });
    else setSort(VENDOR_PO_DEFAULT_SORT);
  };

  const handleSelectionChanged = (event: SelectionChangedEvent<VendorPoListRow>) => {
    setSelectedCount(event.api.getSelectedNodes().length);
  };

  const openPo = (row: VendorPoListRow | undefined) => {
    if (row) router.push(vendorPoPath(companyId, row.id));
  };

  const columnDefs = useMemo<ColDef<VendorPoListRow>[]>(
    () => [
      {
        field: 'poNumber',
        headerName: 'PO #',
        width: 130,
        pinned: 'left',
        cellStyle: { fontWeight: 600 },
      },
      { field: 'vendorName', headerName: 'Vendor', flex: 1, minWidth: 180 },
      {
        field: 'status',
        headerName: 'Status',
        // Fits the longest label ("Partly received") with its dot: StatusDot is nowrap.
        width: 170,
        cellRenderer: (params: ICellRendererParams<VendorPoListRow>) => {
          if (!params.data) return null;
          const display = vendorPoStatusDisplay(params.data.status);
          return <StatusDot label={display.label} color={display.color} />;
        },
        valueFormatter: (params: ValueFormatterParams<VendorPoListRow>) =>
          params.data ? vendorPoStatusDisplay(params.data.status).label : '',
      },
      {
        field: 'orderedOn',
        headerName: 'Ordered',
        width: 120,
        valueFormatter: (params: ValueFormatterParams<VendorPoListRow>) => formatDateOnly(params.value),
      },
      {
        field: 'nextExpectedOn',
        headerName: 'Next due',
        // Fits "11/11/2026 Overdue": at 170 the cell cut the word to "Overdu".
        width: 200,
        valueFormatter: (params: ValueFormatterParams<VendorPoListRow>) =>
          params.value ? formatDateOnly(params.value) : '—',
        // Amber, with the WORD: overdue is behind, not broken (design-system.md "Red means broken;
        // amber means behind"), and the word is what survives when the hue does not land.
        cellRenderer: (params: ICellRendererParams<VendorPoListRow>) => {
          if (!params.data) return null;
          const date = params.data.nextExpectedOn ? formatDateOnly(params.data.nextExpectedOn) : '—';
          return (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, whiteSpace: 'nowrap' }}>
              <span>{date}</span>
              {params.data.isLate && (
                <Typography component="span" variant="body2" sx={{ color: 'warning.light', fontWeight: 600 }}>
                  {VENDOR_PO_OVERDUE.label}
                </Typography>
              )}
            </Box>
          );
        },
      },
      {
        field: 'openAmount',
        headerName: 'Open value (at PO price)',
        // Fits its own header with the sort arrow: at 200 it read "Open value (at PO pr…".
        width: 240,
        type: 'rightAligned',
        // "At PO price", because it is: Jigged never sees the vendor's bill (plan §3.1 UI words).
        valueFormatter: (params: ValueFormatterParams<VendorPoListRow>) => {
          const money = formatMoney(typeof params.value === 'number' ? params.value : Number(params.value ?? 0));
          return params.data?.hasUnpricedLines ? `${money} + TBC` : money;
        },
      },
      {
        // Read off the row's job list — not a column on the view's sort list. Sorting is
        // SERVER-side, so a sortable derived column would send the database a column that does
        // not exist (Sentry JAVASCRIPT-NEXTJS-39). Enforced by __tests__/standards/gridSortableColumns.test.ts.
        colId: 'jobs',
        headerName: 'Jobs',
        width: 170,
        sortable: false,
        valueGetter: (params) => params.data?.jobNumbers.join(', ') ?? '',
        cellRenderer: (params: ICellRendererParams<VendorPoListRow>) => {
          if (!params.data) return null;
          const { jobIds, jobNumbers } = params.data;
          if (jobIds.length === 0) return '—';
          return (
            <Box
              title={jobNumbers.join(', ')}
              sx={{ display: 'flex', alignItems: 'center', overflow: 'hidden', whiteSpace: 'nowrap', width: '100%' }}
            >
              {jobIds.map((id, i) => (
                <Fragment key={id}>
                  <MuiLink
                    component={Link}
                    href={`/dashboard/${companyId}/jobs/${id}`}
                    onClick={(e: React.MouseEvent) => e.stopPropagation()}
                    sx={{ fontWeight: 500, whiteSpace: 'nowrap' }}
                  >
                    {jobNumbers[i] ?? 'Job'}
                  </MuiLink>
                  {i < jobIds.length - 1 && (
                    <Box component="span" sx={{ color: 'text.secondary', mr: 0.5 }}>
                      ,
                    </Box>
                  )}
                </Fragment>
              ))}
            </Box>
          );
        },
      },
      {
        field: 'quickbooksState',
        headerName: 'QuickBooks',
        width: 160,
        cellRenderer: (params: ICellRendererParams<VendorPoListRow>) => {
          if (!params.data) return null;
          const display = VENDOR_PO_QUICKBOOKS_STATE_CONFIG[params.data.quickbooksState];
          return <StatusDot label={display.label} color={display.color} />;
        },
        valueFormatter: (params: ValueFormatterParams<VendorPoListRow>) =>
          params.data ? VENDOR_PO_QUICKBOOKS_STATE_CONFIG[params.data.quickbooksState].label : '',
      },
    ],
    [companyId],
  );

  const gridHeight = useMemo(() => {
    if (rows.length === 0) return 600;
    return Math.max(56 + 52 * Math.min(rows.length, 25) + 56, 400);
  }, [rows.length]);

  // The job chip names the job: its number rides on the rows that carry it.
  const jobLabel = useMemo(() => {
    if (!jobId) return null;
    for (const r of rows) {
      const i = r.jobIds.indexOf(jobId);
      if (i >= 0 && r.jobNumbers[i]) return `Job ${r.jobNumbers[i]}`;
    }
    return 'One job';
  }, [jobId, rows]);

  const statusSummary =
    statuses.length === 0
      ? 'None'
      : allStatusesSelected
        ? 'All statuses'
        : statuses.length === 1
          ? VENDOR_PO_STATUS_CONFIG[statuses[0]].label
          : `${statuses.length} statuses`;
  const qbSummary =
    qbStates.length === 0
      ? 'Any'
      : qbStates.length === 1
        ? VENDOR_PO_QUICKBOOKS_STATE_CONFIG[qbStates[0]].label
        : `${qbStates.length} states`;

  const newPo = () => router.push(vendorPoPath(companyId, 'new'));
  const showGrid = !error && (loading || rows.length > 0);

  return (
    <Box>
      {/* Toolbar */}
      <Box sx={{ display: 'flex', gap: 2, mb: 3, flexWrap: 'wrap', alignItems: 'center' }}>
        <TextField
          placeholder="PO #, vendor, part, job…"
          value={search}
          onChange={(e) => {
            handleSearch(e.target.value);
            clearSelection();
          }}
          size="small"
          sx={{ width: { xs: '100%', sm: 260 } }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ color: 'text.secondary' }} />
                </InputAdornment>
              ),
            },
            htmlInput: { 'aria-label': 'Search purchase orders' },
          }}
        />

        <FormControl size="small" sx={{ width: 190 }}>
          <InputLabel id="vendor-po-status-filter-label" shrink>
            Status
          </InputLabel>
          <Select
            labelId="vendor-po-status-filter-label"
            multiple
            displayEmpty
            value={statuses}
            onChange={handleStatusChange}
            input={<OutlinedInput notched label="Status" />}
            renderValue={() => statusSummary}
          >
            <MenuItem value={STATUS_ALL}>
              <Checkbox size="small" checked={allStatusesSelected} indeterminate={statuses.length > 0 && !allStatusesSelected} />
              <ListItemText primary="All" slotProps={{ primary: { sx: { fontWeight: 600 } } }} />
            </MenuItem>
            <Divider sx={{ my: 0.5 }} />
            {VENDOR_PO_STATUSES.map((s) => (
              <MenuItem key={s} value={s}>
                <Checkbox size="small" checked={statuses.includes(s)} />
                <ListItemText primary={VENDOR_PO_STATUS_CONFIG[s].label} />
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <Box sx={{ minWidth: 220 }}>
          <SearchableSelect
            options={vendors.map((v): SelectOption => ({ id: v.id, label: v.name }))}
            value={vendorId}
            onChange={handleVendorChange}
            label="Vendor"
            allowNone
            noneLabel="All vendors"
            size="small"
          />
        </Box>

        <FormControl size="small" sx={{ width: 190 }}>
          <InputLabel id="vendor-po-qb-filter-label" shrink>
            QuickBooks
          </InputLabel>
          <Select
            labelId="vendor-po-qb-filter-label"
            multiple
            displayEmpty
            value={qbStates}
            onChange={handleQbChange}
            input={<OutlinedInput notched label="QuickBooks" />}
            renderValue={() => qbSummary}
          >
            {VENDOR_PO_QUICKBOOKS_STATES.map((s) => (
              <MenuItem key={s} value={s}>
                <Checkbox size="small" checked={qbStates.includes(s)} />
                <ListItemText primary={VENDOR_PO_QUICKBOOKS_STATE_CONFIG[s].label} />
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <FormControlLabel
          control={
            <Checkbox
              checked={overdueOnly}
              onChange={(e) => handleOverdueChange(e.target.checked)}
              size="small"
              sx={{ color: 'text.secondary', '&.Mui-checked': { color: 'primary.light' } }}
            />
          }
          label="Overdue only"
          sx={{ ml: 0 }}
        />

        {/* An arriving filter must be visible and undoable (quotes/page.tsx). */}
        {jobLabel && <Chip label={jobLabel} onDelete={clearJob} variant="outlined" />}

        <ExportCsvButton gridRef={gridRef} fileName="purchase-orders" selectedCount={selectedCount} />

        <Box sx={{ flex: 1 }} />

        <Button variant="contained" startIcon={<AddIcon />} onClick={newPo}>
          New purchase order
        </Button>
      </Box>

      {data?.truncated && !error && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Showing the first {rows.length.toLocaleString('en-US')} of {data.total.toLocaleString('en-US')} purchase
          orders, in the order shown. Pick a vendor or a status, or search, to see the rest.
        </Alert>
      )}

      {error != null && !loading ? (
        <Card elevation={2}>
          <CardContent sx={{ p: 6, textAlign: 'center' }}>
            <LoadFailedState error={error} entity="purchase orders" onRetry={() => void reload()} />
          </CardContent>
        </Card>
      ) : !showGrid ? (
        <Card elevation={2}>
          <CardContent sx={{ p: 6, textAlign: 'center' }}>
            <DescriptionOutlinedIcon sx={{ fontSize: 64, color: 'text.secondary', mb: 2 }} />
            {hasFilters ? (
              <>
                <Typography variant="h6" color="text.secondary" gutterBottom>
                  No purchase orders match these filters.
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                  Closed and received POs are hidden unless you pick them under Status.
                </Typography>
                <Button variant="outlined" onClick={clearFilters}>
                  Clear filters
                </Button>
              </>
            ) : (
              <>
                <Typography variant="h6" color="text.secondary" gutterBottom>
                  No open purchase orders
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                  Draft, sent and partly received POs show here. Make one, or see what needs buying.
                </Typography>
                <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center', flexWrap: 'wrap' }}>
                  <Button variant="contained" startIcon={<AddIcon />} onClick={newPo}>
                    New purchase order
                  </Button>
                  <Button variant="outlined" onClick={() => router.push(purchasingHubPath(companyId, 'shortages'))}>
                    See shortages
                  </Button>
                </Box>
              </>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card elevation={2} sx={{ position: 'relative', minHeight: 600 }}>
          <Box
            sx={{
              width: '100%',
              height: gridHeight,
              minHeight: 500,
              '& .ag-root-wrapper': { border: 'none' },
              '& .ag-row': { cursor: 'pointer' },
              '& .ag-cell:focus, & .ag-header-cell:focus': { outline: 'none !important', border: 'none !important' },
            }}
          >
            <AgGridReact<VendorPoListRow>
              ref={gridRef}
              rowData={rows}
              columnDefs={columnDefs}
              theme={jiggedAgGridTheme}
              defaultColDef={{ sortable: true, resizable: true }}
              selectionColumnDef={{ pinned: 'left' }}
              rowSelection={{
                mode: 'multiRow',
                checkboxes: true,
                headerCheckbox: true,
                enableClickSelection: false,
                selectAll: 'all',
              }}
              onSelectionChanged={handleSelectionChanged}
              pagination
              paginationPageSize={25}
              paginationPageSizeSelector={[25, 50, 100]}
              domLayout="normal"
              onSortChanged={handleSortChanged}
              onGridReady={handleGridReady}
              loading={loading}
              getRowId={(params) => params.data.id}
              enableCellTextSelection
              ensureDomOrder
              onRowClicked={(event) => openPo(event.data)}
              onCellKeyDown={(event) => {
                const keyboardEvent = event.event as KeyboardEvent | undefined;
                if (keyboardEvent?.key === 'Enter') openPo(event.data);
              }}
            />
          </Box>
        </Card>
      )}
    </Box>
  );
}
