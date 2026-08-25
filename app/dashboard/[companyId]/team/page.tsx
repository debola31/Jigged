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
import StatusChip from '@/components/common/StatusChip';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import DeleteIcon from '@mui/icons-material/Delete';
import SendIcon from '@mui/icons-material/Send';
import CloseIcon from '@mui/icons-material/Close';
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
import { useDemoMode } from '@/components/providers/DemoModeProvider';
import type { TeamMember, Invitation, TeamRow } from '@/types/team';

/**
 * Get the Edge Function URL for unified team endpoint.
 */
const getTeamUrl = () => getEdgeFunctionUrl('team');
const getInvitesUrl = () => getEdgeFunctionUrl('team-invites');

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

// Per-company persistence of the selected tab (device-local). Scoped by company
// to match `jigged.jobs.statusFilter.${companyId}` and the companyId-keyed
// operator station: one user can hold access to several shops, and the tab they
// work from in one is not the tab they work from in another. localStorage
// rather than sessionStorage -- "the tab I was on last time" includes tomorrow
// morning, not just this browser session.
const tabStorageKey = (companyId: string) => `jigged.team.activeTab.${companyId}`;

/**
 * The stored tab for this company, or 0 (Admins).
 *
 * Anything unrecognised falls back to Admins rather than rendering a tab that
 * does not exist: an index left behind by a future tab set, a hand-edited
 * value, or storage blocked outright (Safari private mode throws on access).
 * An ABSENT key lands there too, via `Number(null) === 0` -- the same answer by
 * a different route, which is why there is no separate null branch.
 */
function readStoredTab(companyId: string): number {
  if (typeof window === 'undefined') return 0;
  try {
    const n = Number(window.localStorage.getItem(tabStorageKey(companyId)));
    return n === 0 || n === 1 || n === 2 ? n : 0;
  } catch {
    return 0;
  }
}

function writeStoredTab(companyId: string, tab: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(tabStorageKey(companyId), String(tab));
  } catch {
    // ignore quota / privacy-mode write failures -- persistence is best-effort
  }
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
  const { isDemoMode } = useDemoMode();

  // Tab state (0: Admins, 1: Users, 2: Operators), seeded from the device-local
  // memory of the last tab used in THIS company.
  //
  // A lazy initializer, and deliberately NOT the mount-effect shape the jobs
  // list uses for its saved Status filter -- that page's SSR reasoning does not
  // transfer here. Nothing in this component renders on the server or in the
  // first client render: the dashboard layout wraps every page in AuthGuard,
  // which returns a spinner while its access check runs, and AdminGuard is a
  // second gate behind it. React never calls this function until after
  // hydration, so there is no server render for a localStorage read to
  // disagree with.
  //
  // Doing it in an effect instead would cost a real Edge Function round trip --
  // the loader effect below would fire loadAdmins() on tab 0 and then
  // loadOperators() once the effect corrected it -- plus a flash of the Admins
  // tab on every visit.
  const [activeTab, setActiveTab] = useState(() => readStoredTab(companyId));

  // Operators state
  const [operators, setOperators] = useState<TeamRow[]>([]);
  const [operatorsLoading, setOperatorsLoading] = useState(false);
  const operatorsGridRef = useRef<AgGridReact<TeamRow>>(null);

  // Team members state (for Admins and Users tabs)
  const [admins, setAdmins] = useState<TeamRow[]>([]);
  const [users, setUsers] = useState<TeamRow[]>([]);
  const [adminsLoading, setAdminsLoading] = useState(false);
  const [usersLoading, setUsersLoading] = useState(false);
  const adminsGridRef = useRef<AgGridReact<TeamRow>>(null);
  const usersGridRef = useRef<AgGridReact<TeamRow>>(null);

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

  // Invitations state
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [_invitationsLoading, setInvitationsLoading] = useState(false);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setSearchDebounced(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Convert a TeamMember to a TeamRow
  const memberToRow = (m: TeamMember): TeamRow => ({
    id: m.id,
    type: 'member',
    name: m.name,
    email: m.email,
    role: m.role,
    status: 'active',
    created_at: m.created_at,
    last_sign_in_at: m.last_sign_in_at,
  });

  // Convert an Invitation to a TeamRow
  const invitationToRow = (inv: Invitation): TeamRow => ({
    id: `inv-${inv.id}`,
    type: 'invitation',
    name: null,
    email: inv.email,
    role: inv.role,
    status: 'pending',
    created_at: inv.created_at,
    expires_at: inv.expires_at,
    invitation_id: inv.id,
  });

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

      const data: TeamMember[] = await response.json();
      const memberRows = data.map(memberToRow);
      const pendingRows = invitations.filter(inv => inv.role === 'operator').map(invitationToRow);
      let combined = [...memberRows, ...pendingRows];

      // Client-side search filter
      if (searchDebounced) {
        const searchLower = searchDebounced.toLowerCase();
        combined = combined.filter(
          (row) =>
            row.name?.toLowerCase().includes(searchLower) ||
            row.email?.toLowerCase().includes(searchLower)
        );
      }

      setOperators(combined);
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
  }, [companyId, searchDebounced, invitations]);

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

      const data: TeamMember[] = await response.json();
      const memberRows = data.map(memberToRow);
      const pendingRows = invitations.filter(inv => inv.role === 'admin').map(invitationToRow);
      let combined = [...memberRows, ...pendingRows];

      // Client-side search filter
      if (searchDebounced) {
        const searchLower = searchDebounced.toLowerCase();
        combined = combined.filter(
          (m) =>
            m.name?.toLowerCase().includes(searchLower) ||
            m.email?.toLowerCase().includes(searchLower)
        );
      }

      setAdmins(combined);
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
  }, [companyId, searchDebounced, invitations]);

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

      const data: TeamMember[] = await response.json();
      const memberRows = data.map(memberToRow);
      const pendingRows = invitations.filter(inv => inv.role === 'user').map(invitationToRow);
      let combined = [...memberRows, ...pendingRows];

      // Client-side search filter
      if (searchDebounced) {
        const searchLower = searchDebounced.toLowerCase();
        combined = combined.filter(
          (m) =>
            m.name?.toLowerCase().includes(searchLower) ||
            m.email?.toLowerCase().includes(searchLower)
        );
      }

      setUsers(combined);
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
  }, [companyId, searchDebounced, invitations]);

  // Load pending invitations
  const loadInvitations = useCallback(async () => {
    setInvitationsLoading(true);
    try {
      const supabase = getSupabase();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      const url = `${getInvitesUrl()}?company_id=${companyId}`;
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${session.access_token}` },
      });

      if (!response.ok) throw new Error('Failed to fetch invitations');

      const data: Invitation[] = await response.json();
      setInvitations(data.filter((inv) => inv.status === 'pending'));
    } catch (err) {
      console.error('Error loading invitations:', err);
    } finally {
      setInvitationsLoading(false);
    }
  }, [companyId]);

  // Low-level: revoke a single invitation via the team-invites Edge Function.
  // Returns true on success. No UI side effects — callers own messaging/refresh,
  // so this is reusable by both the per-row Revoke button and bulk delete.
  const revokeInvitationRequest = useCallback(async (
    invitationId: string,
    accessToken: string
  ): Promise<boolean> => {
    try {
      const response = await fetch(`${getInvitesUrl()}/${invitationId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });
      return response.ok;
    } catch {
      return false;
    }
  }, []);

  // Revoke an invitation
  const handleRevokeInvitation = useCallback(async (invitationId: string) => {
    const supabase = getSupabase();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    const ok = await revokeInvitationRequest(invitationId, session.access_token);
    if (ok) {
      setSnackbar({ open: true, message: 'Invitation revoked', severity: 'success' });
      loadInvitations();
    } else {
      setSnackbar({ open: true, message: 'Failed to revoke invitation', severity: 'error' });
    }
  }, [revokeInvitationRequest, loadInvitations]);

  // Resend an invitation
  const handleResendInvitation = useCallback(async (invitationId: string) => {
    try {
      const supabase = getSupabase();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      const response = await fetch(`${getInvitesUrl()}/${invitationId}/resend`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${session.access_token}` },
      });

      if (!response.ok) throw new Error('Failed to resend invitation');

      const data = await response.json();
      setSnackbar({ open: true, message: data.message || 'Invitation resent', severity: 'success' });
      loadInvitations();
    } catch (err) {
      console.error('Error resending invitation:', err);
      setSnackbar({ open: true, message: 'Failed to resend invitation', severity: 'error' });
    }
  }, [loadInvitations]);

  // Load invitations on mount. Data-fetch-on-mount false positive: the loader's
  // setState all runs post-await (the documented class in eslint.config.mjs);
  // the tab loaders chain getSession→fetch, awkward to restructure cleanly.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadInvitations();
  }, [loadInvitations]);

  // Load data based on active tab.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- data-fetch-on-mount: each loader's setState runs post-await */
    if (activeTab === 0) {
      loadAdmins();
    } else if (activeTab === 1) {
      loadUsers();
    } else {
      loadOperators();
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [activeTab, loadAdmins, loadUsers, loadOperators]);

  // Clear selection when search or tab changes — the rows on screen change, so
  // any ids selected before may no longer be visible. Deselects all three
  // per-tab grids (the refs are stable, so the empty dep list is correct);
  // doing all of them keeps this independent of which tab is active. Called
  // from each control's onChange (not an effect) to avoid set-state-in-effect.
  const clearSelection = useCallback(() => {
    setSelectedIds([]);
    adminsGridRef.current?.api?.deselectAll();
    usersGridRef.current?.api?.deselectAll();
    operatorsGridRef.current?.api?.deselectAll();
  }, []);

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

  // Delete selected row(s). A row is either an active member (a
  // user_company_access row) or a pending invitation (id prefixed `inv-`,
  // backed by the invitations table). These live in different places and must
  // be removed differently — members via Supabase, invitations via the
  // team-invites Edge Function — so we split the selection and route each kind.
  const handleDelete = async () => {
    setDeleting(true);
    try {
      const supabase = getSupabase();
      const itemName = activeTab === 0 ? 'admin' : activeTab === 1 ? 'user' : 'operator';

      // Unify single + bulk into one target list.
      const targetIds =
        deleteDialog.type === 'single'
          ? deleteDialog.id
            ? [deleteDialog.id]
            : []
          : selectedIds;

      const inviteIds = targetIds
        .filter((id) => id.startsWith('inv-'))
        .map((id) => id.slice('inv-'.length));
      const memberIds = targetIds.filter((id) => !id.startsWith('inv-'));

      if (targetIds.length === 0) {
        setDeleteDialog({ open: false, type: 'single' });
        return;
      }

      let removedMembers = 0;
      let revokedInvites = 0;
      let failedInvites = 0;

      // Remove active members. count: 'exact' verifies the DB actually deleted
      // the rows rather than silently matching zero (e.g. RLS), so the toast
      // reflects reality instead of assuming success.
      if (memberIds.length > 0) {
        const { error, count } = await supabase
          .from('user_company_access')
          .delete({ count: 'exact' })
          .in('id', memberIds);

        if (error) throw error;
        removedMembers = count ?? 0;
      }

      // Revoke pending invitations via the team-invites Edge Function.
      if (inviteIds.length > 0) {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error('Not authenticated');

        const results = await Promise.all(
          inviteIds.map((invId) => revokeInvitationRequest(invId, session.access_token))
        );
        revokedInvites = results.filter(Boolean).length;
        failedInvites = results.length - revokedInvites;
      }

      const totalRemoved = removedMembers + revokedInvites;

      if (failedInvites > 0) {
        // Partial or total failure on the invitation side — surface it.
        setSnackbar({
          open: true,
          message:
            totalRemoved > 0
              ? `Removed ${totalRemoved}, but ${failedInvites} invitation${failedInvites > 1 ? 's' : ''} could not be revoked`
              : 'Failed to delete',
          severity: 'error',
        });
      } else {
        setSnackbar({
          open: true,
          message: `${totalRemoved} ${itemName}${totalRemoved > 1 ? 's' : ''} removed`,
          severity: 'success',
        });
      }

      setSelectedIds([]);
      if (gridRef.current?.api) {
        gridRef.current.api.deselectAll();
      }
      setDeleteDialog({ open: false, type: 'single' });

      // Refresh data: invitations state feeds the role grids, so reload it
      // whenever invites were touched, then reload the active member list.
      if (inviteIds.length > 0) loadInvitations();
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

  // Selection change handler
  const handleSelectionChanged = (event: SelectionChangedEvent<TeamRow>) => {
    const selectedNodes = event.api.getSelectedNodes();
    const selectedData = selectedNodes
      .map((node) => node.data?.id)
      .filter((id): id is string => id !== undefined);
    setSelectedIds(selectedData);
  };

  // Row click navigation - only for active members, not pending invitations
  const handleRowClicked = (event: RowClickedEvent<TeamRow>) => {
    if (!event.data || event.data.type === 'invitation') return;
    router.push(`/dashboard/${companyId}/team/members/${event.data.id}`);
  };

  // Keyboard navigation
  const handleCellKeyDown = (event: CellKeyDownEvent<TeamRow>) => {
    const keyboardEvent = event.event as KeyboardEvent | undefined;
    if (keyboardEvent?.key === 'Enter' && event.data && event.data.type === 'member') {
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

  // Status cell renderer
  const StatusCellRenderer = useCallback((params: { value: string }) => {
    if (params.value === 'pending') {
      return <StatusChip label="Pending" color="warning" />;
    }
    return <StatusChip label="Active" color="success" />;
  }, []);

  // Actions cell renderer -- pending invitation rows only. A member row carries
  // no per-row action: the row itself is the control, clicking through to the
  // member page. It briefly carried an audited per-person recorded-time icon,
  // which is gone along with the whole per-person reporting path.
  const ActionsCellRenderer = useCallback((params: { data: TeamRow }) => {
    if (params.data?.type !== 'invitation') return null;
    if (!params.data.invitation_id) return null;
    return (
      <Box sx={{ display: 'flex', gap: 0.5 }}>
        <Tooltip title="Resend invitation">
          <IconButton
            size="small"
            onClick={(e) => {
              e.stopPropagation();
              handleResendInvitation(params.data.invitation_id!);
            }}
          >
            <SendIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Revoke invitation">
          <IconButton
            size="small"
            onClick={(e) => {
              e.stopPropagation();
              handleRevokeInvitation(params.data.invitation_id!);
            }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
    );
  }, [handleResendInvitation, handleRevokeInvitation]);

  // AG Grid column definitions -- ONE array, all three tabs.
  //
  // This was two arrays differing in a single column: Admins/Users showed
  // `created_at` as "Joined", Operators showed `last_sign_in_at` as "Last
  // Login". All three now show Last Login, because that is the question this
  // screen actually gets asked -- who is still using this -- and a join date
  // answered a question nobody had. The copies are merged rather than edited in
  // parallel: keeping two identical-but-for-one-column arrays side by side is
  // exactly how they silently diverged.
  const teamColumnDefs: ColDef<TeamRow>[] = useMemo(
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
        field: 'status',
        headerName: 'Status',
        width: 120,
        cellRenderer: StatusCellRenderer,
      },
      // 'Never' (formatRelativeTime's null case) is the honest reading for both
      // rows that can carry no value: a pending invitation, which has no
      // last_sign_in_at at all, and a member who has not signed in yet. The
      // Operators tab has read this way since the column was added.
      {
        field: 'last_sign_in_at',
        headerName: 'Last Login',
        width: 130,
        valueFormatter: (params) => formatRelativeTime(params.value),
      },
      // Invitation-row actions (Resend / Revoke). Invitation rows appear on all
      // three tabs, so the column earns its place on all three. 100px is what
      // two small IconButtons need: 2 x 30px + a 4px gap + the grid theme's
      // 16px cell padding either side. `colId` is what ExportCsvButton filters
      // on to keep this column out of the CSV.
      {
        colId: 'actions',
        headerName: '',
        width: 100,
        sortable: false,
        resizable: false,
        cellRenderer: ActionsCellRenderer,
        suppressHeaderMenuButton: true,
      },
    ],
    [StatusCellRenderer, ActionsCellRenderer]
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
        <Tabs
          value={activeTab}
          onChange={(_, v) => {
            setActiveTab(v);
            writeStoredTab(companyId, v); // persist the deliberate choice
            clearSelection();
          }}
        >
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
            onChange={(e) => {
              setSearch(e.target.value);
              clearSelection();
            }}
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
          {!isDemoMode && (
            <Button
              variant="contained"
              startIcon={<PersonAddIcon />}
              onClick={() => router.push(`/dashboard/${companyId}/team/members/new?role=admin`)}
            >
              Invite Admin
            </Button>
          )}
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
                  : isDemoMode
                    ? 'No admins in this demo company.'
                    : 'Invite your first admin.'}
              </Typography>
              {!searchDebounced && !isDemoMode && (
                <Button
                  variant="contained"
                  startIcon={<PersonAddIcon />}
                  onClick={() => router.push(`/dashboard/${companyId}/team/members/new?role=admin`)}
                >
                  Invite Admin
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
              <AgGridReact<TeamRow>
                ref={adminsGridRef}
                rowData={admins}
                columnDefs={teamColumnDefs}
                theme={jiggedAgGridTheme}
                defaultColDef={defaultColDef}
                selectionColumnDef={{ pinned: 'left' }}
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
            onChange={(e) => {
              setSearch(e.target.value);
              clearSelection();
            }}
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
          {!isDemoMode && (
            <Button
              variant="contained"
              startIcon={<PersonAddIcon />}
              onClick={() => router.push(`/dashboard/${companyId}/team/members/new?role=user`)}
            >
              Invite User
            </Button>
          )}
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
                  : isDemoMode
                    ? 'No users in this demo company.'
                    : 'Invite your first user.'}
              </Typography>
              {!searchDebounced && !isDemoMode && (
                <Button
                  variant="contained"
                  startIcon={<PersonAddIcon />}
                  onClick={() => router.push(`/dashboard/${companyId}/team/members/new?role=user`)}
                >
                  Invite User
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
              <AgGridReact<TeamRow>
                ref={usersGridRef}
                rowData={users}
                columnDefs={teamColumnDefs}
                theme={jiggedAgGridTheme}
                defaultColDef={defaultColDef}
                selectionColumnDef={{ pinned: 'left' }}
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
            onChange={(e) => {
              setSearch(e.target.value);
              clearSelection();
            }}
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
          {!isDemoMode && (
            <Button
              variant="contained"
              startIcon={<PersonAddIcon />}
              onClick={() => router.push(`/dashboard/${companyId}/team/members/new?role=operator`)}
            >
              Invite Operator
            </Button>
          )}
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
                  : isDemoMode
                    ? 'No operators in this demo company.'
                    : 'Invite your first operator.'}
              </Typography>
              {!searchDebounced && !isDemoMode && (
                <Button
                  variant="contained"
                  startIcon={<PersonAddIcon />}
                  onClick={() => router.push(`/dashboard/${companyId}/team/members/new?role=operator`)}
                >
                  Invite Operator
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
              <AgGridReact<TeamRow>
                ref={operatorsGridRef}
                rowData={operators}
                columnDefs={teamColumnDefs}
                theme={jiggedAgGridTheme}
                defaultColDef={defaultColDef}
                selectionColumnDef={{ pinned: 'left' }}
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
