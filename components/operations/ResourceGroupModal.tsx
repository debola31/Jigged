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
import {
  createResourceGroup,
  updateResourceGroup,
  deleteResourceGroup,
  getResourceGroupOperationCount,
} from '@/utils/operationsAccess';
import type { ResourceGroup, ResourceGroupFormData } from '@/types/operations';

interface ResourceGroupModalProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  companyId: string;
  group: ResourceGroup | null; // null = create mode
}

/**
 * Modal dialog for creating/editing resource groups.
 */
export default function ResourceGroupModal({
  open,
  onClose,
  onSaved,
  companyId,
  group,
}: ResourceGroupModalProps) {
  const [formData, setFormData] = useState<ResourceGroupFormData>({
    name: '',
    description: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [operationCount, setOperationCount] = useState(0);

  const isEdit = !!group;

  // Reset form when modal opens/closes or group changes
  useEffect(() => {
    if (group) {
      setFormData({
        name: group.name,
        description: group.description || '',
      });
      // Load operation count for delete warning
      getResourceGroupOperationCount(group.id).then(setOperationCount);
    } else {
      setFormData({ name: '', description: '' });
      setOperationCount(0);
    }
    setError(null);
    setLoading(false);
  }, [group, open]);

  const handleSubmit = async () => {
    if (!formData.name.trim()) {
      setError('Name is required');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      if (isEdit && group) {
        await updateResourceGroup(group.id, formData);
      } else {
        await createResourceGroup(companyId, formData);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save group');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!group) return;

    const message =
      operationCount > 0
        ? `This will move ${operationCount} operation(s) to Ungrouped. Continue?`
        : 'Delete this group?';

    if (!confirm(message)) return;

    setLoading(true);
    try {
      await deleteResourceGroup(group.id);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete group');
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{isEdit ? 'Edit Group' : 'New Group'}</DialogTitle>
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
        <Button onClick={handleSubmit} variant="contained" disabled={loading || !formData.name.trim()}>
          {loading ? 'Saving...' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
