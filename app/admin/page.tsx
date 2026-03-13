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
import FormControlLabel from '@mui/material/FormControlLabel';
import Checkbox from '@mui/material/Checkbox';
import SearchIcon from '@mui/icons-material/Search';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';

import { AgGridReact } from 'ag-grid-react';
import { ModuleRegistry, AllCommunityModule } from 'ag-grid-community';
import type { ColDef, RowClickedEvent } from 'ag-grid-community';

ModuleRegistry.registerModules([AllCommunityModule]);

import { jiggedAgGridTheme } from '@/lib/agGridTheme';
import { getSupabase } from '@/lib/supabase';

interface CompanyListItem {
  id: string;
  name: string;
  slug: string | null;
  created_at: string;
  owner_name: string | null;
  owner_email: string | null;
  member_count: number;
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
  const [showPassword, setShowPassword] = useState(false);
  const [snackbar, setSnackbar] = useState({ open: false, message: '', severity: 'success' as 'success' | 'error' });

  // Form state
  const [form, setForm] = useState({
    company_name: '',
    owner_name: '',
    owner_email: '',
    owner_password: '',
    add_admin_access: true,
  });
  const [formError, setFormError] = useState('');

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
    ],
    []
  );

  const handleRowClicked = useCallback(
    (event: RowClickedEvent<CompanyListItem>) => {
      if (event.data) {
        router.push(`/dashboard/${event.data.id}`);
      }
    },
    [router]
  );

  const resetForm = () => {
    setForm({
      company_name: '',
      owner_name: '',
      owner_email: '',
      owner_password: '',
      add_admin_access: true,
    });
    setFormError('');
    setShowPassword(false);
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
    // Client-side validation
    if (!form.company_name.trim()) {
      setFormError('Company name is required');
      return;
    }
    if (!form.owner_name.trim()) {
      setFormError('Owner name is required');
      return;
    }
    if (!form.owner_email.trim()) {
      setFormError('Owner email is required');
      return;
    }
    if (form.owner_password.length < 8) {
      setFormError('Password must be at least 8 characters');
      return;
    }

    setCreating(true);
    setFormError('');

    try {
      const headers = await getAuthHeaders();
      const response = await fetch(getAdminApiUrl(), {
        method: 'POST',
        headers,
        body: JSON.stringify(form),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ detail: 'Failed to create company' }));
        throw new Error(error.detail || 'Failed to create company');
      }

      const data = await response.json();
      setSnackbar({
        open: true,
        message: `Created "${data.company_name}" successfully`,
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
          '& .ag-row': {
            cursor: 'pointer',
          },
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
          onRowClicked={handleRowClicked}
          domLayout="autoHeight"
          suppressCellFocus
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
            First Owner Account
          </Typography>
          <TextField
            label="Owner Name"
            fullWidth
            required
            value={form.owner_name}
            onChange={(e) => setForm((f) => ({ ...f, owner_name: e.target.value }))}
            sx={{ mb: 2 }}
          />
          <TextField
            label="Owner Email"
            type="email"
            fullWidth
            required
            value={form.owner_email}
            onChange={(e) => setForm((f) => ({ ...f, owner_email: e.target.value }))}
            sx={{ mb: 2 }}
          />
          <TextField
            label="Temporary Password"
            type={showPassword ? 'text' : 'password'}
            fullWidth
            required
            value={form.owner_password}
            onChange={(e) => setForm((f) => ({ ...f, owner_password: e.target.value }))}
            helperText="Owner will be prompted to change on first login"
            slotProps={{
              input: {
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      onClick={() => setShowPassword(!showPassword)}
                      edge="end"
                      size="small"
                    >
                      {showPassword ? <VisibilityOffIcon /> : <VisibilityIcon />}
                    </IconButton>
                  </InputAdornment>
                ),
              },
            }}
            sx={{ mb: 2 }}
          />

          <FormControlLabel
            control={
              <Checkbox
                checked={form.add_admin_access}
                onChange={(e) => setForm((f) => ({ ...f, add_admin_access: e.target.checked }))}
              />
            }
            label="Add me as admin to this company"
          />
          <Typography variant="caption" color="text.secondary" display="block" sx={{ ml: 4, mt: -0.5 }}>
            Lets you view the company dashboard for support
          </Typography>
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
