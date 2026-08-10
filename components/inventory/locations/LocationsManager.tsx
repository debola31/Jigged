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
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import AddIcon from '@mui/icons-material/Add';
import SearchIcon from '@mui/icons-material/Search';
import QrCode2Icon from '@mui/icons-material/QrCode2';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';

import type { InventoryLocation, InventoryLocationNode } from '@/types/inventoryLocations';
import {
  buildLocationTree,
  getLocationBoard,
  createLocation,
  updateLocation,
  duplicateLocation,
  deleteLocation,
} from '@/utils/inventoryLocationsAccess';
import { rollUpOccupancy, occupancyFor } from '@/utils/locationOccupancy';
import { orderUnits } from '@/lib/locationGrid';
import { generateLocationLabelSheet, type LocationLabel } from '@/utils/locationLabelPdf';
import LocationFormModal, { type LocationFormValues } from './LocationFormModal';
import LocationQRModal from './LocationQRModal';
import VisualLocationBuilder from './builder/VisualLocationBuilder';
import StorageUnitList from './StorageUnitList';
import LocationPanel from './LocationPanel';
import PlaceStockActionModal, { type PlaceStockAction } from './PlaceStockActionModal';
import { stockDestinationOptions } from '@/utils/locationDestinations';


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
    if (n.kind !== 'system') out.push({ id: n.id, path: computePath(n.id, byId) });
    n.children.forEach(walk);
  };
  walk(node);
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

interface LocationsManagerProps {
  companyId: string;
  /**
   * The unit being shown, from `?unit=` on the URL.
   *
   * A **query param on one page**, not a nested route. It was `/locations/{unitId}` for a day, and
   * that is the wrong model for a workspace: picking a cabinet is a selection within one screen,
   * not a journey to another, and Next treated each pick as a page transition — the whole thing
   * blanked and reloaded to change one pane. A search param still gives a shareable link and a
   * working back button, without pretending the pane is a destination.
   */
  unitId?: string;
}

export default function LocationsManager({
  companyId,
  unitId,
}: LocationsManagerProps) {
  const router = useRouter();
  /*
   * Master–detail only survives where there is room for both, so below `md` the list and the unit
   * are separate screens — the unit gets the whole width and its own back link, which is what the
   * operator surface has always done. One design, expressed responsively.
   *
   * Done in CSS rather than `useMediaQuery`, for two reasons that both bit. A JS media query
   * resolves false on the server and true after mount, so the first frame is the wrong layout —
   * and `window.matchMedia` does not exist in jsdom, so every test saw the narrow branch and the
   * two-pane layout could not be exercised at all. Breakpoints in `sx` have neither problem.
   */
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
    parentPath: string[];
    existingSiblingNames: string[];
    startSortOrder: number;
  }>({
    open: false,
    parentId: null,
    parentPath: [],
    existingSiblingNames: [],
    startSortOrder: 0,
  });

  // `openTopLevelBuilder` is gone with the toolbar's "Build visually". The builder itself
  // survives, reached only from Subdivide on a unit that already exists — which is what
  // §5.5 decision 3 prescribed all along, and it keeps the `parentId` path as the only
  // path rather than a dormant second one.

  /** Which node the sheet shows. An id, not a node, so a reload re-resolves fresh children. */
  const [placeId, setPlaceId] = useState<string | null>(null);
  /** Filters the unit list. Held here because the field lives in the page header. */
  const [query, setQuery] = useState('');



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

  const byId = useMemo(() => new Map(locations.map((l) => [l.id, l] as const)), [locations]);
  // Sorted once here so the board and the list agree — `Unassigned` last in both. Sorting only
  // inside the board left the list leading with the put-away pile, which is the impression the
  // board's ordering exists to avoid.
  const tree = useMemo(() => orderUnits(buildLocationTree(locations)), [locations]);
  const byNodeId = useMemo(() => indexTree(tree), [tree]);
  const occupancy = useMemo(() => rollUpOccupancy(tree, directPartCounts), [tree, directPartCounts]);
  const allLabels = useMemo(() => tree.flatMap((n) => collectLabels(n, byId)), [tree, byId]);


  const openUnit = unitId ? byNodeId.get(unitId) ?? null : null;

  /**
   * The place whose contents show below the grid.
   *
   * Deliberately NOT navigation: clicking a bin leaves the grid where it is and opens what is in
   * it underneath, so working through a cabinet costs no page loads and never loses your position.
   * Falls back to the unit, which is right in both directions — a single-place unit IS the place,
   * and a structured one starts by saying stock lives in the places rather than in the cabinet.
   */
  const selectedPlace =
    (placeId ? byNodeId.get(placeId) : null) ?? openUnit ?? null;

  /**
   * Opening a unit from the list.
   *
   * Only something with structure gets drawn. A unit with nothing inside it — the Yard, a bench,
   * the `Unassigned` pile — IS one place, so it opens its sheet: there is no grid, and drawing an
   * empty one to say "change its layout" would answer a question nobody asked. The pile needs no
   * special case of its own; having no children is what it has in common with the Yard, and its
   * sheet already leads with "Put these away" rather than a count.
   */
  /**
   * Adding storage is ONE step now: name it and say how it is divided, together.
   *
   * It used to be two — create a bare place here, then find `Divide it up…` inside its detail
   * sheet. Nobody making a cabinet wants an empty cabinet, and the second half was behind a
   * drawer, so a shop could easily end up with named furniture and no places in it. Naming and
   * shaping are one decision, and since `create_location_tree` they are also one transaction.
   */
  /**
   * Which stock verb is open, and on what.
   *
   * The node rather than an id: the dialog titles itself with the place's name, and looking it
   * back up would go stale the moment a rename lands between opening and rendering.
   */
  const [stockAction, setStockAction] = useState<{ action: PlaceStockAction; node: InventoryLocationNode } | null>(null);

  const listHref = `/dashboard/${companyId}/inventory/locations`;
  /**
   * `replace`, not `push`, and `scroll: false`.
   *
   * Replace because clicking through six cabinets should not bury the page you arrived from under
   * six history entries — back means "leave storage", which is what someone pressing it wants.
   * `scroll: false` because the default scrolls to the top on every navigation, which would throw
   * away the position you had in a 12-row grid.
   */
  const showUnit = (id: string | null) =>
    router.replace(id ? `${listHref}?unit=${id}` : listHref, { scroll: false });

  const openAddStorage = () =>
    setBuilder({
      open: true,
      parentId: null,
      parentPath: [],
      existingSiblingNames: [],
      startSortOrder: tree.reduce((max, n) => Math.max(max, n.sort_order), -1) + 1,
    });

  const openUnit_ = (node: InventoryLocationNode) => {
    // Clearing the place matters: keeping it would carry a bin from the last cabinet into this
    // one, where it is not on the grid and its contents are simply wrong.
    setPlaceId(null);
    showUnit(node.id);
  };

  /**
   * Tapping a cell in the grid.
   *
   * A container drills in — its stock lives in its children, so acting on it directly is exactly
   * what the container/bin invariant refuses. A leaf opens the sheet, which owns every action.
   */
  const openCell = (locationId: string) => {
    const node = byNodeId.get(locationId);
    if (node && node.children.length > 0) {
      setPlaceId(null);
      showUnit(locationId);
      return;
    }
    setPlaceId(locationId);
  };

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


  // Every action closes the sheet first: they all open a modal of their own, and two stacked
  // surfaces on a tablet leaves nothing legible underneath.
  const sheetActions = {
    /*
     * The audit, at whatever scope was clicked.
     *
     * `?location=` resolves a container to every leaf under it, so this one handler means "audit
     * this bin" on a bin and "audit this whole cabinet, bin by bin" on a cabinet — which is the
     * scale an audit actually happens at. It navigates rather than opening a dialog because an
     * audit is inherently multi-part; the other three verbs act on one part and stay in place.
     */
    onAdjust: (node: InventoryLocationNode) => {
      setPlaceId(null);
      router.push(`/dashboard/${companyId}/inventory/count?location=${node.id}`);
    },
    onAddStock: (node: InventoryLocationNode) => setStockAction({ action: 'add', node }),
    onRemoveStock: (node: InventoryLocationNode) => setStockAction({ action: 'deplete', node }),
    onMoveStock: (node: InventoryLocationNode) => setStockAction({ action: 'move', node }),
    onAddChild: (node: InventoryLocationNode) => {
      setPlaceId(null);
      setFormState({ open: true, location: null, parentId: node.id, parentPath: computePath(node.id, byId) });
    },
    onSubdivide: (node: InventoryLocationNode) => {
      setPlaceId(null);
      setBuilder({
        open: true,
        parentId: node.id,
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
      setPlaceId(null);
      setFormState({ open: true, location: node, parentId: node.parent_id, parentPath: [] });
    },
    onPrintQR: (node: InventoryLocationNode) => {
      setPlaceId(null);
      setQrState({
        open: true,
        node,
        path: computePath(node.id, byId),
        labels: collectLabels(node, byId),
      });
    },
    onDuplicate: async (node: InventoryLocationNode) => {
      setPlaceId(null);
      try {
        const created = await duplicateLocation(companyId, node.id);
        await reload();
        setToast(`Duplicated ${node.name} (${created.length} location${created.length === 1 ? '' : 's'}).`);
      } catch (e) {
        setToast(e instanceof Error ? e.message : 'Failed to duplicate location.');
      }
    },
    onDelete: (node: InventoryLocationNode) => {
      setPlaceId(null);
      setDeleteState({ open: true, node });
    },
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
    // No `baseUrl` and no `heading`. The origin now comes from the pinned production constant, so a
    // sheet printed from a preview deployment can't encode a hostname that outlives it; and the
    // company-name heading used to print at the top of page 1, which on die-cut Avery stock lands
    // across the middle of label 1.
    const doc = await generateLocationLabelSheet({ companyId, labels });
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
        One header row, and the order is by scope: the two controls that act on the LIST sit above
        the list's own column, and the two that act on the WHOLE SHOP sit right.

        It has been three separate arrangements. Five setup controls — Scan · Print all labels ·
        New top-level location · Build visually, plus a Board|List toggle — on a page whose own
        spec section is titled "Design for the sustain, not the setup". Then three in a toolbar
        aimed at three different scopes. Then a search box stranded inside the list column while
        the page's own buttons floated above it. Same row now, grouped by what they touch.
      */}
      {tree.length > 0 && (
        <Box
          sx={{
            display: 'flex',
            gap: 1,
            mb: 2,
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          {/*
            Goes with the list, so it goes when the list goes. On a phone a unit takes the whole
            screen, and a search field that filters a list you cannot see — beside a button that
            adds to it — is two controls acting on something off-screen.
          */}
          <Box
            sx={{
              display: { xs: openUnit ? 'none' : 'flex', md: 'flex' },
              gap: 1,
              alignItems: 'center',
              flexWrap: 'wrap',
              flex: { xs: '1 1 100%', sm: '0 0 auto' },
            }}
          >
            <TextField
              size="small"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a place"
              type="search"
              sx={{ width: { xs: '100%', sm: 260 } }}
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
            <Button variant="contained" startIcon={<AddIcon />} onClick={openAddStorage}>
              Add storage
            </Button>
          </Box>

          <Box sx={{ flex: 1 }} />

          {/*
            `Count all parts` is gone from here, and nothing replaced it.

            It opened the company-wide count sheet — every stocked part across the shop in one
            list. Nobody audits a shop that way: you audit one cabinet, walking bin to bin, which
            is what `Adjust` on a unit now does (the worksheet resolves a container to every leaf
            under it). A shop-wide sheet still exists for whoever wants one; it is `Count
            Inventory` on the Parts toolbar, where the noun is the items rather than the places.
          */}
          <Button
            variant="outlined"
            startIcon={<QrCode2Icon />}
            onClick={printAllLabels}
            disabled={loading || allLabels.length === 0}
          >
            Print all labels
          </Button>
        </Box>
      )}

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {loading && !boardData ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      ) : tree.length === 0 ? (
        <Card elevation={2}>
          <CardContent sx={{ textAlign: 'center', py: 6 }}>
            <Typography color="text.secondary" sx={{ mb: 2 }}>
              No storage yet. Name the places you already have — a cabinet, a shelf, the
              yard — then print QR labels to scan from the shop floor.
            </Typography>
            <Button variant="contained" startIcon={<AddIcon />} onClick={openAddStorage}>
              Add storage
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* The REAL first-run state: one system bucket, no furniture. Naming the size of the
              pile is the diagnosis that motivates building the first cabinet. */}
          {noRealStorage && (
            <Alert severity="info" sx={{ mb: 2 }}>
              {occupancyFor(occupancy, tree[0].id).totalParts.toLocaleString()} parts, nowhere in
              particular. Build your cabinets, shelving, and bins, then print QR labels to scan
              from the shop floor.
            </Alert>
          )}

          {/*
            The workspace: pick on the left, work on the right.

            The paragraph of instructions that used to sit above this is gone. It explained a page
            whose shape did not explain itself — a list you clicked to swap the page out from under
            you. A list beside the thing it selects needs no caption, and the sentence about stock
            living on the part was answering a question nobody had asked yet.

            Below `md` these are two screens rather than two panes, which is what the operator
            surface has always done.
          */}
          <Box
            sx={{
              display: 'flex',
              gap: 3,
              alignItems: 'flex-start',
              /*
               * Neither pane scrolls, and the page barely does — the GRID owns the vertical
               * overflow instead (see `UnitGridView`). Two other approaches were tried in the
               * browser and both failed for reasons worth recording:
               *
               *   - Nested scroll panes: `maxHeight: 100%` on a child resolves against a parent
               *     with no definite height, so nothing ever scrolled.
               *   - A sticky list: `main` carries `overflow: auto` but never actually scrolls (the
               *     window does), and an `overflow` ancestor silently makes sticky a no-op.
               *
               * Capping the grid keeps the list on screen without depending on the app shell's
               * scroll arrangement, which is not this page's to change.
               */
            }}
          >
            <Box
              sx={{
                // On a phone the list IS the screen until you pick something, and then it gets
                // out of the way entirely.
                display: { xs: openUnit ? 'none' : 'block', md: 'block' },
                width: { xs: '100%', md: 320 },
                flexShrink: 0,
                minWidth: 0,
                maxHeight: { md: 'calc(100vh - 260px)' },
                overflowY: { md: 'auto' },
                pr: { md: 1 },
              }}
            >
              <StorageUnitList
                tree={tree}
                occupancy={occupancy}
                selectedId={openUnit?.id ?? null}
                query={query}
                onOpen={openUnit_}
              />
            </Box>

            {openUnit && selectedPlace ? (
              <Box
                sx={{ flex: 1, minWidth: 0 }}
              >
                <LocationPanel
                  unit={openUnit}
                  place={selectedPlace}
                  occupancy={occupancy}
                  onSelectPlace={openCell}
                  actions={sheetActions}
                  backSlot={
                    <Button
                      startIcon={<ArrowBackIcon />}
                      onClick={() => showUnit(null)}
                      // Only where the list is not already beside you. On a wide screen it would
                      // be a back link out of something you can still see.
                      sx={{ ml: -1, mb: 0.5, display: { xs: 'inline-flex', md: 'none' } }}
                    >
                      All storage
                    </Button>
                  }
                />
              </Box>
            ) : (
              /* Nothing picked, on a wide screen. Says what the pane is for rather than leaving
                 half the page blank and unexplained. Hidden on a phone, where the list is the
                 whole screen and there is no empty pane to explain. */
              <Box
                sx={{
                  display: { xs: 'none', md: 'block' },
                  flex: 1,
                  minWidth: 0,
                  pt: 6,
                  textAlign: 'center',
                }}
              >
                <Typography color="text.secondary">Pick a place to see what is in it.</Typography>
              </Box>
            )}
          </Box>
        </>
      )}

      {/* The scanner lived here and is gone: scanning a printed label is something you do
          standing at a shelf, which is the operator surface, not this admin page. It moved
          to the operator tab bar, where it also resolves job travelers — one scanner for
          every kind of Jigged QR. */}

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
        node={qrState.node}
        path={qrState.path}
        labels={qrState.labels}
        onClose={() => setQrState((s) => ({ ...s, open: false }))}
      />
      <VisualLocationBuilder
        open={builder.open}
        companyId={companyId}
        parentId={builder.parentId}
        parentPath={builder.parentPath}
        siblingNames={tree.map((n) => n.name)}
        existingSiblingNames={builder.existingSiblingNames}
        startSortOrder={builder.startSortOrder}
        onClose={() => setBuilder((s) => ({ ...s, open: false }))}
        onCreated={(n) => {
          void reload();
          setToast(`Created ${n} location${n === 1 ? '' : 's'}.`);
        }}
      />

      {/*
        Add · Remove · Move on one place. Mounted only while open, so the part catalogue and the
        bin's contents are read when the verb is chosen rather than on every panel render.
      */}
      {stockAction && (
        <PlaceStockActionModal
          open
          action={stockAction.action}
          companyId={companyId}
          locationId={stockAction.node.id}
          locationName={stockAction.node.name}
          // Leaves only, never the put-away pile, and never back to where it already is.
          moveDestinations={stockDestinationOptions(locations, { excludeId: stockAction.node.id })}
          onClose={() => setStockAction(null)}
          onDone={async () => {
            await reload();
            setToast('Stock updated.');
          }}
        />
      )}

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
