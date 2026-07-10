'use client';

import { useMemo } from 'react';
import { AgGridReact } from 'ag-grid-react';
import {
  ModuleRegistry,
  AllCommunityModule,
  type ColDef,
  type CellValueChangedEvent,
} from 'ag-grid-community';
import Box from '@mui/material/Box';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Chip from '@mui/material/Chip';
import { jiggedAgGridTheme } from '@/lib/agGridTheme';
import type { EditableRow, WorkingFile } from '@/lib/dataImportEditing';

ModuleRegistry.registerModules([AllCommunityModule]);

interface EditableDataGridProps {
  files: WorkingFile[];
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onCellEdit: (fileIndex: number, rowId: string, colId: string, oldValue: string, newValue: string) => void;
}

/**
 * Spreadsheet-like grid for fixing uploaded data in-app (double-click a cell to edit;
 * sort/filter). One tab per file. Every edit is reported up so the wizard can update the
 * working dataset, re-run the analyzer, and refresh the review live. Increment 1: cell edits
 * only — bulk find-replace and cluster-merge come in later increments.
 */
export default function EditableDataGrid({
  files,
  activeIndex,
  onActiveIndexChange,
  onCellEdit,
}: EditableDataGridProps) {
  const active = files[activeIndex];

  const columnDefs = useMemo<ColDef<EditableRow>[]>(
    () => (active?.headers ?? []).map((h) => ({ field: h, editable: true, minWidth: 150 })),
    [active?.headers],
  );

  if (!active) return null;

  return (
    <Box>
      <Tabs
        value={activeIndex}
        onChange={(_, v) => onActiveIndexChange(v)}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ mb: 1, minHeight: 40 }}
      >
        {files.map((f, i) => (
          <Tab
            key={f.filename}
            value={i}
            sx={{ minHeight: 40, textTransform: 'none' }}
            label={
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                {f.filename}
                <Chip size="small" label={f.rows.length} />
              </Box>
            }
          />
        ))}
      </Tabs>
      <Box sx={{ height: 420, width: '100%' }}>
        <AgGridReact<EditableRow>
          theme={jiggedAgGridTheme}
          rowData={active.rows}
          columnDefs={columnDefs}
          getRowId={(p) => p.data.__rowId}
          defaultColDef={{ sortable: true, resizable: true, filter: true }}
          stopEditingWhenCellsLoseFocus
          onCellValueChanged={(e: CellValueChangedEvent<EditableRow>) => {
            const field = e.colDef.field;
            if (!field) return;
            const oldValue = String(e.oldValue ?? '');
            const newValue = String(e.newValue ?? '');
            if (oldValue === newValue) return;
            onCellEdit(activeIndex, e.data.__rowId, field, oldValue, newValue);
          }}
        />
      </Box>
    </Box>
  );
}
