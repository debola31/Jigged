'use client';

import { useState, useEffect } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';
import InputAdornment from '@mui/material/InputAdornment';
import {
  createPartCategory,
  updatePartCategory,
  deletePartCategory,
} from '@/utils/partCategoriesAccess';
import type { PartCategory, PartCategoryFormData } from '@/types/partCategory';
import { EMPTY_CATEGORY_FORM, partCategoryToFormData } from '@/types/partCategory';

interface PartCategoryModalProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  companyId: string;
  category: PartCategory | null; // null = create mode
}

/**
 * Modal dialog for creating/editing part categories.
 */
export default function PartCategoryModal({
  open,
  onClose,
  onSaved,
  companyId,
  category,
}: PartCategoryModalProps) {
  const [formData, setFormData] = useState<PartCategoryFormData>(EMPTY_CATEGORY_FORM);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEdit = !!category;

  // Reset form when modal opens/closes or category changes
  useEffect(() => {
    if (category) {
      setFormData(partCategoryToFormData(category));
    } else {
      setFormData(EMPTY_CATEGORY_FORM);
    }
    setError(null);
    setLoading(false);
  }, [category, open]);

  const handleSubmit = async () => {
    if (!formData.name.trim()) {
      setError('Name is required');
      return;
    }

    const markupVal = formData.default_markup_percent.trim();
    if (markupVal) {
      const num = parseFloat(markupVal);
      if (isNaN(num) || num < -100 || num > 1000) {
        setError('Markup must be between -100% and 1000%');
        return;
      }
    }

    setLoading(true);
    setError(null);

    try {
      if (isEdit && category) {
        await updatePartCategory(category.id, formData);
      } else {
        await createPartCategory(companyId, formData);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save category');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!category) return;

    const partsCount = category.parts_count ?? 0;
    const message =
      partsCount > 0
        ? `This will remove the category from ${partsCount} part(s). Continue?`
        : 'Delete this category?';

    if (!confirm(message)) return;

    setLoading(true);
    try {
      await deletePartCategory(category.id);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete category');
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{isEdit ? 'Edit Category' : 'New Category'}</DialogTitle>
      <DialogContent>
        <Box sx={{ pt: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {error && <Alert severity="error">{error}</Alert>}

          <TextField
            label="Name"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            required
            fullWidth
            autoFocus
            disabled={loading}
          />

          <TextField
            label="Default Markup"
            type="number"
            value={formData.default_markup_percent}
            onChange={(e) =>
              setFormData({ ...formData, default_markup_percent: e.target.value })
            }
            fullWidth
            disabled={loading}
            helperText="Applied automatically when quoting parts in this category"
            slotProps={{
              input: {
                endAdornment: <InputAdornment position="end">%</InputAdornment>,
              },
              htmlInput: { min: -100, max: 1000, step: 0.1 },
            }}
          />

          <TextField
            label="Description"
            value={formData.description}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            fullWidth
            multiline
            rows={2}
            disabled={loading}
          />
        </Box>
      </DialogContent>
      <DialogActions>
        {isEdit && (
          <Button onClick={handleDelete} color="error" disabled={loading}>
            Delete
          </Button>
        )}
        <Box flex={1} />
        <Button onClick={onClose} disabled={loading}>
          Cancel
        </Button>
        <Button
          onClick={handleSubmit}
          variant="contained"
          disabled={loading || !formData.name.trim()}
        >
          {loading ? 'Saving...' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
