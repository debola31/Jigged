'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import InputAdornment from '@mui/material/InputAdornment';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import SearchIcon from '@mui/icons-material/Search';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import GroupIcon from '@mui/icons-material/Group';
import BadgeIcon from '@mui/icons-material/Badge';
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings';
import PersonIcon from '@mui/icons-material/Person';

import { AgGridReact } from 'ag-grid-react';
import { ModuleRegistry, AllCommunityModule } from 'ag-grid-community';
import type {
  ColDef,
  GridReadyEvent,
  SelectionChangedEvent,
  RowClickedEvent,
  CellKeyDownEvent,
} from 'ag-grid-community';

// Register AG Grid modules (required for v35+)
ModuleRegistry.registerModules([AllCommunityModule]);

import { jiggedAgGridTheme } from '@/lib/agGridTheme';
import { getSupabase, getEdgeFunctionUrl } from '@/lib/supabase';
import ExportCsvButton from '@/components/common/ExportCsvButton';
import AdminGuard from '@/components/auth/AdminGuard';
import type { TeamMember } from '@/types/team';

/**
 * Get the Edge Function URL for unified team endpoint.
 */
const getTeamUrl = () => getEdgeFunctionUrl('team');

// TabPanel component following Operations pattern
interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

function TabPanel({ children, value, index, ...other }: TabPanelProps) {
  return (
    <div role="tabpanel" hidden={value !== index} id={`team-tabpanel-${index}`} {...other}>
      {value === index && <Box sx={{ pt: 3 }}>{children}</Box>}
    </div>
  );
}

/**
 * Team Module Page with Tabbed View.
 *
 * Currently includes:
 * - Operators tab: AG Grid table for managing operator accounts
 *
 * Future tabs can be added for Admin Staff, Roles, etc.
 */
export default function TeamPage() {
  const router = useRouter();
  const params = useParams();
  const companyId = params.companyId as string;

  // Tab state (0: Admins, 1: Users, 2: Operators)
  const [activeTab, setActiveTab] = useState(0);

  // Operators state (now uses TeamMember like other tabs)
  const [operators, setOperators] = useState<TeamMember[]>([]);
  const [operatorsLoading, setOperatorsLoading] = useState(false);
  const operatorsGridRef = useRef<AgGridReact<TeamMember>>(null);

  // Team members state (for Admins and Users tabs)
  const [admins, setAdmins] = useState<TeamMember[]>([]);
  const [users, setUsers] = useState<TeamMember[]>([]);
  const [adminsLoading, setAdminsLoading] = useState(false);
  const [usersLoading, setUsersLoading] = useState(false);
  const adminsGridRef = useRef<AgGridReact<TeamMember>>(null);
  const usersGridRef = useRef<AgGridReact<TeamMember>>(null);

  // Shared state
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const loading = activeTab === 0 ? adminsLoading : activeTab === 1 ? usersLoading : operatorsLoading;
  const gridRef = activeTab === 0 ? adminsGridRef : activeTab === 1 ? usersGridRef : operatorsGridRef;

  // Selection state
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // Delete dialog state
  const [deleteDialog, setDeleteDialog] = useState<{
    open: boolean;
    type: 'single' | 'bulk';
    id?: string;
    name?: string;
  }>({ open: false, type: 'single' });
  const [deleting, setDeleting] = useState(false);

  // Snackbar
  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity: 'error' | 'success';
  }>({ open: false, message: '', severity: 'success' });

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setSearchDebounced(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Load operators from unified team Edge Function
  const loadOperators = useCallback(async () => {
    setOperatorsLoading(true);
    try {
      const supabase = getSupabase();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        throw new Error('Not authenticated');
      }

      const url = `${getTeamUrl()}?company_id=${companyId}&role=operator`;
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch operators');
      }

      let data: TeamMember[] = await response.json();

      // Client-side search filter
      if (searchDebounced) {
        const searchLower = searchDebounced.toLowerCase();
        data = data.filter(
          (op) =>
            op.name?.toLowerCase().includes(searchLower) ||
            op.email?.toLowerCase().includes(searchLower)
        );
      }

      setOperators(data);
    } catch (err) {
      console.error('Error loading operators:', err);
      setSnackbar({
        open: true,
        message: 'Failed to load operators',
        severity: 'error',
      });
    } finally {
      setOperatorsLoading(false);
    }
  }, [companyId, searchDebounced]);

  // Load admins from unified team Edge Function
  const loadAdmins = useCallback(async () => {
    setAdminsLoading(true);
    try {
      const supabase = getSupabase();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        throw new Error('Not authenticated');
      }

      const url = `${getTeamUrl()}?company_id=${companyId}&role=admin`;
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch admins');
      }

      let data: TeamMember[] = await response.json();

      // Client-side search filter
      if (searchDebounced) {
        const searchLower = searchDebounced.toLowerCase();
        data = data.filter(
          (m) =>
            m.name?.toLowerCase().includes(searchLower) ||
            m.email?.toLowerCase().includes(searchLower)
        );
      }

      setAdmins(data);
    } catch (err) {
      console.error('Error loading admins:', err);
      setSnackbar({
        open: true,
        message: 'Failed to load admins',
        severity: 'error',
      });
    } finally {
      setAdminsLoading(false);
    }
  }, [companyId, searchDebounced]);

  // Load users from unified team Edge Function
  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    try {
      const supabase = getSupabase();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        throw new Error('Not authenticated');
      }

      const url = `${getTeamUrl()}?company_id=${companyId}&role=user`;
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch users');
      }

      let data: TeamMember[] = await response.json();

      // Client-side search filter
      if (searchDebounced) {
        const searchLower = searchDebounced.toLowerCase();
        data = data.filter(
          (m) =>
            m.name?.toLowerCase().includes(searchLower) ||
            m.email?.toLowerCase().includes(searchLower)
        );
      }

      setUsers(data);
    } catch (err) {
      console.error('Error loading users:', err);
      setSnackbar({
        open: true,
        message: 'Failed to load users',
        severity: 'error',
      });
    } finally {
      setUsersLoading(false);
    }
  }, [companyId, searchDebounced]);

  // Load data based on active tab
  useEffect(() => {
    if (activeTab === 0) {
      loadAdmins();
    } else if (activeTab === 1) {
      loadUsers();
    } else {
      loadOperators();
    }
  }, [activeTab, loadAdmins, loadUsers, loadOperators]);

  // Clear selection when search or tab changes
  useEffect(() => {
    setSelectedIds([]);
    if (activeTab === 0 && adminsGridRef.current?.api) {
      adminsGridRef.current.api.deselectAll();
    } else if (activeTab === 1 && usersGridRef.current?.api) {
      usersGridRef.current.api.deselectAll();
    } else if (activeTab === 2 && operatorsGridRef.current?.api) {
      operatorsGridRef.current.api.deselectAll();
    }
  }, [searchDebounced, activeTab]);

  // Calculate grid height dynamically based on active tab data
  const currentData = activeTab === 0 ? admins : activeTab === 1 ? users : operators;
  const gridHeight = useMemo(() => {
    if (loading || currentData.length === 0) return 600;
    const headerHeight = 56;
    const rowHeight = 52;
    const paginationHeight = 56;
    const displayedRows = Math.min(currentData.length, 25);
    return Math.max(headerHeight + rowHeight * displayedRows + paginationHeight, 400);
  }, [loading, currentData.length]);

  // Delete item(s) - all roles now use user_company_access
  const handleDelete = async () => {
    setDeleting(true);
    try {
      const supabase = getSupabase();
      const itemName = activeTab === 0 ? 'admin' : activeTab === 1 ? 'user' : 'operator';

      if (deleteDialog.type === 'single' && deleteDialog.id) {
        const { error } = await supabase
          .from('user_company_access')
          .delete()
          .eq('id', deleteDialog.id);

        if (error) throw error;

        setSnackbar({
          open: true,
          message: `${itemName.charAt(0).toUpperCase() + itemName.slice(1)} deleted`,
          severity: 'success',
        });
      } else if (deleteDialog.type === 'bulk') {
        const { error } = await supabase
          .from('user_company_access')
          .delete()
          .in('id', selectedIds);

        if (error) throw error;

        setSnackbar({
          open: true,
          message: `${selectedIds.length} ${itemName}${selectedIds.length > 1 ? 's' : ''} deleted`,
          severity: 'success',
        });
        setSelectedIds([]);
        if (gridRef.current?.api) {
          gridRef.current.api.deselectAll();
        }
      }

      setDeleteDialog({ open: false, type: 'single' });
      // Reload the appropriate data
      if (activeTab === 0) loadAdmins();
      else if (activeTab === 1) loadUsers();
      else loadOperators();
    } catch (err) {
      console.error('Error deleting:', err);
      setSnackbar({
        open: true,
        message: 'Failed to delete',
        severity: 'error',
      });
    } finally {
      setDeleting(false);
    }
  };

  // Selection change handler - all tabs now use TeamMember
  const handleSelectionChanged = (event: SelectionChangedEvent<TeamMember>) => {
    const selectedNodes = event.api.getSelectedNodes();
    const selectedData = selectedNodes
      .map((node) => node.data?.id)
      .filter((id): id is string => id !== undefined);
    setSelectedIds(selectedData);
  };

  // Row click navigation - all roles now go to same detail page
  const handleRowClicked = (event: RowClickedEvent<TeamMember>) => {
    if (!event.data) return;
    router.push(`/dashboard/${companyId}/team/members/${event.data.id}`);
  };

  // Keyboard navigation
  const handleCellKeyDown = (event: CellKeyDownEvent<TeamMember>) => {
    const keyboardEvent = event.event as KeyboardEvent | undefined;
    if (keyboardEvent?.key === 'Enter' && event.data) {
      router.push(`/dashboard/${companyId}/team/members/${event.data.id}`);
    }
  };

  // Bulk delete click handler
  const handleBulkDeleteClick = () => {
    setDeleteDialog({
      open: true,
      type: 'bulk',
    });
  };

  // Format relative time
  const formatRelativeTime = (dateString: string | null): string => {
    if (!dateString) return 'Never';
    const date = new Date(dateString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);

    if (hours < 1) return 'Just now';
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString();
  };

  // AG Grid column definitions for Operators (now uses TeamMember like others)
  const operatorColumnDefs: ColDef<TeamMember>[] = useMemo(
    () => [
      {
        field: 'name',
        headerName: 'Name',
        flex: 1,
        minWidth: 150,
        pinned: 'left' as const,
        valueFormatter: (params) => params.value || '—',
      },
      {
        field: 'email',
        headerName: 'Email',
        flex: 1,
        minWidth: 200,
        valueFormatter: (params) => params.value || '—',
      },
      {
        field: 'last_sign_in_at',
        headerName: 'Last Login',
        width: 130,
        valueFormatter: (params) => formatRelativeTime(params.value),
      },
    ],
    []
  );

  // AG Grid column definitions for Team Members (Admins/Users)
  const teamMemberColumnDefs: ColDef<TeamMember>[] = useMemo(
    () => [
      {
        field: 'name',
        headerName: 'Name',
        flex: 1,
        minWidth: 150,
        pinned: 'left' as const,
        valueFormatter: (params) => params.value || '—',
      },
      {
        field: 'email',
        headerName: 'Email',
        flex: 1,
        minWidth: 200,
        valueFormatter: (params) => params.value || '—',
      },
      {
        field: 'created_at',
        headerName: 'Joined',
        width: 130,
        valueFormatter: (params) => formatRelativeTime(params.value),
      },
    ],
    []
  );

  const defaultColDef: ColDef = useMemo(
    () => ({
      sortable: true,
      resizable: true,
    }),
    []
  );

  const onGridReady = (_params: GridReadyEvent) => {
    // Let flex + minWidth handle column sizing naturally.
    // sizeColumnsToFit() was preventing horizontal scroll on mobile.
  };

  return (
    <AdminGuard message="You don't have permission to manage team members.">
    <Box>
      {/* Tabs */}
      <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 0, mt: -2 }}>
        <Tabs value={activeTab} onChange={(_, v) => setActiveTab(v)}>
          <Tab label="Admins" icon={<AdminPanelSettingsIcon />} iconPosition="start" />
          <Tab label="Users" icon={<PersonIcon />} iconPosition="start" />
          <Tab label="Operators" icon={<BadgeIcon />} iconPosition="start" />
        </Tabs>
      </Box>

      {/* Admins Tab */}
      <TabPanel value={activeTab} index={0}>
        {/* Toolbar */}
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
            placeholder="Search admins..."
            size="small"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            sx={{ width: { xs: '100%', sm: 300 } }}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
              },
            }}
          />

          {/* Bulk actions - show when items selected */}
          {selectedIds.length > 0 && (
            <>
              <ExportCsvButton
                gridRef={adminsGridRef}
                fileName="admins-export"
                selectedCount={selectedIds.length}
              />
              <Button
                variant="contained"
                color="error"
                startIcon={<DeleteIcon />}
                onClick={handleBulkDeleteClick}
              >
                Delete ({selectedIds.length})
              </Button>
            </>
          )}

          <Box sx={{ flex: 1 }} />
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => router.push(`/dashboard/${companyId}/team/members/new?role=admin`)}
          >
            New Admin
          </Button>
        </Box>

        {/* Data Grid or Empty State */}
        {!adminsLoading && admins.length === 0 ? (
          <Card elevation={2}>
            <CardContent sx={{ p: 6, textAlign: 'center' }}>
              <AdminPanelSettingsIcon sx={{ fontSize: 64, color: 'text.secondary', mb: 2 }} />
              <Typography variant="h6" color="text.secondary" gutterBottom>
                No admins yet
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                {searchDebounced
                  ? 'No admins match your search.'
                  : 'Add your first admin.'}
              </Typography>
              {!searchDebounced && (
                <Button
                  variant="contained"
                  startIcon={<AddIcon />}
                  onClick={() => router.push(`/dashboard/${companyId}/team/members/new?role=admin`)}
                >
                  Add Admin
                </Button>
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
                '& .ag-cell:focus, & .ag-header-cell:focus': {
                  outline: 'none !important',
                  border: 'none !important',
                },
              }}
            >
              <AgGridReact<TeamMember>
                ref={adminsGridRef}
                rowData={admins}
                columnDefs={teamMemberColumnDefs}
                theme={jiggedAgGridTheme}
                defaultColDef={defaultColDef}
                rowSelection={{
                  mode: 'multiRow',
                  checkboxes: true,
                  headerCheckbox: true,
                  enableClickSelection: false,
                  selectAll: 'all',
                }}
                onSelectionChanged={handleSelectionChanged}
                onRowClicked={handleRowClicked}
                onCellKeyDown={handleCellKeyDown}
                pagination={true}
                paginationPageSize={25}
                paginationPageSizeSelector={[25, 50, 100]}
                suppressPaginationPanel={false}
                domLayout="normal"
                onGridReady={onGridReady}
                loading={adminsLoading}
                suppressCellFocus={false}
                suppressMenuHide={false}
                getRowId={(params) => params.data.id}
                enableCellTextSelection={true}
                ensureDomOrder={true}
              />
            </Box>
          </Card>
        )}
      </TabPanel>

      {/* Users Tab */}
      <TabPanel value={activeTab} index={1}>
        {/* Toolbar */}
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
            placeholder="Search users..."
            size="small"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            sx={{ width: { xs: '100%', sm: 300 } }}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
              },
            }}
          />

          {/* Bulk actions - show when items selected */}
          {selectedIds.length > 0 && (
            <>
              <ExportCsvButton
                gridRef={usersGridRef}
                fileName="users-export"
                selectedCount={selectedIds.length}
              />
              <Button
                variant="contained"
                color="error"
                startIcon={<DeleteIcon />}
                onClick={handleBulkDeleteClick}
              >
                Delete ({selectedIds.length})
              </Button>
            </>
          )}

          <Box sx={{ flex: 1 }} />
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => router.push(`/dashboard/${companyId}/team/members/new?role=user`)}
          >
            New User
          </Button>
        </Box>

        {/* Data Grid or Empty State */}
        {!usersLoading && users.length === 0 ? (
          <Card elevation={2}>
            <CardContent sx={{ p: 6, textAlign: 'center' }}>
              <PersonIcon sx={{ fontSize: 64, color: 'text.secondary', mb: 2 }} />
              <Typography variant="h6" color="text.secondary" gutterBottom>
                No users yet
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                {searchDebounced
                  ? 'No users match your search.'
                  : 'Add your first user.'}
              </Typography>
              {!searchDebounced && (
                <Button
                  variant="contained"
                  startIcon={<AddIcon />}
                  onClick={() => router.push(`/dashboard/${companyId}/team/members/new?role=user`)}
                >
                  Add User
                </Button>
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
                '& .ag-cell:focus, & .ag-header-cell:focus': {
                  outline: 'none !important',
                  border: 'none !important',
                },
              }}
            >
              <AgGridReact<TeamMember>
                ref={usersGridRef}
                rowData={users}
                columnDefs={teamMemberColumnDefs}
                theme={jiggedAgGridTheme}
                defaultColDef={defaultColDef}
                rowSelection={{
                  mode: 'multiRow',
                  checkboxes: true,
                  headerCheckbox: true,
                  enableClickSelection: false,
                  selectAll: 'all',
                }}
                onSelectionChanged={handleSelectionChanged}
                onRowClicked={handleRowClicked}
                onCellKeyDown={handleCellKeyDown}
                pagination={true}
                paginationPageSize={25}
                paginationPageSizeSelector={[25, 50, 100]}
                suppressPaginationPanel={false}
                domLayout="normal"
                onGridReady={onGridReady}
                loading={usersLoading}
                suppressCellFocus={false}
                suppressMenuHide={false}
                getRowId={(params) => params.data.id}
                enableCellTextSelection={true}
                ensureDomOrder={true}
              />
            </Box>
          </Card>
        )}
      </TabPanel>

      {/* Operators Tab */}
      <TabPanel value={activeTab} index={2}>
        {/* Toolbar */}
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
            placeholder="Search operators..."
            size="small"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            sx={{ width: { xs: '100%', sm: 300 } }}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
              },
            }}
          />

          {/* Bulk actions - show when items selected */}
          {selectedIds.length > 0 && (
            <>
              <ExportCsvButton
                gridRef={operatorsGridRef}
                fileName="operators-export"
                selectedCount={selectedIds.length}
              />
              <Button
                variant="contained"
                color="error"
                startIcon={<DeleteIcon />}
                onClick={handleBulkDeleteClick}
              >
                Delete ({selectedIds.length})
              </Button>
            </>
          )}

          <Box sx={{ flex: 1 }} />
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => router.push(`/dashboard/${companyId}/team/members/new?role=operator`)}
          >
            New Operator
          </Button>
        </Box>

        {/* Data Grid or Empty State */}
        {!operatorsLoading && operators.length === 0 ? (
          <Card elevation={2}>
            <CardContent sx={{ p: 6, textAlign: 'center' }}>
              <GroupIcon sx={{ fontSize: 64, color: 'text.secondary', mb: 2 }} />
              <Typography variant="h6" color="text.secondary" gutterBottom>
                No operators yet
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                {searchDebounced
                  ? 'No operators match your search.'
                  : 'Create your first operator.'}
              </Typography>
              {!searchDebounced && (
                <Button
                  variant="contained"
                  startIcon={<AddIcon />}
                  onClick={() => router.push(`/dashboard/${companyId}/team/members/new?role=operator`)}
                >
                  Add Operator
                </Button>
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
                '& .ag-cell:focus, & .ag-header-cell:focus': {
                  outline: 'none !important',
                  border: 'none !important',
                },
              }}
            >
              <AgGridReact<TeamMember>
                ref={operatorsGridRef}
                rowData={operators}
                columnDefs={operatorColumnDefs}
                theme={jiggedAgGridTheme}
                defaultColDef={defaultColDef}
                rowSelection={{
                  mode: 'multiRow',
                  checkboxes: true,
                  headerCheckbox: true,
                  enableClickSelection: false,
                  selectAll: 'all',
                }}
                onSelectionChanged={handleSelectionChanged}
                onRowClicked={handleRowClicked}
                onCellKeyDown={handleCellKeyDown}
                pagination={true}
                paginationPageSize={25}
                paginationPageSizeSelector={[25, 50, 100]}
                suppressPaginationPanel={false}
                domLayout="normal"
                onGridReady={onGridReady}
                loading={operatorsLoading}
                suppressCellFocus={false}
                suppressMenuHide={false}
                getRowId={(params) => params.data.id}
                enableCellTextSelection={true}
                ensureDomOrder={true}
              />
            </Box>
          </Card>
        )}
      </TabPanel>

      {/* Delete Dialog */}
      <Dialog
        open={deleteDialog.open}
        onClose={() => !deleting && setDeleteDialog({ open: false, type: 'single' })}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle sx={{ pb: 2 }}>
          {deleteDialog.type === 'single'
            ? `Delete ${activeTab === 0 ? 'Admin' : activeTab === 1 ? 'User' : 'Operator'}`
            : `Delete ${activeTab === 0 ? 'Admins' : activeTab === 1 ? 'Users' : 'Operators'}`}
        </DialogTitle>
        <DialogContent sx={{ pt: 0 }}>
          <Box sx={{ mb: 2 }}>
            <Typography variant="body1" sx={{ mb: 1 }}>
              {deleteDialog.type === 'single' ? (
                <>
                  Are you sure you want to delete <strong>{deleteDialog.name}</strong>?
                </>
              ) : (
                <>
                  Are you sure you want to delete <strong>{selectedIds.length}</strong>{' '}
                  {activeTab === 0 ? 'admin' : activeTab === 1 ? 'user' : 'operator'}
                  {selectedIds.length > 1 ? 's' : ''}?
                </>
              )}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              This action cannot be undone.
            </Typography>
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button
            onClick={() => setDeleteDialog({ open: false, type: 'single' })}
            disabled={deleting}
            color="inherit"
            size="large"
          >
            Cancel
          </Button>
          <Button
            onClick={handleDelete}
            variant="contained"
            color="error"
            disabled={deleting}
            size="large"
            startIcon={deleting ? <CircularProgress size={16} color="inherit" /> : <DeleteIcon />}
          >
            {deleting ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Snackbar */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={5000}
        onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
      >
        <Alert severity={snackbar.severity} onClose={() => setSnackbar((s) => ({ ...s, open: false }))}>
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
    </AdminGuard>
  );
}
