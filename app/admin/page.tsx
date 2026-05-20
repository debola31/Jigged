'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import InputAdornment from '@mui/material/InputAdornment';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Divider from '@mui/material/Divider';
import SearchIcon from '@mui/icons-material/Search';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import EmailIcon from '@mui/icons-material/Email';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import ToggleOnIcon from '@mui/icons-material/ToggleOn';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import Stack from '@mui/material/Stack';

import { AgGridReact } from 'ag-grid-react';
import { ModuleRegistry, AllCommunityModule } from 'ag-grid-community';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';

ModuleRegistry.registerModules([AllCommunityModule]);

import { jiggedAgGridTheme } from '@/lib/agGridTheme';
import { getSupabase } from '@/lib/supabase';
import { KNOWN_FEATURES } from '@/lib/featureFlags';

interface CompanyListItem {
  id: string;
  name: string;
  slug: string | null;
  created_at: string;
  owner_name: string | null;
  owner_email: string | null;
  member_count: number;
  features: Record<string, boolean>;
}

const getAdminApiUrl = () => {
  const baseUrl = process.env.NEXT_PUBLIC_API_URL || '';
  if (baseUrl.endsWith('/api')) {
    return `${baseUrl}/admin/companies`;
  }
  return `${baseUrl}/api/admin/companies`;
};

async function getAuthHeaders(): Promise<Record<string, string>> {
  const supabase = getSupabase();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new Error('Not authenticated');
  }
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${session.access_token}`,
  };
}

export default function AdminCompaniesPage() {
  const router = useRouter();
  const [companies, setCompanies] = useState<CompanyListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [snackbar, setSnackbar] = useState({ open: false, message: '', severity: 'success' as 'success' | 'error' });

  // Create form state
  const [form, setForm] = useState({
    company_name: '',
    owner_first_name: '',
    owner_last_name: '',
    owner_email: '',
  });
  const [formError, setFormError] = useState('');

  // Edit state
  const [editOpen, setEditOpen] = useState(false);
  const [editCompany, setEditCompany] = useState<CompanyListItem | null>(null);
  const [editName, setEditName] = useState('');
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState('');

  // Delete state
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteCompany, setDeleteCompany] = useState<CompanyListItem | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);

  // Feature-flags state
  const [featuresOpen, setFeaturesOpen] = useState(false);
  const [featuresCompany, setFeaturesCompany] = useState<CompanyListItem | null>(null);
  const [featuresDraft, setFeaturesDraft] = useState<Record<string, boolean>>({});
  const [featuresSaving, setFeaturesSaving] = useState(false);
  const [featuresError, setFeaturesError] = useState('');

  const fetchCompanies = useCallback(async () => {
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(getAdminApiUrl(), { headers });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ detail: 'Failed to fetch companies' }));
        throw new Error(error.detail || 'Failed to fetch companies');
      }

      const data = await response.json();
      setCompanies(data);
    } catch (err) {
      console.error('Error fetching companies:', err);
      setSnackbar({ open: true, message: 'Failed to load companies', severity: 'error' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCompanies();
  }, [fetchCompanies]);

  // Filtered companies based on search
  const filteredCompanies = useMemo(() => {
    if (!search.trim()) return companies;
    const q = search.toLowerCase();
    return companies.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.slug?.toLowerCase().includes(q) ||
        c.owner_name?.toLowerCase().includes(q) ||
        c.owner_email?.toLowerCase().includes(q)
    );
  }, [companies, search]);

  // --- Actions handlers ---

  const handleVisitDashboard = useCallback(
    (e: React.MouseEvent, company: CompanyListItem) => {
      e.stopPropagation();
      router.push(`/dashboard/${company.id}`);
    },
    [router]
  );

  const handleEditOpen = useCallback((e: React.MouseEvent, company: CompanyListItem) => {
    e.stopPropagation();
    setEditCompany(company);
    setEditName(company.name);
    setEditError('');
    setEditOpen(true);
  }, []);

  const handleEditClose = () => {
    setEditOpen(false);
    setEditCompany(null);
    setEditName('');
    setEditError('');
  };

  const handleEditSave = async () => {
    if (!editCompany) return;
    if (!editName.trim()) {
      setEditError('Company name is required');
      return;
    }

    setEditing(true);
    setEditError('');

    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${getAdminApiUrl()}/${editCompany.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ name: editName.trim() }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ detail: 'Failed to update company' }));
        throw new Error(error.detail || 'Failed to update company');
      }

      const data = await response.json();
      setSnackbar({
        open: true,
        message: `Updated "${data.name}" successfully`,
        severity: 'success',
      });
      handleEditClose();
      fetchCompanies();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update company';
      setEditError(message);
    } finally {
      setEditing(false);
    }
  };

  const handleFeaturesOpen = useCallback((e: React.MouseEvent, company: CompanyListItem) => {
    e.stopPropagation();
    setFeaturesCompany(company);
    // Seed the draft from the registry so unknown saved flags don't
    // accidentally survive a save, and unset flags render as off.
    const seeded: Record<string, boolean> = {};
    for (const f of KNOWN_FEATURES) {
      seeded[f.key] = Boolean(company.features?.[f.key]);
    }
    setFeaturesDraft(seeded);
    setFeaturesError('');
    setFeaturesOpen(true);
  }, []);

  const handleFeaturesClose = () => {
    if (featuresSaving) return;
    setFeaturesOpen(false);
    setFeaturesCompany(null);
    setFeaturesDraft({});
    setFeaturesError('');
  };

  const handleFeaturesSave = async () => {
    if (!featuresCompany) return;
    setFeaturesSaving(true);
    setFeaturesError('');
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(
        `${getAdminApiUrl()}/${featuresCompany.id}/features`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ features: featuresDraft }),
        },
      );
      if (!response.ok) {
        const error = await response.json().catch(() => ({ detail: 'Failed to update features' }));
        throw new Error(error.detail || 'Failed to update features');
      }
      const data = await response.json();
      setSnackbar({
        open: true,
        message: `Updated features for "${featuresCompany.name}"`,
        severity: 'success',
      });
      setFeaturesOpen(false);
      setFeaturesCompany(null);
      setFeaturesDraft({});
      // Optimistic merge into the row + full refresh so other admins'
      // changes show up too.
      setCompanies((prev) =>
        prev.map((c) =>
          c.id === featuresCompany.id
            ? { ...c, features: data.features ?? featuresDraft }
            : c,
        ),
      );
      fetchCompanies();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update features';
      setFeaturesError(message);
    } finally {
      setFeaturesSaving(false);
    }
  };

  const handleDeleteOpen = useCallback((e: React.MouseEvent, company: CompanyListItem) => {
    e.stopPropagation();
    setDeleteCompany(company);
    setDeleteConfirmName('');
    setDeleteOpen(true);
  }, []);

  const handleDeleteClose = () => {
    setDeleteOpen(false);
    setDeleteCompany(null);
    setDeleteConfirmName('');
  };

  const handleDeleteConfirm = async () => {
    if (!deleteCompany) return;

    setDeleting(true);

    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${getAdminApiUrl()}/${deleteCompany.id}`, {
        method: 'DELETE',
        headers,
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ detail: 'Failed to delete company' }));
        throw new Error(error.detail || 'Failed to delete company');
      }

      setSnackbar({
        open: true,
        message: `Deleted "${deleteCompany.name}" successfully`,
        severity: 'success',
      });
      handleDeleteClose();
      fetchCompanies();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete company';
      setSnackbar({ open: true, message, severity: 'error' });
    } finally {
      setDeleting(false);
    }
  };

  // AG Grid columns
  const columnDefs: ColDef<CompanyListItem>[] = useMemo(
    () => [
      {
        field: 'name',
        headerName: 'Company Name',
        flex: 1.5,
        minWidth: 180,
        pinned: 'left' as const,
      },
      {
        field: 'slug',
        headerName: 'Slug',
        flex: 1,
        minWidth: 120,
        valueFormatter: (params) => params.value || '—',
      },
      {
        field: 'owner_name',
        headerName: 'Owner',
        flex: 1,
        minWidth: 150,
        valueFormatter: (params) => params.value || '—',
      },
      {
        field: 'owner_email',
        headerName: 'Owner Email',
        flex: 1.5,
        minWidth: 200,
        valueFormatter: (params) => params.value || '—',
      },
      {
        field: 'member_count',
        headerName: 'Members',
        width: 100,
        type: 'numericColumn',
      },
      {
        field: 'created_at',
        headerName: 'Created',
        flex: 1,
        minWidth: 120,
        valueFormatter: (params) => {
          if (!params.value) return '—';
          return new Date(params.value).toLocaleDateString();
        },
      },
      {
        colId: 'features',
        headerName: 'Features',
        width: 180,
        sortable: false,
        resizable: true,
        valueGetter: (params) => {
          if (!params.data) return '';
          const flags = params.data.features ?? {};
          const enabled = KNOWN_FEATURES.filter((f) => flags[f.key]).map((f) => f.label);
          return enabled.length === 0 ? '—' : enabled.join(', ');
        },
      },
      {
        colId: 'actions',
        headerName: '',
        width: 170,
        sortable: false,
        resizable: false,
        pinned: 'right' as const,
        cellRenderer: (params: ICellRendererParams<CompanyListItem>) => {
          if (!params.data) return null;
          const company = params.data;
          return (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, height: '100%' }}>
              <Tooltip title="Visit Dashboard">
                <IconButton size="small" onClick={(e) => handleVisitDashboard(e, company)}>
                  <OpenInNewIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="Feature flags">
                <IconButton size="small" onClick={(e) => handleFeaturesOpen(e, company)}>
                  <ToggleOnIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="Edit">
                <IconButton size="small" onClick={(e) => handleEditOpen(e, company)}>
                  <EditIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="Delete">
                <IconButton
                  size="small"
                  onClick={(e) => handleDeleteOpen(e, company)}
                  sx={{ '&:hover': { color: 'error.main' } }}
                >
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
          );
        },
      },
    ],
    [handleVisitDashboard, handleEditOpen, handleDeleteOpen, handleFeaturesOpen]
  );

  // --- Create form handlers ---

  const resetForm = () => {
    setForm({
      company_name: '',
      owner_first_name: '',
      owner_last_name: '',
      owner_email: '',
    });
    setFormError('');
  };

  const handleCreateOpen = () => {
    resetForm();
    setCreateOpen(true);
  };

  const handleCreateClose = () => {
    setCreateOpen(false);
    resetForm();
  };

  const handleCreate = async () => {
    if (!form.company_name.trim()) {
      setFormError('Company name is required');
      return;
    }
    if (!form.owner_first_name.trim()) {
      setFormError('First name is required');
      return;
    }
    if (!form.owner_last_name.trim()) {
      setFormError('Last name is required');
      return;
    }
    if (!form.owner_email.trim()) {
      setFormError('Owner email is required');
      return;
    }
    setCreating(true);
    setFormError('');

    try {
      const headers = await getAuthHeaders();
      const owner_name = `${form.owner_first_name.trim()} ${form.owner_last_name.trim()}`;
      const response = await fetch(getAdminApiUrl(), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          company_name: form.company_name,
          owner_name,
          owner_email: form.owner_email,
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ detail: 'Failed to create company' }));
        throw new Error(error.detail || 'Failed to create company');
      }

      const data = await response.json();
      setSnackbar({
        open: true,
        message: `Created "${data.company_name}" — invite email sent`,
        severity: 'success',
      });
      handleCreateClose();
      fetchCompanies();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create company';
      setFormError(message);
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 400 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
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
          placeholder="Search companies..."
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
        <Box sx={{ flex: 1 }} />
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={handleCreateOpen}
        >
          Create Company
        </Button>
      </Box>

      {/* Companies count */}
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {filteredCompanies.length} {filteredCompanies.length === 1 ? 'company' : 'companies'}
      </Typography>

      {/* AG Grid */}
      <Box
        sx={{
          height: 500,
          width: '100%',
          '& .ag-cell:focus, & .ag-header-cell:focus': {
            outline: 'none !important',
            border: 'none !important',
          },
        }}
      >
        <AgGridReact<CompanyListItem>
          rowData={filteredCompanies}
          columnDefs={columnDefs}
          theme={jiggedAgGridTheme}
          defaultColDef={{
            sortable: true,
            resizable: true,
          }}
          domLayout="autoHeight"
          suppressCellFocus
          getRowId={(params) => params.data.id}
        />
      </Box>

      {/* Create Company Dialog */}
      <Dialog
        open={createOpen}
        onClose={handleCreateClose}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle
          sx={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          Create New Company
          <IconButton onClick={handleCreateClose} size="small" sx={{ color: 'text.secondary' }}>
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          {formError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {formError}
            </Alert>
          )}

          <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 2 }}>
            Company Details
          </Typography>
          <TextField
            label="Company Name"
            fullWidth
            required
            autoFocus
            value={form.company_name}
            onChange={(e) => setForm((f) => ({ ...f, company_name: e.target.value }))}
            sx={{ mb: 3 }}
          />

          <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 2 }}>
            First Admin Account
          </Typography>
          <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
            <TextField
              label="First Name"
              fullWidth
              required
              value={form.owner_first_name}
              onChange={(e) => setForm((f) => ({ ...f, owner_first_name: e.target.value }))}
            />
            <TextField
              label="Last Name"
              fullWidth
              required
              value={form.owner_last_name}
              onChange={(e) => setForm((f) => ({ ...f, owner_last_name: e.target.value }))}
            />
          </Box>
          <TextField
            label="Owner Email"
            type="email"
            fullWidth
            required
            value={form.owner_email}
            onChange={(e) => setForm((f) => ({ ...f, owner_email: e.target.value }))}
            sx={{ mb: 2 }}
          />
          <Alert icon={<EmailIcon />} severity="info" sx={{ mb: 2 }}>
            An invite email will be sent to set up their account.
          </Alert>

        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={handleCreateClose} disabled={creating}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleCreate}
            disabled={creating}
          >
            {creating ? 'Creating...' : 'Create Company'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Edit Company Dialog */}
      <Dialog
        open={editOpen}
        onClose={handleEditClose}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle
          sx={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          Edit Company
          <IconButton onClick={handleEditClose} size="small" sx={{ color: 'text.secondary' }}>
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          {editError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {editError}
            </Alert>
          )}

          {editCompany && (
            <Box sx={{ mb: 2 }}>
              <Typography variant="body2" color="text.secondary">
                Owner: {editCompany.owner_name || '—'} ({editCompany.owner_email || '—'})
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Members: {editCompany.member_count}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Created: {editCompany.created_at ? new Date(editCompany.created_at).toLocaleDateString() : '—'}
              </Typography>
            </Box>
          )}

          <Divider sx={{ mb: 3 }} />

          <TextField
            label="Company Name"
            fullWidth
            required
            autoFocus
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            helperText="Slug will be auto-generated from the new name"
          />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={handleEditClose} disabled={editing}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleEditSave}
            disabled={editing || !editName.trim()}
          >
            {editing ? 'Saving...' : 'Save Changes'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete Company Dialog */}
      <Dialog
        open={deleteOpen}
        onClose={!deleting ? handleDeleteClose : undefined}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle
          sx={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          Delete Company
          <IconButton onClick={handleDeleteClose} size="small" disabled={deleting} sx={{ color: 'text.secondary' }}>
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <Alert severity="warning" sx={{ mb: 3 }}>
            This action is permanent and cannot be undone. All data associated with this company will be deleted, including customers, parts, quotes, jobs, routings, and inventory.
          </Alert>

          {deleteCompany && (
            <Box sx={{ mb: 3 }}>
              <Typography variant="body1" sx={{ mb: 0.5 }}>
                Company: <strong>{deleteCompany.name}</strong>
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {deleteCompany.member_count} member{deleteCompany.member_count !== 1 ? 's' : ''} will lose access
              </Typography>
            </Box>
          )}

          <Typography variant="body2" sx={{ mb: 1.5 }}>
            Type <strong>{deleteCompany?.name}</strong> to confirm:
          </Typography>
          <TextField
            fullWidth
            placeholder={deleteCompany?.name}
            value={deleteConfirmName}
            onChange={(e) => setDeleteConfirmName(e.target.value)}
            autoFocus
          />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={handleDeleteClose} disabled={deleting} color="inherit">
            Cancel
          </Button>
          <Button
            variant="contained"
            color="error"
            onClick={handleDeleteConfirm}
            disabled={deleting || deleteConfirmName !== deleteCompany?.name}
            startIcon={deleting ? <CircularProgress size={16} color="inherit" /> : <DeleteIcon />}
          >
            {deleting ? 'Deleting...' : 'Delete Company'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Feature Flags Dialog */}
      <Dialog
        open={featuresOpen}
        onClose={handleFeaturesClose}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle
          sx={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          {featuresCompany ? `Feature Flags — ${featuresCompany.name}` : 'Feature Flags'}
          <IconButton
            onClick={handleFeaturesClose}
            size="small"
            disabled={featuresSaving}
            sx={{ color: 'text.secondary' }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          {featuresError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {featuresError}
            </Alert>
          )}
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Toggles flip <code>companies.settings.features</code> for this
            tenant. UI gates (Create Shipment, Reorder, etc.) read these on
            mount — refresh the company dashboard after saving to pick up
            the new state.
          </Typography>
          <Divider sx={{ mb: 2 }} />
          <Stack spacing={2}>
            {KNOWN_FEATURES.map((f) => (
              <Box key={f.key}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={Boolean(featuresDraft[f.key])}
                      onChange={(e) =>
                        setFeaturesDraft((prev) => ({
                          ...prev,
                          [f.key]: e.target.checked,
                        }))
                      }
                    />
                  }
                  label={
                    <Box>
                      <Typography variant="body1" sx={{ fontWeight: 600 }}>
                        {f.label}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {f.description}
                      </Typography>
                    </Box>
                  }
                  sx={{ alignItems: 'flex-start' }}
                />
              </Box>
            ))}
            {KNOWN_FEATURES.length === 0 && (
              <Alert severity="info">No feature flags registered yet.</Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={handleFeaturesClose} disabled={featuresSaving}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleFeaturesSave}
            disabled={featuresSaving}
            startIcon={featuresSaving ? <CircularProgress size={16} color="inherit" /> : undefined}
          >
            {featuresSaving ? 'Saving…' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Snackbar */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={5000}
        onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity={snackbar.severity} onClose={() => setSnackbar((s) => ({ ...s, open: false }))}>
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
}
