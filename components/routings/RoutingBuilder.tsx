'use client';

import { Box, Card, CardContent, Divider } from '@mui/material';
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
 * Top-level routing builder. Renders Operations on top, Materials below
 * (stacked layout — see variant branches for side-by-side / etc).
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
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
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
    </Box>
  );
}
