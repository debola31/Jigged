'use client';

import { useEffect, useMemo, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import IconButton from '@mui/material/IconButton';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import CloseIcon from '@mui/icons-material/Close';
import PartForm from './PartForm';
import PartTypeChip from './PartTypeChip';
import {
  EMPTY_PART_FORM,
  partKind,
  partToFormData,
} from '@/types/part';
import type { Part, PartFormData } from '@/types/part';
import { getAllParts } from '@/utils/partsAccess';

interface PartFormModalProps {
  open: boolean;
  onClose: () => void;
  /**
   * Called when the user has either created a new part OR confirmed edits to
   * an existing one. Receives the resulting Part either way so callers (e.g.
   * QuoteForm) can pick the just-created/edited part into the parent form.
   */
  onCreated: (part: Part) => void;
  companyId: string;
}

type Phase = 'searching' | 'creating' | 'editing-existing';

interface PartSuggestion {
  id: string;
  part_name: string;
  description: string | null;
  source: 'made' | 'bought';
  is_stocked: boolean;
}

/**
 * Search-first add-part modal.
 *
 * The user types a part name; as they type, we suggest existing parts in the
 * company. Picking a suggestion drops the modal into edit mode for that part.
 * Typing a brand-new name and continuing drops it into create mode with the
 * name pre-filled. Eliminates the "create-collides-with-existing" footgun
 * without needing a separate extend-existing flow.
 *
 * The autocomplete query is RLS-scoped (uses partsAccess.getAllParts), so it
 * cannot leak parts from other companies.
 */
export default function PartFormModal({
  open,
  onClose,
  onCreated,
  companyId,
}: PartFormModalProps) {
  const [phase, setPhase] = useState<Phase>('searching');
  const [searchInput, setSearchInput] = useState('');
  const [searchInputDebounced, setSearchInputDebounced] = useState('');
  const [suggestions, setSuggestions] = useState<PartSuggestion[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null);

  const [editTarget, setEditTarget] = useState<Part | null>(null);
  const [editTargetData, setEditTargetData] = useState<PartFormData | null>(null);
  const [editLoading, setEditLoading] = useState(false);
  const [createInitial, setCreateInitial] = useState<PartFormData>(EMPTY_PART_FORM);
  // Bumped to force PartForm to re-mount whenever we hand it new initialData
  // (e.g. when the user switches between an existing pick and a new name).
  const [formKey, setFormKey] = useState(0);

  // Reset everything when the modal closes/reopens.
  useEffect(() => {
    if (open) {
      setPhase('searching');
      setSearchInput('');
      setSearchInputDebounced('');
      setSuggestions([]);
      setSuggestionsError(null);
      setEditTarget(null);
      setEditTargetData(null);
      setCreateInitial(EMPTY_PART_FORM);
      setFormKey((k) => k + 1);
    }
  }, [open]);

  // Debounce the search input to avoid hammering Supabase on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setSearchInputDebounced(searchInput), 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Pull suggestions whenever the (debounced) input changes and we're still
  // in the search phase. Once the user commits to creating or editing, we
  // stop fetching so a stale suggestion list doesn't fight the form.
  useEffect(() => {
    if (!open || phase !== 'searching') return;

    let cancelled = false;
    async function load() {
      setSuggestionsLoading(true);
      setSuggestionsError(null);
      try {
        const rows = await getAllParts(companyId, searchInputDebounced.trim());
        if (cancelled) return;
        setSuggestions(
          rows.slice(0, 25).map((p) => ({
            id: p.id,
            part_name: p.part_name,
            description: p.description,
            source: p.source,
            is_stocked: p.is_stocked,
          })),
        );
      } catch (err) {
        if (!cancelled) {
          setSuggestionsError(err instanceof Error ? err.message : 'Failed to load parts');
        }
      } finally {
        if (!cancelled) setSuggestionsLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [open, phase, companyId, searchInputDebounced]);

  // Exact-match against current input (case-insensitive). Used to decide
  // whether "press Enter" means "create" or "edit existing".
  const exactMatch = useMemo<PartSuggestion | null>(() => {
    const trimmed = searchInput.trim().toLowerCase();
    if (!trimmed) return null;
    return (
      suggestions.find((s) => s.part_name.toLowerCase() === trimmed) ?? null
    );
  }, [suggestions, searchInput]);

  const startCreate = (name: string) => {
    setCreateInitial({ ...EMPTY_PART_FORM, part_name: name });
    setPhase('creating');
    setFormKey((k) => k + 1);
  };

  const startEditExisting = async (suggestion: PartSuggestion) => {
    setEditLoading(true);
    setSuggestionsError(null);
    try {
      // Pull the full Part. Unit conversions live on the part detail page
      // (chunk 11 moved them out of the create/edit form), so no longer
      // fetched here.
      const allRows = await getAllParts(companyId, suggestion.part_name);
      const fullPart = allRows.find((r) => r.id === suggestion.id) || null;
      if (!fullPart) {
        setSuggestionsError(
          'Could not load the selected part. It may have been deleted.',
        );
        return;
      }
      setEditTarget(fullPart);
      setEditTargetData(partToFormData(fullPart));
      setPhase('editing-existing');
      setFormKey((k) => k + 1);
    } catch (err) {
      setSuggestionsError(err instanceof Error ? err.message : 'Failed to load part');
    } finally {
      setEditLoading(false);
    }
  };

  const handleSelectSuggestion = (option: PartSuggestion | string | null) => {
    if (!option) return;
    if (typeof option === 'string') {
      // User typed something not in the list and pressed Enter.
      const trimmed = option.trim();
      if (!trimmed) return;
      const match = suggestions.find(
        (s) => s.part_name.toLowerCase() === trimmed.toLowerCase(),
      );
      if (match) {
        startEditExisting(match);
      } else {
        startCreate(trimmed);
      }
      return;
    }
    startEditExisting(option);
  };

  const handleContinueAsNew = () => {
    const trimmed = searchInput.trim();
    if (!trimmed) return;
    if (exactMatch) {
      startEditExisting(exactMatch);
    } else {
      startCreate(trimmed);
    }
  };

  const handleBackToSearch = () => {
    setPhase('searching');
    setEditTarget(null);
    setEditTargetData(null);
  };

  const handleSuccess = (part?: Part) => {
    if (part) {
      onCreated(part);
      onClose();
    }
  };

  const title =
    phase === 'searching'
      ? 'Add Part'
      : phase === 'editing-existing' && editTarget
        ? `Edit Part: ${editTarget.part_name}`
        : 'Add Part';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      scroll="paper"
      PaperProps={{
        sx: {
          maxHeight: '90vh',
        },
      }}
    >
      <DialogTitle
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          pb: 1,
        }}
      >
        {title}
        <IconButton onClick={onClose} size="small" sx={{ color: 'text.secondary' }}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent sx={{ pt: 2 }}>
        {phase === 'searching' && (
          <Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Start typing a part name. Pick an existing part to edit it, or
              continue with a new name to create one.
            </Typography>

            <Autocomplete<PartSuggestion, false, false, true>
              freeSolo
              autoHighlight
              options={suggestions}
              loading={suggestionsLoading}
              inputValue={searchInput}
              onInputChange={(_event, newValue, reason) => {
                if (reason !== 'reset') {
                  setSearchInput(newValue);
                }
              }}
              onChange={(_event, value) => handleSelectSuggestion(value)}
              filterOptions={(opts) => opts}
              getOptionLabel={(opt) =>
                typeof opt === 'string' ? opt : opt.part_name
              }
              isOptionEqualToValue={(opt, val) =>
                typeof opt !== 'string' && typeof val !== 'string' && opt.id === val.id
              }
              renderOption={(props, opt) => {
                if (typeof opt === 'string') return null;
                const kind = partKind({
                  source: opt.source,
                  is_stocked: opt.is_stocked,
                });
                return (
                  <Box
                    component="li"
                    {...props}
                    key={opt.id}
                    sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}
                  >
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="body2" sx={{ fontWeight: 500 }}>
                        {opt.part_name}
                      </Typography>
                      {opt.description && (
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{
                            display: 'block',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {opt.description}
                        </Typography>
                      )}
                    </Box>
                    <PartTypeChip kind={kind} />
                  </Box>
                );
              }}
              renderInput={(params) => (
                <TextField
                  {...params}
                  autoFocus
                  label="Part name"
                  placeholder="Type to search or create..."
                  helperText={
                    suggestionsError
                      ? ' '
                      : exactMatch
                        ? 'A part with this exact name already exists. Press Enter to edit it.'
                        : searchInput.trim()
                          ? 'No exact match. Press Enter to create a new part with this name.'
                          : ' '
                  }
                  slotProps={{
                    input: {
                      ...params.InputProps,
                      endAdornment: (
                        <>
                          {(suggestionsLoading || editLoading) && (
                            <CircularProgress color="inherit" size={20} />
                          )}
                          {params.InputProps.endAdornment}
                        </>
                      ),
                    },
                  }}
                />
              )}
            />

            {suggestionsError && (
              <Alert severity="error" sx={{ mt: 2 }}>
                {suggestionsError}
              </Alert>
            )}

            <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 3 }}>
              <Stack direction="row" spacing={2}>
                <Button
                  variant="contained"
                  onClick={handleContinueAsNew}
                  disabled={!searchInput.trim() || editLoading}
                >
                  {exactMatch ? 'Edit existing part' : 'Create new part'}
                </Button>
              </Stack>
            </Box>
          </Box>
        )}

        {phase === 'creating' && (
          <Box>
            <Box sx={{ mb: 2, display: 'flex', justifyContent: 'flex-end' }}>
              <Button size="small" onClick={handleBackToSearch} sx={{ color: 'text.secondary' }}>
                Search again
              </Button>
            </Box>
            <PartForm
              key={formKey}
              mode="create"
              companyId={companyId}
              initialData={createInitial}
              onSuccess={handleSuccess}
              onCancel={onClose}
              hideHeading
            />
          </Box>
        )}

        {phase === 'editing-existing' && editTargetData && editTarget && (
          <Box>
            <Box sx={{ mb: 2, display: 'flex', justifyContent: 'flex-end' }}>
              <Button size="small" onClick={handleBackToSearch} sx={{ color: 'text.secondary' }}>
                Search again
              </Button>
            </Box>
            <PartForm
              key={formKey}
              mode="edit"
              companyId={companyId}
              initialData={editTargetData}
              partId={editTarget.id}
              part={editTarget}
              onSuccess={handleSuccess}
              onCancel={onClose}
              hideHeading
            />
          </Box>
        )}
      </DialogContent>
    </Dialog>
  );
}

