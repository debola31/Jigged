'use client';

import { Card, CardContent, Grid } from '@mui/material';
import RoutingOperationsList from './RoutingOperationsList';
import RoutingMaterialsList from './RoutingMaterialsList';
import type { OperationRowData } from './RoutingOperationRow';
import type { MaterialRowData } from './RoutingMaterialRow';

export interface RoutingBuilderProps {
  companyId: string;
  operations: OperationRowData[];
  materials: MaterialRowData[];
  onOperationsChange: (next: OperationRowData[]) => void;
  onMaterialsChange: (next: MaterialRowData[]) => void;
  disabled?: boolean;
}

/**
 * Side-by-side Operations + Materials layout. Stacks on mobile.
 */
export default function RoutingBuilder({
  companyId,
  operations,
  materials,
  onOperationsChange,
  onMaterialsChange,
  disabled = false,
}: RoutingBuilderProps) {
  return (
    <Grid container spacing={3}>
      <Grid size={{ xs: 12, md: 6 }}>
        <Card elevation={2}>
          <CardContent>
            <RoutingOperationsList
              rows={operations}
              onChange={onOperationsChange}
              companyId={companyId}
              disabled={disabled}
            />
          </CardContent>
        </Card>
      </Grid>
      <Grid size={{ xs: 12, md: 6 }}>
        <Card elevation={2}>
          <CardContent>
            <RoutingMaterialsList
              rows={materials}
              onChange={onMaterialsChange}
              companyId={companyId}
              disabled={disabled}
            />
          </CardContent>
        </Card>
      </Grid>
    </Grid>
  );
}
