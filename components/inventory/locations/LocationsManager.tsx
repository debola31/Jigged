'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import AddIcon from '@mui/icons-material/Add';
import QrCode2Icon from '@mui/icons-material/QrCode2';

import type {
  BulkGenerateSpec,
  InventoryLocation,
  InventoryLocationNode,
} from '@/types/inventoryLocations';
import {
  getLocations,
  buildLocationTree,
  createLocation,
  updateLocation,
  bulkGenerateChildren,
  deleteLocation,
} from '@/utils/inventoryLocationsAccess';
import { generateLocationLabelSheet, type LocationLabel } from '@/utils/locationLabelPdf';
import LocationTreeView from './LocationTreeView';
import LocationFormModal, { type LocationFormValues } from './LocationFormModal';
import BulkGenerateModal from './BulkGenerateModal';
import LocationQRModal from './LocationQRModal';

function computePath(id: string, byId: Map<string, InventoryLocation>): string[] {
  const names: string[] = [];
  let cursor: string | null = id;
  const guard = new Set<string>();
  while (cursor && byId.has(cursor) && !guard.has(cursor)) {
    guard.add(cursor);
    const node: InventoryLocation = byId.get(cursor)!;
    names.unshift(node.name);
    cursor = node.parent_id;
  }
  return names;
}

function collectAnchorLabels(node: InventoryLocationNode, byId: Map<string, InventoryLocation>): LocationLabel[] {
  const out: LocationLabel[] = [];
  const walk = (n: InventoryLocationNode) => {
    if (n.is_qr_anchor) out.push({ id: n.id, path: computePath(n.id, byId), code: n.code });
    n.children.forEach(walk);
  };
  walk(node);
  return out;
}

interface LocationsManagerProps {
  companyId: string;
  companyName?: string;
}

export default function LocationsManager({ companyId, companyName }: LocationsManagerProps) {
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [formState, setFormState] = useState<{
    open: boolean;
    location: InventoryLocation | null;
    parentId: string | null;
    parentPath: string[];
  }>({ open: false, location: null, parentId: null, parentPath: [] });

  const [bulkState, setBulkState] = useState<{ open: boolean; parentId: string; parentPath: string[] }>({
    open: false,
    parentId: '',
    parentPath: [],
  });

  const [qrState, setQrState] = useState<{
    open: boolean;
    node: InventoryLocation | null;
    path: string[];
    anchorLabels: LocationLabel[];
  }>({ open: false, node: null, path: [], anchorLabels: [] });

  const [deleteState, setDeleteState] = useState<{ open: boolean; node: InventoryLocationNode | null }>({
    open: false,
    node: null,
  });

  const byId = useMemo(() => new Map(locations.map((l) => [l.id, l] as const)), [locations]);
  const tree = useMemo(() => buildLocationTree(locations), [locations]);
  const allAnchors = useMemo(() => tree.flatMap((n) => collectAnchorLabels(n, byId)), [tree, byId]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setLocations(await getLocations(companyId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load locations.');
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const callbacks = {
    onAddChild: (node: InventoryLocationNode) =>
      setFormState({ open: true, location: null, parentId: node.id, parentPath: computePath(node.id, byId) }),
    onEdit: (node: InventoryLocationNode) =>
      setFormState({ open: true, location: node, parentId: node.parent_id, parentPath: [] }),
    onBulkGenerate: (node: InventoryLocationNode) =>
      setBulkState({ open: true, parentId: node.id, parentPath: computePath(node.id, byId) }),
    onPrintQR: (node: InventoryLocationNode) =>
      setQrState({
        open: true,
        node,
        path: computePath(node.id, byId),
        anchorLabels: collectAnchorLabels(node, byId),
      }),
    onDelete: (node: InventoryLocationNode) => setDeleteState({ open: true, node }),
  };

  const submitForm = async (values: LocationFormValues) => {
    if (formState.location) {
      await updateLocation(formState.location.id, values);
    } else {
      await createLocation(companyId, { ...values, parent_id: formState.parentId });
    }
    await reload();
  };

  const submitBulk = async (spec: BulkGenerateSpec) => {
    const created = await bulkGenerateChildren(companyId, bulkState.parentId, spec);
    await reload();
    setToast(`Created ${created.length} locations.`);
  };

  const confirmDelete = async () => {
    if (!deleteState.node) return;
    try {
      await deleteLocation(deleteState.node.id);
      setDeleteState({ open: false, node: null });
      await reload();
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Failed to delete location.');
      setDeleteState({ open: false, node: null });
    }
  };

  const printAllAnchors = async () => {
    if (allAnchors.length === 0) {
      setToast('No QR anchors yet. Mark a location as a QR anchor first.');
      return;
    }
    const doc = await generateLocationLabelSheet({
      companyId,
      baseUrl: window.location.origin,
      labels: allAnchors,
      heading: companyName,
    });
    doc.save('inventory-qr-anchors.pdf');
  };

  return (
    <Box>
      {/* Toolbar */}
      <Box sx={{ display: 'flex', gap: 2, mb: 3, flexWrap: 'wrap', alignItems: 'center' }}>
        <Box sx={{ flex: 1 }} />
        <Button
          variant="outlined"
          startIcon={<QrCode2Icon />}
          onClick={printAllAnchors}
          disabled={loading || allAnchors.length === 0}
        >
          Print all QR anchors
        </Button>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => setFormState({ open: true, location: null, parentId: null, parentPath: [] })}
        >
          New top-level location
        </Button>
      </Box>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      ) : tree.length === 0 ? (
        <Card elevation={2}>
          <CardContent sx={{ textAlign: 'center', py: 6 }}>
            <Typography color="text.secondary" sx={{ mb: 2 }}>
              No storage locations yet. Build your shelving, cabinets, and bins here, then print QR
              labels to scan from the shop floor.
            </Typography>
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={() => setFormState({ open: true, location: null, parentId: null, parentPath: [] })}
            >
              New top-level location
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card elevation={2}>
          <CardContent>
            <LocationTreeView nodes={tree} callbacks={callbacks} />
          </CardContent>
        </Card>
      )}

      <LocationFormModal
        open={formState.open}
        location={formState.location}
        parentPath={formState.location ? undefined : formState.parentPath}
        onClose={() => setFormState((s) => ({ ...s, open: false }))}
        onSubmit={submitForm}
      />
      <BulkGenerateModal
        open={bulkState.open}
        parentPath={bulkState.parentPath}
        onClose={() => setBulkState((s) => ({ ...s, open: false }))}
        onSubmit={submitBulk}
      />
      <LocationQRModal
        open={qrState.open}
        companyId={companyId}
        companyName={companyName}
        node={qrState.node}
        path={qrState.path}
        anchorLabels={qrState.anchorLabels}
        onClose={() => setQrState((s) => ({ ...s, open: false }))}
      />

      <Dialog open={deleteState.open} onClose={() => setDeleteState({ open: false, node: null })}>
        <DialogTitle>Delete location?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Delete <strong>{deleteState.node?.name}</strong> and everything empty inside it? This
            can&apos;t be undone. A location can&apos;t be deleted while it (or something inside it)
            holds stock, but past activity is kept in history.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteState({ open: false, node: null })}>Cancel</Button>
          <Button onClick={confirmDelete} color="error" variant="contained">
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={5000}
        onClose={() => setToast(null)}
        message={toast}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Box>
  );
}
