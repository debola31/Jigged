'use client';

import { useState, useEffect, useCallback } from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import IconButton from '@mui/material/IconButton';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import CategoryIcon from '@mui/icons-material/Category';
import type { PartCategory, PartCategoryFormData } from '@/types/partCategory';
import { EMPTY_CATEGORY_FORM, partCategoryToFormData } from '@/types/partCategory';
import {
  getPartCategoriesWithCounts,
  createPartCategory,
  updatePartCategory,
  deletePartCategory,
} from '@/utils/partCategoriesAccess';

interface PartCategoriesSectionProps {
  companyId: string;
}

export default function PartCategoriesSection({ companyId }: PartCategoriesSectionProps) {
  const [categories, setCategories] = useState<PartCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<'create' | 'edit'>('create');
  const [editingCategory, setEditingCategory] = useState<PartCategory | null>(null);
  const [formData, setFormData] = useState<PartCategoryFormData>(EMPTY_CATEGORY_FORM);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // Delete dialog
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingCategory, setDeletingCategory] = useState<PartCategory | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchCategories = useCallback(async () => {
    try {
      setLoading(true);
      const data = await getPartCategoriesWithCounts(companyId);
      setCategories(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load categories');
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    fetchCategories();
  }, [fetchCategories]);

  const handleOpenCreate = () => {
    setDialogMode('create');
    setFormData(EMPTY_CATEGORY_FORM);
    setFormErrors({});
    setEditingCategory(null);
    setDialogOpen(true);
  };

  const handleOpenEdit = (category: PartCategory) => {
    setDialogMode('edit');
    setFormData(partCategoryToFormData(category));
    setFormErrors({});
    setEditingCategory(category);
    setDialogOpen(true);
  };

  const handleOpenDelete = (category: PartCategory) => {
    setDeletingCategory(category);
    setDeleteDialogOpen(true);
  };

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {};
    if (!formData.name.trim()) {
      errors.name = 'Category name is required';
    }
    if (formData.default_markup_percent.trim()) {
      const val = parseFloat(formData.default_markup_percent);
      if (isNaN(val) || val < -100 || val > 1000) {
        errors.default_markup_percent = 'Must be a number between -100 and 1000';
      }
    }
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSave = async () => {
    if (!validateForm()) return;

    setSaving(true);
    try {
      if (dialogMode === 'create') {
        await createPartCategory(companyId, formData);
      } else if (editingCategory) {
        await updatePartCategory(editingCategory.id, formData);
      }
      setDialogOpen(false);
      await fetchCategories();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save';
      if (message.includes('duplicate') || message.includes('unique')) {
        setFormErrors({ name: 'A category with this name already exists' });
      } else {
        setFormErrors({ _general: message });
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deletingCategory) return;

    setDeleting(true);
    try {
      await deletePartCategory(deletingCategory.id);
      setDeleteDialogOpen(false);
      setDeletingCategory(null);
      await fetchCategories();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
      setDeleteDialogOpen(false);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Card elevation={2}>
      <CardContent sx={{ p: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <CategoryIcon sx={{ color: 'text.secondary' }} />
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Part Categories
            </Typography>
          </Box>
          <Button
            variant="contained"
            size="small"
            startIcon={<AddIcon />}
            onClick={handleOpenCreate}
          >
            New Category
          </Button>
        </Box>

        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 3 }}>
          Classify parts into categories with default markup percentages for quoting.
        </Typography>

        <Divider sx={{ mb: 2 }} />

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={24} />
          </Box>
        ) : categories.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 4 }}>
            No categories yet. Create your first category to set default markups for quoting.
          </Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 600 }}>Name</TableCell>
                <TableCell sx={{ fontWeight: 600 }} align="right">Default Markup %</TableCell>
                <TableCell sx={{ fontWeight: 600 }} align="right">Parts</TableCell>
                <TableCell width={100} />
              </TableRow>
            </TableHead>
            <TableBody>
              {categories.map((cat) => (
                <TableRow key={cat.id}>
                  <TableCell>
                    <Typography variant="body2" fontWeight={500}>
                      {cat.name}
                    </Typography>
                    {cat.description && (
                      <Typography variant="caption" color="text.secondary">
                        {cat.description}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell align="right">
                    {cat.default_markup_percent !== null ? `${cat.default_markup_percent}%` : '—'}
                  </TableCell>
                  <TableCell align="right">{cat.parts_count ?? 0}</TableCell>
                  <TableCell>
                    <Box sx={{ display: 'flex', gap: 0.5 }}>
                      <IconButton size="small" onClick={() => handleOpenEdit(cat)}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                      <IconButton size="small" onClick={() => handleOpenDelete(cat)} color="error">
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Box>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>
          {dialogMode === 'create' ? 'New Part Category' : 'Edit Part Category'}
        </DialogTitle>
        <DialogContent>
          {formErrors._general && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {formErrors._general}
            </Alert>
          )}
          <TextField
            fullWidth
            required
            label="Category Name"
            value={formData.name}
            onChange={(e) => {
              setFormData((prev) => ({ ...prev, name: e.target.value }));
              if (formErrors.name) setFormErrors((prev) => ({ ...prev, name: '' }));
            }}
            error={!!formErrors.name}
            helperText={formErrors.name || 'e.g., "Precision Machined", "Assemblies", "Tooling"'}
            disabled={saving}
            sx={{ mt: 1, mb: 2 }}
          />
          <TextField
            fullWidth
            label="Default Markup %"
            type="number"
            value={formData.default_markup_percent}
            onChange={(e) => {
              setFormData((prev) => ({ ...prev, default_markup_percent: e.target.value }));
              if (formErrors.default_markup_percent) setFormErrors((prev) => ({ ...prev, default_markup_percent: '' }));
            }}
            error={!!formErrors.default_markup_percent}
            helperText={formErrors.default_markup_percent || 'Pre-filled when creating quotes for parts in this category'}
            disabled={saving}
            inputProps={{ step: 0.01 }}
            sx={{ mb: 2 }}
          />
          <TextField
            fullWidth
            label="Description"
            value={formData.description}
            onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
            disabled={saving}
            multiline
            rows={2}
            placeholder="Optional description"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            variant="contained"
            disabled={saving}
            startIcon={saving ? <CircularProgress size={16} /> : undefined}
          >
            {saving ? 'Saving...' : dialogMode === 'create' ? 'Create' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)}>
        <DialogTitle>Delete Category?</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to delete <strong>{deletingCategory?.name}</strong>?
          </Typography>
          {deletingCategory && (deletingCategory.parts_count ?? 0) > 0 && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              {deletingCategory.parts_count} part{deletingCategory.parts_count !== 1 ? 's' : ''} will become uncategorized.
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)} disabled={deleting}>
            Cancel
          </Button>
          <Button
            onClick={handleDelete}
            color="error"
            variant="contained"
            disabled={deleting}
            startIcon={deleting ? <CircularProgress size={16} /> : undefined}
          >
            {deleting ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}
