'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLoad } from '@/hooks/useLoad';
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
import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined';

import type { InventoryLocation, InventoryLocationNode } from '@/types/inventoryLocations';
import {
  buildLocationTree,
  getLocationBoard,
  createLocation,
  updateLocation,
  duplicateLocation,
  deleteLocation,
  moveLocation,
  setLocationPhoto,
  clearLocationPhoto,
} from '@/utils/inventoryLocationsAccess';
import { rollUpOccupancy, occupancyFor } from '@/utils/locationOccupancy';
import { generateLocationLabelSheet, type LocationLabel } from '@/utils/locationLabelPdf';
import LocationFormModal, { type LocationFormValues } from './LocationFormModal';
import LocationPicker, { type LocationPickerOption } from './LocationPicker';
import LocationQRModal from './LocationQRModal';
import VisualLocationBuilder from './builder/VisualLocationBuilder';
import LocationTable, { placeOrder } from './LocationTable';
import LocationDetailSheet from './board/LocationDetailSheet';

/** Sentinel for "no parent". A picker option needs an id, and `null` is not one. */
const TOP_LEVEL = '__top__';

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

// Every real location is printable, so a label is collected for the node and
// every descendant. The auto-managed system 'Unassigned' bucket is virtual (no
// physical shelf), so it never gets a printed label.
function collectLabels(node: InventoryLocationNode, byId: Map<string, InventoryLocation>): LocationLabel[] {
  const out: LocationLabel[] = [];
  const walk = (n: InventoryLocationNode) => {
    if (n.kind !== 'system') out.push({ id: n.id, path: computePath(n.id, byId), code: n.code });
    n.children.forEach(walk);
  };
  walk(node);
  return out;
}

/** Ancestors of a node, root → node inclusive, as tree nodes (the sheet's breadcrumb). */
function nodePath(
  id: string,
  byNodeId: Map<string, InventoryLocationNode>,
): InventoryLocationNode[] {
  const out: InventoryLocationNode[] = [];
  let cursor: string | null = id;
  const guard = new Set<string>();
  while (cursor && byNodeId.has(cursor) && !guard.has(cursor)) {
    guard.add(cursor);
    const node: InventoryLocationNode = byNodeId.get(cursor)!;
    out.unshift(node);
    cursor = node.parent_id;
  }
  return out;
}

/** Flatten a tree into id → node so the sheet can re-resolve its node after a reload. */
function indexTree(roots: InventoryLocationNode[]): Map<string, InventoryLocationNode> {
  const out = new Map<string, InventoryLocationNode>();
  const walk = (n: InventoryLocationNode) => {
    out.set(n.id, n);
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  return out;
}

// Stable empty fallbacks so the tree/labels memos don't churn while loading.
const EMPTY_LOCATIONS: InventoryLocation[] = [];
const EMPTY_COUNTS: ReadonlyMap<string, number> = new Map();
const EMPTY_URLS: ReadonlyMap<string, string> = new Map();

interface LocationsManagerProps {
  companyId: string;
  companyName?: string;
}

export default function LocationsManager({ companyId, companyName }: LocationsManagerProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  /**
   * The builder, aimed either at the top level or at an existing unit.
   *
   * A non-null `parentId` is what makes it "Subdivide this unit" — the nested-create path was
   * fully built and had no caller until now.
   */
  const [builder, setBuilder] = useState<{
    open: boolean;
    parentId: string | null;
    parentCode: string | null;
    parentPath: string[];
    existingSiblingNames: string[];
    startSortOrder: number;
  }>({
    open: false,
    parentId: null,
    parentCode: null,
    parentPath: [],
    existingSiblingNames: [],
    startSortOrder: 0,
  });

  // `openTopLevelBuilder` is gone with the toolbar's "Build visually". The builder itself
  // survives, reached only from Subdivide on a unit that already exists — which is what
  // §5.5 decision 3 prescribed all along, and it keeps the `parentId` path as the only
  // path rather than a dormant second one.

  /** Which node the sheet shows. An id, not a node, so a reload re-resolves fresh children. */
  const [sheetId, setSheetId] = useState<string | null>(null);

  const [formState, setFormState] = useState<{
    open: boolean;
    location: InventoryLocation | null;
    parentId: string | null;
    parentPath: string[];
  }>({ open: false, location: null, parentId: null, parentPath: [] });

  const [qrState, setQrState] = useState<{
    open: boolean;
    node: InventoryLocation | null;
    path: string[];
    labels: LocationLabel[];
  }>({ open: false, node: null, path: [], labels: [] });

  const [deleteState, setDeleteState] = useState<{ open: boolean; node: InventoryLocationNode | null }>({
    open: false,
    node: null,
  });

  const {
    data: boardData,
    loading,
    reload,
  } = useLoad(() => getLocationBoard(companyId), [companyId], {
    onError: (e) => {
      setError(e instanceof Error ? e.message : 'Failed to load locations.');
    },
  });
  const locations = boardData?.locations ?? EMPTY_LOCATIONS;
  const directPartCounts = boardData?.directPartCounts ?? EMPTY_COUNTS;
  const photoUrls = boardData?.photoUrls ?? EMPTY_URLS;

  const byId = useMemo(() => new Map(locations.map((l) => [l.id, l] as const)), [locations]);
  // Sorted once here so the board and the list agree — `Unassigned` last in both. Sorting only
  // inside the board left the list leading with the put-away pile, which is the impression the
  // board's ordering exists to avoid.
  const tree = useMemo(() => buildLocationTree(locations).sort(placeOrder), [locations]);
  const byNodeId = useMemo(() => indexTree(tree), [tree]);
  const occupancy = useMemo(() => rollUpOccupancy(tree, directPartCounts), [tree, directPartCounts]);
  const allLabels = useMemo(() => tree.flatMap((n) => collectLabels(n, byId)), [tree, byId]);

  const sheetNode = sheetId ? byNodeId.get(sheetId) ?? null : null;
  const sheetPath = useMemo(() => (sheetId ? nodePath(sheetId, byNodeId) : []), [sheetId, byNodeId]);

  /**
   * Names already taken beside whatever the form is about to write.
   *
   * The DB refuses a duplicate sibling name outright, so the form warns before you can hit it.
   * Editing scopes to the location's own parent; creating scopes to the chosen parent, and a
   * top-level create compares against the roots.
   */
  const formSiblingNames = useMemo(() => {
    const parentId = formState.location ? formState.location.parent_id : formState.parentId;
    const siblings = parentId ? byNodeId.get(parentId)?.children ?? [] : tree;
    return siblings.map((n) => n.name);
  }, [formState.location, formState.parentId, byNodeId, tree]);

  /**
   * "Nothing here yet" can't be `tree.length === 0`.
   *
   * `trg_auto_track_stocked_part` creates a top-level `('Unassigned', kind='system')` row the
   * moment any stocked part exists, so `tree.length === 0` was **false for every real tenant** —
   * the empty state below and both its CTAs were unreachable, and what an owner actually got was
   * one action-less row reading "Unassigned". `tree.length === 0` is kept for the genuinely
   * fresh company (flag on, no stocked parts yet).
   */
  const noRealStorage = tree.length > 0 && tree.every((n) => n.kind === 'system');

  const openSheet = (node: InventoryLocationNode) => setSheetId(node.id);

  // Every action closes the sheet first: they all open a modal of their own, and two stacked
  // surfaces on a tablet leaves nothing legible underneath.
  const sheetActions = {
    onCountHere: (node: InventoryLocationNode) => {
      setSheetId(null);
      router.push(`/dashboard/${companyId}/inventory/count?location=${node.id}`);
    },
    onAddChild: (node: InventoryLocationNode) => {
      setSheetId(null);
      setFormState({ open: true, location: null, parentId: node.id, parentPath: computePath(node.id, byId) });
    },
    onSubdivide: (node: InventoryLocationNode) => {
      setSheetId(null);
      setBuilder({
        open: true,
        parentId: node.id,
        parentCode: node.code,
        parentPath: computePath(node.id, byId),
        // What's already inside, so a second subdivide continues the run (Row 4–6) rather than
        // regenerating Row 1–3 and colliding partway through the sequential inserts.
        existingSiblingNames: node.children.map((c) => c.name),
        // …and sort the new children AFTER them, or they interleave: subdividing a cabinet that
        // holds Shelf A/B into Rows drew `Row 1 · Row 2 · Shelf A · Row 3 · Shelf B`.
        startSortOrder: node.children.reduce((max, c) => Math.max(max, c.sort_order), -1) + 1,
      });
    },
    onEdit: (node: InventoryLocationNode) => {
      setSheetId(null);
      setFormState({ open: true, location: node, parentId: node.parent_id, parentPath: [] });
    },
    onPrintQR: (node: InventoryLocationNode) => {
      setSheetId(null);
      setQrState({
        open: true,
        node,
        path: computePath(node.id, byId),
        labels: collectLabels(node, byId),
      });
    },
    onDuplicate: async (node: InventoryLocationNode) => {
      setSheetId(null);
      try {
        const created = await duplicateLocation(companyId, node.id);
        await reload();
        setToast(`Duplicated ${node.name} (${created.length} location${created.length === 1 ? '' : 's'}).`);
      } catch (e) {
        setToast(e instanceof Error ? e.message : 'Failed to duplicate location.');
      }
    },
    onMove: (node: InventoryLocationNode) => {
      setSheetId(null);
      setMoveState({ open: true, node });
    },
    onDelete: (node: InventoryLocationNode) => {
      setSheetId(null);
      setDeleteState({ open: true, node });
    },
  };

  /**
   * Re-parent a place.
   *
   * `moveLocation` shipped with the first locations migration, complete with cycle detection and
   * tests, and never had a caller — so a cabinet created under the wrong parent was permanent and
   * the only remedy was deleting the subtree and rebuilding it. Drag-to-reparent stays cut
   * (§5.5); this is the same picker the rest of the app uses.
   *
   * The options exclude the node itself AND its descendants. `moveLocation` refuses a cycle
   * anyway, but offering a destination that will be rejected is a worse experience than not
   * offering it — the guard is the backstop, not the interface.
   */
  const [moveState, setMoveState] = useState<{ open: boolean; node: InventoryLocationNode | null }>({
    open: false,
    node: null,
  });
  const [moveTo, setMoveTo] = useState<LocationPickerOption | null>(null);
  const [moving, setMoving] = useState(false);

  const moveOptions = useMemo<LocationPickerOption[]>(() => {
    const node = moveState.node;
    if (!node) return [];
    const banned = new Set<string>([node.id]);
    // One pass is enough: `locations` is parent-before-child by `sort_order` only by accident, so
    // walk ancestry per row instead of trusting order.
    const isUnder = (id: string | null): boolean => {
      let cursor = id;
      const guard = new Set<string>();
      while (cursor && !guard.has(cursor)) {
        if (cursor === node.id) return true;
        guard.add(cursor);
        cursor = byId.get(cursor)?.parent_id ?? null;
      }
      return false;
    };
    return [
      { id: TOP_LEVEL, label: 'Top level (not inside anything)', kind: null },
      ...locations
        .filter((l) => !banned.has(l.id) && !isUnder(l.parent_id))
        .map((l) => ({ id: l.id, label: computePath(l.id, byId).join(' › '), kind: l.kind }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    ];
  }, [moveState.node, locations, byId]);

  const confirmMove = async () => {
    const node = moveState.node;
    if (!node || !moveTo) return;
    setMoving(true);
    try {
      await moveLocation(node.id, moveTo.id === TOP_LEVEL ? null : moveTo.id, companyId);
      await reload();
      setToast(`Moved ${node.name}.`);
      setMoveState({ open: false, node: null });
      setMoveTo(null);
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Failed to move location.');
    } finally {
      setMoving(false);
    }
  };

  /**
   * Photo handlers.
   *
   * A full `reload()` afterwards rather than patching state: the board's signed URLs come from one
   * batched read, and re-deriving them here would mean a second code path producing the same map.
   */
  const pickPhoto = async (node: InventoryLocationNode, file: File) => {
    await setLocationPhoto(companyId, node.id, file, node.photo_path);
    await reload();
  };

  const dropPhoto = async (node: InventoryLocationNode) => {
    await clearLocationPhoto(node.id, node.photo_path);
    await reload();
  };

  const submitForm = async (values: LocationFormValues) => {
    if (formState.location) {
      await updateLocation(formState.location.id, values);
    } else {
      await createLocation(companyId, { ...values, parent_id: formState.parentId });
    }
    await reload();
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

  const printLabels = async (labels: LocationLabel[], filename: string) => {
    if (labels.length === 0) {
      setToast('No locations to print yet.');
      return;
    }
    const doc = await generateLocationLabelSheet({
      companyId,
      baseUrl: window.location.origin,
      labels,
      heading: companyName,
    });
    doc.save(filename);
  };

  const printAllLabels = async () => {
    if (allLabels.length === 0) {
      setToast('No locations to print yet.');
      return;
    }
    await printLabels(allLabels, 'inventory-labels.pdf');
  };

  return (
    <Box>
      {/*
        Toolbar.

        It once held five setup controls — Scan · Print all labels · New top-level location ·
        Build visually, plus a Board|List toggle — on a page whose own spec section is titled
        "Design for the sustain, not the setup". Scan left because scanning a printed label is
        something you do standing at a shelf, so it belongs to the operator. `Build visually`
        left because it called the identical function as the in-grid Add tile.

        **The Board|List toggle is worth a correction.** It was removed on the reasoning that
        "an indented text tree is the opposite of the map the research asks for, and Cabinet 1
        alone exploded into 15 rows". The second half was an artefact of the WIZARD, not of
        lists: the cabinet template generates 1 × 5 × 2 = 16 nodes in one pass. And the map it
        was protecting turned out to draw nothing for a flat shop. The list won in the end —
        see the note at the top of `LocationTable`. There is no toggle now because there is
        nothing to toggle between.

        `Add storage` moved here from the board's in-grid tile: a table has no grid to hold a
        tile, and a toolbar button is where every other "new thing" in this product lives.
      */}
      {/* Hidden entirely with no places: `Print all labels` has nothing to print, `Count
          everything` has nothing to count, and a second `Add storage` would sit a few hundred
          pixels above the one in the empty-state card. One screen, one call to action. */}
      {tree.length > 0 && (
      <Box sx={{ display: 'flex', gap: 2, mb: 3, flexWrap: 'wrap', alignItems: 'center' }}>
        <Box sx={{ flex: 1 }} />
        <Button
          variant="outlined"
          startIcon={<QrCode2Icon />}
          onClick={printAllLabels}
          disabled={loading || allLabels.length === 0}
        >
          Print all labels
        </Button>
        {/* Was an in-grid tile on the board. A table has no grid to put a tile in, and a toolbar
            button is where every other "new thing" on this product lives. */}
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => setFormState({ open: true, location: null, parentId: null, parentPath: [] })}
        >
          Add storage
        </Button>
        <Button
          variant="outlined"
          startIcon={<FactCheckOutlinedIcon />}
          onClick={() => router.push(`/dashboard/${companyId}/inventory/count`)}
        >
          Count all parts
        </Button>
      </Box>
      )}

      {/* The page never said what it was for, and a first-time reader could not tell — reasonably,
          because almost every control on it is one-time setup. Two sentences: what you're looking
          at, and the one thing here you come back to do. */}
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3, maxWidth: 720 }}>
        Your storage, and what&apos;s in it. Click a place to count it, put parts away, print its QR
        label, or divide it up. Adding and removing stock happens on the part itself, or on the
        shop floor by scanning a label.
      </Typography>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {loading && !boardData ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      ) : tree.length === 0 ? (
        <Card elevation={2}>
          <CardContent sx={{ textAlign: 'center', py: 6 }}>
            {/* One button, matching the board's single "Add storage" tile. This offered
                "Build visually" and "Add manually" side by side — asking someone who has
                never seen the feature to choose between two flows before they know what
                either produces. Name one place; subdivide it later if it needs it. */}
            <Typography color="text.secondary" sx={{ mb: 2 }}>
              No storage yet. Name the places you already have — a cabinet, a shelf, the
              yard — then print QR labels to scan from the shop floor.
            </Typography>
            <Box sx={{ display: 'flex', gap: 1, justifyContent: 'center', flexWrap: 'wrap' }}>
              <Button
                variant="contained"
                startIcon={<AddIcon />}
                onClick={() =>
                  setFormState({ open: true, location: null, parentId: null, parentPath: [] })
                }
              >
                Add storage
              </Button>
            </Box>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* The REAL first-run state: one system bucket, no furniture. Naming the size of the
              pile is the diagnosis that motivates building the first cabinet. */}
          {noRealStorage && (
            <Alert severity="info" sx={{ mb: 2 }}>
              {occupancyFor(occupancy, tree[0].id).totalParts.toLocaleString()} parts, nowhere in
              particular. Build your cabinets, shelving, and bins below, then print QR labels to
              scan from the shop floor.
            </Alert>
          )}

          <LocationTable
            tree={tree}
            occupancy={occupancy}
            onOpen={openSheet}
            onCountHere={(node) =>
              router.push(`/dashboard/${companyId}/inventory/count?location=${node.id}`)
            }
          />
        </>
      )}

      {/* The scanner lived here and is gone: scanning a printed label is something you do
          standing at a shelf, which is the operator surface, not this admin page. It moved
          to the operator tab bar, where it also resolves job travelers — one scanner for
          every kind of Jigged QR. */}

      <LocationDetailSheet
        open={sheetNode !== null}
        node={sheetNode}
        path={sheetPath}
        occupancy={occupancy}
        photoUrl={sheetNode?.photo_path ? photoUrls.get(sheetNode.photo_path) ?? null : null}
        actions={sheetActions}
        onPickPhoto={pickPhoto}
        onClearPhoto={dropPhoto}
        onNavigate={openSheet}
        onClose={() => setSheetId(null)}
      />

      <LocationFormModal
        open={formState.open}
        location={formState.location}
        parentPath={formState.location ? undefined : formState.parentPath}
        siblingNames={formSiblingNames}
        onClose={() => setFormState((s) => ({ ...s, open: false }))}
        onSubmit={submitForm}
      />
      <LocationQRModal
        open={qrState.open}
        companyId={companyId}
        companyName={companyName}
        node={qrState.node}
        path={qrState.path}
        labels={qrState.labels}
        onClose={() => setQrState((s) => ({ ...s, open: false }))}
      />
      <VisualLocationBuilder
        open={builder.open}
        companyId={companyId}
        parentId={builder.parentId}
        parentCode={builder.parentCode}
        parentPath={builder.parentPath}
        existingSiblingNames={builder.existingSiblingNames}
        startSortOrder={builder.startSortOrder}
        onClose={() => setBuilder((s) => ({ ...s, open: false }))}
        onCreated={(n) => {
          void reload();
          setToast(`Created ${n} location${n === 1 ? '' : 's'}.`);
        }}
      />

      <Dialog
        open={moveState.open}
        onClose={() => {
          setMoveState({ open: false, node: null });
          setMoveTo(null);
        }}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Move {moveState.node?.name}</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            Everything inside it moves too, and the stock goes with it — this changes where a
            place sits, not what is in it.
          </DialogContentText>
          <LocationPicker
            label="Move it into"
            options={moveOptions}
            value={moveTo}
            onChange={setMoveTo}
          />
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setMoveState({ open: false, node: null });
              setMoveTo(null);
            }}
          >
            Cancel
          </Button>
          <Button variant="contained" disabled={!moveTo || moving} onClick={confirmMove}>
            Move
          </Button>
        </DialogActions>
      </Dialog>

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
