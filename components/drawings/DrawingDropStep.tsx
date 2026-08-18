'use client';

/**
 * Step 1 — the files, and who they came from.
 *
 * The customer selector lives here rather than at the end because this is the only
 * moment the attribution reliably exists. After this screen closes, nothing knows
 * whose numbering these part numbers belong to.
 */

import { useCallback, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import CreateNewFolderIcon from '@mui/icons-material/CreateNewFolder';
import UploadFileIcon from '@mui/icons-material/UploadFile';

import Autocomplete from '@mui/material/Autocomplete';
import UnitOfMeasurementSelect from '@/components/parts/UnitOfMeasurementSelect';
import { getAllCustomers } from '@/utils/customerAccess';
import type { CustomerWithRelations } from '@/types/customer';

interface Props {
  /** Made or bought, for the whole package — see the block that renders it. */
  defaultSource: 'made' | 'bought';
  onDefaultSourceChange: (next: 'made' | 'bought') => void;
  companyId: string;
  customerId: string | null;
  onCustomerChange: (id: string | null) => void;
  defaultUnit: string;
  onDefaultUnitChange: (unit: string) => void;
  onFiles: (files: File[]) => void;
  disabled: boolean;
}

export default function DrawingDropStep({
  companyId,
  customerId,
  defaultSource,
  onDefaultSourceChange,
  onCustomerChange,
  defaultUnit,
  onDefaultUnitChange,
  onFiles,
  disabled,
}: Props) {
  const [customers, setCustomers] = useState<CustomerWithRelations[]>([]);
  const [loadingCustomers, setLoadingCustomers] = useState(false);
  const [dragging, setDragging] = useState(false);

  // Loaded when the field is opened rather than on mount: most of the work on this
  // screen never needs the list, and a shop can have thousands of customers.
  const loadCustomers = useCallback(async () => {
    if (customers.length > 0 || loadingCustomers) return;
    setLoadingCustomers(true);
    try {
      setCustomers(await getAllCustomers(companyId));
    } finally {
      setLoadingCustomers(false);
    }
  }, [companyId, customers.length, loadingCustomers]);
  const [picked, setPicked] = useState<File[]>([]);
  const folderInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const take = useCallback((list: FileList | null) => {
    if (!list) return;
    setPicked(Array.from(list));
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (disabled) return;
      take(e.dataTransfer.files);
    },
    [disabled, take],
  );

  return (
    <Card>
      <CardContent sx={{ p: 4 }}>
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mb: 3 }}>
          <Box sx={{ minWidth: 280, flex: 1 }}>
            <Autocomplete
              options={customers}
              loading={loadingCustomers}
              getOptionLabel={(c) => c.name}
              value={customers.find((c) => c.id === customerId) ?? null}
              onChange={(_, next) => onCustomerChange(next?.id ?? null)}
              onOpen={loadCustomers}
              renderInput={(p) => (
                <TextField {...p} label="Whose drawings are these?" size="small" />
              )}
            />
            <Typography variant="caption" color="text.secondary">
              Optional, but it lets us keep their part numbers straight from another
              customer&apos;s.
            </Typography>
          </Box>
          {/*
            One answer for the package, not a column in the grid.
            A shop importing a folder of prints is importing parts it MAKES —
            bought stock arrives as a different job, and a per-row toggle on 31
            identical answers is 31 chances to mis-click for no information gained.
          */}
          <Box sx={{ minWidth: 200 }}>
            <Typography variant="caption" color="text.secondary" display="block">
              Are these made or bought?
            </Typography>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={defaultSource}
              onChange={(_, next) => next && onDefaultSourceChange(next)}
              sx={{ mt: 0.5 }}
            >
              <ToggleButton value="made">We make them</ToggleButton>
              <ToggleButton value="bought">We buy them</ToggleButton>
            </ToggleButtonGroup>
            <Typography variant="caption" color="text.secondary" display="block">
              Import the other kind separately.
            </Typography>
          </Box>
          <Box sx={{ minWidth: 200 }}>
            <UnitOfMeasurementSelect
              value={defaultUnit}
              onChange={(next) => onDefaultUnitChange(next ?? 'ea')}
              companyId={companyId}
              required
            />
            <Typography variant="caption" color="text.secondary">
              A drawing never states one, and every part needs one.
            </Typography>
          </Box>
        </Box>

        <Box
          onDragOver={(e) => {
            e.preventDefault();
            if (!disabled) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          sx={{
            border: '2px dashed',
            borderColor: dragging ? 'primary.main' : 'divider',
            borderRadius: 1,
            bgcolor: dragging ? 'action.hover' : 'transparent',
            p: 6,
            textAlign: 'center',
            transition: 'border-color 120ms, background-color 120ms',
          }}
        >
          <UploadFileIcon sx={{ fontSize: 56, color: 'text.secondary', mb: 1 }} />
          <Typography variant="h6" gutterBottom>
            Drop the drawings here
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            PDF, DXF and STEP. Files that share a name are treated as one part.
          </Typography>

          {/* Stated as a reason, never a rule: the shop does not own these drawings,
              and an ask aimed at their customer's customer should not be a wall. */}
          <Alert severity="info" sx={{ mb: 3, textAlign: 'left' }}>
            <strong>Include the DXF where you have it</strong> — we read more from it. PDFs alone
            work too.
          </Alert>

          <Box sx={{ display: 'flex', gap: 1, justifyContent: 'center', flexWrap: 'wrap' }}>
            <Button
              variant="contained"
              startIcon={<CreateNewFolderIcon />}
              onClick={() => folderInput.current?.click()}
              disabled={disabled}
            >
              Choose a folder
            </Button>
            <Button variant="outlined" onClick={() => fileInput.current?.click()} disabled={disabled}>
              Choose files
            </Button>
          </Box>

          {/* `webkitdirectory` is non-standard but universal, and it is the only way
              to pick a whole package in one action. The plain input stays for the
              flat-selection case and for browsers that refuse the folder one. */}
          <input
            ref={folderInput}
            type="file"
            hidden
            multiple
            // @ts-expect-error — webkitdirectory is not in React's HTML types.
            webkitdirectory=""
            directory=""
            onChange={(e) => take(e.target.files)}
          />
          <input
            ref={fileInput}
            type="file"
            hidden
            multiple
            accept=".pdf,.dxf,.step,.stp"
            onChange={(e) => take(e.target.files)}
          />

          {picked.length > 0 && (
            <Box sx={{ mt: 3 }}>
              <Chip
                color="success"
                label={`${picked.length} file${picked.length === 1 ? '' : 's'} ready`}
              />
            </Box>
          )}
        </Box>

        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 3 }}>
          <Button
            variant="contained"
            size="large"
            disabled={disabled || picked.length === 0}
            onClick={() => onFiles(picked)}
          >
            Read {picked.length > 0 ? `${picked.length} files` : 'the drawings'}
          </Button>
        </Box>
      </CardContent>
    </Card>
  );
}
